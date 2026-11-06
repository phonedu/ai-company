/**
 * 引擎共享类型（DEV §5、PLAN §19、schema.sql 的 `action_log` 规范）。
 */
import type { SchedulerConfig } from '../../core/scheduler.js';
import type { TaskState } from '../../core/types.js';

/** 事件来源：任务机 / 工作项机。进入串行循环的统一输入形状（可脚本化注入）。 */
export interface EngineEvent {
  scope: 'task' | 'work_item';
  /** scope='task' 时为 taskId；scope='work_item' 时为 workItemId。 */
  id: number;
  /** 事件名（见 statemachine 的事件列）。 */
  event: string;
  actor?: string;
  payload?: Record<string, unknown>;
  /** epoch ms；缺省用引擎时钟。 */
  ts?: number;
}

export type ActionSubjectKind = 'task' | 'work_item' | 'report' | 'changeset';

/** 副作用动作（事务外执行、幂等）。 */
export interface EngineAction {
  /** 动作类型，如 dispatch_planning / notify_report / dispatch。 */
  kind: string;
  subjectKind: ActionSubjectKind;
  subjectId: number;
  /** 主体上的「第几次」（work_item.attempt；无自然次数用 0）。 */
  revision: number;
  taskId: number | null;
  payload: Record<string, unknown>;
}

/** `action_key` = `<kind>:<subject_kind>:<subject_id>:<revision>`（schema.sql 规范）。 */
export function actionKeyOf(action: EngineAction): string {
  return `${action.kind}:${action.subjectKind}:${action.subjectId}:${action.revision}`;
}

/** 已登记的动作（从 action_log 读回，交给执行器）。 */
export interface PersistedAction {
  actionKey: string;
  kind: string;
  taskId: number | null;
  payload: Record<string, unknown>;
}

/**
 * 副作用执行器（可注入）：M0 用桩实现（记录/无真实 LLM）；
 * **必须幂等**——「已执行、未置 done」的崩溃窗口内的重放是 at-least-once。
 */
export interface EffectExecutor {
  execute(action: PersistedAction): void | Promise<void>;
}

export interface EngineConfig {
  scheduler?: Partial<SchedulerConfig>;
  /** N2：速率阈值（降档线/排队线，$/h）；缺省＝env AICO_RATE_LIMIT_USD_PER_HOUR（默认 3，排队线＝×1.5）。 */
  rateLimit?: { softUsdPerHour?: number; hardUsdPerHour?: number };
  /** N3(P20/P22)：并发上限——**卡"正在工作"的数量，不卡人头**（闲置员工回收后 ≈ 零成本）。缺省 任务内 3 / 公司级 6。 */
  concurrency?: { maxPerTask?: number; maxCompany?: number };
  /** 是否运行调度 fixpoint（DEV §5）。默认 true；手工逐步驱动（T0.6 证据）可置 false。 */
  autoSchedule?: boolean;
  /** 异步循环 tick 间隔（ms），用于定时器看门狗。默认 1000。 */
  tickMs?: number;
  /** 时钟（测试可注入 fake clock）。 */
  now?: () => number;
  /** 事件总线（推送渲染进程/测试观察）。 */
  onEvent?: (event: EngineEvent) => void;
  /**
   * 已提交事件回调：**事务提交后**逐条回调（入队时/回滚时都不触发）。
   * 用于「必须看到已落库状态」的副作用（如 RM-2：任务离开待决策后清理同任务 pending 卡）。
   */
  onCommitted?: (event: EngineEvent) => void;
  /** BRK15：卡片落库回调（`evt:notify`/`evt:inbox` 实时推送的接线点；缺省＝不推，渲染层靠下一次拉取）。 */
  onCard?: (info: { taskId: number | null; kind: string; card: string }) => void;
  /**
   * UG-02：任务截止提醒/逾期回调（由 main 注入 → `notify()` 落 alert 卡）。
   * **只提醒，不改状态**；终态任务的残留 timer 由引擎丢弃。
   */
  onDeadline?: (info: {
    taskId: number;
    shortId: string | null;
    title: string;
    deadline: number;
    overdue: boolean;
  }) => void;
  /**
   * BRK17/BRK4：任务级取消/暂停真中断在跑工作项后，**逐件回调**（由 main 注入 →
   * 真停该件的员工会话，`AgentSession.abort()`）。缺省不回调（测试/旧装配——停件仍生效，仅会话停不做）。
   */
  onWorkItemInterrupted?: (info: { workItemId: number; employeeId: number; taskId: number }) => void;
  /**
   * BRK17/BRK4：任务级取消/暂停时**按任务**回调一次（由 main 注入 → 停不挂件的**角色会话**：
   * planner/critic/verifier——如验证中跑着的 verifier 会话）。缺省不回调。
   */
  onTaskCancelled?: (info: { taskId: number }) => void;
  /** M1-4 接缝：提供 git runner 后，派发时解析任务工作目录、完成时按 `touched_paths` 提交。 */
  git?: import('../git/index.js').GitRunner;
  /** worktree 根目录（默认 `<repo>/../.aico-worktrees`）。 */
  worktreesBaseDir?: string;
  /** M1-1：受管工作单元台账管理器（与会话生命周期配套）。 */
  effectScopes?: import('./effect-scope.js').EffectScopeManager;
  /**
   * OPT-M9-1：权限闸门（**默认开启**——副作用动作执行前过 `permissionGate`）。
   * 传 `false` 显式关闭（仅测试/明确无需防护时）；传对象覆盖缺省能力档/放行档/项目根。
   */
  permission?: PermissionConfig | false;
}

/** OPT-M9-1：默认引擎路径的权限配置（缺省对每个动作按任务/项目从 DB 解析）。 */
export interface PermissionConfig {
  /** 员工能力档缺省（`employees.capability_tier` 缺失时）。默认 `standard`。 */
  capabilityTier?: 'sandbox' | 'standard' | 'trusted';
  /** DB 无任何策略时的缺省放行档。默认 `standard`。 */
  defaultAutonomy?: 'strict' | 'standard' | 'loose';
  /** 项目根缺省（项目 `root_dir` 缺失时）。默认 `process.cwd()`。 */
  projectRoot?: string;
}

/** 任务迁移上下文。 */
export interface TaskTransitionContext {
  taskId: number;
  from: TaskState;
  now: number;
  actor: string;
  riskLevel: 0 | 1 | 2;
  payload: Record<string, unknown>;
  resumeState: TaskState | null;
  stateBeforeClose: TaskState | null;
  /** AskCard 超时默认动作（'approve' 等）。 */
  defaultAction: string | null;
  /** 该任务是否已有 work item（executing→verifying 判据）。 */
  hasWorkItems?: boolean;
  allWorkItemsDone?: boolean;
  /**
   * 计划轮次（＝已产出的 `plan_drafted` 事件数；**本次事件写入前**计数 ⇒ 首版为 0）。
   * 用途（重规划 v+1）：`dispatch_planning` / `dispatch_critic` 的**幂等键带轮次**——
   * 否则打回后重规划时键与首轮相同、`OR IGNORE` 吞掉动作 ⇒ 任务永停 `planning`（真机缺口）。
   */
  planRevision?: number;
}
