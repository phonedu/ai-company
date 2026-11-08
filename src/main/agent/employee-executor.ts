/**
 * OPT-AI-1 · 员工**真会话执行器**（替换 `makeRecordingExecutor()` 桩）。
 *
 * 口径（2285 裁定）：
 *  - **派发 `dispatch`（work_item）→ 员工真会话**：按 `work_items.employee_id` 取会话，cwd = 任务工作目录；
 *  - **回写**：会话**必须调 `submit_work_item`** → 发引擎事件 `submit_work_item`（→`submitted`）；
 *    **未提交** → 发 `agent_settled{submitted:false, lastOutput}`（→`failed`，**失败可见、不静默**）；
 *  - **`ask_colleague`**：会话内调用 → 走 M10-1 mailbox（`requestAsk`，不污染人类频道）；
 *  - **任务级 `dispatch_<phase>`**：`planning`＝**R3-1 规划会话**（本件接管：`dispatch_planning` → planner 会话
 *    → `submit_plan` → `plan_drafted`〔L0 直通 / L1·L2 进 critic 由状态机决定〕）；`critic/verifier`＝G4 评审会话。
 *
 * 本模块**不依赖 Pi**；`buildContext`（`agent/context.ts`）与 `dispatch`（在 `index.ts` 接线为 `engine.dispatch`）均**注入**，故可单测。
 */
import { createHash } from 'node:crypto';

import { getEmployeeModelPref, getProjectById, getProjectModelPolicy, getTaskById, getWorkItem, insertContextMetric, insertEmployee, insertReport, insertTaskEvent, recordCost, setReportVerdict, updateContextMetricAfterRun } from '../db/index.js';
import { listUnreadAnswers, markAnswersRead, requestAsk, spawnReplyWorkItem } from '../engine/mailbox.js';
import { formatStructuredAnswer } from './answer-colleague-tool.js';
import { answerAsk, getAsk, listOpenAsksForEmployee } from '../engine/mailbox.js';
import { notify } from '../notify/index.js';
import { redactPayload } from '../notify/redact.js';
import type { EffectExecutor, EngineEvent, PersistedAction } from '../engine/types.js';
import type { AgentEvent, AgentRunResult, AgentUsage, BuildEmployeeContext, EmployeeContext } from './types.js';import { EmployeeSessionRuntime, employeeSessionKey, plannerSessionKey, reviewSessionKey } from './employee-runtime.js';
import { buildPlanningContext, buildReviewContext, type PlanningContextInput, type ReviewContextInput } from './context.js';
import { sessionCompactionStats } from './compaction-policy.js';
import { contextWindowForModel } from './model-catalog.js';
import { formatMachineChecks, runAcceptanceChecksAsync } from './acceptance-checks.js';
import { sendRecruitCard } from './assistant-cards.js';
import { heartbeatWorkItem } from '../engine/timers.js';
import { getFallbackChain, getRoleMap, isProviderUnavailableError, modelRefKey, normalModelName, providerBackoffMs, resolveSessionModel } from './model-policy.js';
import {
  assistantChoiceCandidates,
  type AssistantChoice,
  type AssistantChoiceCandidate,
  type AssistantChoiceInput,
} from './assistant-model.js';
import { applyModelKeyGate, providerOf, type ModelTierResolution, type ProjectModelPolicy } from '../../core/model-tiers.js';
import { validateSubmission } from './submission.js';
import { projectProgressReported, sanitizeToolInput } from './tool-events.js';
import type { SqliteDb } from '../db/open.js';
import { listPlanSteps, type PlanStepState } from '../db/plan_steps.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { PLAN_STEPS_MAX } from './submit-plan-tool.js';
import { normalizePlanWorkItems } from '../../core/plan.js';

export interface EmployeeExecutorDeps {
  /** SQLite 句柄（只读 + mailbox 写入）。 */
  db: unknown;
  runtime: EmployeeSessionRuntime;
  /** 上下文组装（实现）；缺省则用内置最小占位（**不调用 context.ts**——见报告，避免双份实现）。 */
  buildContext?: BuildEmployeeContext;
  /** G4：评审上下文组装（critic/verifier）；缺省用 `buildReviewContext`。 */
  buildReviewContext?: (db: unknown, input: ReviewContextInput) => EmployeeContext;
  /** R3-1：规划上下文组装（planner）；缺省用 `buildPlanningContext`。 */
  buildPlanningContext?: (db: unknown, input: PlanningContextInput) => EmployeeContext;
  /** 会话键（G4）：可与 `EmployeeSessionRuntime` 共用；缺省不限制。 */
  sessionKeyFor?: (input: { employeeId: number; taskId: number; workItemId?: number | null }) => string;
  /** 事件回灌引擎（接线为 `(e) => engine.dispatch(e)`）；缺省则只记录不推进状态。 */
  dispatch?: (event: EngineEvent) => Promise<void> | void;
  /**
   * M2-D（预算流式结算）：成本走**引擎**入口（写 `costs` ＋ `cost_recorded` ＋ 回写 `cost_tokens`
   * ＋ **超预算 → `budget_exceeded` → paused**）。装配方接成 `(i) => engine.recordCost(i)`；
   * 缺省/未接线 → 回退 `db/costs` 直写（**只记账、无预算闸**——日志明示）。
   */
  recordCost?: (input: {
    taskId: number;
    workItemId: number | null;
    employeeId: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    usd: number;
    projectId: number | null;
    /** 可选来源标记（如 `assistant_selection`）；透传给成本事件。 */
    source?: string;
    now: number;
  }) => Promise<{ costTotal: number | null; budgetExceeded: boolean } | void> | { costTotal: number | null; budgetExceeded: boolean } | void;
  /**
   * D-22 选择期 Key 硬校验：解析出模型后核对供应商 Key 是否可用（只读，不返回明文）。
   * 生产装配传 `isModelKeyAvailable`；单测缺省视为可用（不读真实 secrets）。
   */
  modelKeyConfigured?: (model: string) => boolean;
  /**
   * D-22 assistant：LLM 幕僚长选型（异步，带缓存）。缺省/失败 → 解析器回落确定性规则。
   * 生产装配传 `createAssistantModelChooser()`；单测可注入假实现。
   */
  chooseAssistantModel?: (input: AssistantChoiceInput) => Promise<AssistantChoice | null>;
  /** 选型候选来源；缺省读主进程模型目录（生产），单测可注入固定候选。 */
  assistantCandidates?: (allowed: readonly string[]) => AssistantChoiceCandidate[];
  now?: () => number;
}

interface ResolvedWorkItem {
  workItemId: number;
  taskId: number;
  employeeId: number;
  attempt: number;
}

/**
 * B2-3/D-30②（D4 复核 P1-b 提取为可测纯函数）：返工件会话键继承判定——
 * **同员工**才继承「员工×任务×源件」会话键（前轮现场可见）；换员工改派不继承
 * （隔离优先，返回 undefined ⇒ 走新件自己的会话键）；无源件（retry_of 为空）同此。
 */
export function reworkInheritedSessionKey(
  src: { id: number; employee_id: number } | null | undefined,
  employeeId: number,
  taskId: number,
): string | undefined {
  if (src == null || src.employee_id !== employeeId) return undefined;
  return employeeSessionKey({ employeeId, taskId, workItemId: src.id });
}

/** 从 `actionKey = <kind>:<subjectKind>:<subjectId>:<revision>` 解析 work_item 派发目标。 */
export function parseDispatchAction(action: PersistedAction): ResolvedWorkItem | null {
  if (action.kind !== 'dispatch') return null;
  const [, subjectKind, subjectId, revision] = action.actionKey.split(':');
  if (subjectKind !== 'work_item') return null;
  const workItemId = Number(subjectId);
  if (!Number.isInteger(workItemId) || action.taskId == null) return null;
  return { workItemId, taskId: action.taskId, employeeId: -1, attempt: Number(revision) || 0 };
}

/** 从 `actionKey` 解析 critic/verifier 任务级派发（G4）；其余返回 null。 */
export function parseReviewAction(action: PersistedAction): { role: 'critic' | 'verifier'; taskId: number } | null {
  if (action.kind !== 'dispatch_critic' && action.kind !== 'dispatch_verifier') return null;
  if (action.taskId == null) return null;
  return { role: action.kind === 'dispatch_critic' ? 'critic' : 'verifier', taskId: action.taskId };
}

/** R3-1：从 `actionKey` 解析 planning 任务级派发（`inbox --triage--> planning` 的动作）；其余返回 null。 */
export function parsePlanningAction(action: PersistedAction): { taskId: number } | null {
  if (action.kind !== 'dispatch_planning') return null;
  if (action.taskId == null) return null;
  return { taskId: action.taskId };
}

/** D-22：取任务所属项目的模型策略（无项目/坏值 → null＝旧行为）。 */
function projectPolicyForTask(db: unknown, task: { project_id?: number | null } | null | undefined): ProjectModelPolicy | null {
  const projectId = task?.project_id;
  return typeof projectId === 'number' ? getProjectModelPolicy(db as never, projectId) : null;
}

/**
 * D-22 审计：只有**回落**或**硬约束拒绝**才写 `model_selected`（普通选择不刷事件）；
 * payload 带 source / 原因 / 允许清单，供任务详情与复盘查。
 */
function recordModelTier(
  db: unknown,
  input: {
    taskId: number;
    workItemId: number | null;
    employeeId: number;
    role: string;
    tier: ModelTierResolution;
    allowedBy: readonly string[];
    ts: number;
  },
): void {
  if (!input.tier.rejected && !input.tier.fallbackFrom && input.tier.source !== 'assistant') return;
  try {
    insertTaskEvent(db as never, {
      taskId: input.taskId,
      workItemId: input.workItemId,
      ts: input.ts,
      kind: 'model_selected',
      actor: `employee:${input.employeeId}`,
      payload: {
        role: input.role,
        model: input.tier.model,
        source: input.tier.source,
        allowedBy: [...input.allowedBy],
        ...(input.tier.reason ? { reason: input.tier.reason } : {}),
        ...(input.tier.fallbackFrom
          ? { fallbackFrom: input.tier.fallbackFrom, reason: input.tier.fallbackReason ?? null }
          : {}),
        ...(input.tier.rejected ? { rejected: input.tier.rejected } : {}),
      },
    });
  } catch (error) {
    // 审计失败不改变任务结果；留下控制台痕迹（不静默）。
    console.warn(`[agent] model_selected 审计写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** D-22：硬约束拒绝 → 响亮失败（不静默改派）。 */
function rejectedModelError(tier: ModelTierResolution): Error | null {
  return tier.rejected ? new Error(`[agent] ${tier.rejected}`) : null;
}

/** G5：思考文本入库上限（截断；不把整段思考无限写库）。 */
export const AGENT_THINKING_MAX = 2000;

/**
 * 重规划安全阀（重规划 v+1 配套）：critic 最多把计划打回到第 `1 + MAX_PLAN_REVISIONS` 版；
 * 再打回不再重规划（每次都真烧两次会话），转 `escalate` 交老板裁定。
 */
export const MAX_PLAN_REVISIONS = 2;

/**
 * 老板最近一次裁定后的**连续打回版数**（RW-21 残留收尾，M5 真机 S9 批）：
 * 旧口径＝累计 `plan_drafted` 总数——老板裁定「按评审意见再改」后预算不重置，critic 只消一轮
 * 打回就立刻再升级（老板沦为橡皮章，真机 T-1015 round=4 实锤）。新口径＝最后一次
 * `decision_made` 之后的 plan_drafted 计数（无裁定过的任务照旧数全部）。
 */
export function countPlanDrafts(db: SqliteDb, taskId: number): number {
  const lastDecision = db
    .prepare("SELECT id FROM task_events WHERE task_id = ? AND kind = 'decision_made' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { id: number } | undefined;
  const row = (
    lastDecision
      ? db
          .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'plan_drafted' AND id > ?")
          .get(taskId, lastDecision.id)
      : db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'plan_drafted'").get(taskId)
  ) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** G5：思考文本入库前**脱敏 + 截断**（密钥/Bearer/绝对路径不得入库）。 */
export function sanitizeThinking(text: string): string {
  const safe = String(redactPayload(text));
  return safe.length > AGENT_THINKING_MAX ? `${safe.slice(0, AGENT_THINKING_MAX)}…` : safe;
}

/** 最小占位上下文（仅当未注入 `buildContext` 时；真实路径应注入 `agent/context.ts`）。 */
function fallbackContext(db: unknown, input: { employeeId: number; taskId: number; workItemId?: number | null; bossText?: string | null }): EmployeeContext {
  const task = getTaskById(db as never, input.taskId);
  const project = task ? getProjectById(db as never, task.project_id) : undefined;
  const root = project?.root_dir ?? process.cwd();
  return {
    systemPrompt: ['[平台底座] ai-company 员工。', `[角色规则] 你是员工 #${input.employeeId}。`, '[人设] —'].join('\n'),
    userPrompt: [input.bossText ?? '', `任务：${task?.title ?? ''}`, `目标：${task?.goal ?? ''}`].filter(Boolean).join('\n'),
    meta: { layers: { platform: true, role: true, persona: false, memory: false, memoryBrief: false, skills: false, retrieval: false, fewShot: false, baseline: false, project: !!project, task: !!task }, projectRoot: root, cwd: root },
  };
}

export function createEmployeeExecutor(deps: EmployeeExecutorDeps): EffectExecutor {
  const db = deps.db;
  const build: BuildEmployeeContext = deps.buildContext ?? (fallbackContext as BuildEmployeeContext);
  // G4：评审上下文（可选注入；缺省用 buildReviewContext）。
  const buildReview = deps.buildReviewContext ?? (buildReviewContext as unknown as (db: unknown, input: ReviewContextInput) => EmployeeContext);
  // R3-1：规划上下文（可选注入；缺省用 buildPlanningContext）。
  const buildPlan = deps.buildPlanningContext ?? (buildPlanningContext as unknown as (db: unknown, input: PlanningContextInput) => EmployeeContext);
  const now = deps.now ?? (() => Date.now());
  // D-22：选择期 Key 硬校验（不注入＝单测环境，视为可用；生产由 employee-factory 接真凭据面）。
  const keyConfigured = deps.modelKeyConfigured ?? (() => true);
  const gateModelKey = (tier: ModelTierResolution, project: ProjectModelPolicy | null): ModelTierResolution =>
    applyModelKeyGate(tier, { project, companyDefault: normalModelName(), keyConfigured });

  /** D-22 硬拒可见：任务级会话（规划/评审）→ escalate（决策卡）；旧装配无 dispatch 时仍抛。 */
  async function rejectTaskModel(phase: string, taskId: number, role: string, rejected: Error): Promise<void> {
    if (!deps.dispatch) throw rejected;
    await deps.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: {
        role,
        phase,
        reason: `模型/凭据不可用：${rejected.message}`,
        modelRejected: rejected.message,
      },
    });
  }

  /** D-22 硬拒可见：执行工作项 → work_item error（件 failed，任务聚合出异常卡）；旧装配无 dispatch 时仍抛。 */
  async function rejectWorkItemModel(target: { taskId: number; workItemId: number }, rejected: Error): Promise<void> {
    if (!deps.dispatch) throw rejected;
    await deps.dispatch({
      scope: 'work_item',
      id: target.workItemId,
      event: 'error',
      actor: 'system',
      payload: { reason: `模型/凭据不可用：${rejected.message}`, modelRejected: rejected.message },
    });
  }

  /**
   * D-22 assistant：先异步问幕僚长（同任务同角色只问一次），把结果交给同步解析器；
   * 未启用/无候选/失败 → null，解析器走确定性规则。
   */
  async function assistantChoiceFor(
    taskId: number,
    role: string,
    task:
      | {
          title?: string | null;
          goal?: string | null;
          acceptance?: unknown;
          risk_level?: number | null;
          model?: string | null;
        }
      | null
      | undefined,
    project: ProjectModelPolicy | null,
  ): Promise<AssistantChoice | null> {
    if (!deps.chooseAssistantModel || project?.policy !== 'assistant' || project.allowedModels.length === 0) return null;
    // 任务级显式模型/评审角色映射已经在解析器里压过幕僚长——不必再花一次选型调用。
    const taskModel = typeof task?.model === 'string' ? task.model.trim() : '';
    if (taskModel && project.allowedModels.includes(taskModel)) return null;
    if (role === 'critic' || role === 'verifier') {
      const mapped = getRoleMap()[role];
      if (mapped && project.allowedModels.includes(mapped.model)) return null;
    }
    const candidates = (deps.assistantCandidates ?? assistantChoiceCandidates)(project.allowedModels);
    if (candidates.length === 0) return null;
    // 选型调用本身也必须落在项目边界内；优先项目默认，其次第一个可用候选。
    const selectorModel =
      project.defaultModel && candidates.some((c) => c.model === project.defaultModel)
        ? project.defaultModel
        : candidates[0]!.model;
    return deps.chooseAssistantModel({
      taskId,
      role,
      title: typeof task?.title === 'string' ? task.title : '',
      goal: typeof task?.goal === 'string' ? task.goal : '',
      acceptance: typeof task?.acceptance === 'string' ? task.acceptance : '',
      riskLevel: typeof task?.risk_level === 'number' ? task.risk_level : null,
      projectId: typeof (task as { project_id?: number | null } | null | undefined)?.project_id === 'number'
        ? (task as { project_id: number }).project_id
        : null,
      selectorModel,
      allowed: [...project.allowedModels],
      candidates,
    });
  }

  /**
   * G4 角色边界：critic 必须独立于规划者与（计划的）实现者。
   * 返回 null ⇒ 无独立人选；调用方派 `critic_unavailable` 升级，**不允许自评**。
   * RW-12（M5 真机带回）：选人**优先专职评审角色**（role 含 review/critic/评审）——纯按 id 会
   * 让 dev 同事顶替专职评审员工（「评审≠执行」名存实亡）；无专职时回退按 id（既有行为）。
   */
  function pickIndependentCritic(input: {
    plannerEmployeeId: number;
    implementerEmployeeId: number | null;
  }): number | null {
    const row = (db as never as { prepare: (s: string) => { get: (...args: unknown[]) => unknown } })
      .prepare(
        `SELECT id FROM employees WHERE active = 1 AND id <> ? AND id <> ?
         ORDER BY (CASE WHEN lower(role) LIKE '%review%' OR lower(role) LIKE '%critic%' OR role LIKE '%评审%' THEN 0 ELSE 1 END), id
         LIMIT 1`,
      )
      .get(input.plannerEmployeeId, input.implementerEmployeeId ?? -1) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * F-01（2026-11-05 终验真机）：critic 无人可选时**先自动补一名评审员工**（D-20 口径），返回其 id。
   * 只在「非幕僚长在职员工 < 2」且「名册里还没有专职评审」时补——已经有人/已有评审仍选不出来，
   * 说明是独立性问题（都占满了），那才该升级老板裁定（不自评不变）。招募**可见**：发招募卡（不阻塞）。
   */
  function recruitReviewerIfMissing(taskId: number, taskShortId: string | null): number | null {
    const d = db as unknown as {
      prepare: (s: string) => { get: (...args: unknown[]) => unknown };
    };
    const count = Number((d.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND is_assistant = 0 AND id <> 0').get() as { n: number }).n);
    if (count >= 2) return null;
    const hasReviewer = d
      .prepare(
        `SELECT id FROM employees WHERE active = 1 AND is_assistant = 0
           AND (role LIKE '%评审%' OR lower(role) LIKE '%review%' OR lower(role) LIKE '%critic%') LIMIT 1`,
      )
      .get() as { id: number } | undefined;
    if (hasReviewer != null) return null;
    const employeeId = insertEmployee(db as never, {
      name: '评审员工',
      role: '评审',
      persona: '自动招募：负责独立评审/验证；老板可在设置·员工中细化人设/模型/技能。',
      capabilityTier: 'standard',
      now: now(),
    });
    console.warn(`[agent] 无独立评审可选 → 自动招募评审员工 #${employeeId}（任务 ${taskId}）`);
    try {
      sendRecruitCard(db as never, {
        employeeId,
        employeeName: '评审员工',
        role: '评审',
        persona: '自动招募：负责独立评审/验证。',
        model: '跟随默认',
        skills: [],
        tier: 'standard',
        taskId,
        taskShortId: taskShortId ?? `#${taskId}`,
        blocking: false,
      });
    } catch {
      // 卡发不出去不能反噬评审（招募本身已落库、可继续）；留痕不静默。
      console.error('[agent] 自动招募评审员工后发招募卡失败（评审继续）');
    }
    return employeeId;
  }

  /**
   * N5 余账（2026-10-16）：**运行时兜底链**——主模型不可用（分类见 `isProviderUnavailableError`：
   * 401/403/429/5xx/模型不存在/连接层）⇒ 按 `models.fallback_chain` **逐级降级**（≤5），
   * **降级记事件**（`agent_model_fallback`，含 from/to/原因）后重跑；全链失败 → 抛最后一个错（失败可见）。
   * 会话被**真中止**（`AgentSession.abort()`，取消路径）→ 返回 `{aborted:true}`（调用方按中止收场，不回写 settle）。
   */
  async function runSessionWithFallback(
    base: Parameters<EmployeeSessionRuntime['run']>[0],
    onEvent: (event: AgentEvent) => void,
    note: { role: string; allowedModels?: readonly string[] },
  ): Promise<{ aborted: true } | { aborted: false; result: AgentRunResult }> {
    // 裸名（deepseek-flash）与 provider/model（deepseek/deepseek-flash）是同一个模型；
    // 按原始字符串过滤会让兜底链重复试同一模型（独立审查 2026-10-18）。
    const baseKey = modelRefKey(base.model ?? '');
    const allowed = note.allowedModels ?? [];
    const allowedRefs = new Set(allowed.map((m) => modelRefKey(m)));
    // D-22：运行期降级也受项目边界约束——清单外或缺 Key 的备选不得顶替（否则硬边界只在选择期成立）。
    // 清单按规范引用比较（裸名/provider 前缀混写视为同一模型）；链内同引用只试一次。
    const chain = getFallbackChain()
      .filter(
        (m) =>
          modelRefKey(m) !== baseKey &&
          (allowed.length === 0 || allowedRefs.has(modelRefKey(m))) &&
          keyConfigured(m),
      )
      .filter((m, i, arr) => arr.findIndex((x) => modelRefKey(x) === modelRefKey(m)) === i);
    let candidate = base.model;
    let lastError: unknown = null;
    for (let hop = 0; hop <= chain.length; hop += 1) {
      try {
        const result = await deps.runtime.run({ ...base, model: candidate }, onEvent);
        return { aborted: false, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/abort/i.test(message)) return { aborted: true }; // 真中止（取消路径）
        lastError = error;
        const next = chain[hop];
        if (!isProviderUnavailableError(message) || next == null) throw error;
        // B0-11：指数退避后再换模型（限流/5xx 不要立刻打满整链）。
        const wait = providerBackoffMs(hop);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        console.warn(`[agent] 主模型不可用 → 降级（${note.role}）：${candidate} → ${next}（${message.slice(0, 140)}）`);
        insertTaskEvent(db as never, {
          taskId: base.taskId,
          workItemId: base.workItemId ?? null,
          ts: now(),
          kind: 'agent_model_fallback',
          actor: 'system',
          payload: { role: note.role, from: candidate, to: next, reason: message.slice(0, 300) },
        });
        candidate = next;
      }
    }
    throw lastError ?? new Error('[employee-executor] 兜底链耗尽');
  }

  /**
   * CTX1-2：把本轮**真实拼装**的上下文落一行遥测（会话开始、真正吃 token 之前写）。
   * 窗口未知 → `context_window/utilization` 写 NULL（渲染层显 `—`，不写假 0）；遥测失败**不阻断会话**但响亮报错。
   */
  function recordContextMetric(options: {
    ctx: EmployeeContext;
    taskId: number;
    workItemId: number | null;
    employeeId: number | null;
    projectId: number | null;
    sessionKey: string;
    model: string;
  }): number | null {
    const telemetry = options.ctx.meta.telemetry;
    if (!telemetry) return null; // 占位上下文（fallback/旧注入）无遥测：不写假行
    const contextWindow = contextWindowForModel(options.model);
    const stats = sessionCompactionStats(options.sessionKey);
    try {
      return insertContextMetric(db as SqliteDb, {
        taskId: options.taskId,
        workItemId: options.workItemId,
        employeeId: options.employeeId,
        projectId: options.projectId,
        sessionKey: options.sessionKey,
        ts: now(),
        totalTokens: telemetry.totalTokens,
        systemTokens: telemetry.systemTokens,
        userTokens: telemetry.userTokens,
        contextWindow,
        utilization: contextWindow != null && contextWindow > 0 ? telemetry.totalTokens / contextWindow : null,
        truncated: telemetry.truncated,
        layers: telemetry.layers,
        compactionCount: stats.count,
        tokensBeforeCompaction: stats.lastBefore?.tokensBefore ?? null,
        model: options.model,
        // CTX1-9：system 前缀指纹（逐轮可比；同会话除压缩外应稳定）。
        systemPromptHash: createHash('sha256').update(options.ctx.systemPrompt).digest('hex'),
      });
    } catch (error) {
      console.error(`[context] 遥测落库失败（不阻断会话）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** CTX1-2：会话结束后回填 cache 读写与压缩读数（无用量回执 → cache 保持 NULL）。 */
  function finalizeContextMetric(id: number | null, usage: AgentUsage | undefined, sessionKey: string): void {
    if (id == null) return;
    const stats = sessionCompactionStats(sessionKey);
    try {
      updateContextMetricAfterRun(db as SqliteDb, id, {
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        compactionCount: stats.count,
        tokensBeforeCompaction: stats.lastBefore?.tokensBefore ?? null,
      });
    } catch (error) {
      console.error(`[context] 遥测回填失败（不阻断会话）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * B0-8（ADV-1 I1）：会话统计是**累计值**（Pi `getSessionStats()` 遍历全会话），同会话多轮
   * （nudge/重试/返工复用会话键）若全额入账就会重复计入。这里按 sessionKey 落**差值**：
   * 游标持久化在 settings（`cost.usageCursor.<hash>`）——重启后续跑同一落盘会话也不重记。
   * 非累计用量（fake/单轮）原样返回（既有行为不变）。
   */
  function usageDelta(usage: AgentUsage | undefined, sessionKey: string): AgentUsage | undefined {
    if (!usage || usage.cumulativeSessionStats !== true) return usage;
    const cursorKey = `cost.usageCursor.${createHash('sha256').update(sessionKey).digest('hex').slice(0, 20)}`;
    const raw = readSetting(db as SqliteDb, cursorKey);
    const prev =
      raw && typeof raw === 'object'
        ? (raw as { i?: number; o?: number; cr?: number; cw?: number; usd?: number })
        : null;
    const cur = {
      i: usage.inputTokens ?? 0,
      o: usage.outputTokens ?? 0,
      cr: usage.cacheReadTokens ?? 0,
      cw: usage.cacheWriteTokens ?? 0,
      usd: usage.costUsd ?? 0,
    };
    // 会话被重建（统计回退）→ 差值按 0 处理，绝不记负数。
    const delta = {
      i: Math.max(0, cur.i - (prev?.i ?? 0)),
      o: Math.max(0, cur.o - (prev?.o ?? 0)),
      cr: Math.max(0, cur.cr - (prev?.cr ?? 0)),
      cw: Math.max(0, cur.cw - (prev?.cw ?? 0)),
      usd: Math.max(0, cur.usd - (prev?.usd ?? 0)),
    };
    try {
      writeSetting(db as SqliteDb, cursorKey, cur);
    } catch (error) {
      console.error('[cost] 用量游标写入失败（本次仍按差值记账）', error);
    }
    if (delta.i + delta.o + delta.cr + delta.cw === 0 && delta.usd === 0) return undefined; // 纯重放
    return {
      ...usage,
      inputTokens: delta.i,
      outputTokens: delta.o,
      cacheReadTokens: delta.cr,
      cacheWriteTokens: delta.cw,
      costUsd: delta.usd,
      cumulativeSessionStats: undefined,
    };
  }

  /**
   * OPT-AI-8：把一次会话的用量落库（**无用量不写行**——不臆造；项目归属由 task 解析）。
   * 记账失败**不阻断会话**，但**响亮报错**（P6：不许静默失败）。
   */
  async function persistUsage(usage: AgentUsage | undefined, taskId: number, workItemId: number | null, employeeId: number): Promise<void> {
    if (!usage) return;
    const tokensIn = usage.inputTokens ?? 0;
    const tokensOut = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const usd = usage.costUsd ?? 0;
    if (tokensIn + tokensOut + cacheRead + cacheWrite === 0 && usd === 0) return; // 零用量＝无事实可记
    // B0-11：未定价模型（底座没给 cost）→ 留痕告警，不静默把花费当 $0（美元预算闸会失真）。
    if (usage.costUsd == null) {
      try {
        insertTaskEvent(db as never, {
          taskId,
          workItemId,
          ts: now(),
          kind: 'cost_unpriced',
          actor: 'system',
          payload: { model: usage.model ?? 'unknown', tokens: tokensIn + tokensOut + cacheRead + cacheWrite },
        });
      } catch (error) {
        console.error('[cost] 未定价告警落库失败（不阻断记账）', error);
      }
    }
    let projectId: number | null = null;
    try {
      projectId = (getTaskById(db as never, taskId) as { project_id?: number } | undefined)?.project_id ?? null;
    } catch {
      projectId = null;
    }
    const entry = {
      taskId, workItemId, employeeId,
      model: usage.model ?? 'unknown',
      tokensIn, tokensOut, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, usd, projectId,
      now: now(),
    };
    try {
      if (deps.recordCost) {
        // M2-D：引擎入口（含预算闸门与 cost_recorded 事件）——生产装配必须走这条。
        await deps.recordCost(entry);
      } else {
        // 未接线：只记账（无预算闸）——**显式提示**（静默风险不许藏）。
        console.warn('[cost] recordCost 未接线（引擎入口缺失）→ 本次只记账、预算闸不生效');
        recordCost(db as never, entry);
      }
    } catch (error) {
      console.error('[cost] 成本落库失败（会话继续；读数可能偏低）', { taskId, workItemId, employeeId }, error);
    }
  }

  /** G4：critic/verifier 会话（角色分键）。 */
  async function runReview(role: 'critic' | 'verifier', taskId: number): Promise<void> {
    const task = getTaskById(db as never, taskId) as
      | {
          owner_id?: number | null;
          project_id?: number | null;
          risk_level?: number | null;
          model?: string | null;
          title?: string | null;
          short_id?: string | null;
          goal?: string | null;
          acceptance?: unknown;
        }
      | null
      | undefined;
    if (!task) throw new Error(`[employee-executor] 任务不存在：${taskId}`);
    // 选人：verifier 取工作项的 verifier_employee_id（≠实现者）；critic 缺省幕僚长(0)。
    let reviewerId: number;
    let workItemId: number | null = null;
    // N5 余账（异供应商，§10.3）：**实现者 id**——critic＝首个件员工；verifier＝被验件员工（下面两支各自取）。
    let implementerEmployeeId: number | null = null;
    if (role === 'verifier') {
      const rows = (db as never as { prepare: (s: string) => { all: (t: number) => unknown[] } })
        .prepare('SELECT id, employee_id, verifier_employee_id, state FROM work_items WHERE task_id = ? ORDER BY id')
        .all(taskId) as Array<{ id: number; employee_id: number; verifier_employee_id: number | null; state: string }>;
      const target = rows.find((w) => w.verifier_employee_id != null && w.employee_id !== w.verifier_employee_id) ?? null;
      if (!target) {
        // BRK3 修：派**任务机真事件** `escalate`（FLOWS §3.1.1「任意非终态」行 → `needs_decision` ＋ AskCard；
        // 此前派 `verification_blocked`——任务机没有这个事件 ⇒ 真引擎抛错、任务永停 `verifying`、无卡）。
        await deps.dispatch?.({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { role, reason: 'no_verifier' } });
        return;
      }
      reviewerId = target.verifier_employee_id as number;
      workItemId = target.id;
      implementerEmployeeId = target.employee_id;
    } else {
      // critic：规划者（tasks.owner_id，缺省幕僚长 0）不得评审自己的计划；
      // 同时不得让（计划的）实现者自评。无独立人选 → 升级老板，不跑自评会话。
      const plannerId = typeof task.owner_id === 'number' ? task.owner_id : 0;
      const impl = (db as never as { prepare: (s: string) => { get: (t: number) => unknown } })
        .prepare('SELECT employee_id FROM work_items WHERE task_id = ? ORDER BY id LIMIT 1')
        .get(taskId) as { employee_id: number } | undefined;
      implementerEmployeeId = impl?.employee_id ?? null;
      if (implementerEmployeeId == null) {
        const projectRow = (db as never as { prepare: (s: string) => { get: (t: number) => unknown } })
          .prepare('SELECT default_employee_ids FROM projects WHERE id = ?')
          .get(task.project_id ?? -1) as { default_employee_ids?: string | null } | undefined;
        let staffingIds: number[] = [];
        try {
          const parsed = JSON.parse(projectRow?.default_employee_ids ?? '[]') as unknown;
          if (Array.isArray(parsed)) staffingIds = parsed.filter((v): v is number => typeof v === 'number');
        } catch {
          staffingIds = [];
        }
        const active = staffingIds.find((id) => {
          const row = (db as never as { prepare: (s: string) => { get: (t: number) => unknown } })
            .prepare('SELECT id FROM employees WHERE id = ? AND active = 1')
            .get(id) as { id: number } | undefined;
          return row != null;
        });
        implementerEmployeeId = active ?? (typeof task.owner_id === 'number' ? task.owner_id : 0);
      }
      let picked = pickIndependentCritic({ plannerEmployeeId: plannerId, implementerEmployeeId });
      // F-01（2026-11-05 终验真机）：空公司/单人公司派任务时，planning→critic 这一步会直接升级成
      // 只有「取消任务」的死卡；而 D-20 的自动补评审（engine.ensureReviewer）只在**建工作项**阶段调用，
      // 永远走不到。这里先按 D-20 口径**自动补一名评审员工**（可见招募卡）再重试选人；
      // 仍无独立人选才升级老板（不自评不变）。
      if (picked == null || picked === plannerId || picked === implementerEmployeeId) {
        const recruited = recruitReviewerIfMissing(taskId, task?.short_id ?? null);
        if (recruited != null) {
          picked = pickIndependentCritic({ plannerEmployeeId: plannerId, implementerEmployeeId });
        }
      }
      if (picked == null || picked === plannerId || picked === implementerEmployeeId) {
        await deps.dispatch?.({
          scope: 'task',
          id: taskId,
          event: 'escalate',
          actor: 'system',
          payload: { role, reason: 'critic_unavailable', plannerEmployeeId: plannerId, implementerEmployeeId },
        });
        return;
      }
      reviewerId = picked;
    }

    // M3-DOC-4（P6）：宿主先跑 `acceptance[].check`。任一条失败＝硬门——跳过 verifier 模型，
    // 直接落 fail 报告并派 `verification_completed`（模型不得翻案；也省一次会话成本）。
    const machineChecks = role === 'verifier' ? await runAcceptanceChecksAsync(db as unknown as SqliteDb, taskId) : null;
    if (machineChecks?.failed) {
      const notes = `机器检查未通过（硬门）：\n${formatMachineChecks(machineChecks)}`;
      const report = insertReport(db as never, {
        taskId,
        kind: 'report',
        payload: { role: 'verifier', verdict: 'fail', notes, machineChecks: machineChecks.items, title: `验收复核：${task?.short_id ?? `#${taskId}`}` },
        now: now(),
      }) as { id: number };
      setReportVerdict(db as never, report.id, 'fail', reviewerId);
      await deps.dispatch?.({
        scope: 'task',
        id: taskId,
        event: 'verification_completed',
        actor: `employee:${reviewerId}`,
        payload: { role: 'verifier', verdict: 'fail', notes, workItemId, reportId: report.id, machineChecks: machineChecks.items },
      });
      return;
    }

    const ctx = buildReview(db, {
      role,
      taskId,
      workItemId,
      reviewerEmployeeId: reviewerId,
      bossText: null,
      machineChecks: role === 'verifier' && machineChecks ? formatMachineChecks(machineChecks) : null,
    });
    // N5（`R3-3`）：评审会话档位（**任务级 > 员工显式 > role_map > 项目默认 > 普通档**；评审不降档——危险档保持强模型）。
    const pref = getEmployeeModelPref(db as never, reviewerId);
    // D-22：项目模型策略＝边界与默认（fixed 压平员工偏好；允许清单外的任务模型直接拒）。
    const project = projectPolicyForTask(db, task);
    const assistantChoice = await assistantChoiceFor(taskId, role, task, project);
    const employeeChoice = await assistantChoiceFor(taskId, 'employee', task, project);
    // N5 余账（异供应商，§10.3「critic/verifier 建议用不同供应商——视角差异」）：实现者（该件员工）的
    // 有效模型供应商 → peer；无件/实现者=评审者（上面已拦）→ 不尝试叠加。
    let peerProvider: string | null = null;
    if (implementerEmployeeId != null && implementerEmployeeId !== reviewerId) {
      const implPref = getEmployeeModelPref(db as never, implementerEmployeeId);
      const resolvedImplTier = resolveSessionModel({
        role: 'employee',
        riskLevel: (task as { risk_level?: number | null }).risk_level ?? null,
        taskModel: (task as { model?: string | null } | null)?.model ?? null,
        employeeModel: implPref.model,
        employeeThinking: implPref.thinking,
        project,
        assistantChoice: employeeChoice,
      });
      const implTier = gateModelKey(resolvedImplTier, project);
      peerProvider = implTier.rejected ? null : providerOf(implTier.model);
    }
    const resolvedTier = resolveSessionModel({
      role,
      riskLevel: (task as { risk_level?: number | null }).risk_level ?? null,
      // 009（N5 余账）：任务级模型＝指派链最高档（显式人工指派，对全部会话角色生效）。
      taskModel: (task as { model?: string | null } | null)?.model ?? null,
      employeeModel: pref.model,
      employeeThinking: pref.thinking,
      project,
      peerProvider,
      assistantChoice,
    });
    const tier = gateModelKey(resolvedTier, project);
    recordModelTier(db, {
      taskId,
      workItemId,
      employeeId: reviewerId,
      role,
      tier,
      allowedBy: project?.allowedModels ?? [],
      ts: now(),
    });
    const rejected = rejectedModelError(tier);
    if (rejected) {
      await rejectTaskModel(role, taskId, role, rejected);
      return;
    }
    if (tier.diversified === false) {
      console.warn(`[agent] critic/verifier 异供应商不可达（fallback_chain 无第二供应商）：保持 ${tier.model}`);
    }
    // CTX1-2：评审上下文的真实读数落库（含材料/机器检查；窗口未知 → NULL）。
    const reviewSession = reviewSessionKey({ role, taskId, workItemId });
    const reviewMetricId = recordContextMetric({
      ctx,
      taskId,
      workItemId: workItemId ?? null,
      employeeId: reviewerId,
      projectId: (task as { project_id?: number | null }).project_id ?? null,
      sessionKey: reviewSession,
      model: tier.model,
    });
    let reviewInput: Record<string, unknown> | null = null;
    let reviewSucceeded = false;
    const onReviewEvent = (e: AgentEvent): void => {
      if (e.type === 'tool_call_start' && e.toolName === 'submit_review') reviewInput = e.input;
      if (e.type === 'tool_call_end' && e.toolName === 'submit_review' && !e.isError) reviewSucceeded = true;
    };
    let run: Awaited<ReturnType<typeof runSessionWithFallback>>;
    try {
      run = await runSessionWithFallback(
        {
          employeeId: reviewerId,
          taskId,
          workItemId,
          systemPrompt: ctx.systemPrompt,
          userPrompt: ctx.userPrompt,
          cwd: ctx.meta.cwd,
          sessionKey: reviewSessionKey({ role, taskId, workItemId }),
          model: tier.model,
          thinkingLevel: tier.thinking ?? undefined,
          skills: ctx.meta.skillRefs,
          mcps: ctx.meta.mcpRefs,
        },
        onReviewEvent,
        { role, allowedModels: project?.allowedModels ?? [] },
      );
    } catch (error) {
      // S1 同族（2026-10-24）：submit_review 成功后 SDK 可能 terminate，`prompt` 抛 terminated；
      // 评审结论已提交，不能把 action 记失败、让任务卡在 verifying。
      const message = error instanceof Error ? error.message : String(error);
      if (reviewSucceeded && reviewInput && /terminated/i.test(message)) {
        console.log(
          `[agent] 评审会话在提交后终止（role=${role}, task=${taskId}：${message.slice(0, 120)}）——按已提交结论收场`,
        );
        run = {
          aborted: false,
          result: {
            text: '',
            toolCalls: [{ id: 'submit-review-recovered', name: 'submit_review', input: reviewInput, isError: false }],
          },
        };
      } else {
        throw error;
      }
    }
    if (run.aborted) {
      finalizeContextMetric(reviewMetricId, undefined, reviewSession);
      console.log(`[agent] 评审会话被中止（role=${role}, task=${taskId}）——按中止语义收场`);
      return;
    }
    const result = run.result;
    finalizeContextMetric(reviewMetricId, result.usage, reviewSession);

    await persistUsage(usageDelta(result.usage, reviewSession), taskId, workItemId, reviewerId); // OPT-AI-8/B0-8：评审会话同口径（差值）
    const call = result.toolCalls.find((t) => t.name === 'submit_review' && t.isError !== true);
    let raw = call ? String((call.input as { verdict?: unknown }).verdict ?? '') : '';
    let notes = call ? String((call.input as { notes?: unknown }).notes ?? '') : '';
    // F-02（2026-11-06 老板裁「不设硬门，必须交代」）：独立字段，宿主可机器校验。
    const planStepsExplanation = call ? String((call.input as { planStepsNote?: unknown }).planStepsNote ?? '').trim() : '';

    if (role === 'critic') {
      if (raw === 'approve') {
        await deps.dispatch?.({ scope: 'task', id: taskId, event: 'plan_reviewed', actor: `employee:${reviewerId}`, payload: { role, verdict: 'approve', notes } });
      } else if (raw === 'revise') {
        // 安全阀（重规划 v+1 的配套）：每次打回都会真重规划（规划＋评审两次真会话）⇒
        // critic 把第 3 版计划也打回时不再重规划，改派 `escalate` 交老板裁定（防无限烧钱；阈值＝常量）。
        const round = countPlanDrafts(db as never, taskId);
        if (round > MAX_PLAN_REVISIONS) {
          console.warn(`[agent] critic 连续打回达上限（第 ${round} 版）→ 转 escalate 交老板（task=${taskId}）`);
          await deps.dispatch?.({
            scope: 'task',
            id: taskId,
            event: 'escalate',
            actor: `employee:${reviewerId}`,
            payload: { role, reason: 'critic_revise_limit', round, notes },
          });
          return;
        }
        // 走现有打回路径：先到 awaiting_approval，再 `revise` 回 planning（**revise 行会再派规划**＝重规划 v+1）。
        await deps.dispatch?.({ scope: 'task', id: taskId, event: 'plan_reviewed', actor: `employee:${reviewerId}`, payload: { role, verdict: 'revise', notes } });
        await deps.dispatch?.({ scope: 'task', id: taskId, event: 'revise', actor: `employee:${reviewerId}`, payload: { role, notes } });
      } else {
        // BRK3 修：无结论 → `escalate`（可见的决策卡；此前派任务级 `error`——任务机无此事件 ⇒ 静默停摆）。
        await deps.dispatch?.({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { role, reason: 'no_verdict', raw } });
      }
      return;
    }

    // verifier：pass / fail；无 verdict → `escalate`（**绝不默认通过**；BRK3 修：必须可见，不许静默停摆）
    if (raw !== 'pass' && raw !== 'fail') {
      await deps.dispatch?.({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { role, reason: 'no_verdict', raw } });
      return;
    }
    // F-02（2026-11-06 老板裁）：计划步骤未完成**不是硬门**，但必须交代。
    // 校验独立字段 `planSteps`（写在 notes 里不算，避免"结论里顺口提一句"冒充交代）：
    // pass + 有未完成步骤 + 未交代 → 宿主改为 fail（留痕，报告/事件可审计）。
    const reviewSteps = listPlanSteps(db as unknown as SqliteDb, taskId);
    const unfinishedSteps = reviewSteps.filter(
      (s) => s.state === 'pending' || s.state === 'running' || s.state === 'failed',
    );
    if (planStepsExplanation.length > 0) {
      notes = `${notes}${notes ? '\n\n' : ''}[计划步骤交代] ${planStepsExplanation}`;
    }
    if (raw === 'pass' && unfinishedSteps.length > 0 && planStepsExplanation.length === 0) {
      const downgrade =
        `[宿主校验 F-02] 计划仍有 ${unfinishedSteps.length}/${reviewSteps.length} 步未完成` +
        `（第 ${unfinishedSteps.map((s) => s.idx).join('、')} 步），但 submit_review 未提供 planSteps 交代` +
        ' → 按未说明处理：pass → fail。';
      notes = notes ? `${notes}\n\n${downgrade}` : downgrade;
      raw = 'fail';
      console.warn(`[agent] verifier pass 未交代未完成计划步骤 → 改 fail（task=${taskId}）`);
    } else if (raw === 'pass' && unfinishedSteps.length > 0) {
      notes = `${notes}\n\n[计划步骤状态] ${reviewSteps.length - unfinishedSteps.length}/${reviewSteps.length} 步已关（未完成步骤已交代，不阻断验收）。`;
    }
    const planStepAudit = {
      planStepsNote: planStepsExplanation.length > 0 ? planStepsExplanation : null,
      unfinishedSteps: unfinishedSteps.map((s) => ({ idx: s.idx, state: s.state, text: s.text })),
    };

    // F-G4-B（抓）：verdict 必须**落库**（`reports.verdict` + `verifier_employee_id`）——不能只发事件。
    // 每次验证**新建 report**：不能复用上一条（否则 fail→返工→pass 会把历史 fail 行改写成 pass）。
    const report = insertReport(db as never, {
      taskId,
      kind: 'report',
      payload: { role: 'verifier', verdict: raw, notes, title: `验收复核：${task?.short_id ?? `#${taskId}`}`, ...planStepAudit },
      now: now(),
    }) as { id: number };
    const reportId = report.id;
    setReportVerdict(db as never, reportId, raw, reviewerId);
    // 可审计结论事件（此前 `recordVerdict` 只有测试调用；生产 verifier 不落 review_completed）。
    insertTaskEvent(db as never, {
      taskId,
      workItemId: workItemId ?? null,
      ts: now(),
      kind: 'review_completed',
      actor: `employee:${reviewerId}`,
      payload: { reportId, verdict: raw, role: 'verifier', notes, ...planStepAudit },
    });
    await deps.dispatch?.({ scope: 'task', id: taskId, event: 'verification_completed', actor: `employee:${reviewerId}`, payload: { role, verdict: raw, notes, workItemId, reportId, ...planStepAudit } });
  }

  /**
   * R3-1：planning 会话（`inbox --triage--> planning` 的 `dispatch_planning` 动作的消费者）。
   * 产出口径：会话**必须调 `submit_plan`** → `plan_drafted{steps}`（L0 → `ready` 直通；L1/L2 → 启动 critic，
   * 由状态机决定）；**无有效计划 → 派 `escalate`**（BRK3 修：任务进 `needs_decision` ＋ 决策卡——可见、不静默；
   * 此前派任务级 `error`——任务机无此事件 ⇒ 真引擎抛错、任务永停 `planning`）。
   * 选人：`tasks.owner_id`（缺省＝幕僚长 0）。
   */
  async function runPlanning(taskId: number): Promise<void> {
    const task = getTaskById(db as never, taskId) as
      | {
          owner_id?: number | null;
          project_id?: number | null;
          risk_level?: number | null;
          model?: string | null;
          title?: string | null;
          short_id?: string | null;
          goal?: string | null;
          acceptance?: unknown;
        }
      | null
      | undefined;
    if (!task) throw new Error(`[employee-executor] 任务不存在：${taskId}`);
    const plannerId = typeof task.owner_id === 'number' ? task.owner_id : 0;

    const ctx = buildPlan(db, { taskId, plannerEmployeeId: plannerId, bossText: null });
    // N5（`R3-3`）：规划会话档位（规划**不降档**——贵模型想、便宜模型干）。
    const pref = getEmployeeModelPref(db as never, plannerId);
    const project = projectPolicyForTask(db, task); // D-22：项目边界/默认
    const assistantChoice = await assistantChoiceFor(taskId, 'planner', task, project);
    const resolvedTier = resolveSessionModel({
      role: 'planner',
      riskLevel: task.risk_level ?? null,
      taskModel: task.model ?? null, // 009：任务级模型（最高档）
      employeeModel: pref.model,
      employeeThinking: pref.thinking,
      project,
      assistantChoice,
    });
    const tier = gateModelKey(resolvedTier, project);
    recordModelTier(db, {
      taskId,
      workItemId: null,
      employeeId: plannerId,
      role: 'planner',
      tier,
      allowedBy: project?.allowedModels ?? [],
      ts: now(),
    });
    const rejected = rejectedModelError(tier);
    if (rejected) {
      await rejectTaskModel('planning', taskId, 'planner', rejected);
      return;
    }
    // CTX1-2：规划上下文的真实读数落库（含规划规则/上一版计划）。
    const planSession = plannerSessionKey({ taskId });
    const planMetricId = recordContextMetric({
      ctx,
      taskId,
      workItemId: null,
      employeeId: plannerId,
      projectId: (task as { project_id?: number | null }).project_id ?? null,
      sessionKey: planSession,
      model: tier.model,
    });
    let planInput: Record<string, unknown> | null = null;
    let planSucceeded = false;
    const onPlanEvent = (e: AgentEvent): void => {
      if (e.type === 'tool_call_start' && e.toolName === 'submit_plan') planInput = e.input;
      if (e.type === 'tool_call_end' && e.toolName === 'submit_plan' && !e.isError) planSucceeded = true;
    };
    let run: Awaited<ReturnType<typeof runSessionWithFallback>>;
    try {
      run = await runSessionWithFallback(
        {
          employeeId: plannerId,
          taskId,
          workItemId: null,
          systemPrompt: ctx.systemPrompt,
          userPrompt: ctx.userPrompt,
          cwd: ctx.meta.cwd,
          sessionKey: plannerSessionKey({ taskId }),
          model: tier.model,
          thinkingLevel: tier.thinking ?? undefined,
          skills: ctx.meta.skillRefs,
          mcps: ctx.meta.mcpRefs,
        },
        onPlanEvent,
        { role: 'planner', allowedModels: project?.allowedModels ?? [] },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // S1 同族（2026-10-24）：submit_plan 成功后 SDK 可能 terminate；计划已提交，不能丢。
      if (planSucceeded && planInput && /terminated/i.test(message)) {
        console.log(`[agent] 规划会话在提交后终止（task=${taskId}：${message.slice(0, 120)}）——按已提交计划收场`);
        run = {
          aborted: false,
          result: {
            text: '',
            toolCalls: [{ id: 'submit-plan-recovered', name: 'submit_plan', input: planInput, isError: false }],
          },
        };
      } else {
        // C2 真机（2026-10-17）：模型/凭据不可用（401/403/429/5xx/模型不存在/连接层）在**规划会话**里
        // 必须走可见失败面（任务 failed＋异常卡）；此前被当成“没有 submit_plan”升级为 no_plan 决策卡，
        // 401 只在会话 JSONL 里、老板看不到。完全无凭据的 C8 仍由 unavailable-executor 的 escalate 负责。
        if (!isProviderUnavailableError(message)) throw error;
        const reason = `模型/凭据不可用：${message.slice(0, 300)}`;
        if (!deps.dispatch) throw error; // 旧装配/测试无 dispatch：照旧抛（action_failed 可见）
        await deps.dispatch({
          scope: 'task',
          id: taskId,
          event: 'error',
          actor: 'system',
          payload: { role: 'planner', reason },
        });
        return;
      }
    }
    if (run.aborted) {
      finalizeContextMetric(planMetricId, undefined, planSession);
      console.log(`[agent] 规划会话被中止（task=${taskId}）——按中止语义收场`);
      return;
    }
    const result = run.result;
    finalizeContextMetric(planMetricId, result.usage, planSession);

    await persistUsage(usageDelta(result.usage, planSession), taskId, null, plannerId); // OPT-AI-8/B0-8：规划会话同口径（差值）
    const call = result.toolCalls.find((t) => t.name === 'submit_plan' && t.isError !== true);
    const rawSteps = call ? (call.input as { steps?: unknown }).steps : undefined;
    // B2-3/D-30②：结构化多件随 plan_drafted 带给引擎（校验在引擎 spawn 侧再做一次——双保险）。
    const rawWorkItems = call ? (call.input as { workItems?: unknown }).workItems : undefined;
    const workItems = rawWorkItems != null ? normalizePlanWorkItems(rawWorkItems) : null;
    const steps = Array.isArray(rawSteps)
      ? rawSteps
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, PLAN_STEPS_MAX)
      : [];
    if (steps.length === 0) {
      // BRK3 修：无有效计划 → `escalate`（任务 `needs_decision` ＋ 决策卡；可见、不静默停摆）。
      await deps.dispatch?.({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { role: 'planner', reason: 'no_plan' } });
      return;
    }
    await deps.dispatch?.({
      scope: 'task',
      id: taskId,
      event: 'plan_drafted',
      actor: `employee:${plannerId}`,
      payload: {
        steps,
        plannerEmployeeId: plannerId,
        // B2-3：合法结构化多件才透传；非法→不透传（引擎回落单件），响亮留痕不静默。
        ...(workItems != null && workItems.ok
          ? { workItems: workItems.items }
          : workItems != null && !workItems.ok
            ? { workItemsInvalid: workItems.message }
            : {}),
      },
    });
  }

  return {
    async execute(action: PersistedAction): Promise<void> {
      const target = parseDispatchAction(action);
      // 只接管 work_item `dispatch`；R3-1：任务级 planning 规划会话；G4：critic/verifier 评审会话。
      if (!target) {
        const review = parseReviewAction(action);
        if (review) {
          await runReview(review.role, review.taskId);
          return;
        }
        const planning = parsePlanningAction(action);
        if (planning) await runPlanning(planning.taskId);
        return;
      }

      const wi = getWorkItem(db as never, target.workItemId);
      if (!wi) throw new Error(`[employee-executor] 工作项不存在：${target.workItemId}`);
      const employeeId = wi.employee_id;
      // R2-2（G7 回灌）：本轮要带进简报的未读答复（会话收尾后标读——见下方 markAnswersRead）。
      const pendingAnswers = listUnreadAnswers(db as never, { taskId: target.taskId, employeeId });
      // BRK12：点名问本员工的未结提问（跨任务；askDedupeKey 供 answer_colleague 使用）。
      const pendingAsks = listOpenAsksForEmployee(db as never, employeeId).map((a) => ({
        askDedupeKey: a.askDedupeKey,
        from: a.from,
        question: a.question,
        blocking: a.blocking,
      }));
      const built = build(db, {
        employeeId,
        taskId: target.taskId,
        workItemId: target.workItemId,
        bossText: null,
        // R2-2（G7 回灌）：pre-run 取未读答复进简报；会话收尾后标读（崩溃则下轮重读，不静默丢失）。
        mailboxAnswers: pendingAnswers.map((a) => ({ from: a.from, answer: a.answer })),
        // BRK12：被问员工看到问题与 askDedupeKey。
        mailboxAsks: pendingAsks,
      });
      // G2：派发 payload 带的任务工作区 cwd（M1-4 worktree/staging）优先；否则用上下文默认（项目根）。
      const payloadCwd =
        action.payload && typeof action.payload === 'object' && typeof (action.payload as { cwd?: unknown }).cwd === 'string'
          ? ((action.payload as { cwd: string }).cwd)
          : undefined;
      const ctx = payloadCwd ? { ...built, meta: { ...built.meta, cwd: payloadCwd } } : built;
      const actor = `employee:${employeeId}`;
      // N5（`R3-3`）：执行会话档位（**L0 直通 → 经济档**；员工显式 > role_map 优先；L1/L2 不降）。
      const taskRow = getTaskById(db as never, target.taskId) as
        | {
            risk_level?: number | null;
            model?: string | null;
            project_id?: number | null;
            title?: string | null;
            goal?: string | null;
            acceptance?: unknown;
          }
        | null
        | undefined;
      const pref = getEmployeeModelPref(db as never, employeeId);
      const project = projectPolicyForTask(db, taskRow); // D-22：项目边界/默认
      const assistantChoice = await assistantChoiceFor(target.taskId, 'employee', taskRow, project);
      const resolvedTier = resolveSessionModel({
        role: 'employee',
        riskLevel: taskRow?.risk_level ?? null,
        taskModel: taskRow?.model ?? null, // 009：任务级模型（最高档）
        employeeModel: pref.model,
        employeeThinking: pref.thinking,
        project,
        assistantChoice,
      });
      const tier = gateModelKey(resolvedTier, project);
      recordModelTier(db, {
        taskId: target.taskId,
        workItemId: target.workItemId,
        employeeId,
        role: 'employee',
        tier,
        allowedBy: project?.allowedModels ?? [],
        ts: now(),
      });
      const rejected = rejectedModelError(tier);
      if (rejected) {
        await rejectWorkItemModel(target, rejected);
        return;
      }

      // CTX1-2：工作项上下文的真实读数落库（会话开始前；任务结束后回填用量/压缩）。
      const workSession = employeeSessionKey({ employeeId, taskId: target.taskId, workItemId: target.workItemId });
      const workMetricId = recordContextMetric({
        ctx,
        taskId: target.taskId,
        workItemId: target.workItemId,
        employeeId,
        projectId: taskRow?.project_id ?? null,
        sessionKey: workSession,
        model: tier.model,
      });
      let metricUsage: AgentUsage | undefined;

      let thinking = '';
      // G3：会话内工具计时（仅归因/留痕；不改执行顺序、不作并发通道）
      const toolStarts = new Map<string, number>();
      const timings: Array<{
        toolName: string;
        toolCallId: string;
        durationMs: number;
        ok: boolean;
        outputSummary?: string;
        outputRef?: string;
        outputBytes?: number;
      }> = [];
      let run: { aborted: true } | { aborted: false; result: AgentRunResult };
      // BRK-R6：会话有动静就刷新工作项心跳（最多每 30s 一次，避免每个 token 写库）。
      let lastHeartbeatAt = 0;
      // S1 修复：submit_work_item 成功后 SDK 可能立刻 terminate，提交事件尚未落库；
      // 记录工具成功事实与参数，catch 里据此补发，避免把已完成的件写成 failed。
      let submitInput: Record<string, unknown> | null = null;
      let submitSucceeded = false;
      const onEvent = (e: AgentEvent): void => {
        const at = now();
        if (at - lastHeartbeatAt >= 30_000) {
          try {
            heartbeatWorkItem(db as never, { taskId: target.taskId, workItemId: target.workItemId, now: at });
            lastHeartbeatAt = at;
          } catch (error) {
            console.error(`[agent] 心跳刷新失败（work_item ${target.workItemId}）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (e.type === 'thinking_delta') thinking += e.delta; // G5：收集思考流
        if (e.type === 'tool_call_start' && e.toolName === 'submit_work_item') submitInput = e.input;
        if (e.type === 'tool_call_end' && e.toolName === 'submit_work_item' && !e.isError) submitSucceeded = true;
        if (e.type === 'tool_call_start') {
          toolStarts.set(e.toolCallId, now()); // G3
          // RET-F-08：开始事件落 input（白名单/截断），让 DB 能回答“读了哪些文件/跑了什么命令”。
          try {
            insertTaskEvent(db as never, {
              taskId: target.taskId,
              workItemId: target.workItemId,
              ts: now(),
              kind: 'tool_call',
              actor,
              payload: {
                toolName: e.toolName,
                toolCallId: e.toolCallId,
                phase: 'start',
                input: sanitizeToolInput(e.input),
              },
            });
          } catch (error) {
            console.error(`[agent] tool_call start 落库失败（不影响会话）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (e.type === 'tool_call_end') {
          const startedAt = toolStarts.get(e.toolCallId);
          if (startedAt != null) {
            timings.push({
              toolName: e.toolName,
              toolCallId: e.toolCallId,
              durationMs: Math.max(0, now() - startedAt),
              ok: !e.isError,
              ...(e.outputSummary ? { outputSummary: e.outputSummary } : {}),
              ...(e.outputRef ? { outputRef: e.outputRef } : {}),
              ...(typeof e.outputBytes === 'number' ? { outputBytes: e.outputBytes } : {}),
            });
            toolStarts.delete(e.toolCallId);
          }
        }
      };
      // B2-3/D-30②：返工件会话继承——血缘源件存在且同员工 → 沿用「员工×任务×源件」会话键
      // （前轮现场可见，57 P1-7/P2-2）；换员工改派不继承（隔离优先，新会话）。
      const srcForSession = wi.retry_of != null ? getWorkItem(db as never, wi.retry_of) : undefined;
      const inheritedSessionKey = reworkInheritedSessionKey(srcForSession, employeeId, target.taskId);
      const runOne = async (prompt: string): Promise<{ aborted: true } | { aborted: false; result: AgentRunResult }> => {
        const r = await runSessionWithFallback(
          {
            employeeId,
            taskId: target.taskId,
            workItemId: target.workItemId,
            ...(inheritedSessionKey != null ? { sessionKey: inheritedSessionKey } : {}),
            systemPrompt: ctx.systemPrompt,
            userPrompt: prompt,
            cwd: ctx.meta.cwd,
            model: tier.model,
            thinkingLevel: tier.thinking ?? undefined,
            skills: ctx.meta.skillRefs,
            mcps: ctx.meta.mcpRefs,
          },
          onEvent,
          { role: 'employee', allowedModels: project?.allowedModels ?? [] },
        );
        // OPT-AI-8：每次会话（含补提交那一次）都入账——金额与行数如实。
        if (!r.aborted) {
          // B0-8：会话键跨轮稳定 ⇒ 累计统计必须按差值入账（nudge/重试不重复计入）。
          const sessionKey = employeeSessionKey({ employeeId, taskId: target.taskId, workItemId: target.workItemId });
          await persistUsage(usageDelta(r.result.usage, sessionKey), target.taskId, target.workItemId, employeeId);
        }
        return r;
      };
      try {
        const first = await runOne(ctx.userPrompt);
        if (!first.aborted) {
          const r = first.result;
          const hasSubmit = r.toolCalls.some((t) => t.name === 'submit_work_item' && t.isError !== true);
          const hasAsk = r.toolCalls.some((t) => t.name === 'ask_colleague' && t.isError !== true);
          const hasEscalate = r.toolCalls.some((t) => t.name === 'escalate_to_boss' && t.isError !== true);
          // 2026-10-17 MiMo 验收实测：模型把工作项当聊天题、只回文字不提交（L2 偶发）。
          // 兜底＝**再给一次明确提交回合**（只一次）；仍不提交才按失败收场。规划/评审/提问/升级不触发。
          if (!hasSubmit && !hasAsk && !hasEscalate && r.text.trim().length > 0) {
            const nudgePrompt =
              '【系统提醒】你刚才只回复了文字，没有调用 submit_work_item。现在必须调用 submit_work_item 提交本工作项（summary 必填；产物/证据按实际给）；不要只回复文字。';
            const second = await runOne(nudgePrompt);
            if (second.aborted) {
              run = second;
            } else {
              run = {
                aborted: false,
                result: {
                  ...second.result,
                  toolCalls: [...r.toolCalls, ...second.result.toolCalls],
                  text: second.result.text || r.text,
                },
              };
            }
          } else {
            run = first;
          }
        } else {
          run = first;
        }
        // CTX1-2：一次会话（含补提交第二轮）结束后，以最后一轮 usage 回填 cache 读数。
        metricUsage = 'result' in run ? run.result.usage : undefined;
      } catch (error) {
        // BRK17（挂载 3 余·取消小步）：老板取消会**真中止会话**（`AgentSession.abort()`）→ `prompt` 抛出。
        // 件已被**取消路径中断**（`interrupted`）时这不是「执行失败」：如实留一行说明按中止语义收场
        //（不再走 settle——回写会撞未知迁移）。其余状态照旧抛出（失败可见，不吞）。
        const message = error instanceof Error ? error.message : String(error);
        const wiNow = getWorkItem(db as never, target.workItemId);
        if (wiNow?.state === 'interrupted') {
          console.log(`[agent] 会话被中止（work_item ${target.workItemId}：interrupted）——按中止语义收场，不回写 settle`);
          return;
        }
        // 真机抓到：`submit_work_item` 成功后工具会 terminate，SDK `prompt` 以 `terminated` 抛出；
        // 件此时已经 submitted，不能再按会话失败写成 failed（否则 verifier 永远不派）。
        if (wiNow?.state === 'submitted') {
          console.log(
            `[agent] 会话在提交后结束（work_item ${target.workItemId}：submitted；${message.slice(0, 120)}）——保持 submitted，不写 failed`,
          );
          return;
        }
        // S1 修复（2026-10-24）：工具已成功但宿主事件尚未落库时，SDK 的 terminate 会抢在提交前面。
        // 不能只看 DB 状态；捕获到的成功 submit 是权威事实：先给正常事件一个落库窗口，落不下来就补发。
        if (submitSucceeded && submitInput) {
          const checked = validateSubmission(submitInput);
          if (checked.ok) {
            for (let i = 0; i < 25; i += 1) {
              if (getWorkItem(db as never, target.workItemId)?.state === 'submitted') {
                console.log(`[agent] 提交事件已落库（work_item ${target.workItemId}）——保持 submitted`);
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            if (deps.dispatch) {
              try {
                await deps.dispatch({
                  scope: 'work_item',
                  id: target.workItemId,
                  event: 'submit_work_item',
                  actor,
                  payload: { result: checked.value },
                });
                console.log(
                  `[agent] 会话在提交后终止（${message.slice(0, 120)}）→ 已补发 submit_work_item（work_item ${target.workItemId}）`,
                );
                return;
              } catch (dispatchError) {
                if (getWorkItem(db as never, target.workItemId)?.state === 'submitted') {
                  console.log(`[agent] 补发时提交事件已落库（work_item ${target.workItemId}）——保持 submitted`);
                  return;
                }
                console.error('[agent] 提交后终止：补发 submit_work_item 失败（继续按失败收场）', dispatchError);
              }
            }
          }
        }
        // N5 余账（2026-10-16，401 可视）：会话级失败（Key 无效 401/模型不可用且**兜底链也救不回**等）
        // → 件按真值表进 failed（`running --error--> failed`）⇒ 任务级失败聚合 ⇒ **异常卡**
        //（BRK2 通路）——此前只有 `action_failed` 日志，卡/横幅皆无（"Key 无效（401）不可见"）。无
        // `dispatch` 可报时照旧抛（action_failed 可见，绝不静默）。
        if (!deps.dispatch) throw error;
        const providerHint = isProviderUnavailableError(message) ? '模型/凭据不可用：' : '';
        try {
          await deps.dispatch({
            scope: 'work_item',
            id: target.workItemId,
            event: 'error',
            actor,
            payload: { reason: `${providerHint}${message}`.slice(0, 500), via: 'session_run_error' },
          });
        } catch (reportError) {
          console.error('[agent] 会话失败回写 `error` 事件失败（照旧抛原错）', reportError);
          throw error;
        }
        console.error(`[agent] 员工会话失败 → 件 ${target.workItemId} 进 failed（异常卡经任务聚合）：${message.slice(0, 200)}`);
        return;
      } finally {
        // CTX1-2：正常/中止/失败/提前返回都回填一次（缺用量保持 NULL；不阻断任何路径）。
        finalizeContextMetric(workMetricId, metricUsage, workSession);
      }
      if (run.aborted) {
        console.log(`[agent] 会话被中止（work_item ${target.workItemId}）——按中止语义收场，不回写 settle`);
        return;
      }
      const result = run.result;

      // G3：工具耗时落库（沿用既有 kind `tool_call`；只归因、不作并发通道）。
      for (const t of timings) {
        insertTaskEvent(db as never, {
          taskId: target.taskId,
          workItemId: target.workItemId,
          ts: now(),
          kind: 'tool_call',
          actor,
          payload: {
            toolName: t.toolName,
            toolCallId: t.toolCallId,
            durationMs: t.durationMs,
            ok: t.ok,
            phase: 'end',
            scope: 'session_tool',
            ...(t.outputSummary ? { outputSummary: t.outputSummary } : {}),
            ...(t.outputRef ? { outputRef: t.outputRef } : {}),
            ...(typeof t.outputBytes === 'number' ? { outputBytes: t.outputBytes } : {}),
          },
        });
      }

      // G5：思考落库（**脱敏 + 截断**；只本地、不进人类频道；无思考不写）。
      if (thinking.trim().length > 0) {
        insertTaskEvent(db as never, {
          taskId: target.taskId,
          workItemId: target.workItemId,
          ts: now(),
          kind: 'agent_thinking',
          actor,
          payload: { employeeId, text: sanitizeThinking(thinking) },
        });
      }

      // 会话内工具副作用（与真值表一致）：submit_work_item → 提交；ask_colleague → mailbox。
      const submit = result.toolCalls.find((t) => t.name === 'submit_work_item' && t.isError !== true);
      const recordToolError = (toolName: string, toolCallId: string, message: string): void => {
        console.error(`[agent] ${toolName} 参数/归属非法（work_item ${target.workItemId}）：${message}`);
        insertTaskEvent(db as never, {
          taskId: target.taskId,
          workItemId: target.workItemId,
          ts: now(),
          kind: 'tool_call',
          actor,
          payload: { toolName, toolCallId, phase: 'end', isError: true, error: message, scope: 'session_tool' },
        });
      };
      const asked = result.toolCalls.filter((t) => t.name === 'ask_colleague' && t.isError !== true);
      const blockingAskKeys: string[] = [];
      for (const [i, ask] of asked.entries()) {
        const to = Number((ask.input as { to?: unknown }).to);
        const question = String((ask.input as { question?: unknown }).question ?? '');
        const blocking = (ask.input as { blocking?: unknown }).blocking === true;
        if (!Number.isInteger(to) || !question) {
          recordToolError('ask_colleague', ask.id, '需要整数 to 与非空 question');
          continue;
        }
        try {
          // ADV-1 P0-1：序号必须**跨轮唯一**——旧实现用「本轮下标」i，每轮第一条都是 0，
          // 返工/重试轮的新问题撞上一轮旧键 → delivered:false → 静默丢失。改用动作版本
          // （actionKey 的 revision＝重试轮次）＋本轮下标；重放同一动作键不变（仍幂等）。
          const rec = requestAsk(db as never, {
            taskId: target.taskId,
            workItemId: target.workItemId,
            from: employeeId,
            to,
            question,
            blocking,
            seq: `r${target.attempt}-${i}`,
            now: now(),
          });
          if (!rec.delivered) {
            // 幂等重放（同一动作被 at-least-once 重执行）：不重复投递，但**留痕**（不静默）。
            insertTaskEvent(db as never, {
              taskId: target.taskId,
              workItemId: target.workItemId,
              ts: now(),
              kind: 'tool_call',
              actor,
              payload: {
                toolName: 'ask_colleague',
                toolCallId: ask.id,
                phase: 'end',
                replay: true,
                dedupeKey: rec.dedupeKey,
                question,
                scope: 'session_tool',
              },
            });
          }
          // B2-5/D-30：目标空闲 → 派轻量 reply 件唤醒（busy/exists 如实留痕不静默）。
          if (rec.delivered) {
            try {
              const wake = spawnReplyWorkItem(db as never, {
                taskId: target.taskId,
                askDedupeKey: rec.dedupeKey,
                from: employeeId,
                to,
                question,
                now: now(),
              });
              if (wake !== 'spawned') {
                insertTaskEvent(db as never, {
                  taskId: target.taskId,
                  workItemId: target.workItemId,
                  ts: now(),
                  kind: 'tool_call',
                  actor,
                  payload: { toolName: 'ask_colleague', toolCallId: ask.id, phase: 'end', replyWake: wake, dedupeKey: rec.dedupeKey, scope: 'session_tool' },
                });
              }
            } catch (wakeError) {
              console.error('[mailbox] reply 件唤醒失败（问题已投递，不阻断）', wakeError);
            }
          }
          if (blocking) blockingAskKeys.push(rec.dedupeKey);
        } catch (error) {
          recordToolError('ask_colleague', ask.id, error instanceof Error ? error.message : String(error));
        }
      }
      // BRK12：被问员工作答（只认「问我的」未结 ask）；阻塞式提问的对方工作项在此真唤醒。
      const answered = result.toolCalls.filter((t) => t.name === 'answer_colleague' && t.isError !== true);
      for (const call of answered) {
        const askDedupeKey = String((call.input as { askDedupeKey?: unknown }).askDedupeKey ?? '').trim();
        const rawAnswer = String((call.input as { answer?: unknown }).answer ?? '').trim();
        // B2-5：结构化答复（结论/依据/产物引用/追问）组装；旧单句原样
        const text = formatStructuredAnswer({
          answer: rawAnswer,
          conclusion: String((call.input as { conclusion?: unknown }).conclusion ?? '').trim() || undefined,
          evidence: Array.isArray((call.input as { evidence?: unknown }).evidence)
            ? ((call.input as { evidence?: unknown }).evidence as unknown[]).filter((e): e is string => typeof e === 'string')
            : undefined,
          artifacts: Array.isArray((call.input as { artifacts?: unknown }).artifacts)
            ? ((call.input as { artifacts?: unknown }).artifacts as unknown[]).filter((a): a is string => typeof a === 'string')
            : undefined,
          followup: String((call.input as { followup?: unknown }).followup ?? '').trim() || undefined,
        });
        if (askDedupeKey.length === 0 || text.length === 0) {
          recordToolError('answer_colleague', call.id, '需要 askDedupeKey 与非空 answer');
          continue;
        }
        try {
          const ask = getAsk(db as never, askDedupeKey);
          if (!ask || ask.to !== employeeId) {
            recordToolError('answer_colleague', call.id, `提问不存在或不是问员工 #${employeeId}：${askDedupeKey}`);
            continue;
          }
          const rec = answerAsk(db as never, {
            taskId: ask.taskId,
            workItemId: ask.workItemId,
            from: employeeId,
            to: ask.from,
            askDedupeKey,
            answer: text,
            via: 'employee',
            now: now(),
          });
          if (rec.delivered && ask.blocking && ask.workItemId != null) {
            await deps.dispatch?.({
              scope: 'work_item',
              id: ask.workItemId,
              event: 'answer_received',
              actor,
              payload: { via: 'employee_answer', employeeId },
            });
          }
        } catch (error) {
          recordToolError('answer_colleague', call.id, error instanceof Error ? error.message : String(error));
        }
      }
      // BRK5（挂载 1 余）：`report_progress` → `progress_reported` 事件 ＋ `plan_steps` 真投影
      //（复用**单一投影逻辑** `projectProgressReported`，actor＝员工；此前无消费者 ⇒ 回执「宿主会把这一步投影进
      //  任务进度条」是假承诺、进度条不动）。参数非法**响亮**（tool_call 标 error，与幕僚长侧同口径）且不阻断提交。
      const progress = result.toolCalls.filter((t) => t.name === 'report_progress' && t.isError !== true);
      for (const p of progress) {
        const input = p.input as { stepIdx?: unknown; state?: unknown; note?: unknown };
        try {
          projectProgressReported(db as never, {
            taskId: target.taskId,
            workItemId: target.workItemId,
            stepIdx: Number(input.stepIdx),
            state: input.state as PlanStepState,
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
            actor,
            at: now(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[agent] report_progress 投影失败（work_item ${target.workItemId}）：${message}`);
          insertTaskEvent(db as never, {
            taskId: target.taskId,
            workItemId: target.workItemId,
            ts: now(),
            kind: 'tool_call',
            actor,
            payload: { toolName: 'report_progress', toolCallId: p.id, phase: 'end', isError: true, error: message, scope: 'session_tool' },
          });
        }
      }
      // BRK5：`request_review` → 落 `review_requested` 事件（**指派/强制度仍由引擎 `requestReview` 在派工时按
      //  `risk_level` 决定**——v1 口径，与 `FLOWS` verify 分级一致；员工显式请求不改强制度）。
      const reviews = result.toolCalls.filter((t) => t.name === 'request_review' && t.isError !== true);
      for (const rr of reviews) {
        const reason = (rr.input as { reason?: unknown }).reason;
        insertTaskEvent(db as never, {
          taskId: target.taskId,
          workItemId: target.workItemId,
          ts: now(),
          kind: 'review_requested',
          actor,
          payload: { reason: typeof reason === 'string' ? reason : null, via: 'employee_tool' },
        });
      }
      // R2-2（G7 回灌）：答复已进本轮简报 → 标读（幂等；崩溃未标读则下轮重读，宁可重复上屏，不静默丢失）。
      if (pendingAnswers.length > 0) {
        markAnswersRead(db as never, pendingAnswers.map((a) => a.dedupeKey), now());
      }

      // 原始交流（rawConversation）：会话最终输出 → `agent_message`（供只读投影；成功/失败都记）
      if (result.text) {
        insertTaskEvent(db as never, {
          taskId: target.taskId,
          workItemId: target.workItemId,
          ts: now(),
          kind: 'agent_message',
          actor,
          payload: { employeeId, text: result.text },
        });
      }

      // G6：会话未落盘（惰性 flush 未发生）→ **响亮报错**，并在回写事件里带可见标记（不静默）。
      if (result.persisted === false) {
        console.error(`[agent] 员工会话未落盘（work_item ${target.workItemId}）—— 会话历史可能丢失（重启不可续）`);
      }
      const persistedPayload = result.persisted === false ? { sessionPersisted: false } : {};

      // 阻塞式 mailbox（M2 尾）：本轮有 blocking ask ⇒ 件从 running 进 blocked，**不再 settle**
      //（settle 会把件判成 failed/submitted，两者都在说谎）。答复到达后由 mailbox:answer 派
      // `answer_received` 回 queued，下一轮简报带未读答复继续。
      if (blockingAskKeys.length > 0) {
        if (!deps.dispatch) {
          throw new Error('[agent] 阻塞式 ask 已投递，但引擎未接线（deps.dispatch 缺失）——不能静默 settle');
        }
        await deps.dispatch({
          scope: 'work_item',
          id: target.workItemId,
          event: 'ask_blocked',
          actor,
          payload: { askDedupeKeys: blockingAskKeys },
        });
        console.log(`[agent] 件 ${target.workItemId} 因阻塞式提问暂停（ask=${blockingAskKeys.join(',')}）——答复后自动回队`);
        return;
      }

      // BRK17（挂载 3 余·取消小步）：**收尾竞态**——会话跑完了、但件已被取消路径**中断**
      //（`interrupted`：真实中止到达与模型收尾同时发生）⇒ 不再回写 settle/escalate
      //（回写会撞未知迁移或把已中止的件改回 failed——两样都在说谎）。
      const wiAtSettle = getWorkItem(db as never, target.workItemId);
      if (wiAtSettle?.state === 'interrupted') {
        console.log(`[agent] 件已被中断（work_item ${target.workItemId}：interrupted）——跳过 settle 回写`);
      } else if (submit) {
        // OPT-AI-7：宿主侧**再审一遍**（工具侧已校验——这里防绕过/防旧工具）；非法 → 失败路径 + 带原因（不静默）
        const checked = validateSubmission(submit.input);
        if (checked.ok) {
          await deps.dispatch?.({
            scope: 'work_item',
            id: target.workItemId,
            event: 'submit_work_item',
            actor,
            payload: { result: checked.value, ...persistedPayload },
          });
        } else {
          console.error(`[agent] 提交校验失败（work_item ${target.workItemId}）：${checked.errors.join('；')}`);
          await deps.dispatch?.({
            scope: 'work_item',
            id: target.workItemId,
            event: 'agent_settled',
            actor,
            payload: {
              submitted: false,
              submissionErrors: checked.errors,
              lastOutput: result.text.slice(-2000),
              ...persistedPayload,
            },
          });
        }
      } else {
        // 未提交 → agent_settled{submitted:false} → failed（reason='agent_settled'，M8-2① 既有）；附带最后输出，失败可见。
        await deps.dispatch?.({
          scope: 'work_item',
          id: target.workItemId,
          event: 'agent_settled',
          actor,
          payload: { submitted: false, lastOutput: result.text.slice(-2000), ...persistedPayload },
        });
      }

      // R2-2（G9 升级）＋BRK11（挂载 2，2026-10-15）：员工调 escalate_to_boss → dispatch `escalate`
      //（任务进 `needs_decision`；**卡由状态机侧唯一合成**——此前此处再内联一张 notify ⇒ 同题两张卡，审计抓）。
      // 提问文本/紧急度/归属随 payload 透传（状态机 `NOTIFY_PASSTHROUGH_KEYS` → 决策卡 payload）。
      // `notifyRevision = employeeId·1000+i`：同一 (员工,序号) 升级只出一张卡（幂等＝动作键）。
      // 放在 submit 之后：升级＝最后一句话（等老板裁决），不被同轮的提交覆盖。
      // BRK17（取消小步）：件已被中断时不再弹升级卡（任务已取消，弹了也没人回——不打扰）。
      if (wiAtSettle?.state !== 'interrupted') {
        const escalations = result.toolCalls.filter((t) => t.name === 'escalate_to_boss' && t.isError !== true);
        for (const [i, esc] of escalations.entries()) {
          const input = esc.input as { question?: unknown; options?: unknown; selection?: unknown };
          const question = String(input.question ?? '').trim();
          if (!question) continue;
          // RW-21 泛化：工具传入的结构化选项直通决策卡按钮（脏数据丢弃——只留 key/label 都是非空字符串的项）。
          const rawOptions = Array.isArray(input.options) ? input.options : [];
          const options = rawOptions
            .filter((o): o is { key: string; label: string } => {
              const rec = o as { key?: unknown; label?: unknown };
              return typeof rec.key === 'string' && rec.key.trim().length > 0 && typeof rec.label === 'string' && rec.label.trim().length > 0;
            })
            .map((o) => ({ key: o.key.trim(), label: o.label.trim() }))
            .slice(0, 4);
          // 多选（老板 2026-10-28 指令）：single/multi 声明透传；其余值丢弃（缺省单选）。
          const selection = input.selection === 'multi' || input.selection === 'single' ? input.selection : undefined;
          await deps.dispatch?.({
            scope: 'task',
            id: target.taskId,
            event: 'escalate',
            actor,
            payload: {
              question,
              ...(options.length > 0 ? { options } : {}),
              ...(selection != null ? { selection } : {}),
              employeeId,
              workItemId: target.workItemId,
              via: 'escalate_to_boss',
              urgent: true, // 员工被卡住＝紧急：静默期内也照常推（PLAN §151 优先级维）
              notifyRevision: employeeId * 1000 + i,
            },
          });
        }
      }
    },
  };
}
