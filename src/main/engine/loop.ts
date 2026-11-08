/**
 * `loop.ts` —— 串行事件循环 + 事务边界 + fixpoint + 启动恢复（DEV §5、PLAN §19、DEV §4.5）。
 *
 * 每 tick：取一批事件 → **一个事务**里 `applyEvent`（写 task_events + 更新状态 + 登记 action_log）
 * → 反复跑 `planScheduling` 直到无新决议（fixpoint）→ 提交；事务外执行副作用（`executePendingActions`）。
 *
 * 引擎从不 `await` 一个会话：派发只是登记动作，由执行器（M0 桩 / M1 真会话）异步完成。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SCHEDULER_CONFIG, planScheduling, type SchedulerConfig, type SchedulerInput } from '../../core/scheduler.js';
import { normalizePlanWorkItems, type NormalizedPlanWorkItem } from '../../core/plan.js';
import { insertWorkItemDep } from '../db/work_item_deps.js';
import { SqliteMemoryStore } from '../memory/index.js';
import type { TaskState, WaitingReason } from '../../core/types.js';
import { DEFAULT_RATE_LIMITS, describeRateLimit, rateAction, type RateLimits, type RateTier } from './rate-gate.js';
import { setEconomyMode } from '../agent/model-policy.js';
import { sendRecruitCard } from '../agent/assistant-cards.js';
import { notify } from '../notify/index.js';
import { redactPayload } from '../notify/redact.js';
import {
  findOtherRunningWorkItem,
  answerApproval,
  assignWorkItemVerifier,
  createTask,
  getTaskById,
  getProjectById,
  getWorkItem,
  setWorkItemTouchedPaths,
  countRunningWorkItems,
  getWorkItemPathClaim,
  insertArtifact,
  insertApproval,
  insertEmployee,
  insertCheckpoint,
  insertChangeset,
  insertChangesetFile,
  insertTaskEvent,
  getCheckpointForAttempt,
  finishCheckpoint,
  usdInWindow,
  insertWorkItem,
  latestPendingApproval,
  linkApprovalReport,
  linkArtifactsToChangeset,
  listRunningPathClaims,
  listPlanSteps,
  listTaskSnapshots,
  listWorkItems,
  listWorkItemsByTask,
  acceptanceTexts,
  readSetting,
  parseTouchedPaths,
  projectPlanStepEvent,
  recordCost,
  recordTaskMemory,
  resolveDefaultEmployeeId,
  getProjectDefaultBudget,
  runningByEmployee,
  setReportVerdict,
  SqliteCounterStore,
  toWorkItemSnapshot,
  updateReportPayload,
  updateTask,
  updateWorkItem,
  type PathClaim,
  type RecordCostInput,
  type SqliteDb,
  type WorkItemPatch,
} from '../db/index.js';
import { resolveGateContext } from './gate-context.js';
import { registerActions, executePendingActions, type ExecuteResult } from './actions.js';import { EventBus } from './bus.js';
import { pathConflictWith, type PathConflict } from './path-ownership.js';
import { commitAll, commitPaths, hasWorkingTreeChanges, isLockfilePath, listChangedPaths, resolveTaskWorkspace } from '../git/index.js';
import { cleanupMirroredInputs, mirrorTaskInputs } from './workspace-inputs.js';
import { effectScopeKey } from './effect-scope.js';
import {
  DEFAULT_SAMPLE_EVERY,
  verificationRequired,
  verificationStrength,
  type VerificationStrength,
} from './verification.js';
import {
  EmployeeBusyError,
  planTaskTransition,
  planWorkItemTransition,
  type TaskTransitionContext,
  type WorkItemTransitionContext,
} from './statemachine.js';
import { clearUnfiredTimers, clearWorkItemHeartbeat, heartbeatWorkItem, listDueTimers, markTimerFired, rebuildTimers, scheduleTimer } from './timers.js';
import type { EffectExecutor, EngineConfig, EngineEvent, PersistedAction } from './types.js';
import { collapsePath, permissionGate, type GateResult } from '../permission/gate.js';
import { resolveDefaultActionKind, type DefaultActionKind } from './statemachine.js';
import { hasPendingActions } from '../db/action_log.js';
import { changesetSummary, summaryFromWorkItemResult, workItemCommitMessage } from './commit-message.js';

/** 任务是否挂了机器验收命令（`acceptance[].check`）——有则**必须派 verifier**（DOC-4 硬门）。 */
function hasMachineAcceptance(raw: unknown): boolean {
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const check = (item as { check?: unknown }).check;
      return typeof check === 'string' && check.trim().length > 0;
    });
  } catch {
    return false;
  }
}

/**
 * RW-27（S11 真机，老板裁 A）：规划派发前的**最小预算额度**——剩余低于它就不开会话。
 * 真机依据：500 token 预算的任务规划/评审烧到 10138 token（20×）才停；一次真规划会话
 * 的实测成本在数千 token 级，1000 是"还不够起步"的保守下限（不随模型价格浮动，只挡明显不足）。
 */
export const MIN_DISPATCH_BUDGET_TOKENS = 1000;

export interface RecoveryReport {
  interrupted: number;
  /** BRK8：重启后自动重派的 interrupted 件数（仅任务仍 executing；其余留人工/恢复）。 */
  redispatched: number;
  replayed: ExecuteResult;
  timersRebuilt: number;
}

/** 2026-10-29 P2（F-N04）：评审/验证角色不能当“执行员工”派工（首启只有评审员工时会派错人）。 */
export function isExecutionRole(role: string | null | undefined): boolean {
  const r = (role ?? '').toLowerCase();
  return !/评审|验证|review|verifier|critic/.test(r);
}

export class Engine {
  readonly bus = new EventBus<EngineEvent>();
  private readonly queue: EngineEvent[] = [];
  /** RM-2：processBatch 事务期间收集的已应用事件（含调度 fixpoint 的派生事件），提交后统一通知 onCommitted。 */
  private committedEventsBuffer: EngineEvent[] | null = null;
  private readonly schedulerConfig: SchedulerConfig;
  /** N2：速率阈值（降档线 / 排队线；缺省读 env `AICO_RATE_LIMIT_USD_PER_HOUR`）。 */
  private readonly rateLimits: RateLimits;
  /** N3：并发上限（任务内 / 公司级）。**幕僚长不持 work item ⇒ 天然豁免**（无需特判）。 */
  private readonly concurrency: { maxPerTask: number; maxCompany: number };
  /** N2：上一轮档位（**只在切换时留痕**，不刷屏）。 */
  private lastRateTier: RateTier | null = null;
  /** N2：本轮档位是否发生切换（用于「首次拦截才留痕」，避免刷屏）。 */
  private rateTierChanged = false;
  private readonly autoSchedule: boolean;
  /** B0-3：运行时错误自动重试次数上限（0=关）。 */
  private readonly autoRetryLimit: number;
  private readonly tickMs: number;
  private readonly clock: () => number;
  private running = false;
  private stopping = false;
  private handle: ReturnType<typeof setTimeout> | null = null;
  /** M1-2：因路径相交被 hold 的派发（work item id → 原因/冲突对象）。R3-2：`detail`＝给 UI 的数字补充。 */
  private readonly pathHolds = new Map<number, { reason: WaitingReason; conflictsWith: number[]; detail?: string }>();
  /**
   * BRK14：调度器产出的**任务级** hold（`no_slot`/`budget`/`employee_busy`）——等待原因必须能上屏
   * （此前只有 WI 级三条〔速率/并发/路径〕进 `pathHolds`，三类排队原因被 fixpoint 的 `filter(hold)` 丢掉）。
   * 每轮 fixpoint 开头重建（与调度器同拍），不残留。
   */
  private readonly taskHolds = new Map<number, { reason: WaitingReason; detail?: string; occupiedBy?: number }>();
  /** M1-4 接缝（仅当提供 `git` 时启用）。 */
  private readonly git?: import('../git/index.js').GitRunner;
  private readonly worktreesBaseDir?: string;
  private readonly effectScopes?: import('./effect-scope.js').EffectScopeManager;
  private readonly workspaceByWorkItem = new Map<
    number,
    {
      cwd: string;
      rootDir: string;
      accessMode: string;
      shortId: string;
      touched: string[];
      employeeId: number;
      attempt: number;
      /** `inplace` 共享工作区：派发前是否干净（不干净则绝不自动提交，避免卷入老板在制改动）。 */
      baselineClean: boolean;
    }
  >();
  /** OPT-M9-1：默认路径的权限闸门（`config.permission === false` 时为空）。 */
  private readonly gate?: (action: PersistedAction) => GateResult;
  /**
   * B8/B10：包一层执行器 —— 先把内置 spawn（建续办任务 / 建返工工作项）处理掉，
   * 其余动作交回注入的执行器。spawn 必须发生**事务外**：`createTask`/`insertWorkItem`
   * 自开事务（嵌套会 `cannot start a transaction within a transaction`），且
   * `createTask` 的短号分配必须独立提交（短号永不复用）。幂等仍由 `action_log` 键保证。
   */
  private readonly actionExecutor: EffectExecutor;

  /** D3 会话实测抓到的真 bug 修复：**执行中动作的认领集合**（防重入执行；见 `actionExecutor` 注释）。 */
  private readonly inFlightActions = new Set<string>();

  constructor(
    private readonly db: SqliteDb,
    private readonly executor: EffectExecutor,
    private readonly config: EngineConfig = {},
  ) {
    this.schedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...(config.scheduler ?? {}) };
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...(config.rateLimit ?? {}) };
    this.concurrency = { maxPerTask: config.concurrency?.maxPerTask ?? 3, maxCompany: config.concurrency?.maxCompany ?? 6 };
    this.autoSchedule = config.autoSchedule ?? true;
    this.autoRetryLimit = (() => {
      if (typeof config.autoRetry === 'number' && Number.isFinite(config.autoRetry)) {
        return Math.max(0, Math.min(Math.trunc(config.autoRetry), 5));
      }
      const raw = (process.env.AICO_TASK_AUTO_RETRY ?? '').trim();
      const parsed = raw.length > 0 ? Number(raw) : Number.NaN;
      return Number.isFinite(parsed) ? Math.max(0, Math.min(Math.trunc(parsed), 5)) : 1;
    })();
    this.tickMs = config.tickMs ?? 1000;
    this.clock = config.now ?? (() => Date.now());
    this.git = config.git;
    this.worktreesBaseDir = config.worktreesBaseDir;
    this.effectScopes = config.effectScopes;
    this.actionExecutor = {
      execute: async (action: PersistedAction) => {
        // **重入守卫（D3 会话实测抓到的真 bug）**：执行器内部会 `dispatch` 事件 → 该事件 drain 时会
        // 再列 pending 动作——而**正在执行的这条仍是 `pending`**（执行完才标 done）⇒ 同一动作被**重入执行**
        // （planner/critic/verifier/员工会话各跑两遍、第二遍还因状态已前进而失败 → 动作被误标 `failed`）。
        // 进程内 `inFlight` 集合认领：重入时跳过（崩溃后仍是 `pending` ⇒ 恢复重放语义不变）。
        if (this.inFlightActions.has(action.actionKey)) {
          console.warn(`[engine] 动作重入被拦：${action.actionKey}（执行中）`);
          return;
        }
        this.inFlightActions.add(action.actionKey);
        try {
          // OPT-M3-1/G4 接线（链路审计第 6 处断线：`requestReview` 全仓无调用方）：**派工时指派验证者**——
          // 强度：L0/未命中抽验→不指派；L1 命中抽验 / L2 强制→指派 verifier ≠ 实现者；L2 无人可用→抛
          //（`FLOWS §204` 口径）⇒ 动作响亮失败（`action_failed`），不静默。放这里＝**事务外**
          //（`requestReview` 自开事务；fixpoint 在事务内，不能在那里调）。
          if (action.kind === 'dispatch') {
            const wiId = Number(action.actionKey.split(':')[2] ?? 0);
            // 工作项不在库（合成/历史键）→ 跳过（由 delegate 执行器按既有语义处理，不在引擎侧炸）
            if (Number.isInteger(wiId) && wiId > 0 && getWorkItem(this.db, wiId)) this.requestReview(wiId);
          }
          // D4（链路审计）：**`notify_*` 动作的执行方**——此前无执行方 ⇒ 批准卡/决策卡/汇报卡/异常卡
          // 都不产生（老板永远看不到闸门）。引擎侧统一执行（与 C2 同形；幂等键＝动作键本身）。
          if (action.kind.startsWith('notify_')) return this.runNotifyAction(action);
          if (action.kind === 'renew') return this.spawnRenewedTask(action);
          if (action.kind === 'spawn_work_item') return this.spawnReworkItem(action);
          if (action.kind === 'plan_work_items') return this.spawnPlanWorkItems(action);
          // RW-27（S11 真机，老板裁 A）：规划派发**前**预算预检——剩余低于最小规划额度就不开会话
          // （此前 500 token 预算的任务规划期已烧 10138 token 才停在「等预算」）。
          if (action.kind === 'dispatch_planning' && action.taskId != null) {
            const insufficient = this.budgetPrecheckInsufficient(action.taskId);
            if (insufficient != null) {
              await this.escalateBudgetInsufficient(action.taskId, insufficient, 'planning');
              return;
            }
          }
          // B0-11：预算预检扩展到**执行派发**（此前只在规划前拦——预算见底后仍会开新会话烧钱）。
          if (action.kind === 'dispatch' && action.taskId != null) {
            const task = getTaskById(this.db, action.taskId) as { state?: string } | undefined;
            if (task?.state === 'executing') {
              const insufficient = this.budgetPrecheckInsufficient(action.taskId);
              if (insufficient != null) {
                await this.escalateBudgetInsufficient(action.taskId, insufficient, 'dispatch');
                return;
              }
            }
          }
          // BRK17（挂载 3 余·取消小步）：任务级取消 → 真中断在跑的件（见方法头注）。
          if (action.kind === 'interrupt_work_items') return this.interruptWorkItems(action);
          return await this.executor.execute(action);
        } finally {
          this.inFlightActions.delete(action.actionKey);
        }
      },
    };
    this.gate = config.permission === false ? undefined : this.buildDefaultGate(config.permission ?? {});
  }

  /**
   * OPT-M9-1：构造默认权限闸门。
   * 有效权限 = **员工能力档**（`employees.capability_tier`，缺省 standard）∩ **放行档**（`resolvePermissionPolicy` 三级覆盖 global←project←task，缺省 standard）；
   * L2 → 放行档自动收紧一档；项目根 = 项目 `root_dir`（缺省 `config.permission.projectRoot` / cwd）。
   * 映射：动作 `kind` 直接作为工具名交给 `permissionGate`（`external/spend/install` 类永不自动放行）。
   */
  private buildDefaultGate(cfg: {
    capabilityTier?: 'sandbox' | 'standard' | 'trusted';
    defaultAutonomy?: 'strict' | 'standard' | 'loose';
    projectRoot?: string;
  }): (action: PersistedAction) => GateResult {
    return (action: PersistedAction): GateResult => {
      // G1：与**会话内工具**共用同一套上下文解析（`gate-context.ts`），避免两套口径。
      let employeeId: number | null = null;
      if (action.payload && typeof action.payload === 'object') {
        const subjectKind = (action.payload as { subjectKind?: unknown }).subjectKind;
        const subjectId = (action.payload as { subjectId?: unknown }).subjectId;
        if (subjectKind === 'work_item' && typeof subjectId === 'number') {
          employeeId = getWorkItem(this.db, subjectId)?.employee_id ?? null;
        }
      }
      const cwd =
        action.payload && typeof action.payload === 'object' && typeof (action.payload as { cwd?: unknown }).cwd === 'string'
          ? ((action.payload as { cwd: string }).cwd)
          : undefined;
      const ctx = resolveGateContext(this.db, { taskId: action.taskId ?? null, employeeId, cwd }, cfg);
      return permissionGate({ name: action.kind, args: (action.payload ?? {}) as Record<string, unknown> }, ctx);
    };
  }

  now(): number {
    return this.clock();
  }

  /** 入队一个事件（不立即处理；`drain()`/`start()` 消费）。 */
  enqueue(event: EngineEvent): void {
    this.queue.push(event);
    this.config.onEvent?.(event);
    this.bus.emit(event);
  }

  /** 便捷：入队并同步排空（手工驱动 T0.6 / 脚本化验收）。**严格**：非法事件向调用方抛。 */
  async dispatch(event: EngineEvent): Promise<void> {
    this.enqueue(event);
    await this.drain(false);
  }

  /** 手动调度 tick（无事件，仅跑调度 fixpoint）—— 用于状态驱动的推进（如 D4 依赖激活）。 */
  async tick(): Promise<void> {
    await this.enforceCompanyDailyBudget();
    const keys = this.processBatch([]);
    if (keys.length > 0) {
      await executePendingActions(this.db, this.actionExecutor, this.now(), this.gate, undefined, (e) => this.enqueue(e));
    }
  }

  /** B3：记录一笔成本（写 `costs` + `cost_recorded` 事件 + 回写 `cost_tokens`）；超预算则发 `budget_exceeded`。 */
  async recordCost(input: RecordCostInput): Promise<{ costTotal: number | null; budgetExceeded: boolean }> {
    const { costTotal } = recordCost(this.db, input);
    // C4：公司级日预算（所有 costs，含 task_id NULL 的共享开销）
    await this.enforceCompanyDailyBudget();
    // C2：公司级开销（taskId=null）无任务可回写/无预算概念 ⇒ 直接返回（不假报 0）
    if (input.taskId == null) return { costTotal, budgetExceeded: false };
    const task = getTaskById(this.db, input.taskId);
    const budgetExceeded = !!task && task.budget_tokens != null && task.cost_tokens >= task.budget_tokens && task.state === 'executing';
    if (budgetExceeded) {
      await this.dispatch({ scope: 'task', id: input.taskId, event: 'budget_exceeded', actor: 'system' });
    }
    return { costTotal, budgetExceeded };
  }

  // ───────────────────────── C4：公司级日预算（可选；默认关） ─────────────────────────

  /** 今日（本地 0 点起）公司花费 / 预算真读数；未设预算 ⇒ `budget:null`（不写假 0）。 */
  companyDailyBudgetState(): { budgetUsd: number | null; spentUsd: number; over: boolean; day: string } {
    const now = this.clock();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const raw = readSetting(this.db, 'budget.companyDailyUsd');
    const budgetUsd = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    const spentUsd = usdInWindow(this.db, { windowMs: Math.max(0, now - start.getTime()), now });
    return { budgetUsd, spentUsd, over: budgetUsd != null && spentUsd >= budgetUsd, day };
  }

  /** 达线暂停：所有 `executing` 任务发 `budget_exceeded`（幂等：已 paused 不在查询里）；并发保护防重入。 */
  private enforcingCompanyBudget = false;
  async enforceCompanyDailyBudget(): Promise<boolean> {
    if (this.enforcingCompanyBudget) return false;
    const state = this.companyDailyBudgetState();
    if (!state.over || state.budgetUsd == null) return false;
    this.enforcingCompanyBudget = true;
    try {
      const tasks = this.db.prepare("SELECT id FROM tasks WHERE state = 'executing' ORDER BY id").all() as Array<{ id: number }>;
      for (const task of tasks) {
        await this.dispatch({
          scope: 'task',
          id: task.id,
          event: 'budget_exceeded',
          actor: 'system',
          payload: { reason: 'company_daily_budget', budgetUsd: state.budgetUsd, spentUsd: state.spentUsd, day: state.day },
        });
      }
      // 公司级提示：按天 dedupe（重启/多次结算不刷屏）；任务级 budget_exceeded 另有卡。
      notify(this.db, {
        taskId: null,
        kind: 'alert',
        // 按「天＋预算值」去重：提高预算后再次超支应再提示一次（同日不同预算值）。
        dedupeKey: `budget:company-daily:${state.day}:${state.budgetUsd}`,
        payload: {
          title: '公司日预算已用尽',
          text: `今日已花 $${state.spentUsd.toFixed(4)} / 预算 $${state.budgetUsd.toFixed(2)}；执行中任务已暂停（提高预算后需手动继续）。`,
        },
      });
      return true;
    } finally {
      this.enforcingCompanyBudget = false;
    }
  }

  /** 派发前的日预算 hold（over ⇒ 原因/读数；否则 undefined）。 */
  companyDailyBudgetHold(): string | undefined {
    const state = this.companyDailyBudgetState();
    if (!state.over || state.budgetUsd == null) return undefined;
    return `公司日预算已用尽：今日 $${state.spentUsd.toFixed(4)} / $${state.budgetUsd.toFixed(2)}（${state.day}）`;
  }

  // ───────────────── OPT-M3-1：独立验证（强制度分级 + verifier≠实现者） ─────────────────

  /** 该 work item 的验证强度（按所属任务 `risk_level`：L0 免 / L1 抽验 / L2 强制）。 */
  verificationStrengthFor(workItemId: number, sampleEvery: number = DEFAULT_SAMPLE_EVERY): VerificationStrength {
    const wi = getWorkItem(this.db, workItemId);
    if (!wi) throw new Error(`[engine] 工作项不存在: ${workItemId}`);
    const task = getTaskById(this.db, wi.task_id);
    const base = verificationStrength(task?.risk_level ?? 1, workItemId, sampleEvery);
    return base === 'none' && hasMachineAcceptance(task?.acceptance) ? 'sampled' : base;
  }

  private pickVerifier(implementerEmployeeId: number): number | null {
    // 角色边界：幕僚长（is_assistant=1）只协调/汇总，**不参与验收**；L2 无合格验者时
    // 留空交给验证阶段 `no_verifier` 升级，绝不回退到幕僚长。
    // RW-12（M5 真机带回）：与 critic 同口径——优先专职评审角色（review/critic/评审），无专职回退按 id。
    const row = this.db
      .prepare(
        `SELECT id FROM employees WHERE active = 1 AND is_assistant = 0 AND id <> ?
         ORDER BY (CASE WHEN lower(role) LIKE '%review%' OR lower(role) LIKE '%critic%' OR role LIKE '%评审%' THEN 0 ELSE 1 END), id
         LIMIT 1`,
      )
      .get(implementerEmployeeId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * 为 work item 指派验证者（**默认实现者 ≠ 验证者**），落 `review_requested` 事件。
   * `required`（L2）时必须能指派到不同于实现者的员工，否则抛错。
   */
  requestReview(
    workItemId: number,
    opts: { verifierEmployeeId?: number; sampleEvery?: number } = {},
  ): { strength: VerificationStrength; verifierEmployeeId: number | null } {
    const wi = getWorkItem(this.db, workItemId);
    if (!wi) throw new Error(`[engine] 工作项不存在: ${workItemId}`);
    const task = getTaskById(this.db, wi.task_id);
    const baseStrength = verificationStrength(task?.risk_level ?? 1, workItemId, opts.sampleEvery ?? DEFAULT_SAMPLE_EVERY);
    // DOC-4：机器检查强制验证——即使 L1 未抽验，也要先指派独立 verifier（否则验证阶段 no_verifier）。
    const strength: VerificationStrength =
      baseStrength === 'none' && hasMachineAcceptance(task?.acceptance) ? 'sampled' : baseStrength;
    if (strength === 'none' && opts.verifierEmployeeId == null) return { strength, verifierEmployeeId: null };

    const verifier = opts.verifierEmployeeId ?? this.pickVerifier(wi.employee_id);
    if (verifier == null || verifier === wi.employee_id) {
      // L2 无合格验者（≠实现者、且非幕僚长）→ **不在派工时硬失败**：留空，提交后由
      // 执行器 `no_verifier` 升级给老板（可见决策卡）；绝不自签/回退幕僚长。
      if (strength === 'required') {
        console.warn(`[engine] L2 无合格验证者（需≠实现者且非幕僚长）：work item ${workItemId} → 验证阶段升级`);
      }
      return { strength, verifierEmployeeId: null };
    }
    this.db.exec('BEGIN');
    try {
      assignWorkItemVerifier(this.db, workItemId, verifier);
      insertTaskEvent(this.db, {
        taskId: wi.task_id,
        workItemId,
        ts: this.now(),
        kind: 'review_requested',
        actor: 'system',
        payload: { verifierEmployeeId: verifier, strength },
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { strength, verifierEmployeeId: verifier };
  }

  /** 记录验证结论到 `reports`（verdict + verifier）并落 `review_completed` 事件（可审计）。 */
  recordVerdict(input: {
    taskId: number;
    reportId: number;
    workItemId?: number | null;
    verdict: 'pass' | 'fail' | 'partial';
    verifierEmployeeId: number;
  }): void {
    setReportVerdict(this.db, input.reportId, input.verdict, input.verifierEmployeeId);
    insertTaskEvent(this.db, {
      taskId: input.taskId,
      workItemId: input.workItemId ?? null,
      ts: this.now(),
      kind: 'review_completed',
      actor: `employee:${input.verifierEmployeeId}`,
      payload: { verdict: input.verdict, verifierEmployeeId: input.verifierEmployeeId },
    });
  }

  // ───────────────────────── 启动恢复（DEV §4.5 / PLAN §19.3） ─────────────────────────

  /** ② running→interrupted ③ 重放 pending ④ 重建 timers。迁移（①）由调用方在 open 后先跑。 */
  async recover(): Promise<RecoveryReport> {
    const now = this.now();

    const runningItems = listWorkItems(this.db).filter((w) => w.state === 'running');
    this.db.exec('BEGIN');
    try {
      for (const wi of runningItems) {
        insertTaskEvent(this.db, {
          taskId: wi.task_id,
          workItemId: wi.id,
          ts: now,
          kind: 'work_item_interrupted',
          actor: 'system',
          payload: { reason: 'restart' },
        });
        updateWorkItem(this.db, wi.id, { state: 'interrupted', finished_at: now });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    // RW-3②（M5 真机带回）：verifying 态的**唯一待办是验收**——verifier 会话不随重启存活，而
    // 旧键已消费（action_log 同键 OR IGNORE）⇒ 不补派就永久挂死。逐个 verifying 任务查
    // `dispatch_verifier` 已用最大轮次，登记 **max+1** 的新键（在下方 replay 统一执行）。
    // 安全性：不动工作项队列（与 BRK8「验证中不擅自重派」不冲突——补的是验收会话，不是生产会话）；
    // 幂等：action_log 唯一键 ⇒ 重复 recover 不会叠加；verifier 完成会写 verification_completed，
    // 若仍 verifying（又挂）再 recover 会再 +1，形成阶梯。
    let verifierRefiled = 0;
    const verifyingTasks = this.db
      .prepare("SELECT id FROM tasks WHERE state = 'verifying'")
      .all() as Array<{ id: number }>;
    if (verifyingTasks.length > 0) {
      this.db.exec('BEGIN');
      try {
        for (const t of verifyingTasks) {
          // 轮次取已用最大 +1（JS 侧解析键尾，避免 SQL substr 对多位数的截断坑）
          const rows = this.db
            .prepare("SELECT action_key FROM action_log WHERE kind = 'dispatch_verifier' AND action_key LIKE ?")
            .all(`dispatch_verifier:task:${t.id}:%`) as Array<{ action_key: string }>;
          const maxRev = rows.reduce((m, r) => {
            const rev = Number(r.action_key.split(':').pop());
            return Number.isFinite(rev) && rev > m ? rev : m;
          }, -1);
          const registered = registerActions(
            this.db,
            [
              {
                kind: 'dispatch_verifier',
                subjectKind: 'task',
                subjectId: t.id,
                revision: maxRev + 1,
                taskId: t.id,
                payload: { phase: 'verifier', via: 'restart_reconcile' },
              },
            ],
            now,
          );
          verifierRefiled += registered.registered.length;
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    const replayed = await executePendingActions(this.db, this.actionExecutor, now, this.gate, undefined, (e) =>
      this.enqueue(e),
    );

    // BRK8：崩溃恢复策略（v1）——任务仍在 executing 的 interrupted 件自动重派（queued，attempt+1）；
    // 暂停/阻塞/验证中的任务不擅自重派（由 resume/人工恢复处理，避免把暂停态跑起来）。
    // 注意：这里**只改队列，不跑调度 fixpoint**——真正派发给引擎 start() 后的 schedulePass，
    // 避免恢复阶段在窗口/IPC 就绪前启动员工会话。
    const toRedispatch = runningItems.filter((wi) => getTaskById(this.db, wi.task_id)?.state === 'executing');
    if (toRedispatch.length > 0) {
      this.db.exec('BEGIN');
      try {
        for (const wi of toRedispatch) {
          this.applyEventInTx(
            { scope: 'work_item', id: wi.id, event: 'redispatch', actor: 'system', payload: { via: 'restart_recovery' } },
            [],
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    const tasks = listTaskSnapshots(this.db).map((t) => ({
      id: t.id,
      state: t.state as TaskState,
      deadline: t.deadline,
    }));
    this.db.exec('BEGIN');
    let timersRebuilt = 0;
    try {
      timersRebuilt = rebuildTimers(this.db, tasks, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { interrupted: runningItems.length, redispatched: toRedispatch.length, replayed, timersRebuilt };
  }

  // ───────────────────────── 事件循环 ─────────────────────────

  /**
   * 同步排空事件队列（每个批次一个事务），并执行产生的副作用。
   * `isolate`（缺省 true）＝毒事件隔离（B0-5）：整批失败后逐事件重试，毒事件回滚自己并落痕上卡。
   * `dispatch()` 传 false —— **直接调用语义保持严格**（UI/IPC 依赖非法迁移的 rejection 出回执）；
   * 隔离只针对队列里非直接调用的事件（定时器/引擎派生/恢复重放）。
   */
  async drain(isolate = true): Promise<void> {
    let guard = 0;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      let keys: string[];
      if (isolate) {
        try {
          keys = this.processBatch(batch);
        } catch (error) {
          // ADV-1 P0-2：旧实现整批 ROLLBACK ⇒ 同批其余事件随批丢失（drain 已 splice）。
          // 新口径：整批失败后逐事件重试——毒事件隔离（回滚＋留痕＋上卡），其余照常提交。
          console.error('[engine] 整批应用失败 → 逐事件隔离重试（毒事件不再连坐同批）', error);
          keys = this.applyBatchIsolated(batch);
        }
      } else {
        keys = this.processBatch(batch);
      }
      if (keys.length > 0) {
        await executePendingActions(this.db, this.actionExecutor, this.now(), this.gate, undefined, (e) => this.enqueue(e));
      }
      if ((guard += 1) > 100_000) throw new Error('[engine] drain 超过迭代上限（疑似死循环）');
    }
  }

  /**
   * **时间驱动的调度一拍**（空队列也跑一次 fixpoint）——生产由 `start()` 的 tick 每秒调用；
   * 测试可显式调用（等价"等到下一拍"）。
   *
   * 为什么需要（C2 链路修正，2026-10-14）：调度/老化是**时间驱动**的——只在"事件到达时"跑 fixpoint，
   * 会让「新登记的工作项等下一个无关事件才被派发」（首次拆派＝死等）和「老化晋升永不发生」。
   * 空批 `processBatch([])` 只做一次 fixpoint（无事件可应用），决议为空即无写入。
   */
  async schedulePass(): Promise<void> {
    const keys = this.processBatch([]);
    // MP1-F15：有挂起动作也排水（不只本拍新登记的）——员工会话一跑数分钟且无新事件时，
    // 其他任务的 pending 动作（如 plan_work_items）会一直躺着：任务 executing 无工作项、无等待原因
    // （「不静默排队」被打破）。tick 每拍排水即可；重入由 inFlightActions 守卫兜底，ask 幂等由 BRK10 保证。
    if (keys.length > 0 || hasPendingActions(this.db)) {
      await executePendingActions(this.db, this.actionExecutor, this.now(), this.gate, this.inFlightActions);
    }
  }

  /**
   * 处理一批事件：一个事务内 apply + fixpoint；返回本批新登记的动作键。
   * **严格**（失败整体回滚并抛）——隔离策略在 `drain(isolate)` 里按事件来源决定（B0-5）。
   */
  processBatch(batch: EngineEvent[]): string[] {
    return this.applyBatchAtomically(batch);
  }

  /** 一批事件在**同一事务**内 apply（正常路径；失败整体回滚由调用方决定如何隔离）。 */
  private applyBatchAtomically(batch: EngineEvent[]): string[] {
    const keys: string[] = [];
    const worklist = [...batch];
    // 派生事件（如 L0/未抽验 L1 的自动 `verification_completed`）在事务提交后才对外发布：
    // trigger service 必须看到**已落库的终态**，不能根据入队前的事件名猜“任务完成了”。
    const derivedCommitted: EngineEvent[] = [];
    const committedEvents: EngineEvent[] = [];
    this.committedEventsBuffer = committedEvents;
    this.db.exec('BEGIN');
    try {
      while (worklist.length > 0) {
        const event = worklist.shift() as EngineEvent;
        committedEvents.push(event);
        const derived = this.applyEventInTx(event, keys);
        for (const d of derived) {
          worklist.push(d);
          this.bus.emit(d);
          derivedCommitted.push(d);
        }
      }
      if (this.autoSchedule) this.runSchedulingFixpoint(keys);
      this.db.exec('COMMIT');
    } catch (error) {
      this.committedEventsBuffer = null;
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.committedEventsBuffer = null;
    for (const event of derivedCommitted) {
      try {
        this.config.onEvent?.(event);
      } catch (error) {
        console.error('[engine] 派生事件 onEvent 处理失败（事件已提交，不影响状态）', error);
      }
    }
    // RM-2：原文事件与派生事件都在提交后逐条通知（onEvent 在入队时也会触发，不能承载“已落库”副作用）。
    for (const event of committedEvents) {
      try {
        this.config.onCommitted?.(event);
      } catch (error) {
        console.error('[engine] 已提交事件 onCommitted 处理失败（事件已提交，不影响状态）', error);
      }
    }
    return keys;
  }

  /** 逐事件独立事务：毒事件只回滚自己，记录 `engine_error`＋异常卡后继续（B0-5）。 */
  private applyBatchIsolated(batch: EngineEvent[]): string[] {
    const keys: string[] = [];
    for (const event of batch) {
      try {
        keys.push(...this.applyBatchAtomically([event]));
      } catch (error) {
        this.recordEngineError(event, error);
      }
    }
    return keys;
  }

  /**
   * 毒事件留痕：任务存在时写 `engine_error` 事件流；同时投一张 **alert 异常卡**（老板可见，
   * 不只控制台）。记账失败不再向上抛（否则又会连坐已成功的事件）。
   * 幂等：同任务＋同事件＋同原因只提示一次（毒事件每拍重试不刷屏）。
   */
  private recordEngineError(event: EngineEvent, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[engine] 事件应用失败（已隔离）：${event.scope}#${event.id} ${event.event} — ${message.slice(0, 300)}`);
    const taskId = event.scope === 'task' ? event.id : Number(event.payload?.taskId);
    const task = Number.isInteger(taskId) && taskId > 0 ? getTaskById(this.db, taskId) : undefined;
    try {
      this.db.exec('BEGIN');
      try {
        if (task) {
          insertTaskEvent(this.db as never, {
            taskId: task.id,
            ts: this.now(),
            kind: 'engine_error',
            actor: 'system',
            payload: { event: event.event, scope: event.scope, id: event.id, error: message, payload: redactPayload(event.payload ?? {}) },
          });
        }
        notify(this.db, {
          taskId: task?.id ?? null,
          kind: 'alert',
          // 同任务同事件同原因 → 一张卡；原因变化才再提示。
          dedupeKey: `engine_error:${event.scope}:${event.id}:${event.event}:${message.slice(0, 120)}`,
          payload: {
            title: '引擎有事件处理失败（已隔离，其他事件照常）',
            text: `${event.scope}#${event.id} 的「${event.event}」失败：${message.slice(0, 300)}`,
          },
          urgent: true,
        });
      } catch (inner) {
        this.db.exec('ROLLBACK');
        throw inner;
      } finally {
        if (this.db.inTransaction) this.db.exec('COMMIT');
      }
    } catch (inner) {
      console.error('[engine] 毒事件留痕失败（不影响其他事件）', inner);
    }
  }

  // ───────────────────────── B8/B10 spawn（事务外建对象；幂等已由 action_log 键保证） ─────────────────────────

  /**
   * B8 续办：新建续办任务（「继承语境、不继承承诺」，FLOWS §F6 / 裁定 (c)）。
   * 继承：`project_id` / `title(+（续）)` / `goal` / `acceptance` / `risk_level` / `priority`；
   * 不继承：`task_deps` / `owner_id`（续办重走 triage/plan）→ 新行 `origin='renew'`。
   * 链路：新行 `renewed_from` = 旧任务 id（列已存在）；新任务上补一条 `task_renewed`
   * （payload `renewedFrom/renewedFromShortId/parentTaskId`，“续自 T-xxxx”可查）。
   */
  private spawnRenewedTask(action: PersistedAction): void {
    const payload = action.payload as { parentTaskId?: unknown };
    const parentTaskId = Number(payload.parentTaskId ?? 0);
    const old = parentTaskId ? getTaskById(this.db, parentTaskId) : undefined;
    if (!old) throw new Error(`[engine] renew 动作缺少有效 parentTaskId（actionKey=${action.actionKey}）`);
    let acceptance: unknown[] = [];
    try {
      const parsed = JSON.parse(old.acceptance ?? '[]') as unknown;
      if (Array.isArray(parsed)) acceptance = parsed;
    } catch {
      acceptance = [];
    }
    const created = createTask(this.db, new SqliteCounterStore(this.db), {
      projectId: old.project_id,
      title: `${old.title}（续）`,
      goal: old.goal,
      acceptance,
      riskLevel: old.risk_level as 0 | 1 | 2,
      priority: old.priority,
      origin: 'renew',
      parentTaskId: old.id,
      renewedFrom: old.id,
      budgetTokens: old.project_id != null ? (getProjectDefaultBudget(this.db, old.project_id) ?? undefined) : undefined,
      now: this.now(),
    });
    insertTaskEvent(this.db, {
      taskId: created.id,
      ts: this.now(),
      kind: 'task_renewed',
      actor: 'system',
      payload: { renewedFrom: old.id, renewedFromShortId: old.short_id, parentTaskId: old.id },
    });
  }

  /**
   * B10 验证打回：建返工工作项（`brief` = 验证者批注；owner = 实现者；`attempt=0`；`queued`）。
   * 只对 `verdict!=='pass'` 生效（对应迁移行自带守卫）；同源工作项仅生成一个返工项（幂等键）。
   */
  private spawnReworkItem(action: PersistedAction): void {
    const payload = action.payload as { workItemId?: unknown; notes?: unknown; employeeId?: unknown };
    const srcWiId = Number(payload.workItemId ?? 0);
    const src = srcWiId ? getWorkItem(this.db, srcWiId) : undefined;
    if (!src) throw new Error(`[engine] spawn_work_item 动作缺少有效 workItemId（actionKey=${action.actionKey}）`);
    // B2-6：跨任务守卫——签收拒绝的件必须属于本任务（防越权返工别的任务的件）。
    if (action.taskId != null && src.task_id !== action.taskId) {
      throw new Error(`[engine] spawn_work_item 拒绝：件 ${srcWiId} 属任务 ${src.task_id}，动作属任务 ${action.taskId}`);
    }
    const notes = typeof payload.notes === 'string' && payload.notes.trim() ? payload.notes.trim() : null;
    const employeeId = typeof payload.employeeId === 'number' ? payload.employeeId : src.employee_id;
    insertWorkItem(this.db, {
      taskId: src.task_id,
      employeeId,
      title: `返工：${src.title}`,
      brief: notes ?? '验证未通过：按验证者批注返工（无批注文本）。',
      touchedPaths: parseTouchedPaths(src.brief) ?? undefined,
      // B2-3/D-30②：血缘指向源件——同员工返工在派发时继承「员工×任务×源件」会话键
      // （前轮现场可见）；换员工改派不继承（执行器侧判 employee 一致才用）。
      retryOf: src.id,
      now: this.now(),
      actor: 'system',
    });
  }

  /**
   * C2（真拆派）：**规划产出工作项**（`FLOWS §3.1.2` 首行口径；D-6 缺省链）。
   *
   * v1 口径：**1 任务 = 1 工作项**（整个任务一件；"拆多件/并行 DAG"留后续）；`brief` = 结构化工作简报
   * （目标 + 验收 + 计划步骤 + 预算）。
   * **选人＝缺省链**：① 规划者指定（v1 未接——`submit_plan` 不带走员工）→ ② **项目默认员工**
   * （编制 `projects.default_employee_ids`，D-11 已落地：取**首个在职者**，离岗跳过错）→ ③ **任务负责人**
   * （`tasks.owner_id`）→ ④ **首个可执行员工**（active 且 `is_assistant=0`）；没有则**自动招募执行员工**。
   * **幕僚长不再兜底执行**（`D-20`，2026-10-20 老板令：没员工就自动找，不能全让老板确认）。
   * L1/L2 需要独立评审时，若只有一名可执行员工，同步自动补一名评审员工。
   * 幂等：动作键 `plan_work_items:task:<id>:0`（`action_log` OR IGNORE ⇒ 一任务一次）；已有工作项
   * （重规划/重放）→ **跳过并响亮留痕**（v1 不重算工作项：不建第二份、不静默）。
   */
  private isEligibleWorker(employeeId: number | null | undefined): boolean {
    if (typeof employeeId !== 'number' || !Number.isInteger(employeeId)) return false;
    // 显式指定（项目默认员工/负责人）仍尊重老板的选择；F-N04 只改“自动挑第一个”这一步。
    return (
      this.db
        .prepare('SELECT id FROM employees WHERE id = ? AND active = 1 AND is_assistant = 0')
        .get(employeeId) != null
    );
  }

  private firstEligibleWorker(): number | null {
    // F-N04：评审/验证角色不是执行者——跳过；一个执行员工都没有时由 autoRecruitWorker 招募。
    const rows = this.db
      .prepare('SELECT id, role FROM employees WHERE active = 1 AND is_assistant = 0 ORDER BY id')
      .all() as Array<{ id: number; role: string | null }>;
    return rows.find((row) => isExecutionRole(row.role))?.id ?? null;
  }

  private eligibleWorkerCount(): number {
    // 这里的“可执行”沿用宽口径（非幕僚长、在职）：用于判断是否需要补评审（既有行为）。
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND is_assistant = 0').get() as {
        n: number;
      }).n,
    );
  }

  /** 无员工时自动招募执行员工（D-20）；L1/L2 同时保证有一名独立评审员工。 */
  private autoRecruitWorker(taskId: number, riskLevel: number): number {
    const now = this.now();
    const employeeId = insertEmployee(this.db, {
      name: '执行员工',
      role: '执行',
      persona: '自动招募：由幕僚长按任务需要创建；老板可在设置·员工中细化人设/模型/技能。',
      capabilityTier: 'standard',
      now,
    });
    console.warn(`[engine] 无可用执行员工 → 自动招募员工 #${employeeId}（任务 ${taskId}）`);
    this.notifyAutoRecruit(taskId, 'execute', employeeId);
    if (riskLevel >= 1) this.ensureReviewer(taskId);
    return employeeId;
  }

  /** D-20/B-5：自动招募必须**可见**（进「待我处理」通知；不靠 console 留痕）。E-16 升级：加招募卡。 */
  private notifyAutoRecruit(taskId: number, role: 'execute' | 'review', employeeId: number): void {
    const label =
      (this.db.prepare('SELECT short_id FROM tasks WHERE id = ?').get(taskId) as { short_id?: string | null } | undefined)
        ?.short_id ?? `#${taskId}`;
    const isReview = role === 'review';
    // E-16：招募卡（含员工档案详情，走 assistant-cards 的 sendRecruitCard）
    try {
      const emp = this.db
        .prepare('SELECT name, role, persona, capability_tier FROM employees WHERE id = ?')
        .get(employeeId) as { name: string; role: string; persona: string | null; capability_tier: string | null } | undefined;
      if (emp != null) {
        const skills = this.db
          .prepare('SELECT s.name FROM skills s JOIN employee_skills es ON es.skill_id = s.id WHERE es.employee_id = ?')
          .all(employeeId) as Array<{ name: string }>;
        // 静态导入（文件头）：运行时 require 的相对路径打包后不存在，会被 catch 吞掉 → 招募卡永远发不出来（G-4 回归锚点）。
        sendRecruitCard(this.db, {
          employeeId,
          employeeName: emp.name,
          role: emp.role,
          persona: emp.persona ?? '（自动招募：由幕僚长按任务需要创建）',
          model: '跟随默认',
          skills: skills.map((s) => s.name),
          tier: emp.capability_tier ?? 'standard',
          taskId,
          taskShortId: label,
          blocking: false, // 默认自招模式（D-20）：通知+可改不阻塞
        });
      }
    } catch { /* 招募卡失败不阻断原有通知 */ }
    try {
      notify(this.db, {
        taskId,
        kind: 'notification',
        dedupeKey: `auto-recruit:${role}:task:${taskId}`,
        payload: {
          title: isReview ? '已自动招募评审员工' : '已自动招募执行员工',
          body: isReview
            ? `L1/L2 需要独立评审，已自动招募「评审员工」#${employeeId}（${label}）；可在设置·员工细化。`
            : `没有可用执行员工，已自动招募「执行员工」#${employeeId}（${label}）；可在设置·员工细化。`,
          employeeId,
          role,
          trigger: 'D-20',
        },
        now: this.now(),
      });
    } catch (error) {
      console.error('[engine] 自动招募通知落库失败（员工已创建）', error);
    }
  }

  /** 评审角色必须独立于执行者/幕僚长；没有第二名可执行员工时自动补一名评审员工。 */
  private ensureReviewer(taskId: number): void {
    if (this.eligibleWorkerCount() >= 2) return;
    const now = this.now();
    const employeeId = insertEmployee(this.db, {
      name: '评审员工',
      role: '评审',
      persona: '自动招募：负责独立评审/验证；老板可在设置·员工中细化人设/模型/技能。',
      capabilityTier: 'standard',
      now,
    });
    console.warn(`[engine] 缺少独立评审员工 → 自动招募员工 #${employeeId}（任务 ${taskId}）`);
    this.notifyAutoRecruit(taskId, 'review', employeeId);
  }

  /**
   * RW-27（S11 真机，老板裁 A）：规划派发前预算预检。
   * 剩余 = budget_tokens - cost_tokens；**低于最小规划额度**就视为不足（预算 500 时哪怕还没花，
   * 也远不够一次真规划会话——先拦下来问老板，而不是烧掉再停）。
   * 无预算（null）→ null（不受影响）。
   */
  private budgetPrecheckInsufficient(taskId: number): { budget: number; cost: number; remaining: number } | null {
    const task = getTaskById(this.db, taskId) as { budget_tokens?: number | null; cost_tokens?: number | null } | undefined;
    if (!task || typeof task.budget_tokens !== 'number') return null;
    const budget = task.budget_tokens;
    const cost = Number(task.cost_tokens ?? 0);
    const remaining = budget - cost;
    if (remaining >= MIN_DISPATCH_BUDGET_TOKENS) return null;
    return { budget, cost, remaining };
  }

  /** 预算不足：升级给老板（一次性卡：加预算后点重试 / 取消）。 */
  private async escalateBudgetInsufficient(
    taskId: number,
    info: { budget: number; cost: number; remaining: number },
    phase: 'planning' | 'dispatch' = 'planning',
  ): Promise<void> {
    const phaseText = phase === 'planning' ? '规划前检查' : '执行前检查';
    console.warn(
      `[engine] 预算预检拦截${phase === 'planning' ? '规划' : '执行'}派发：task=${taskId} 已用=${info.cost} 上限=${info.budget}（剩余 ${info.remaining} < ${MIN_DISPATCH_BUDGET_TOKENS}）`,
    );
    await this.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: {
        reason: 'budget_insufficient',
        question:
          `预算不足（${phaseText}）：已用 ${info.cost} / 上限 ${info.budget} token，剩余 ${info.remaining} 不够一次${phase === 'planning' ? '规划' : '执行'}。` +
          `请到任务详情「预算上限」加预算后点「已加预算，重试${phase === 'planning' ? '规划' : '执行'}」，或取消任务。`,
        options: [
          { key: 'retry', label: `已加预算，重试${phase === 'planning' ? '规划' : '执行'}` },
          { key: 'cancel', label: '取消任务' },
        ],
        urgent: true,
      },
    });
  }

  private spawnPlanWorkItems(action: PersistedAction): void {
    const taskId = action.taskId;
    if (taskId == null) throw new Error(`[engine] plan_work_items 动作缺少 taskId（actionKey=${action.actionKey}）`);
    const task = getTaskById(this.db, taskId) as
      | {
          id: number;
          title?: string | null;
          goal?: string | null;
          acceptance?: unknown;
          project_id?: number | null;
          owner_id?: number | null;
          risk_level?: number;
          budget_tokens?: number | null;
        }
      | undefined;
    if (!task) throw new Error(`[engine] plan_work_items：任务不存在 ${taskId}`);
    const existing = listWorkItemsByTask(this.db, taskId);
    if (existing.length > 0) {
      // 不静默：v1 不重算工作项（重规划走返工/续办；如需要重拆，属后续件）
      console.warn(`[engine] plan_work_items 跳过：任务 ${taskId} 已有 ${existing.length} 个工作项（v1 不重算）`);
      return;
    }
    // ② 项目默认员工（编制，D-11）→ ③ 负责人 → ④ 首个可执行员工；都没有 → 自动招募。
    // 幕僚长（is_assistant=1）永不进入执行候选（D-20）。
    const staffingDefault =
      typeof task.project_id === 'number' ? resolveDefaultEmployeeId(this.db, task.project_id) : null;
    const candidates = [staffingDefault, typeof task.owner_id === 'number' ? task.owner_id : null];
    let employeeId = candidates.find((id): id is number => this.isEligibleWorker(id)) ?? this.firstEligibleWorker();
    const riskLevel = typeof task.risk_level === 'number' ? task.risk_level : 1;
    if (employeeId == null) employeeId = this.autoRecruitWorker(taskId, riskLevel);
    else if (riskLevel >= 1) this.ensureReviewer(taskId);
    const steps = listPlanSteps(this.db, taskId).map((s) => s.text);
    const acceptance = acceptanceTexts(task.acceptance);
    const lines = [`目标：${String(task.goal ?? '').trim() || '（未填）'}`];
    if (acceptance.length > 0) lines.push(`验收：${acceptance.join('；')}`);
    if (steps.length > 0) lines.push(`计划：${steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
    // 2026-10-17 MiMo 验收实测：执行员工把「计划」复述一遍并等指令 ⇒ 工作项 failed。
    // 计划此时已批准（L0 直通 / L1·L2 plan_approved），必须写明「直接执行、不要等指令」。
    lines.push('执行要求：计划已批准（L0 为直通）；你是执行员工，直接按计划完成并把产出落盘/验证，不要复述计划、不要等指令；完成后必须调用 submit_work_item 提交。');
    if (typeof task.budget_tokens === 'number') lines.push(`预算：${task.budget_tokens} tokens`);
    // B2-4/D-30：路径预言**退役为提示**——brief 不再写 `'.'` 整树认领（B0-7 的兜底，
    // 正确但把 inplace 恒串行化）；认领改由执行期实测（touched-path-recorder 在工具调用
    // 执行前登记，`recordWorkItemTouchedPaths`）。brief 只留一句「路径按实测」提示。
    lines.push('预计改哪些文件：按你实际读写为准——路径保护按执行期实测判定（本行仅提示，不参与认领）。');
    const project = typeof task.project_id === 'number' ? getProjectById(this.db, task.project_id) : undefined;
    const briefText = lines.join('\n');
    const brief = briefText;
    // B2-3/D-30②：结构化多件（plan_drafted payload 的 workItems）——2-N 件带依赖落库；
    // 校验失败/缺省 → 回落单件（现状）。依赖**只允许同任务内**（work_item_deps DAO 环检测）。
    const planItems = this.normalizePlanItems(action.payload);
    if (planItems != null) {
      const created: number[] = [];
      for (const item of planItems) {
        const itemBrief = `${item.brief ?? item.title}\n\n${briefText}`;
        // B2a 出口 B 供件：件级 employeeId（规划者指定）——在职且非幕僚长才生效，否则回落缺省链。
        const itemEmployee =
          item.employeeId != null && this.isEligibleWorker(item.employeeId) ? item.employeeId : employeeId;
        const row = insertWorkItem(this.db, {
          taskId,
          employeeId: itemEmployee,
          title: item.title,
          brief: itemBrief,
          now: this.now(),
          actor: 'system',
        });
        created.push(row.id);
      }
      for (const [idx, item] of planItems.entries()) {
        for (const d of item.dependsOn) {
          insertWorkItemDep(this.db, { workItemId: created[idx]!, dependsOn: created[d - 1]!, now: this.now() });
        }
      }
      console.log(`[engine] plan_work_items：任务 ${taskId} 拆 ${created.length} 件（D-30② 多件 DAG，依赖 ${planItems.reduce((n, i) => n + i.dependsOn.length, 0)} 条）`);
      return;
    }
    insertWorkItem(this.db, {
      taskId,
      employeeId,
      title: task.title ?? `任务 ${taskId}`,
      brief,
      now: this.now(),
      actor: 'system',
    });
  }

  /**
   * B2-3：plan_drafted payload 的结构化 workItems 校验（规划会话已过一遍，这里再兜一道）。
   * 合法 → 归一化件列表；缺省/非法 → null（回落单件；非法时响亮留痕——不静默丢）。
   */
  private normalizePlanItems(payload: Record<string, unknown> | undefined): NormalizedPlanWorkItem[] | null {
    const raw = payload?.['workItems'];
    if (raw == null) return null;
    const validated = normalizePlanWorkItems(raw);
    if (!validated.ok) {
      console.warn(`[engine] plan_work_items：结构化多件非法（${validated.message}）→ 回落单件`);
      return null;
    }
    return validated.items;
  }

  /**
   * M2-C 第 5 项：`submit_work_item` 的 `result.artifacts`（路径列表）→ `artifacts` 行（同事务）。
   * `source` = `<accessMode>:<collapsePath(cwd)>`（**与 G2 的会话/cwd 归一化同源**）；`sha256` 尽力而为。
   */
  private writeSubmittedArtifacts(wi: import('../db/index.js').WorkItemRow, event: EngineEvent, now: number): void {
    const result = (event.payload as { result?: { artifacts?: unknown } } | undefined)?.result;
    const raw = Array.isArray(result?.artifacts) ? (result.artifacts as unknown[]) : [];
    const paths = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    if (paths.length === 0) return;
    const ws = this.workspaceByWorkItem.get(wi.id);
    // `submit_work_item.result.artifacts` 是员工显式登记的产出路径——inplace 的路径白名单
    // 和 staging 的产物回挂都以它为准；在 finishWorkspace 之前并入 ctx.touched。
    if (ws) ws.touched = [...new Set([...ws.touched, ...paths])];
    const source = ws ? `${ws.accessMode}:${collapsePath(ws.cwd)}` : null;
    for (const p of paths) {
      try {
        let sha: string | null = null;
        if (ws) {
          try {
            sha = createHash('sha256').update(readFileSync(resolve(ws.cwd, p))).digest('hex');
          } catch {
            sha = null; // 路径不可读（URL/标识符/未产出）⇒ 不阻塞登记
          }
        }
        insertArtifact(this.db, {
          taskId: wi.task_id,
          workItemId: wi.id,
          path: p,
          kind: 'file',
          source,
          sha256: sha,
          now,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[engine] 产物登记失败（work item ${wi.id}, path=${p}）：${msg}`);
      }
    }
  }

  /** 应用一个事件；返回其派生事件（如工作项聚合出「全部完成」）。 */
  private applyEventInTx(event: EngineEvent, keys: string[]): EngineEvent[] {
    return event.scope === 'task'
      ? this.applyTaskEventInTx(event, keys)
      : this.applyWorkItemEventInTx(event, keys);
  }

  private applyTaskEventInTx(event: EngineEvent, keys: string[]): EngineEvent[] {
    const now = event.ts ?? this.now();
    const task = getTaskById(this.db, event.id);
    if (!task) throw new Error(`[engine] 任务不存在: ${event.id}`);

    // B6：超时默认动作 —— 优先事件显式值，否则读**待决审批卡**的真实 `default_action`（不再硬编码 `approve`）。
    const pendingApproval = latestPendingApproval(this.db, task.id);
    const explicitDefault = (event.payload?.defaultAction as string | undefined) ?? null;
    const defaultActionKey = explicitDefault ?? pendingApproval?.default_action ?? null;
    const defaultActionKind: DefaultActionKind = resolveDefaultActionKind(
      defaultActionKey,
      parseApprovalOptions(pendingApproval?.options),
    );
    // 重规划 v+1：计划轮次＝**已产出的** plan_drafted 数（本事件写入前计数 ⇒ 首版 0）。
    // 只读、确定性 ⇒ 重放同一事件得同一 ctx（动作键可复现）。
    const planRevision = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'plan_drafted'")
          .get(task.id) as { n: number }
      ).n ?? 0,
    );
    // BRK4：续跑轮次（本次 task_resumed 写入前计数）——verifier 幂等键用它，避免恢复后被旧键吞掉。
    const resumeRevision = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'task_resumed'")
          .get(task.id) as { n: number }
      ).n ?? 0,
    );
    // BRK25：decision_made 次数（本次写入前）——答卡回 planning 的重派键用它，避免与首轮/打回键相撞。
    const decisionRevision = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'decision_made'")
          .get(task.id) as { n: number }
      ).n ?? 0,
    );
    // RW-3（M5 真机带回）：验证轮次（本次 verification_started 写入前计数 ⇒ 首轮 0、返工/恢复轮递增）
    // ——verifier 幂等键用它；resumeRevision 只覆盖暂停恢复，返工轮键不变会被 OR IGNORE 吞掉（真机挂死）。
    const verifyRevision = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'verification_started'")
          .get(task.id) as { n: number }
      ).n ?? 0,
    );
    // B2-6/D-30③：L1+ verifier pass 的签收卡——事件 payload 填 question＋options
    // （sign＋逐件 rework；notifyAction 透传 → 决策卡＋approvals 行）。0 件可返工时只给 sign。
    if (event.event === 'verification_completed' && (event.payload as { verdict?: unknown } | undefined)?.verdict === 'pass' && (task.risk_level ?? 1) >= 1 && (event.payload as { options?: unknown }).options == null) {
      const signoffItems = listWorkItemsByTask(this.db, task.id).filter((w) => w.state === 'done' || w.state === 'submitted');
      event.payload = {
        ...event.payload,
        options: [
          { key: 'sign', label: '✅ 签收通过' },
          ...signoffItems.slice(0, 6).map((w) => ({ key: `rework:${w.id}`, label: `↩ 返工：${w.title.slice(0, 18)}` })),
        ],
        question: `验收通过，请签收：${task.short_id ?? `#${task.id}`}（${String(task.title ?? '').slice(0, 30)}）`,
      };
    }
    const ctx: TaskTransitionContext = {
      taskId: task.id,
      from: task.state as TaskState,
      now,
      actor: event.actor ?? 'system',
      riskLevel: task.risk_level as 0 | 1 | 2,
      payload: event.payload ?? {},
      resumeState: task.resume_state as TaskState | null,
      stateBeforeClose: task.state_before_close as TaskState | null,
      defaultAction: defaultActionKey,
      defaultActionKind,
      closedAt: task.closed_at,
      archived: task.archived === 1,
      shortId: task.short_id ?? undefined,
      planRevision,
      decisionRevision,
      resumeRevision,
      verifyRevision,
    };
    const outcome = planTaskTransition(ctx, event.event);

    for (const kind of outcome.kinds) {
      insertTaskEvent(this.db, {
        taskId: task.id,
        ts: now,
        kind,
        actor: ctx.actor,
        payload: event.payload ?? {},
      });
      // 投影：plan_drafted / plan_edited / progress_reported → plan_steps（DEV §4 第 8 条；事务内、可重放）
      projectPlanStepEvent(this.db, { taskId: task.id, kind, payload: event.payload ?? {}, now });
      // GAP8：批准前编辑计划 → 待批卡同步新计划（卡是老板实际作答的界面；不能只刷详情）。
      if (kind === 'plan_edited') this.syncApprovalCardPlan(task.id);
    }
    // v15：暂停来源落库（同状态不同来源；加预算/继续只自动恢复 budget 来源）。
    const pauseReason =
      outcome.to === 'paused'
        ? event.event === 'budget_exceeded'
          ? (event.payload as { reason?: unknown } | undefined)?.reason === 'company_daily_budget'
            ? 'company_budget'
            : 'task_budget'
          : 'manual'
        : ctx.from === 'paused'
          ? null
          : undefined;
    updateTask(
      this.db,
      task.id,
      pauseReason === undefined ? outcome.patch : { ...outcome.patch, pause_reason: pauseReason },
      now,
    );

    // G11：任务进终态 `done` → 参与者员工的项目记忆（确定性投影、同事务、幂等；见 db/memory.ts）
    if (outcome.to === 'done') {
      recordTaskMemory(this.db, task.id, now);
      // B3-5/D-31：LLM 抽取提议卡（**异步、不阻塞事务**；fail-closed——无 Key/失败仅留痕，
      // 候选写 provisional 待老板确认，见 agent/memory-extract.ts）
      void this.extractMemoryCandidatesFor(task.id);
    }

    const registered = registerActions(this.db, outcome.actions, now);
    keys.push(...registered.registered);

    // 看门狗 timer：离开不再适用的状态→清除残留；进入对应状态→登记（FLOWS §3.1.1）
    if (ctx.from === 'awaiting_approval' && outcome.to !== 'awaiting_approval') {
      clearUnfiredTimers(this.db, 'askcard_timeout', task.id);
    }
    if (ctx.from === 'needs_decision' && outcome.to !== 'needs_decision') {
      clearUnfiredTimers(this.db, 'askcard_timeout', task.id);
    }
    if (ctx.from === 'blocked' && outcome.to !== 'blocked') {
      clearUnfiredTimers(this.db, 'blocked_watchdog', task.id);
    }
    if (outcome.to === 'awaiting_approval') {
      this.scheduleWatchdog('askcard_timeout', task.id, 'askcard', now);
    }
    // B6：进 `needs_decision` 也排 AskCard 超时（原先只排 awaiting_approval ⇒ 那条迁移永远走不到）
    if (outcome.to === 'needs_decision') {
      this.scheduleWatchdog('askcard_timeout', task.id, 'askcard', now);
    }
    if (outcome.to === 'blocked') {
      this.scheduleWatchdog('blocked_watchdog', task.id, 'watchdog:blocked', now);
    }

    // D3-B（链路审计）：**任务级验收通过 → 对已提交的工作项发 `review_accept`**
    //（`FLOWS §3.1.2`「`submitted` --`review_accept`（verifier 验收项 pass）--> `done`」的落点；
    // L1/L2 的工作项在 verifying 阶段被接受——v1：1 任务 1 件，任务级 pass ⇒ 全部 submitted 件接受）。
    const derived: EngineEvent[] = [];
    if (event.event === 'verification_completed' && (event.payload as { verdict?: unknown } | undefined)?.verdict === 'pass') {
      const risk = (task.risk_level ?? 1) as number;
      for (const it of listWorkItemsByTask(this.db, task.id)) {
        if (it.state !== 'submitted') continue;
        // 只接受**可被接受**的件：免验（none）或有合规 verifier（≠实现者）——否则会去撞
        // 「未验证不得 done」守卫（那是给"绕过验证直发 review_accept"留的牙，不该被本派生触发）。
        const verifiable =
          !verificationRequired(risk, it.id) ||
          (it.verifier_employee_id != null && it.verifier_employee_id !== it.employee_id);
        if (verifiable) derived.push({ scope: 'work_item', id: it.id, event: 'review_accept', actor: 'system' });
      }
    }
    // D3-C（链路审计）：**无事可验** → 任务级验收免，**如实自动 pass**（`via` 标注来源；不假装跑过 verifier）。
    if (
      outcome.to === 'verifying' &&
      (event.payload as { verificationNeeded?: unknown } | undefined)?.verificationNeeded === false
    ) {
      derived.push({
        scope: 'task',
        id: task.id,
        event: 'verification_completed',
        actor: 'system',
        payload: { verdict: 'pass', via: 'no_verification_required' },
      });
    }
    // BRK4：任何路径进入 executing（含手工 start_task / 调度 start_task）都做一次恢复对账：
    // 重派 interrupted 件；已全 settled ⇒ 立即聚合（暂停期间跑完的件不再等一个不存在的后续事件）。
    if (event.event === 'start_task' && outcome.to === 'executing') {
      this.reconcileExecutingTask(task.id, keys);
    }
    return derived;
  }

  /**
   * D4（链路审计）：**`notify_*` 动作 → 真卡**（`reports` ＋ `notifications`；复用 `notify()`，不另造载体）。
   *
   * 口径（`UI §4.1` 四类卡；`FLOWS §3.1.1` 动作列）：
   * - `notify_approval` → **决策卡**（`kind='ask'`；payload 带 `options`＝批准/打回）＋ **建审批行**
   *   （`report_id` 回挂真卡；`default_action`：**L1='approve'**（超时按批准执行＝`FLOWS §3.1.1` L224）、
   *   **L2=null**（永不自动））；
   * - `notify_decision` → 决策卡＋审批行（`default_action=null`，B6 fail-closed）；
   * - `notify_report` → 汇报卡（`kind='report'`）；`notify_alert` → 异常卡（`kind='alert'`，**urgent**＝静默期照推）。
   * **幂等**：去重键＝**动作键本身**（`notify()` 的 dedupe_key UNIQUE ⇒ 重放/重入安全）；审批行用
   * `latestPendingApproval` 同题去重（重放不叠第二张）。
   * **V3 修（真机配方抓到的断链）**：卡先落 → 审批行**回挂 `report_id`** ＋ 选项**写进卡 payload**
   * （渲染层出按钮、`enrichReport` 取 `approvalId` 都靠这两条；此前两样都没有 ⇒ 批准卡上无按钮、
   * 按钮点下去 `task:approve` 直接 bad_request）。
   * **实时推送**：本版只落库（渲染层下次拉取可见）；`evt:notify` 实时刷新留后续件（如实登记）。
   */
  /**
   * BRK17（挂载 3 余·取消小步，2026-10-16 裁决 D-9；余两态扩展同批）：任务级「取消」→ **真中止**。
   *
   * 语义：① 逐个把 `running` 件按真值表走 `pause_task`（`running → interrupted`；WI 机唯一中断词）——
   * 事件入队后由外层 drain 循环按机器规应用（不绕过真值表直写状态）；② 逐件回调
   * `onWorkItemInterrupted`（main 注入 → 真停员工会话 `AgentSession.abort()`；缺省不回调＝仅停件）；
   * ③ **按任务**回调一次 `onTaskCancelled`（不挂件的**角色会话**：planner/critic/verifier——如验证中
   * 跑着的 verifier 会话）。
   * **已 `submitted` 的件不动**（不再验证；收尾卡如实交代）；`queued` 件随任务终态不再派发。
   */
  /**
   * BRK4（M3-R-1）：暂停恢复后的**执行态对账**——任务重新进入 executing 时：
   *  ① 被暂停打断的件（`interrupted`）→ `redispatch`（回 queued，交给调度重派）；
   *  ② 失败任务重试带来的 `failed` 件 → `retry`（attempt+1，走既有 `failed --retry--> running` 重派）；
   *  ③ 若全部件已经 done/submitted（暂停时刚好跑完）→ 立即发 `all_work_items_done`，
   *     不再等一个不存在的后续事件（原缺陷：恢复后无人再聚合，任务卡 executing）。
   * 幂等：interrupted/failed 只转一次；全 settled 的聚合由状态机 `executing` 守卫兜底（重复事件会抛未知迁移）。
   */
  private reconcileExecutingTask(taskId: number, keys: string[]): void {
    const task = getTaskById(this.db, taskId);
    if (!task || task.state !== 'executing') return;
    for (const wi of listWorkItemsByTask(this.db, taskId)) {
      if (wi.state === 'interrupted') {
        this.applyDerivedInTx(
          [{ scope: 'work_item', id: wi.id, event: 'redispatch', actor: 'system', payload: { via: 'resume_reconcile' } }],
          keys,
        );
      } else if (wi.state === 'failed') {
        // S1 修复（2026-10-24）：任务 `failed --retry--> ready` 只重开任务，failed 件不会自己动；
        // 在任务真正进入 executing 后补一次件级 retry（attempt+1 ⇒ 新 dispatch 键），避免空转。
        this.applyDerivedInTx(
          [{ scope: 'work_item', id: wi.id, event: 'retry', actor: 'system', payload: { via: 'task_retry_reconcile' } }],
          keys,
        );
      }
    }
    const items = listWorkItemsByTask(this.db, taskId);
    if (items.length === 0 || !items.every((it) => it.state === 'done' || it.state === 'submitted')) return;
    const risk = (task.risk_level ?? 1) as number;
    // DOC-4：挂了机器检查的任务**必须**走 verifier（L1 未抽验也不能自动 pass）。
    const verificationNeeded = hasMachineAcceptance(task?.acceptance) || items.some((it) => verificationRequired(risk, it.id));
    this.applyDerivedInTx(
      [
        {
          scope: 'task',
          id: taskId,
          event: 'all_work_items_done',
          actor: 'system',
          payload: { verificationNeeded, via: 'resume_reconcile' },
        },
      ],
      keys,
    );
  }

  /** 事务内递归应用派生事件（调度 fixpoint 用；与 processBatch 的 worklist 同语义）。 */
  private applyDerivedInTx(events: EngineEvent[], keys: string[]): void {
    const work = [...events];
    while (work.length > 0) {
      const e = work.shift() as EngineEvent;
      this.committedEventsBuffer?.push(e);
      const derived = this.applyEventInTx(e, keys);
      for (const d of derived) {
        work.push(d);
        this.bus.emit(d);
      }
      this.bus.emit(e);
    }
  }

  private interruptWorkItems(action: PersistedAction): void {
    const taskId = action.taskId;
    if (taskId == null) return;
    const via = typeof action.payload?.via === 'string' ? action.payload.via : 'task_cancel';
    const running = listWorkItemsByTask(this.db, taskId).filter((wi) => wi.state === 'running');
    for (const wi of running) {
      this.enqueue({
        scope: 'work_item',
        id: wi.id,
        event: 'pause_task',
        actor: 'system',
        payload: { via },
      });
      this.config.onWorkItemInterrupted?.({ workItemId: wi.id, employeeId: wi.employee_id, taskId });
    }
    // 不挂件的角色会话（planner/critic/verifier）也停——取消与暂停共用（BRK4/BRK17）。
    this.config.onTaskCancelled?.({ taskId });
  }

  /**
   * GAP8：把当前 `plan_steps` 合并进**待批卡的 payload.planSteps**。
   * 只在 `plan_edited` 后调用；卡或审批行缺失（重放/历史数据）→ 静默跳过（详情仍有新计划）。
   */
  private syncApprovalCardPlan(taskId: number): void {
    const pending = latestPendingApproval(this.db, taskId);
    if (!pending || pending.report_id == null) return;
    const planSteps = listPlanSteps(this.db, taskId).map((step) => step.text);
    updateReportPayload(this.db, pending.report_id, { planSteps });
  }

  private runNotifyAction(action: PersistedAction): void {
    const taskId = action.taskId;
    if (taskId == null) return; // 无任务锚的通知（如全局日报）不走本路——不臆造
    const card = action.kind.replace('notify_', '');
    const task = getTaskById(this.db, taskId) as
      | { risk_level?: number; short_id?: string | null; title?: string | null; goal?: string | null; acceptance?: string | null }
      | undefined;
    const shortId = task?.short_id ?? `#${taskId}`;

    // BRK10/11：决策卡 extras（闸门权限卡/员工升级按白名单透传；不整包——防大载荷进 action_log）。
    const extras = action.payload ?? {};
    const extraQuestion =
      typeof extras.question === 'string' && extras.question.trim().length > 0 ? extras.question : null;
    const extraOptions = Array.isArray(extras.options) ? (extras.options as Array<{ key: string; label?: string }>) : [];
    const approvalId = typeof extras.approvalId === 'number' ? extras.approvalId : null;
    const reason = typeof extras.reason === 'string' ? extras.reason : null;
    const modelRejected = typeof extras.modelRejected === 'string' ? extras.modelRejected : null;
    // 只有 C2 的模型/凭据异常卡把 reason 当 summary 上屏；`no_plan`/`work_item_failed` 等代码词
    // 不得漏进决策卡/异常卡正文（独立审查 2026-10-18）。
    const alertSummary = card === 'alert' && reason?.startsWith('模型/凭据不可用：') ? reason : null;

    // 决策类的选项：**同时**进卡 payload（UI 按钮的唯一来源）与审批行（作答/超时的台账）。
    // RW-21（M5 真机 S9 批）：critic 打回达上限的升级此前不带 options——卡上没有可点按钮，
    // 老板文字回复只进幕僚长对话（它没有任务裁定工具）⇒ 任务永久 needs_decision（真机实锤 T-1015）。
    // 选项键全部对齐任务机真边：proceed＝decision_proceed_latest（最新稿视同批准，不重规划）；
    // revise＝decision_made（回规划带评审意见）；cancel＝cancel（真取消）。
    // 兜底不变式：**needs_decision 的决策卡至少有「取消任务」**——任何升级都不许把任务砖死。
    const options =
      card === 'approval'
        ? [
            { key: 'approve', label: '批准（推荐）' },
            { key: 'revise', label: '打回，改计划' },
          ]
        : extraOptions.length > 0
          ? extraOptions
          : card === 'decision' && reason === 'critic_revise_limit'
            ? [
                { key: 'proceed', label: '按最新版继续' },
                { key: 'revise', label: '按评审意见再改（推荐）' },
                { key: 'cancel', label: '取消任务' },
              ]
            : card === 'decision'
              ? [{ key: 'cancel', label: '取消任务' }]
              : extraOptions;
    const question =
      card === 'approval'
        ? `批准计划？（${shortId} ${task?.title ?? ''}）`.trim()
        : card === 'decision'
          ? (extraQuestion ??
            (reason === 'critic_unavailable'
              ? `没有独立评审员工（不能由规划者/实现者自评）。先招募至少一名员工，或到任务详情处理（${shortId}）。`
              : reason === 'no_verifier'
                ? `没有独立验证员工（不能由实现者/幕僚长自验）。先招募至少一名员工，或到任务详情处理（${shortId}）。`
                : reason === 'critic_revise_limit'
                  ? `评审员工连续打回 ${typeof extras.round === 'number' ? extras.round : '多'} 版计划（达上限）——需要你裁定（${shortId}）：按最新版继续／按评审意见再改／取消任务（评审意见见卡下正文）。`
                  : reason === 'no_plan'
                    ? `规划会话没有产出可用计划（${shortId}：${task?.title ?? ''}）。可去任务详情查看记录，或取消任务。`
                    : reason === 'no_verdict'
                      ? `验证会话没有给出结论（${shortId}：${task?.title ?? ''}）。可去任务详情查看记录，或取消任务。`
                      : reason === 'no_credential'
                        ? `员工会话不可用（${shortId}）：未配置凭据或模型服务连接失败。修好后到任务详情重试，或取消任务。`
                        : `任务需要你决策（${shortId}：${task?.title ?? ''}）。可去任务详情查看上下文，或取消任务。`))
          : null;
    // RW-6（M5 真机带回）：critic 打回达上限的升级必须**把评审意见带上卡**——老板拿到卡要能决策。
    // 摘要进 payload.body（Card.tsx / InboxView 已渲染 body——E-16 批接的渲染面）；截断 360 字符防大载荷。
    const criticNotes =
      card === 'decision' && reason === 'critic_revise_limit' && typeof extras.notes === 'string' && extras.notes.trim().length > 0
        ? extras.notes.trim().slice(0, 360)
        : null;

    const kind = card === 'report' ? 'report' : card === 'alert' ? 'alert' : 'ask';
    // GAP8：计划批准卡带**计划全文**（卡上就能审计划；编辑后由 syncApprovalCardPlan 合并刷新）。
    const planSteps = card === 'approval' ? listPlanSteps(this.db, taskId).map((step) => step.text) : [];
    // 2026-10-29 P2（F-N06）：批准卡不只有命令细节——把目标/验收条数/风险放在 tldr（人话摘要）。
    let approvalTldr: string | null = null;
    if (card === 'approval') {
      let acceptanceCount = 0;
      try {
        const parsed: unknown = JSON.parse(task?.acceptance ?? '[]');
        if (Array.isArray(parsed)) acceptanceCount = parsed.length;
      } catch {
        acceptanceCount = 0;
      }
      const goal = (task?.goal ?? '').trim();
      const risk = typeof task?.risk_level === 'number' ? ['低', '中', '高'][task.risk_level] ?? String(task.risk_level) : '—';
      approvalTldr = `${goal.length > 0 ? `目标：${goal.slice(0, 140)}` : '目标：—'} · 验收 ${acceptanceCount} 条 · 风险：${risk}`;
    }
    // N5 余账（EMPLOYEES §10.3「汇报卡标注'本次由 X 模型降级完成'」）：收尾卡在**发生过运行时降级**时
    // 如实加注（读 `agent_model_fallback` 事件计数；无降级不加注——不臆造）。
    const fallbackCount =
      card === 'report'
        ? (this.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'agent_model_fallback'").get(taskId) as { n: number }).n
        : 0;
    const fallbackNote = fallbackCount > 0 ? `（含模型降级 ×${fallbackCount}）` : '';
    // GAP12：完成卡带上最近一次验证结论/批注（微信不能用“详情见桌面”替代结论本身）。
    let reviewVerdict: string | null = null;
    let reviewNotes: string | null = null;
    if (card === 'report') {
      const review = this.db
        .prepare("SELECT verdict, payload FROM reports WHERE task_id = ? AND kind = 'report' ORDER BY id DESC LIMIT 1")
        .get(taskId) as { verdict?: string | null; payload?: string } | undefined;
      if (review) {
        reviewVerdict = review.verdict ?? null;
        try {
          const payload = JSON.parse(String(review.payload ?? '{}')) as Record<string, unknown>;
          if (!reviewVerdict && typeof payload.verdict === 'string') reviewVerdict = payload.verdict;
          if (typeof payload.notes === 'string' && payload.notes.trim().length > 0) reviewNotes = payload.notes.trim();
        } catch {
          // 老行/坏 JSON：不猜，保持 null
        }
      }
    }
    const title =
      card === 'approval'
        ? `等你批准：${shortId} 的计划`
        : card === 'decision'
          ? `等你决策：${shortId}`
          : card === 'report'
            ? extras.outcome === 'cancelled'
              ? `已取消：${shortId}${fallbackNote}`
              : `完成：${shortId}${fallbackNote}`
            : `异常：${shortId}`;
    // RW-10（M5 真机带回，改判后收窄的修法）：done 完成卡存在**未合并变更集**时提示
    // 「产物在暂存工作区、需到任务详情合并才落项目根」——自动 pass→done 的任务尤其实用
    // （合并入口在详情页「变更与产物→变更（本次提交）」行内，完成卡不提示老板会以为产物丢了）。
    const pendingMerge =
      card === 'report'
        ? (
            this.db
              .prepare("SELECT COUNT(*) AS n FROM changesets WHERE task_id = ? AND state = 'open'")
              .get(taskId) as { n: number }
          ).n
        : 0;
    const pendingMergeNote =
      pendingMerge > 0
        ? `产物在暂存工作区（未合并变更集 ×${pendingMerge}）：到「任务详情 → 变更与产物」点「合并」后才会落到项目根。`
        : null;
    const delivered = notify(this.db, {
      taskId,
      kind,
      dedupeKey: action.actionKey, // 幂等＝动作键（重放/重入不叠卡）
      payload: {
        title,
        shortId,
        card,
        actionKey: action.actionKey,
        ...(question != null ? { question } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(typeof extras.selection === 'string' && extras.selection.length > 0 ? { selection: extras.selection } : {}),
        ...(planSteps.length > 0 ? { planSteps } : {}),
        ...(approvalTldr != null ? { tldr: approvalTldr } : {}),
        ...(typeof extras.employeeId === 'number' ? { employeeId: extras.employeeId } : {}),
        ...(typeof extras.workItemId === 'number' ? { workItemId: extras.workItemId } : {}),
        ...(typeof extras.via === 'string' ? { via: extras.via } : {}),
        ...(typeof extras.permissionKey === 'string' ? { permissionKey: extras.permissionKey } : {}),
        ...(reviewVerdict != null ? { verdict: reviewVerdict } : {}),
        ...(reviewNotes != null ? { notes: reviewNotes } : {}),
        ...(reason != null ? { reason } : {}),
        ...(criticNotes != null ? { body: criticNotes } : {}),
        ...(pendingMergeNote != null ? { body: pendingMergeNote } : {}),
        ...(modelRejected != null ? { modelRejected } : {}),
        ...(alertSummary != null ? { summary: alertSummary } : {}),
      },
      // BRK10/11：员工升级＝紧急（payload.urgent，静默期照推）；异常卡恒紧急。
      urgent: card === 'alert' || extras.urgent === true,
      now: this.now(),
    });

    // BRK10：闸门权限卡的审批行**由闸门侧先建**（`approvalId` 透传）——本路只做真卡回挂，不叠第二行。
    if (approvalId != null) {
      if (delivered.reportId != null) linkApprovalReport(this.db, approvalId, delivered.reportId);
    } else if (question != null) {
      const existing = latestPendingApproval(this.db, taskId);
      if (!existing || existing.question !== question) {
        insertApproval(this.db, {
          taskId,
          reportId: delivered.reportId, // 挂真卡（重放短路时＝既有卡）
          question,
          options,
          // 超时默认动作：仅 L1 计划批准＝'approve'（L2 永不自动；决策卡一律 null＝fail-closed，B6 口径）
          defaultAction: card === 'approval' && task?.risk_level === 1 ? 'approve' : null,
        });
      } else if (existing.report_id == null && delivered.reportId != null) {
        linkApprovalReport(this.db, existing.id, delivered.reportId); // 半程中断/老行补挂（同题同卡，不新建）
      }
    }

    // BRK15：卡片落库回调（`evt:notify`/`evt:inbox` 实时推送的接线点；缺省不推＝渲染层靠下一次拉取）。
    this.config.onCard?.({ taskId, kind, card });
  }

  private applyWorkItemEventInTx(event: EngineEvent, keys: string[]): EngineEvent[] {
    const now = event.ts ?? this.now();
    const wi = getWorkItem(this.db, event.id);
    if (!wi) throw new Error(`[engine] 工作项不存在: ${event.id}`);
    const task = getTaskById(this.db, wi.task_id);

    // OPT-M3-1：未验证不得 done —— L2（强制）/L1（抽验命中）且 verifier 缺失或 = 实现者 → 拒绝
    if (event.event === 'review_accept' && verificationRequired(task?.risk_level ?? 1, wi.id)) {
      if (wi.verifier_employee_id == null || wi.verifier_employee_id === wi.employee_id) {
        throw new Error(
          `[engine] 未验证不得 done（work item ${wi.id}）：需 verifier≠实现者（risk_level=${task?.risk_level ?? '?'}）`,
        );
      }
    }

    const ctx: WorkItemTransitionContext = {
      workItemId: wi.id,
      taskId: wi.task_id,
      attempt: wi.attempt,
      from: wi.state,
      now,
      actor: event.actor ?? 'system',
      payload: event.payload ?? {},
      // B12：`submitted` **不看调用方 payload** —— 由**真实提交事实**决定（工作项已 `submitted` 或有 `result`）。
      submitted: wi.state === 'submitted' || wi.result != null,
      taskState: task?.state as TaskState | undefined,
    };
    const outcome = planWorkItemTransition(ctx, event.event);

    // 员工并发=1 硬守卫（FLOWS §0 第 4 条 / §3.1.2）：任何 → running 的迁移前，若该员工
    // 已有另一个 running work item，直接拒绝（旁路注入事件 / 恢复重放也会被拦，保持 queued）。
    // 正常路径由 core/scheduler 的占用队列在派发前剔除忙员工；本守卫是防绕过的第二道锁。
    if (outcome.to === 'running') {
      const busy = findOtherRunningWorkItem(this.db, wi.employee_id, wi.id);
      if (busy) throw new EmployeeBusyError(wi.employee_id, busy.id, wi.id);
    }

    for (const kind of outcome.kinds) {
      // OPT-M8-2①：失败/中断也留痕并带原因（= 触发事件名）
      const failKind = kind === 'work_item_failed' || kind === 'work_item_interrupted';
      insertTaskEvent(this.db, {
        taskId: wi.task_id,
        workItemId: wi.id,
        ts: now,
        kind,
        actor: ctx.actor,
        payload: failKind ? { ...(event.payload ?? {}), reason: event.event } : (event.payload ?? {}),
      });
    }

    const patch: WorkItemPatch = {};
    if (outcome.to) patch.state = outcome.to;
    if (outcome.to === 'running' && wi.started_at == null) patch.started_at = now;
    if (outcome.to === 'done' || outcome.to === 'failed') patch.finished_at = now;
    if (event.event === 'submit_work_item' && event.payload?.result !== undefined) {
      patch.result = JSON.stringify(event.payload.result);
    }
    // B9：WI transition 的 `patch`（如 retry 的 `attempt+1`）→ 真写库（否则幂等键永远不变 = 静默 no-op）。
    Object.assign(patch, outcome.patch);
    updateWorkItem(this.db, wi.id, patch);

    // BRK-R6：running 件登记/刷新心跳；离开 running 清掉未触发心跳（会话结束/中断/阻塞）。
    if (outcome.to === 'running') {
      heartbeatWorkItem(this.db, { taskId: wi.task_id, workItemId: wi.id, now });
    } else if (outcome.to != null) {
      clearWorkItemHeartbeat(this.db, wi.id);
    }

    // M2-C 第 5 项：提交时把产物写进 `artifacts`（带 `source` 归属；同一事务）
    if (event.event === 'submit_work_item') {
      this.writeSubmittedArtifacts(wi, event, now);
    }

    // M1-4 接缝：工作项**提交即收尾工作区**（不是等任务 done）——否则 verifying 阶段
    // 还没有 changeset，合并/回滚无对象可审（M3 联动审计 F2）。失败/中断也收尾，保留现场。
    if (outcome.to === 'submitted' || outcome.to === 'done' || outcome.to === 'failed' || outcome.to === 'interrupted') {
      this.finishWorkspace(wi.id);
    }

    // MF2（2026-10-19 复查）：retry / rejected→redispatch 直接进 running，不走调度器的
    // `beginWorkspace`；在登记 dispatch 动作前先确保工作区（worktree）存在并解析 cwd。
    if (outcome.to === 'running') this.ensureWorkspace(wi.id);
    // G2：派发时把**任务工作区 cwd**（M1-4 worktree/staging）写进 action payload → 会话按该 cwd 分区。
    const wsCwd = this.workspaceByWorkItem.get(wi.id)?.cwd;
    const actionsToRegister = wsCwd
      ? outcome.actions.map((a) => (a.kind === 'dispatch' ? { ...a, payload: { ...(a.payload ?? {}), cwd: wsCwd } } : a))
      : outcome.actions;
    const registered = registerActions(this.db, actionsToRegister, now);
    keys.push(...registered.registered);

    // 聚合：任务 executing 且全部 work item 已终结/已提交 → 触发 executing→verifying（§3.1.2 联动）
    // D3（链路审计）：条件由「全部 `done`」放宽为「**全部 `done` 或 `submitted`**」——否则 L1/L2 的工作项
    // 在 verifying 之前不会被接受（`review_accept` 在验收 pass 后发）⇒ 永远凑不齐"全部 done"＝死锁。
    const derived: EngineEvent[] = [];
    if ((outcome.to === 'done' || outcome.to === 'submitted') && task && task.state === 'executing') {
      const items = listWorkItemsByTask(this.db, wi.task_id);
      if (items.length > 0 && items.every((it) => it.state === 'done' || it.state === 'submitted')) {
        // D3：把"有没有件需要验证"随事件带给状态机（决定是否派 verifier 会话；见 statemachine 该行注释）
        const risk = (task.risk_level ?? 1) as number;
        // DOC-4：挂了机器检查的任务**必须**走 verifier（L1 未抽验也不能自动 pass）。
    const verificationNeeded = hasMachineAcceptance(task?.acceptance) || items.some((it) => verificationRequired(risk, it.id));
        derived.push({
          scope: 'task',
          id: wi.task_id,
          event: 'all_work_items_done',
          actor: 'system',
          payload: { verificationNeeded },
        });
      }
    }
    // D3-A（链路审计）：**L0（免验）提交即自动接受**（`verificationRequired=false`）——
    // 否则 L0 的件停在 `submitted`，任务永远到不了 verifying/done。
    if (
      outcome.to === 'submitted' &&
      !verificationRequired(task?.risk_level ?? 1, wi.id) &&
      !hasMachineAcceptance(task?.acceptance)
    ) {
      derived.push({ scope: 'work_item', id: wi.id, event: 'review_accept', actor: 'system' });
    }
    // BRK2（挂载 1 余）：**失败聚合**——件进 `failed`，任务不得永停 `executing`（无卡、无后续）。
    // FLOWS §3.1.2 L298：「任务 `executing` 时，关键 work item `failed` 且无重试路径 → 任务 `executing → failed`
    // 或经 `needs_decision` 问你」——v1 取前者（派生任务级 `fail` ⇒ 任务机 `executing --fail--> failed`
    // 出**异常卡**〔`notify_alert`〕）；多件部分失败/自动重试路径留后续件（v1＝1 任务 1 件）。
    if (outcome.to === 'failed' && task && task.state === 'executing') {
      // B0-3（ADV-1 G3）：**运行时错误**（event=error：会话超时/连接失败等）自动重试，落盘会话可续跑；
      // 业务失败（agent_settled 未提交）照旧判死——不掩盖员工没干活。重试用尽才任务 failed 出卡。
      // B2-3/D-30②：失败粒度=单件——业务失败（agent_settled 未提交）与运行时错误同口径
      // 单件 attempt+1 重派；重试耗尽才任务 failed（B0-3 的「业务失败照旧判死」被 D-30 推翻；
      // 重试全程 attempt/事件留痕，不掩盖员工没干活）。
      const canRetry = wi.attempt < this.autoRetryLimit;
      if (canRetry) {
        derived.push({
          scope: 'work_item',
          id: wi.id,
          event: 'retry',
          actor: 'system',
          payload: { via: 'auto_retry', attempt: wi.attempt + 1, reason: event.payload?.reason ?? null },
        });
      } else {
        derived.push({
          scope: 'task',
          id: wi.task_id,
          event: 'fail',
          actor: 'system',
          payload: { reason: 'work_item_failed', workItemId: wi.id, detail: event.payload?.reason ?? null },
        });
      }
    }
    return derived;
  }

  // ───────────────────────── 调度 fixpoint（DEV §5） ─────────────────────────

  private buildSchedulerInput(): SchedulerInput {
    const rows = listWorkItems(this.db);
    const deps = new Map<number, number[]>();
    for (const r of this.db.prepare('SELECT task_id, depends_on FROM task_deps').all() as {
      task_id: number;
      depends_on: number;
    }[]) {
      const list = deps.get(r.task_id) ?? [];
      list.push(r.depends_on);
      deps.set(r.task_id, list);
    }
    // B2-3/D-30②：工作项依赖边（调度门控用；空表 → 空 Map，无门控）。
    const workItemDeps = new Map<number, number[]>();
    for (const r of this.db.prepare('SELECT work_item_id, depends_on FROM work_item_deps').all() as Array<{
      work_item_id: number;
      depends_on: number;
    }>) {
      const list = workItemDeps.get(r.work_item_id) ?? [];
      list.push(r.depends_on);
      workItemDeps.set(r.work_item_id, list);
    }
    return {
      now: this.now(),
      config: this.schedulerConfig,
      tasks: listTaskSnapshots(this.db),
      workItems: rows.map(toWorkItemSnapshot),
      deps,
      workItemDeps,
      runningByEmployee: runningByEmployee(this.db),
    };
  }

  /** 反复 planScheduling 并应用决议，直到无新决议（fixpoint）。 */
  private runSchedulingFixpoint(keys: string[]): void {
    // M1-2：本轮已派发（用于同轮内的路径相交去重）
    const dispatchedThisBatch: PathClaim[] = [];
    // N2：**每轮规划开头**评估速率档位（回落也在这里复位——**不粘滞**）
    this.rateTierChanged = false;
    this.lastRateTier = this.evaluateRateGate();
    for (let i = 0; i < 1000; i += 1) {
      const actions = planScheduling(this.buildSchedulerInput());
      // BRK14：任务级 hold 入库（每拍重建——与调度器同拍；三类排队原因由此能上屏）
      this.taskHolds.clear();
      for (const h of actions) {
        if (h.type !== 'hold') continue;
        const detail =
          h.reason === 'no_slot'
          ? '无可用槽位'
          : h.reason === 'budget'
            ? '超预算（budget_tokens）'
            : h.reason === 'employee_busy'
              ? '员工正忙'
              : h.reason === 'dependency'
                ? '前置工作项未完成（B2-3 依赖门控）'
                : undefined;
        this.taskHolds.set(h.taskId, {
          reason: h.reason,
          ...(detail ? { detail } : {}),
          ...(h.occupiedBy != null ? { occupiedBy: h.occupiedBy } : {}),
        });
      }
      const actionable = actions.filter((a) => a.type !== 'hold');
      if (actionable.length === 0) break;
      let applied = false;
      for (const action of actionable) {
        if (action.type === 'start_task') {
          this.applyTaskEventInTx({ scope: 'task', id: action.taskId, event: 'start_task', actor: 'system' }, keys);
          applied = true;
        } else if (action.type === 'block_task') {
          // D4：ready 但依赖未满足 → 真进 blocked（不占槽位）；依赖完成后 activate_task 回 ready。
          this.applyTaskEventInTx(
            { scope: 'task', id: action.taskId, event: 'block', actor: 'system', payload: { reason: action.reason } },
            keys,
          );
          applied = true;
        } else if (action.type === 'activate_task') {
          this.applyTaskEventInTx({ scope: 'task', id: action.taskId, event: 'task_activated', actor: 'system' }, keys);
          applied = true;
        } else if (action.type === 'advance_parent') {
          this.applyTaskEventInTx(
            { scope: 'task', id: action.taskId, event: 'all_work_items_done', actor: 'system' },
            keys,
          );
          applied = true;
        } else if (action.type === 'dispatch_work_item') {
          // C4：公司日预算达线 → 新派发 hold（在跑任务由 enforce 暂停；不在这里硬打断）
          const companyBudgetDetail = this.companyDailyBudgetHold();
          if (companyBudgetDetail) {
            this.pathHolds.set(action.workItemId, { reason: 'budget', conflictsWith: [], detail: companyBudgetDetail });
            continue;
          }
          // B0-11：任务预算不足 → **派发前 hold**（件保持 queued、等待原因可见）＋一次决策卡。
          // 放在这里（fixpoint，事务内）而不是执行器里：先于 running 迁移，避免「件 running 但会话没开」挂死。
          const taskBudgetGap = this.budgetPrecheckInsufficient(
            getWorkItem(this.db, action.workItemId)?.task_id ?? 0,
          );
          if (taskBudgetGap) {
            this.pathHolds.set(action.workItemId, {
              reason: 'budget',
              conflictsWith: [],
              detail: `预算不足：已用 ${taskBudgetGap.cost} / 上限 ${taskBudgetGap.budget} token`,
            });
            const budgetTaskId = getWorkItem(this.db, action.workItemId)?.task_id ?? 0;
            const budgetTask = budgetTaskId > 0 ? getTaskById(this.db, budgetTaskId) : undefined;
            if (budgetTask?.state === 'executing') {
              this.applyDerivedInTx(
                [
                  {
                    scope: 'task',
                    id: budgetTaskId,
                    event: 'escalate',
                    actor: 'system',
                    payload: {
                      reason: 'budget_insufficient',
                      question:
                        `预算不足（执行前检查）：已用 ${taskBudgetGap.cost} / 上限 ${taskBudgetGap.budget} token，` +
                        `剩余 ${taskBudgetGap.remaining} 不够一次执行。请加预算后点「已加预算，重试执行」，或取消任务。`,
                      options: [
                        { key: 'retry', label: '已加预算，重试执行' },
                        { key: 'cancel', label: '取消任务' },
                      ],
                      urgent: true,
                    },
                  },
                ],
                keys,
              );
            }
            continue;
          }
          // N2 速率闸门：超"排队线" → **新派发 hold**（在跑任务不打断；降档已在装配期生效）
          if (this.lastRateTier === 'hold') {
            const wasHeld = this.pathHolds.get(action.workItemId)?.reason === 'rate_limit';
            this.pathHolds.set(action.workItemId, {
              reason: 'rate_limit',
              conflictsWith: [],
              // R3-2：等待原因带数字（决策点直给；UI 不需要猜阈值）
              detail: describeRateLimit(this.usdPerHour(), this.rateLimits),
            });
            if (!wasHeld) { // 首次拦截**该件**留痕一次（不按轮次刷屏）
              insertTaskEvent(this.db, {
                taskId: getWorkItem(this.db, action.workItemId)?.task_id ?? 0,
                workItemId: action.workItemId,
                ts: this.clock(),
                kind: 'rate_limited',
                actor: 'system',
                payload: { tier: 'hold', usdPerHour: this.usdPerHour(), softUsdPerHour: this.rateLimits.softUsdPerHour, hardUsdPerHour: this.rateLimits.hardUsdPerHour },
              });
            }
            continue;
          }
          // N3(P20/P22) 并发闸门：超上限 → **新派发排队**（在跑任务不打断）；R3-2：把「哪一层满了」带进 detail
          const concurrencyDetail = this.concurrencyBlockReason(action.workItemId);
          if (concurrencyDetail) {
            this.pathHolds.set(action.workItemId, { reason: 'concurrency_limit', conflictsWith: [], detail: concurrencyDetail });
            continue;
          }
          // M1-2：同一 root_dir 内路径相交 → 不并行派发（hold + 原因）
          // B2-4：候选认领＝实测 ∪ 返工血缘（seedClaimPaths）；无实测不凭空拦。
          const seededClaim = getWorkItemPathClaim(this.db, action.workItemId);
          const candidate = seededClaim ? { ...seededClaim, paths: this.seedClaimPaths(action.workItemId) } : null;
          const occupied = [...listRunningPathClaims(this.db), ...dispatchedThisBatch];
          const conflicts = candidate ? pathConflictWith(candidate, occupied) : [];
          if (conflicts.length > 0) {
            this.pathHolds.set(action.workItemId, { reason: 'path_conflict', conflictsWith: conflicts });
            continue;
          }
          this.pathHolds.delete(action.workItemId);
          this.applyWorkItemEventInTx(
            { scope: 'work_item', id: action.workItemId, event: 'dispatch', actor: 'system' },
            keys,
          );
          if (candidate) dispatchedThisBatch.push(candidate);
          applied = true;
      // M1-4 接缝：仅在提供 git 时解析工作目录（inplace 默认不建 worktree）
      if (this.git) this.ensureWorkspace(action.workItemId);
        }
      }
      if (!applied) break;
    }
  }

  /**
   * N3(P20/P22)：并发闸门——返回 hold 理由（公司级优先，其次任务内），不超则 undefined。
   * 计数口径＝**正在跑（running）的 work item 数**（本批已派发的在同一事务内可见，无需另记）。
   * **幕僚长不持 work item ⇒ 天然不受约束**（"同一任务内 agent ≤3、除幕僚长"即此）。
   */
  private concurrencyBlockReason(workItemId: number): string | undefined {
    const wi = getWorkItem(this.db, workItemId);
    if (!wi) return undefined;
    const company = countRunningWorkItems(this.db);
    if (company >= this.concurrency.maxCompany) return "公司级并发已达上限 " + this.concurrency.maxCompany;
    const row = this.db.prepare('SELECT max_parallel_work_items AS cap FROM tasks WHERE id = ?').get(wi.task_id) as { cap: number | null } | undefined;
    const cap = row?.cap ?? this.concurrency.maxPerTask;
    const inTask = countRunningWorkItems(this.db, { taskId: wi.task_id });
    if (inTask >= cap) return "同任务并发已达上限 " + cap;
    return undefined;
  }

  /**
   * R3-2：顶栏「槽位 x/y」（**任务级活跃槽位**；占用/上限——与 UI §1「槽位占用（x/3）」一致）。
   * 真读数：正在 `executing` 的任务数（空库＝0/3 也如实；引擎缺失时 ipc 层回 `null` → UI 显 `—`）。
   */
  /**
   * B3-5/D-31：任务 done 后 LLM 抽取记忆候选（异步 fire-and-forget）。
   * 材料＝任务目标＋参与者提交摘要；候选写 provisional（老板确认才进 brief）；
   * 失败/无 Key → 落 `memory_extract_failed` 事件（有 Key 时）或不留痕（无 Key＝未配置，正常态）。
   */
  private async extractMemoryCandidatesFor(taskId: number): Promise<void> {
    try {
      const { extractMemoryCandidates, writeCandidatesAsProvisional, memoryExtractKeyAvailable } = await import(
        '../agent/memory-extract.js',
      );
      if (!memoryExtractKeyAvailable()) return; // 未配置 Key＝正常态，不留痕
      const task = getTaskById(this.db, taskId) as { goal?: string; title?: string; project_id?: number | null } | undefined;
      if (!task) return;
      const items = listWorkItemsByTask(this.db, taskId);
      const summaries = items
        .map((w) => {
          try {
            const r = JSON.parse(w.result ?? 'null') as { summary?: unknown } | string | null;
            const summary = typeof r === 'string' ? r : (r?.summary ?? '');
            return typeof summary === 'string' ? summary : '';
          } catch {
            return '';
          }
        })
        .filter((s) => s.trim().length > 0)
        .join('\n');
      const text = `${task.title ?? ''}\n${task.goal ?? ''}\n${summaries}`.trim();
      if (text.length === 0) return;
      const candidates = await extractMemoryCandidates({ text });
      if (candidates.length === 0) {
        insertTaskEvent(this.db, {
          taskId,
          ts: this.now(),
          kind: 'memory_extract_failed',
          actor: 'system',
          payload: { reason: 'no_candidates_or_error' },
        });
        return;
      }
      const written = await writeCandidatesAsProvisional(
        new SqliteMemoryStore(this.db),
        { taskId, projectId: task.project_id ?? null, candidates, now: this.now() },
      );
      insertTaskEvent(this.db, {
        taskId,
        ts: this.now(),
        kind: 'memory_extracted',
        actor: 'system',
        payload: { candidates: candidates.length, written },
      });
    } catch (error) {
      try {
        insertTaskEvent(this.db, {
          taskId,
          ts: this.now(),
          kind: 'memory_extract_failed',
          actor: 'system',
          payload: { reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) },
        });
      } catch (writeError) {
        console.error('[engine] memory_extract_failed 留痕写入失败（不静默）', writeError);
      }
    }
  }

  /**
   * B2-4/D-30：路径所有权**执行期实测**登记（采集器在工具调用执行前调用）。
   * 内存 ws.touched（本件提交白名单用）∪ DB brief（running 认领/崩溃恢复用）；不抛（采集不反噬会话）。
   */
  recordWorkItemTouchedPaths(workItemId: number, paths: string[]): void {
    const ws = this.workspaceByWorkItem.get(workItemId);
    const normalized = paths
      .map((p) => {
        // 绝对路径 → 相对项目根（ws.rootDir）；相对路径原样（`'.'` 整树保留）。
        if (ws != null && (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p))) {
          const norm = p.replace(/\\/g, '/');
          const root = ws.rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
          return norm.toLowerCase().startsWith(root.toLowerCase() + '/') ? norm.slice(root.length + 1) : '.';
        }
        return p;
      })
      .filter((p) => p.length > 0);
    if (normalized.length === 0) return;
    if (ws) ws.touched = [...new Set([...ws.touched, ...normalized])];
    try {
      setWorkItemTouchedPaths(this.db, workItemId, normalized);
    } catch (error) {
      console.error('[engine] 实测路径落库失败（内存认领已更新）', error);
    }
  }

  /** B2-4：候选件的派发冲突判定（实测认领 ∩ 在跑认领；引擎动作同口径，供测试/UI 复用）。 */
  pathConflictsFor(workItemId: number): number[] {
    const candidate = getWorkItemPathClaim(this.db, workItemId);
    if (!candidate) return [];
    const wi = getWorkItem(this.db, workItemId);
    const occupied = listRunningPathClaims(this.db).filter((c) => c.workItemId !== workItemId);
    const conflicts = pathConflictWith(candidate, occupied);
    void wi;
    return conflicts;
  }

  /**
   * B2-4：派发认领构造——实测路径（brief JSON）∪ 返工血缘源件实测（retry_of；
   * 重启/重试不丢已测事实）。无认领 → 空（派发不凭空拦）。
   */
  seedClaimPaths(workItemId: number): string[] {
    const wi = getWorkItem(this.db, workItemId);
    if (!wi) return [];
    const own = parseTouchedPaths(wi.brief) ?? [];
    if (wi.retry_of == null) return own;
    const src = getWorkItem(this.db, wi.retry_of);
    const srcPaths = src != null ? (parseTouchedPaths(src.brief) ?? []) : [];
    return [...new Set([...srcPaths, ...own])];
  }

  schedulerSlots(): { running: number; total: number } {
    const row = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE state = 'executing'").get() as { n: number };
    const total = this.schedulerConfig.maxActiveTasks;
    return { running: row?.n ?? 0, total };
  }

  /** 最近 1 小时美元额（速率闸门的唯一读数源；禁抄第二遍）。 */
  private usdPerHour(): number {
    return usdInWindow(this.db, { windowMs: 3_600_000, now: this.clock() });
  }

  /**
   * N2：评估速率档位并**只在切换时留痕**；返回本轮档位。
   *  - `economy`：切省钱档（**装配期生效**）＋ 在该任务上写 `rate_limited` 事件（可审计）；
   *  - `hold`：调用方把该 work item 置为 `rate_limit` 等待（**在跑任务不打断**）；
   *  - 回落：低于降档线即复位（**不粘滞**），同样留痕。
   */
  private evaluateRateGate(): RateTier {
    const usd = this.usdPerHour();
    const tier = rateAction(usd, this.rateLimits);
    if (tier !== this.lastRateTier) {
      this.lastRateTier = tier;
      setEconomyMode(tier !== 'ok');
      const detail = describeRateLimit(usd, this.rateLimits);
      console.error(`[rate] 档位 → ${tier}：${detail}`); // 静默风险显式（P6）
      this.rateTierChanged = true;
    }
    return tier;
  }

  /** M1-2：因路径冲突被 hold 的派发（返回原因/冲突对象；R3-2 起带 `detail`；不存在则 undefined）。 */
  dispatchHold(workItemId: number): { reason: WaitingReason; conflictsWith: number[]; detail?: string } | undefined {
    return this.pathHolds.get(workItemId);
  }

  /** BRK14：派发等待读数（WI 级三条 ＋ 任务级三条）——UI「为什么排队」的数据源（`computeWaits`）。 */
  listDispatchHolds(): Array<{
    workItemId: number | null;
    taskId: number;
    reason: WaitingReason;
    conflictsWith: number[];
    detail?: string;
  }> {
    return [
      ...[...this.pathHolds.entries()].map(([workItemId, v]) => ({
        workItemId,
        taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
        ...v,
      })),
      ...[...this.taskHolds.entries()].map(([taskId, v]) => ({
        workItemId: null,
        taskId,
        // MP1-3：employee_busy 的占用件作为 conflictsWith 上屏（computeWaits 会换算成任务短号）
        conflictsWith: v.occupiedBy != null ? [v.occupiedBy] : ([] as number[]),
        ...v,
      })),
    ];
  }

  // ───────────────────── M1-4 接缝：工作目录 + 路径白名单提交 ─────────────────────

  /** 幂等：已解析过工作区就复用（正常调度在 apply 内已建，调度器循环再调不重复开 scope/检查点）。 */
  private ensureWorkspace(workItemId: number): void {
    if (this.workspaceByWorkItem.has(workItemId)) return;
    this.beginWorkspace(workItemId);
  }

  private beginWorkspace(workItemId: number): void {
    const wi = getWorkItem(this.db, workItemId);
    if (!wi) return;
    const task = getTaskById(this.db, wi.task_id);
    if (!task) return;
    const proj = this.db
      .prepare('SELECT root_dir, access_mode FROM projects WHERE id = ?')
      .get(task.project_id) as { root_dir: string; access_mode: string } | undefined;
    if (!proj) return;
    const shortId = task.short_id ?? `task-${task.id}`;
    // BRK22 加固（2026-10-16）：工作区解析失败（如 staging 项目根不是 git 仓）**不得炸派发**——
    // 响亮留痕并回退项目根（与 inplace 同形；产物来源/指纹尽量照落，不谎报 worktree）。
    let ws: { cwd: string; worktree: { path: string; branch: string } | null };
    try {
      ws = resolveTaskWorkspace({
        repoRoot: proj.root_dir,
        shortId,
        accessMode: proj.access_mode,
        worktreesBaseDir: this.worktreesBaseDir,
        git: this.git,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[engine] 工作区解析失败（work item ${workItemId}，access_mode=${proj.access_mode}）：` +
          `${message}——回退项目根`,
      );
      insertTaskEvent(this.db, {
        taskId: task.id,
        workItemId,
        ts: this.now(),
        kind: 'action_failed',
        actor: 'system',
        payload: { action: 'workspace', reason: `工作区解析失败（${proj.access_mode}）：${message}——已回退项目根，检查点/合并不可用` },
      });
      ws = { cwd: proj.root_dir, worktree: null };
    }
    // M3-N-2（GAP4）：staging 工作项派发即记检查点（base_sha = 工作项开始前的 HEAD）。
    // 失败只留日志、不阻塞派发；真正回滚前还会核对分支/祖先/脏路径。
    if (proj.access_mode === 'staging' && ws.worktree && this.git) {
      try {
        const head = this.git.run(['rev-parse', 'HEAD'], ws.cwd);
        if (head.status === 0 && head.stdout.trim()) {
          const checkpoint = insertCheckpoint(this.db, {
            taskId: task.id,
            workItemId,
            attempt: wi.attempt,
            branch: ws.worktree.branch,
            baseSha: head.stdout.trim(),
            worktreePath: ws.cwd,
            now: this.now(),
          });
          if (checkpoint.created) {
            insertTaskEvent(this.db, {
              taskId: task.id,
              workItemId,
              ts: this.now(),
              kind: 'checkpoint_created',
              actor: 'system',
              payload: {
                checkpointId: checkpoint.row.id,
                baseSha: checkpoint.row.base_sha,
                branch: checkpoint.row.branch,
              },
            });
          }
        }
      } catch (error) {
        console.error(
          `[engine] 检查点写入失败（work item ${workItemId}）：${error instanceof Error ? error.message : String(error)}——回滚将对本件不可用`,
        );
      }
    }
    // UG-04b：staging 的员工 cwd＝worktree，项目根 `inputs/` 在 worktree 外；镜像进来并把
    // `inputs/` 写进该 worktree 的 info/exclude，避免输入附件被自动提交进变更集。
    if (proj.access_mode === 'staging' && ws.worktree) {
      try {
        const mirrored = mirrorTaskInputs({
          projectRoot: proj.root_dir,
          worktreePath: ws.cwd,
          shortId,
          git: this.git,
        });
        if (mirrored.warnings.length > 0) {
          insertTaskEvent(this.db, {
            taskId: task.id,
            workItemId,
            ts: this.now(),
            kind: 'action_failed',
            actor: 'system',
            payload: { action: 'input_mirror', reason: mirrored.warnings.join('；') },
          });
        }
      } catch (error) {
        insertTaskEvent(this.db, {
          taskId: task.id,
          workItemId,
          ts: this.now(),
          kind: 'action_failed',
          actor: 'system',
          payload: {
            action: 'input_mirror',
            reason: `输入附件镜像失败：${error instanceof Error ? error.message : String(error)}`,
          },
        });
      }
    }
    // B2-4/D-30：认领＝实测（brief JSON）∪ 返工血缘源件实测（重启/重试不丢已测事实）。
    const touched = this.seedClaimPaths(workItemId);
    // staging 是任务独占 worktree ⇒ 工作区里的改动都属于本件；inplace 是共享工作区，
    // 只有派发前干净时才允许按路径白名单自动提交（否则可能把老板在制改动卷进去）。
    const baselineClean =
      proj.access_mode === 'staging' ? true : this.git ? !hasWorkingTreeChanges(this.git, ws.cwd) : false;
    this.workspaceByWorkItem.set(workItemId, {
      cwd: ws.cwd,
      rootDir: proj.root_dir,
      accessMode: proj.access_mode,
      shortId,
      touched,
      employeeId: wi.employee_id,
      attempt: wi.attempt,
      baselineClean,
    });
    // 2026-10-19 staging 真机：dispatch 动作在 `beginWorkspace` 之前登记，payload 里还没有 cwd；
    // 员工因此落到项目根写文件，worktree 保持干净 → changeset base=head/files=0。
    // 工作区解析出来后把 cwd 回填到本条 pending 动作，员工会话才会在 staging worktree 里干活。
    const dispatchKey = `dispatch:work_item:${workItemId}:${wi.attempt}`;
    const actionRow = this.db
      .prepare('SELECT payload FROM action_log WHERE action_key = ?')
      .get(dispatchKey) as { payload: string } | undefined;
    if (actionRow) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(actionRow.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      this.db
        .prepare('UPDATE action_log SET payload = ? WHERE action_key = ?')
        .run(JSON.stringify({ ...payload, cwd: ws.cwd }), dispatchKey);
    }
    this.effectScopes?.open({
      sessionKey: `wi:${workItemId}`,
      employeeId: wi.employee_id,
      workItemId,
      attempt: wi.attempt,
      taskId: wi.task_id,
      tempDir: ws.cwd,
      pidTree: [],
    });
  }

  private finishWorkspace(workItemId: number): void {
    const ctx = this.workspaceByWorkItem.get(workItemId);
    if (!ctx) return;
    // B0-12：提交信息带语义摘要（员工 submit_work_item.summary）；没有就明说，不用模板占位。
    const finishWi = getWorkItem(this.db, workItemId);
    const finishTask = finishWi ? getTaskById(this.db, finishWi.task_id) : undefined;
    const commitMessage = workItemCommitMessage({
      shortId: ctx.shortId,
      title: finishTask?.title ?? finishWi?.title ?? null,
      summary: summaryFromWorkItemResult(finishWi?.result),
      workItemId,
    });
    if (this.git && ctx.accessMode === 'staging') {
      // M1-4 的硬约束保留：有显式 `touched_paths`/产物白名单时只提交白名单。
      // 真实 planner 产出的工作项是纯文本 brief（白名单为空）——此时 staging 是任务独占 worktree，
      // 按工作区真实改动提交，不再因 `touched=[]` 跳过提交（M3 联动审计 P0-1 的根因）。
      // F-03（2026-10-24）：白名单先与真实 diff 对账——员工可能漏报锁文件、或把 gitignored 产物
      // （如 `out/*.png`）报进来导致 `git add` 整条失败；staging 是独占工作区，过滤后为空则提交全部。
      const changed = listChangedPaths(this.git, ctx.cwd);
      const actual = changed.ok ? changed.paths : null;
      let paths = ctx.touched;
      if (actual) {
        const whitelist = ctx.touched.filter((p) => actual.includes(p));
        paths = [...new Set([...whitelist, ...actual.filter(isLockfilePath)])];
      }
      const committed =
        ctx.touched.length > 0 && paths.length > 0
          ? commitPaths(this.git, ctx.cwd, paths, commitMessage)
          : commitAll(this.git, ctx.cwd, commitMessage);
      if (!committed.committed && committed.detail !== 'no changes' && committed.detail !== 'empty paths') {
        insertTaskEvent(this.db, {
          taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
          workItemId,
          ts: this.now(),
          kind: 'action_failed',
          actor: 'system',
          payload: { action: 'auto_commit', reason: committed.detail },
        });
      }
    } else if (this.git && ctx.accessMode === 'inplace' && hasWorkingTreeChanges(this.git, ctx.cwd)) {
      // inplace = 共享工作区：只在「派发前干净 + 本次有明确路径白名单」时提交，
      // 避免把老板在制改动卷进任务提交。无白名单/基线不干净 ⇒ 不提交并如实留痕。
      // F-03（2026-10-24）：白名单先与真实 diff 对账，过滤 gitignored/不存在路径；锁文件自动纳入。
      if (ctx.baselineClean && ctx.touched.length > 0) {
        const changed = listChangedPaths(this.git, ctx.cwd);
        const actual = changed.ok ? changed.paths : null;
        const paths = actual
          ? [...new Set([...ctx.touched.filter((p) => actual.includes(p)), ...actual.filter(isLockfilePath)])]
          : ctx.touched;
        if (paths.length === 0) {
          insertTaskEvent(this.db, {
            taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
            workItemId,
            ts: this.now(),
            kind: 'action_failed',
            actor: 'system',
            payload: {
              action: 'auto_commit',
              reason: '产物白名单与真实改动无交集（可能只含 gitignored/未落盘路径），未自动提交；改动仍在工作区',
            },
          });
        } else {
          const committed = commitPaths(this.git, ctx.cwd, paths, commitMessage);
          if (!committed.committed) {
            insertTaskEvent(this.db, {
              taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
              workItemId,
              ts: this.now(),
              kind: 'action_failed',
              actor: 'system',
              payload: { action: 'auto_commit', reason: committed.detail },
            });
          }
        }
      } else {
        insertTaskEvent(this.db, {
          taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
          workItemId,
          ts: this.now(),
          kind: 'action_failed',
          actor: 'system',
          payload: {
            action: 'auto_commit',
            reason: ctx.baselineClean
              ? '本次未登记产物路径（touched_paths 为空），未自动提交；改动仍在工作区'
              : '派发前工作区已有未提交改动，未自动提交（避免卷入老板在制改动）',
          },
        });
      }
    }
    // M3-N-2（GAP4）：完成提交后补检查点 head 与真实改动路径（base..head）。
    if (ctx.accessMode === 'staging' && this.git) {
      try {
        const checkpoint = getCheckpointForAttempt(this.db, workItemId, ctx.attempt);
        if (checkpoint && checkpoint.state === 'open' && checkpoint.base_sha) {
          const head = this.git.run(['rev-parse', 'HEAD'], ctx.cwd);
          const headSha = head.status === 0 ? head.stdout.trim() : null;
          const paths =
            headSha != null
              ? this.git
                  .run(['diff', '--name-only', '--no-renames', checkpoint.base_sha, headSha], ctx.cwd)
                  .stdout.split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
              : [];
          finishCheckpoint(this.db, { checkpointId: checkpoint.id, headSha, paths });
        }
      } catch (error) {
        console.error(
          `[engine] 检查点收尾失败（work item ${workItemId}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // M2-C 第 5 项：**真写** changeset（staging 提交后按 numstat 汇总）+ 回挂产物。
    // 注：只对 `staging` 写（`inplace` 无任务分支 ⇒ changesets 的 branch/base/head 语义不成立；M0 默认行为不变）。
    if (ctx.accessMode === 'staging') {
      this.writeChangesetForWorkItem(workItemId, ctx);
    }
    if (ctx.accessMode === 'staging') {
      const cleanup = cleanupMirroredInputs(ctx.cwd, ctx.shortId);
      if (cleanup.error) {
        insertTaskEvent(this.db, {
          taskId: getWorkItem(this.db, workItemId)?.task_id ?? 0,
          workItemId,
          ts: this.now(),
          kind: 'action_failed',
          actor: 'system',
          payload: { action: 'input_cleanup', reason: `输入附件镜像清理失败：${cleanup.error}` },
        });
      }
    }
    this.effectScopes?.reclaim(effectScopeKey({ employeeId: ctx.employeeId, workItemId, attempt: ctx.attempt }), 'release');
    this.workspaceByWorkItem.delete(workItemId);
  }

  /**
   * M2-C 第 5 项：把 work item 的这次提交写成一条 `changesets`（+ 每文件行）并回挂其产物。
   *
   * - **写点**：`finishWorkspace()`（staging 提交后）；`inplace` 也写（无提交则 numstat 为空 ⇒ 0/0/0，仍留痕）。
   * - **幂等**：`UNIQUE(work_item_id, head_sha)`（`003`）+ `INSERT OR IGNORE` ⇒ 重放/重复完成不写第二条。
   * - **失败不阻塞终态**：任何 git/DB 异常 → `action_failed` 留痕 + `console.error`，工作项照常进终态。
   */
  private writeChangesetForWorkItem(
    workItemId: number,
    ws: { cwd: string; rootDir: string; accessMode: string; shortId: string; employeeId: number; attempt: number },
  ): void {
    const git = this.git;
    if (!git) return;
    try {
      const head = git.run(['rev-parse', 'HEAD'], ws.cwd);
      const headSha = head.status === 0 ? head.stdout.trim() : null;
      const baseSha = this.resolveBaseSha(ws.cwd);
      // 硬要求（#3476）：**基准解析不到 ⇒ 不得拿猜的基准充当 diff**（空态不伪装同族）。
      // 做法：`files_changed/insertions/deletions` 全部 0、不写 `changeset_files`，`action_failed` 留痕；
      // `state='open'` 照写（消费侧用 `base_sha IS NULL` 显式显示「基准未知」）。
      const baseUnknown = baseSha == null || headSha == null;
      const { files, insertions, deletions } = baseUnknown
        ? { files: [], insertions: 0, deletions: 0 }
        : this.numstat(git, ws.cwd, baseSha, headSha);
      const wi = getWorkItem(this.db, workItemId);
      if (!wi) return;
      if (baseUnknown) {
        insertTaskEvent(this.db, {
          taskId: wi.task_id,
          workItemId,
          ts: this.now(),
          kind: 'action_failed',
          actor: 'system',
          payload: {
            action: 'changeset_base_sha',
            reason: 'base_sha 未知（merge-base 解析失败）—— 不展示猜测的 diff',
            baseUnknown: true,
          },
        });
      }
      const created = insertChangeset(this.db, {
        taskId: wi.task_id,
        workItemId,
        branch: `aico/${ws.shortId}`,
        baseSha,
        headSha,
        filesChanged: files.length,
        insertions,
        deletions,
        // B0-12：员工提交摘要（≤200 字）；无摘要写明文件数，不再写空串。
        summary: changesetSummary({ summary: summaryFromWorkItemResult(wi.result), filesChanged: files.length }),
        commitMsg: null,
        state: 'open',
        now: this.now(),
      });
      if (!created.created) return; // 幂等：同 (wi, head_sha) 已写过 ⇒ 不重写文件行
      for (const f of files) {
        insertChangesetFile(this.db, {
          changesetId: created.row.id,
          path: f.path,
          status: f.status,
          insertions: f.insertions,
          deletions: f.deletions,
          employeeId: ws.employeeId,
        });
      }
      linkArtifactsToChangeset(this.db, workItemId, created.row.id);
      insertTaskEvent(this.db, {
        taskId: wi.task_id,
        workItemId,
        ts: this.now(),
        kind: 'changeset_created',
        actor: 'system',
        payload: { changesetId: created.row.id, headSha, baseSha, filesChanged: files.length, baseUnknown },
      });
    } catch (error) {
      // 失败要留痕、不静默；**不得**阻塞 work item 终态
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[engine] changeset 写入失败（work item ${workItemId}）：${msg}`);
      try {
        const wi = getWorkItem(this.db, workItemId);
        if (wi) {
          insertTaskEvent(this.db, {
            taskId: wi.task_id,
            workItemId,
            ts: this.now(),
            kind: 'action_failed',
            actor: 'system',
            payload: { action: 'changeset_write', reason: msg },
          });
        }
      } catch {
        // 连留痕都失败 ⇒ 只留控制台（不抛，保持不阻塞）
      }
    }
  }

  /** `base_sha` 现算（不强依赖新存储）：`symbolic-ref origin/HEAD` → `main` → `master`；都不行 → null。 */
  private resolveBaseSha(cwd: string): string | null {
    const git = this.git;
    if (!git) return null;
    const candidates: string[] = [];
    const sym = git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (sym.status === 0 && sym.stdout.trim()) candidates.push(sym.stdout.trim());
    candidates.push('main', 'master');
    for (const base of candidates) {
      const res = git.run(['merge-base', base, 'HEAD'], cwd);
      if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
    }
    console.warn(`[engine] 无法解析 base_sha（cwd=${cwd}）—— changeset.base_sha 置 NULL`);
    return null;
  }

  /** `git diff --numstat <base>..<head>`（**只在 base+head 都有时才算**；基准未知时不猜）。 */
  private numstat(
    git: import('../git/index.js').GitRunner,
    cwd: string,
    baseSha: string,
    headSha: string,
  ): { files: Array<{ path: string; status: string; insertions: number; deletions: number }>; insertions: number; deletions: number } {
    const range = `${baseSha}..${headSha}`;
    const res = git.run(['diff', '--numstat', range], cwd);
    if (res.status !== 0) return { files: [], insertions: 0, deletions: 0 };
    const statusRes = git.run(['diff', '--name-status', range], cwd);
    const statusByPath = new Map<string, string>();
    if (statusRes.status === 0) {
      for (const line of statusRes.stdout.split('\n')) {
        const [code, p] = line.split('\t');
        if (code && p) statusByPath.set(p.trim(), code.trim());
      }
    }
    const files: Array<{ path: string; status: string; insertions: number; deletions: number }> = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of res.stdout.split('\n')) {
      const [ins, del, path] = line.split('\t');
      if (!path || ins == null || del == null) continue;
      const i = ins === '-' ? 0 : Number(ins);
      const d = del === '-' ? 0 : Number(del);
      insertions += i;
      deletions += d;
      const code = statusByPath.get(path.trim()) ?? 'M';
      const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified';
      files.push({ path: path.trim(), status, insertions: i, deletions: d });
    }
    return { files, insertions, deletions };
  }

  /** M1-2：从物化状态**重算**路径冲突 hold（幂等、不改状态；供 UI `waiting_reason` 与验收）。 */
  evaluatePathHolds(): PathConflict[] {
    const occupied = listRunningPathClaims(this.db);
    const holds: PathConflict[] = [];
    for (const w of listWorkItems(this.db)) {
      if (w.state !== 'queued') continue;
      const candidate = getWorkItemPathClaim(this.db, w.id);
      if (!candidate) continue;
      const conflicts = pathConflictWith(candidate, occupied);
      if (conflicts.length > 0) {
        holds.push({ workItemId: candidate.workItemId, reason: 'path_conflict', conflictsWith: conflicts });
      }
    }
    return holds;
  }

  // ───────────────────────── 看门狗 / 异步循环 ─────────────────────────

  private scheduleWatchdog(kind: string, taskId: number, dedupeKey: string, now: number): void {
    const dueAt = now + (kind === 'blocked_watchdog' ? 30 * 60 * 1000 : 30 * 60 * 1000);
    scheduleTimer(this.db, { kind, taskId, dueAt, dedupeKey, payload: {} });
  }

  /** 把到期的定时器转成事件入队（看门狗）。返回触发的定时器数。 */
  fireDueTimers(): number {
    const now = this.now();
    const due = listDueTimers(this.db, now);
    let fired = 0;
    for (const timer of due) {
      if (timer.task_id == null) continue;
      const owner = getTaskById(this.db, timer.task_id);
      if (timer.kind === 'session_heartbeat') {
        let workItemId: number | null = null;
        try {
          const payload = JSON.parse(timer.payload || '{}') as { workItemId?: unknown };
          if (typeof payload.workItemId === 'number' && Number.isInteger(payload.workItemId)) workItemId = payload.workItemId;
        } catch {
          workItemId = null;
        }
        const wi = workItemId != null ? getWorkItem(this.db, workItemId) : null;
        // 件已不在 running（提交/失败/暂停/阻塞）→ 残留心跳丢弃；件仍 running 才判卡死。
        if (!wi || wi.state !== 'running' || wi.task_id !== timer.task_id) {
          markTimerFired(this.db, timer.id, now);
          continue;
        }
        if (markTimerFired(this.db, timer.id, now)) {
          this.enqueue({
            scope: 'work_item',
            id: wi.id,
            event: 'heartbeat_timeout',
            actor: 'system',
            payload: { reason: `no_heartbeat:${timer.payload || '{}'}`, via: 'watchdog' },
          });
          fired += 1;
        }
      } else if (timer.kind === 'blocked_watchdog') {
        // 残留看门狗：任务已离开 blocked → 标记已触发并丢弃（不得抛"未定义迁移"）
        if (owner?.state !== 'blocked') {
          markTimerFired(this.db, timer.id, now);
          continue;
        }
        if (markTimerFired(this.db, timer.id, now)) {
          this.enqueue({ scope: 'task', id: timer.task_id, event: 'blocked_watchdog', actor: 'system' });
          fired += 1;
        }
      } else if (timer.kind === 'task_deadline_remind' || timer.kind === 'task_deadline_overdue') {
        // UG-02：截止提醒/逾期卡——只回调通知，不改任务状态；终态/已归档任务丢弃残留 timer。
        if (!owner || owner.state === 'done' || owner.state === 'cancelled' || owner.archived === 1) {
          markTimerFired(this.db, timer.id, now);
          continue;
        }
        let scheduledDeadline: number | null = null;
        try {
          const payload = JSON.parse(timer.payload || '{}') as { deadline?: unknown };
          if (typeof payload.deadline === 'number') scheduledDeadline = payload.deadline;
        } catch {
          scheduledDeadline = null;
        }
        // 截止被改过：旧 timer 不冒充新截止（换截止时应重排；当前无 UI 写入口，先丢弃旧票）。
        if (scheduledDeadline != null && owner.deadline !== scheduledDeadline) {
          markTimerFired(this.db, timer.id, now);
          continue;
        }
        if (markTimerFired(this.db, timer.id, now)) {
          try {
            this.config.onDeadline?.({
              taskId: timer.task_id,
              shortId: owner.short_id,
              title: owner.title,
              deadline: owner.deadline ?? scheduledDeadline ?? now,
              overdue: timer.kind === 'task_deadline_overdue',
            });
          } catch (error) {
            console.error('[engine] onDeadline 回调失败（timer 已消费，不阻塞引擎）', error);
          }
          fired += 1;
        }
      } else if (timer.kind === 'askcard_timeout') {
        const ownerState = owner?.state;
        if (ownerState !== 'awaiting_approval' && ownerState !== 'needs_decision') {
          markTimerFired(this.db, timer.id, now);
          continue;
        }
        // B6：读**真实** default_action（不再硬编码 `approve` = 替老板做决定）
        const pending = latestPendingApproval(this.db, timer.task_id);
        const realDefault = pending?.default_action ?? null;
        const kind = resolveDefaultActionKind(realDefault, parseApprovalOptions(pending?.options));
        // 可自动执行？`awaiting_approval`：FLOWS §3.1.1 L224（L1 且 default_action=批准）；
        // `needs_decision`：B6 白名单（fail-closed）——只有非破坏性默认动作才自动。
        const ownerRisk = owner && 'risk_level' in owner ? (owner as { risk_level: number }).risk_level : null;
        const actionable =
          ownerState === 'awaiting_approval' ? realDefault === 'approve' && ownerRisk === 1 : kind === 'auto';
        if (markTimerFired(this.db, timer.id, now)) {
          if (actionable) {
            // 审计：**只有**自动执行时才记 `decided_by=timeout`（未执行不记）
            if (pending && realDefault != null) {
              try {
                answerApproval(this.db, { approvalId: pending.id, chosen: realDefault, decidedBy: 'timeout', now });
              } catch {
                // 已被老板回答/已记录 → 不阻断超时事件（幂等）
              }
            }
            this.enqueue({
              scope: 'task',
              id: timer.task_id,
              event: 'askcard_timeout',
              actor: 'system',
              payload: { defaultAction: realDefault },
            });
            fired += 1;
          } else {
            // 到期只留痕、不迁移：审批卡保持待决（老板在待办里仍看得到）
            console.warn(
              `[engine] askcard_timeout 到期未自动执行（task=${timer.task_id} state=${ownerState} ` +
                `default_action=${realDefault ?? 'null'} kind=${kind}）——审批卡保持待决，等老板决定`,
            );
          }
        }
      }
    }
    return fired;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    const tick = async (): Promise<void> => {
      if (this.stopping) return;
      await this.enforceCompanyDailyBudget();
      this.fireDueTimers();
      try {
        await this.drain();
        // 时间驱动的调度一拍（老化晋升 / 新登记工作项派发不靠"等下一个事件"；C2）
        await this.schedulePass();
      } catch (error) {
        this.config.onEvent?.({ scope: 'task', id: 0, event: 'engine_error', payload: { error: String(error) } });
      }
      if (!this.stopping) {
        this.handle = setTimeout(() => void tick(), this.tickMs);
        // 不因看门狗定时器而“吊住”进程事件循环（否则测试/CLI 跑完不退出；见 pnpm test 泄漏定位）。
        this.handle.unref?.();
      }
    };
    void tick();
  }

  stop(): void {
    this.stopping = true;
    this.running = false;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  /** 重启：stop → recover（②③④）→ start。 */
  async restart(): Promise<RecoveryReport> {
    this.stop();
    const report = await this.recover();
    this.start();
    return report;
  }
}

/** 解析 `approvals.options`（JSON 文本）为选项表；非法/空 → `undefined`（视为无选项）。 */
function parseApprovalOptions(raw: string | null | undefined): Array<{ key?: unknown; variant?: unknown }> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<{ key?: unknown; variant?: unknown }>) : undefined;
  } catch {
    return undefined;
  }
}
