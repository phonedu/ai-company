/**
 * `statemachine.ts` —— FLOWS §3.1 状态迁移真值表的**代码化**（唯一权威）。
 *
 * 本文件把 §3.1.1（任务，49 行）与 §3.1.2（工作项，16 行）逐行编码为数据表：
 *   `(from, event, guard) → to / 写哪些 task_events.kind / 触发哪些动作`。
 * **不得自行发明迁移**：新增状态/事件先改 FLOWS §3.1 再改本文件。
 *
 * M0 范围：只实做/测试 T0.6 主链（inbox→planning→awaiting_approval→ready→executing→verifying→done）
 * 与该链上的 paused/needs_decision；其余行的**规则**（from/event/guard→to/kind）照表写全，
 * 但触发动作留 M2（`m0: false`，actions 为空或仅登记）。
 */
import type { TaskState, WorkItemState } from '../../core/types.js';
import type { TaskPatch } from '../db/tasks.js';
import type { EngineAction } from './types.js';

export type TaskFrom = TaskState | 'NEW' | '*';

export interface TaskTransition {
  from: TaskFrom | TaskFrom[];
  event: string;
  guard?: (ctx: TaskTransitionContext) => boolean;
  to: TaskState | 'KEEP' | 'resume_state' | 'state_before_close';
  kinds: string[];
  patch?: (ctx: TaskTransitionContext) => TaskPatch;
  actions?: (ctx: TaskTransitionContext) => EngineAction[];
  /** true = M0 主链/paused/needs_decision（被实现并测试）。 */
  m0: boolean;
  /** 便于追溯的 FLOWS 行备注。 */
  note?: string;
}

export interface TaskTransitionContext {
  taskId: number;
  from: TaskState;
  now: number;
  actor: string;
  riskLevel: 0 | 1 | 2;
  payload: Record<string, unknown>;
  resumeState: TaskState | null;
  stateBeforeClose: TaskState | null;
  defaultAction: string | null;
  /** B6：超时默认动作的语义档（由 loop 从 `approvals` 行 + 白名单判定）；守卫只读它。 */
  defaultActionKind?: DefaultActionKind;
  /** 进入终态的时刻（epoch ms）；`undo_finish` 的 7 天窗口用（FLOWS §3.1.1）。 */
  closedAt?: number | null;
  /** 是否已归档（`tasks.archived`）；已归档不允许撤销结束，只能续办。 */
  archived?: boolean;
  hasWorkItems?: boolean;
  allWorkItemsDone?: boolean;
  /**
   * 计划轮次（＝已产出的 `plan_drafted` 事件数；**本次事件写入前**计数 ⇒ 首版为 0）。
   * 用途（重规划 v+1）：`dispatch_planning` / `dispatch_critic` 的**幂等键带轮次**——
   * 否则打回后重规划时键与首轮相同、`OR IGNORE` 吞掉动作 ⇒ 任务永停 `planning`（真机缺口）。
   */
  planRevision?: number;
  /** `decision_made` 已发生数（本次事件前）；BRK25 答卡回 planning 时用它生成新重派键。 */
  decisionRevision?: number;
  /**
   * 续跑轮次（＝已发生的 `task_resumed` 事件数；**本次事件写入前**计数 ⇒ 首次为 0）。
   * 用途（BRK4）：暂停恢复后重跑 verifier 时，幂等键必须比暂停前那一轮大——否则
   * `dispatch_verifier:task:<id>:0` 已被 `OR IGNORE` 吞掉，恢复后无人再验收。
   */
  resumeRevision?: number;
  /**
   * 验证轮次（＝已发生的 `verification_started` 事件数；**本次事件写入前**计数 ⇒ 首轮 0）。
   * 用途（RW-3，M5 真实测试带回）：验证 fail → 返工 → 第二次 `verification_started` 时，
   * resumeRevision 仍为 0 ⇒ 键不变被 `OR IGNORE` 吞掉 ⇒ 任务永停 verifying（真机挂死）。
   * verifier 幂等键改用本轮次（兼容覆盖 BRK4 暂停恢复场景：resume 后重验时计数同样 +1）。
   */
  verifyRevision?: number;
  /** B8：本任务短号（续办时写入 `task_renewed` payload，供“续自 T-xxx”显示）。 */
  shortId?: string;
}

/** 「撤销结束」窗口：`done` 后 7 天内可原地复活（FLOWS §3.1.1）。 */
export const UNDO_FINISH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_STATES = new Set<TaskState>(['done', 'failed', 'cancelled']);
const NON_TERMINAL_STATES = new Set<TaskState>([
  'inbox',
  'planning',
  'awaiting_approval',
  'ready',
  'executing',
  'paused',
  'verifying',
  'needs_decision',
  'blocked',
]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

function act(
  kind: string,
  subjectKind: EngineAction['subjectKind'],
  subjectId: number,
  revision: number,
  taskId: number,
  payload: Record<string, unknown> = {},
): EngineAction {
  return { kind, subjectKind, subjectId, revision, taskId, payload };
}

/**
 * B6：超时**允许自动执行**的默认动作白名单（**fail-closed**）。
 *
 * - 只列**非破坏性**动作：`keep`（保持）/ `pause`（暂缓）——超时**不是**老板批准了取消/删除；
 * - **不在表内一律不自动**（含 `default_action == null`＝「一直等」、未定义 key、`variant==='danger'`）；
 * - **扩表必须显式改本常量 + `FLOWS §3.1.1`**（B6 裁定：改能力要留痕）。
 */
export const TIMEOUT_AUTO_ACTIONS: readonly string[] = ['keep', 'pause'];

/** 超时默认动作的语义档：`auto` 可自动执行 / `none` 一直等 / `blocked` 有值但不允许自动。 */
export type DefaultActionKind = 'auto' | 'none' | 'blocked';

/** 把 `default_action`（选项 key）+ 选项表判成语义档（唯一判据入口；守卫只读结果、不读裸 key）。 */
export function resolveDefaultActionKind(
  defaultAction: string | null | undefined,
  options?: ReadonlyArray<{ key?: unknown; variant?: unknown }> | null,
): DefaultActionKind {
  if (defaultAction == null || defaultAction === '') return 'none';
  if (!TIMEOUT_AUTO_ACTIONS.includes(defaultAction)) return 'blocked';
  const opt = options?.find((o) => o?.key === defaultAction);
  if (opt && opt.variant === 'danger') return 'blocked';
  return 'auto';
}

/**
 * 会话动作。**planning / critic 的幂等键带计划轮次**（`ctx.planRevision`；首版＝0 与旧键一致）——
 * 重规划 v+1 时若键不变，`OR IGNORE` 会吞掉动作 ⇒ 打回后无人再规划/再评审（真机缺口「重规划 v+1」）。
 * **verifier 的幂等键带 max(verifyRevision, resumeRevision)**（RW-3）：验证 fail 返工后的再验证
 * （resumeRevision 不变）与暂停恢复后的再验证（verifyRevision 同步 +1）都必须能再派真验收——
 * 取两者较大值保证任一「再验证」轮的键都未被消费过（首轮＝0 与旧键一致，存量键不变）。
 */
const sessionAction = (ctx: TaskTransitionContext, phase: 'planning' | 'critic' | 'verifier'): EngineAction =>
  act(
    `dispatch_${phase}`,
    'task',
    ctx.taskId,
    phase === 'verifier' ? Math.max(ctx.verifyRevision ?? 0, ctx.resumeRevision ?? 0) : (ctx.planRevision ?? 0),
    ctx.taskId,
    { phase },
  );

/** BRK10/11：notify 动作**透传白名单**（决策卡要带 question/options/审批回挂/紧急度——不整包透传，防大载荷进 action_log）。 */
// RW-6（M5 真机带回）：增补 `notes`/`round`——critic 打回达上限的升级必须把评审意见与轮次带上卡
// （runNotifyAction 只对 critic_revise_limit 消费这两个键，截断后进 payload.body；其余升级不受影响）。
// 多选＋自定义作答（老板 2026-10-28 指令）：`selection`（single/multi）随升级透传——员工可问多选题。
const NOTIFY_PASSTHROUGH_KEYS = ['question', 'options', 'selection', 'urgent', 'employeeId', 'workItemId', 'via', 'approvalId', 'permissionKey', 'reason', 'modelRejected', 'notes', 'round'] as const;

const notifyAction = (ctx: TaskTransitionContext, card: string, revision = 0): EngineAction => {
  const extras: Record<string, unknown> = {};
  for (const key of NOTIFY_PASSTHROUGH_KEYS) {
    if (ctx.payload[key] !== undefined) extras[key] = ctx.payload[key];
  }
  return act(`notify_${card}`, 'task', ctx.taskId, revision, ctx.taskId, { card, ...extras });
};

/**
 * BRK17（挂载 3 余·取消，`D-9`／2026-10-16 余两态）：取消的公共动作——
 * ① `interrupt_work_items`：按真值表中断在跑的件（`pause_task`）＋回调停件级会话；
 * ② `notify_report{outcome:'cancelled'}`：收尾卡「已取消：…」（不谎报「完成」）。
 * 角色会话（planner/critic/verifier，不挂件）的停靠 `interrupt_work_items` 执行端一并回调（`onTaskCancelled`）。
 */
const cancelActions = (ctx: TaskTransitionContext): EngineAction[] => [
  act('interrupt_work_items', 'task', ctx.taskId, 0, ctx.taskId, { via: 'task_cancel' }),
  act('notify_report', 'task', ctx.taskId, 0, ctx.taskId, { card: 'report', outcome: 'cancelled' }),
];

/**
 * BRK4（M3-R-1）：暂停的公共动作——**真中断在跑的件/会话**，但**不做取消收尾**：
 * 已提交的件保持 submitted（恢复后聚合），queued 件保持 queued；resume 仍回 ready 走调度，
 * 由引擎在 `start_task` 后重派 interrupted 件并重新聚合（见 loop 的 pause/resume 批注）。
 */
const pauseActions = (ctx: TaskTransitionContext): EngineAction[] => [
  // 幂等键带 resumeRevision：同一任务可多次暂停（每次暂停前可能已 continue 过），
  // 固定 revision=0 会让第二次暂停的 interrupt 动作被 OR IGNORE 吞掉 ⇒ 在跑件不停。
  act('interrupt_work_items', 'task', ctx.taskId, ctx.resumeRevision ?? 0, ctx.taskId, { via: 'task_pause' }),
];

/**
 * B8 续办：登记幂等 spawn 动作 → 事务外由引擎建新任务（`createTask` 自开事务，不可嵌套）。
 * 键 = `renew:task:<oldTaskId>:0` ⇒ **同一旧任务最多续办一次**（第二次点续办被 `OR IGNORE` 拦下）。
 */
const renewAction = (ctx: TaskTransitionContext): EngineAction[] => [
  act('renew', 'task', ctx.taskId, 0, ctx.taskId, {
    parentTaskId: ctx.taskId,
    ...(ctx.shortId ? { renewedFromShortId: ctx.shortId } : {}),
  }),
];

/**
 * B10 验证打回：登记幂等 spawn 动作 → 事务外建新 work item（`insertWorkItem` 自开事务）。
 * 键 = `spawn_work_item:work_item:<srcWiId>:0` ⇒ **同一被打回工作项只生成一个返工项**。
 * 无来源工作项（未带 `workItemId`）⇒ 不建（不凭空造对象）。
 */
const spawnReworkAction = (ctx: TaskTransitionContext): EngineAction[] => {
  const srcWi = typeof ctx.payload.workItemId === 'number' ? ctx.payload.workItemId : null;
  if (srcWi == null) return [];
  return [
    act('spawn_work_item', 'work_item', srcWi, 0, ctx.taskId, {
      workItemId: srcWi,
      notes: (ctx.payload.notes ?? ctx.payload.reason ?? null) as unknown,
      employeeId: (ctx.payload.employeeId ?? null) as unknown,
    }),
  ];
};

/** 关闭到终态：写 closed_at + 快照 state_before_close（撤销结束回边用）。 */
const close = (ctx: TaskTransitionContext): TaskPatch => ({
  closed_at: ctx.now,
  state_before_close: ctx.from,
});

const readyNow = (ctx: TaskTransitionContext): TaskPatch => ({ ready_since: ctx.now });

// ─────────────────────────── 任务机（FLOWS §3.1.1，49 行） ───────────────────────────

export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  // —（新建）
  {
    from: 'NEW',
    event: 'task_created',
    to: 'inbox',
    kinds: ['task_created'],
    m0: false,
    note: '建任务流程（db.createTask）负责落库；本行供追溯',
  },
  // inbox
  { from: 'inbox', event: 'triage', to: 'planning', kinds: ['task_triaged'], actions: sessionActionP, m0: true },
  { from: 'inbox', event: 'confirm_as_task', to: 'planning', kinds: ['task_triaged'], actions: sessionActionP, m0: true },
  {
    from: 'inbox',
    event: 'ask_owner',
    to: 'needs_decision',
    kinds: ['decision_requested'],
    patch: () => ({ resume_state: 'inbox' }),
    actions: (ctx) => [notifyAction(ctx, 'decision')],
    m0: true,
  },
  { from: 'inbox', event: 'discard', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // planning
  {
    from: 'planning',
    event: 'plan_drafted',
    guard: (ctx) => ctx.riskLevel === 0,
    to: 'ready',
    kinds: ['plan_drafted'],
    patch: readyNow,
    actions: planWorkItemsAction,
    m0: true,
    note: 'L0 直通（计划即终稿 → 同批建工作项，C2）',
  },
  {
    from: 'planning',
    event: 'plan_drafted',
    guard: (ctx) => ctx.riskLevel >= 1,
    to: 'KEEP',
    kinds: ['plan_drafted'],
    actions: sessionActionC,
    m0: true,
    note: 'L1/L2：启动 critic',
  },
  {
    from: 'planning',
    event: 'plan_reviewed',
    to: 'awaiting_approval',
    kinds: ['plan_reviewed'],
    // V3 修：critic 判 `revise` 时本行只是**过路态**（下一步 `revise` 回 planning）——不产出批准卡/审批行，
    // 否则真库出现「planning＋卡 pending＋审批待答」三方不一致（幽灵卡）。approve/无 verdict → 照常出卡。
    actions: (ctx) => (ctx.payload.verdict === 'revise' ? [] : [notifyAction(ctx, 'approval')]),
    m0: true,
  },
  { from: 'planning', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  {
    from: 'planning',
    event: 'error',
    to: 'failed',
    kinds: ['task_failed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'alert')],
    m0: false,
    note: 'C2 真机（2026-10-17）：规划会话模型/凭据不可用（兜底链耗尽）→ failed＋异常卡；不再伪装 no_plan',
  },
  // awaiting_approval
  {
    from: 'awaiting_approval',
    event: 'plan_approved',
    to: 'ready',
    kinds: ['plan_approved'],
    patch: readyNow,
    actions: planWorkItemsAction,
    m0: true,
  },
  {
    from: 'awaiting_approval',
    event: 'plan_edited',
    to: 'KEEP',
    kinds: ['plan_edited'],
    // GAP8：老板在批准前增删/排序计划。仍是事件驱动的 materialized 投影
    // （plan_edited.payload.steps[] → plan_steps）；状态不变、不派会话、不建工作项——
    // 批准（plan_approved）仍走下一行，派工读到的就是改后的 plan_steps。
    m0: true,
    note: '批准前编辑计划：状态保持 awaiting_approval；卡与详情同步新计划',
  },
  {
    from: 'awaiting_approval',
    event: 'askcard_timeout',
    guard: (ctx) => ctx.riskLevel === 1 && ctx.defaultAction === 'approve',
    to: 'ready',
    kinds: ['plan_approved'],
    patch: readyNow,
    // BRK1 修：FLOWS §3.1.1 该行明写「同上一行（含建工作项）」——缺了它 ⇒ 超时通过的任务
    // `ready→executing` 零工作项、永久空转（无派工、无聚合、无汇合）。
    actions: planWorkItemsAction,
    m0: false,
  },
  {
    from: 'awaiting_approval',
    event: 'revise',
    to: 'planning',
    kinds: ['plan_reviewed'],
    // 重规划 v+1（工单）：打回 ⇒ **真再派规划会话**（键带轮次：`dispatch_planning:…:<planRevision>`；
    // 首轮键 :0 已用 ⇒ 无此动作时任务永停 `planning`）。「带意见」由规划上下文（上一版计划＋打回意见）承担；
    // 无限重规划由执行器侧安全阀（critic 打回达上限 → escalate）兜住。
    actions: sessionActionP,
    m0: true,
    note: 'critic 判 block / 老板打回 → 重规划 v+1（不从头再来）',
  },
  { from: 'awaiting_approval', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // ready
  { from: 'ready', event: 'start_task', to: 'executing', kinds: ['task_started'], m0: true },
  { from: 'ready', event: 'hold', to: 'KEEP', kinds: [], m0: false, note: '纯等待，不写事件' },
  { from: 'ready', event: 'pause', to: 'paused', kinds: ['task_paused'], m0: true },
  { from: 'ready', event: 'block', to: 'blocked', kinds: ['task_blocked'], m0: true },
  { from: 'ready', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // executing
  {
    from: 'executing',
    event: 'all_work_items_done',
    to: 'verifying',
    kinds: ['verification_started'],
    // D3：**无事可验**（聚合事件带 `verificationNeeded:false`＝全部工作项验证强度＝none，如 L0/未命中抽验）
    // → **不派 verifier 会话**（派了也没人可当 verifier ≠ 实现者，先前会响亮失败）；任务级验收由引擎如实自动 pass。
    actions: (ctx) => ((ctx.payload as { verificationNeeded?: boolean } | undefined)?.verificationNeeded === false ? [] : sessionActionV(ctx)),
    m0: true,
    note: '由 §3.1.2 聚合触发（引擎在全部 work item 已终结/已提交时发出；`verificationNeeded=false` ⇒ 免验自动通过）',
  },
  {
    from: 'executing',
    event: 'budget_exceeded',
    to: 'paused',
    kinds: ['budget_exceeded', 'task_paused'],
    actions: (ctx) => [notifyAction(ctx, 'alert')],
    m0: true,
  },
  {
    from: 'executing',
    event: 'pause',
    to: 'paused',
    kinds: ['task_paused'],
    actions: pauseActions,
    m0: true,
    note: 'BRK4：中断在跑件/停会话；已提交件保留，resume 走 ready→调度重新聚合',
  },
  { from: 'executing', event: 'block', to: 'blocked', kinds: ['task_blocked'], m0: true },
  {
    from: 'executing',
    event: 'fail',
    to: 'failed',
    kinds: ['task_failed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'alert')],
    m0: true,
  },
  {
    from: 'executing',
    event: 'finish_manual',
    to: 'done',
    kinds: ['task_completed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'report')],
    m0: true,
  },
  {
    from: 'executing',
    event: 'cancel',
    to: 'cancelled',
    kinds: ['task_cancelled'],
    patch: close,
    actions: cancelActions,
    m0: true,
    note: '取消：停件/停会话/收尾卡；UI＝行内二次确认（FLOWS §3 UI 列同批）',
  },
  // verifying
  {
    from: 'verifying',
    event: 'verification_completed',
    guard: (ctx) => (ctx.payload.verdict ?? 'pass') === 'pass',
    to: 'done',
    kinds: ['verification_completed', 'task_completed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'report')],
    m0: true,
  },
  {
    from: 'verifying',
    event: 'verification_completed',
    guard: (ctx) => (ctx.payload.verdict ?? 'pass') !== 'pass',
    to: 'executing',
    kinds: ['verification_completed', 'work_item_created'],
    m0: true,
    actions: spawnReworkAction,
    note: '打回：批注变新 work item（B10：验证者批注同事务登记 spawn 动作，事务外按其幂等键建新 wi）',
  },
  {
    from: 'verifying',
    event: 'pause',
    to: 'paused',
    kinds: ['task_paused'],
    actions: pauseActions,
    m0: true,
    note: 'BRK4：停 verifier 会话；resume 后按 resumeRevision 重新派 verifier',
  },
  {
    from: 'verifying',
    event: 'cancel',
    to: 'cancelled',
    kinds: ['task_cancelled'],
    patch: close,
    // BRK17（取消余两态，2026-10-16）：验证中也真中止——已提交的件不再验证（收尾卡如实）；
    // 跑着的 verifier 角色会话由 `onTaskCancelled` 停（不挂件）。
    actions: cancelActions,
    m0: true,
    note: '取消（余两态）：停件/停 verifier 会话/收尾卡；UI＝行内二次确认',
  },
  // blocked
  { from: 'blocked', event: 'task_activated', to: 'ready', kinds: ['task_activated'], patch: readyNow, m0: true },
  { from: 'blocked', event: 'unblock', to: 'ready', kinds: ['task_activated'], patch: readyNow, m0: true },
  {
    from: 'blocked',
    event: 'blocked_watchdog',
    to: 'needs_decision',
    kinds: ['decision_requested'],
    patch: () => ({ resume_state: 'blocked' }),
    actions: (ctx) => [notifyAction(ctx, 'decision')],
    m0: false,
  },
  { from: 'blocked', event: 'pause', to: 'paused', kinds: ['task_paused'], m0: true },
  { from: 'blocked', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // paused
  { from: 'paused', event: 'resume', to: 'ready', kinds: ['task_resumed'], patch: readyNow, m0: true },
  {
    from: 'paused',
    event: 'finish',
    to: 'done',
    kinds: ['task_completed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'report')],
    m0: true,
  },
  { from: 'paused', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // needs_decision
  {
    from: 'needs_decision',
    event: 'decision_made',
    to: 'resume_state',
    kinds: ['decision_made'],
    // BRK25：答复决策卡只是状态回边；resume=planning 时必须重派规划会话，否则任务永停 planning。
    actions: decisionResumeAction,
    m0: true,
  },
  {
    from: 'needs_decision',
    event: 'decision_proceed_latest',
    // RW-21 收尾（M5 真机 S9）：「按最新版继续」＝**最新稿视同批准**（不重规划）——
    // 与 awaiting_approval+plan_approved 同语义（readyNow＋建工作项）。仅规划期升级有意义；
    // 验证期升级（resume=verifying）不适用（跳过验收＝危险，guard 拦下→作答走别的选项）。
    guard: (ctx) => ctx.resumeState === 'planning',
    to: 'ready',
    kinds: ['decision_made'],
    patch: readyNow,
    actions: planWorkItemsAction,
    m0: true,
  },
  {
    from: 'needs_decision',
    event: 'askcard_timeout',
    // B6（FLOWS §3.1.1 L252 + 裁定）：**fail-closed 白名单**——只有非破坏性默认动作才自动执行；
    // null（一直等）/ 白名单外 / danger 一律到期只留痕、不迁移。
    guard: (ctx) => ctx.defaultActionKind === 'auto',
    to: 'resume_state',
    kinds: ['decision_made'],
    // BRK25：超时自动决策同样要重派（resume=planning）。
    actions: decisionResumeAction,
    m0: true,
  },
  { from: 'needs_decision', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // done
  {
    from: 'done',
    event: 'undo_finish',
    // 守卫（FLOWS §3.1.1）：`now - closed_at ≤ 7d` 且 `archived = 0`
    guard: (ctx) =>
      ctx.archived !== true && ctx.closedAt != null && ctx.now - ctx.closedAt <= UNDO_FINISH_WINDOW_MS,
    to: 'state_before_close',
    kinds: ['task_reopened'],
    patch: readyNow,
    m0: true,
    note: '挂载 3 转正（BRK17）：UI 解除 disabled（taskActions done.undo-finish）；超窗/已归档经 task:transition 得人话回执',
  },
  { from: 'done', event: 'renew', to: 'KEEP', kinds: ['task_renewed'], m0: true, actions: renewAction, note: '续办：建新任务（继承语境、不继承承诺；F6/(c)）' },
  {
    from: 'done',
    event: 'archive',
    to: 'KEEP',
    kinds: ['task_archived'],
    patch: (ctx) => ({ archived: 1, archived_at: ctx.now }),
    m0: true,
    note: '挂载 3 接线（BRK17）：入口＝左栏终态任务行（**不是**详情操作表——归档≠state 口径 3067/3095）',
  },
  {
    from: 'done',
    event: 'reopen_reply',
    guard: (ctx) => ctx.payload.archived === true,
    to: 'needs_decision',
    kinds: ['decision_requested'],
    patch: () => ({ resume_state: 'done' }),
    actions: (ctx) => [notifyAction(ctx, 'decision')],
    m0: true,
    note: '挂载 3 深件（BRK17）：生产方＝`chat:send` 回复链打到**已归档终态**任务（提议续办；卡文案给现成指令）',
  },
  // failed
  { from: 'failed', event: 'retry', to: 'ready', kinds: ['task_reopened'], patch: readyNow, m0: true },
  {
    from: 'failed',
    event: 'finish',
    to: 'done',
    kinds: ['task_completed'],
    patch: close,
    actions: (ctx) => [notifyAction(ctx, 'report')],
    m0: true,
  },
  { from: 'failed', event: 'cancel', to: 'cancelled', kinds: ['task_cancelled'], patch: close, m0: true },
  // failed / cancelled：archive / renew / reopen_reply（同 done 对应行）
  {
    from: ['failed', 'cancelled'],
    event: 'archive',
    to: 'KEEP',
    kinds: ['task_archived'],
    patch: (ctx) => ({ archived: 1, archived_at: ctx.now }),
    m0: true,
    note: '挂载 3 接线（BRK17）：入口＝左栏终态任务行（同 done.archive）',
  },
  { from: ['failed', 'cancelled'], event: 'renew', to: 'KEEP', kinds: ['task_renewed'], m0: true, actions: renewAction },
  {
    from: ['failed', 'cancelled'],
    event: 'reopen_reply',
    guard: (ctx) => ctx.payload.archived === true,
    to: 'needs_decision',
    kinds: ['decision_requested'],
    patch: () => ({ resume_state: 'done' }),
    actions: (ctx) => [notifyAction(ctx, 'decision')],
    m0: true,
    note: '挂载 3 深件（BRK17）：生产方＝`chat:send` 回复链打到已归档终态任务（同 done.reopen_reply）',
  },
  // 任意非终态
  {
    from: '*',
    event: 'escalate',
    guard: (ctx) => !isTerminalTaskState(ctx.from),
    to: 'needs_decision',
    kinds: ['decision_requested'],
    // BRK10/11：重复升级保护——已在 `needs_decision` 时再升级**不得**把恢复目标覆盖成 `needs_decision`（保留原 resume_state）。
    patch: (ctx) => ({ resume_state: ctx.from === 'needs_decision' ? (ctx.resumeState ?? ctx.from) : ctx.from }),
    // BRK10/11：决策卡**唯一合成点**——question/options/审批回挂/紧急度随 payload 透传（见 NOTIFY_PASSTHROUGH_KEYS）；
    // `notifyRevision` ＝通知版次（权限卡按 `approvalId` 分卡、员工升级按 `employeeId·序号`）——
    // 同一升级只出一张（旧断链：内联卡＋状态机卡两张；矩阵/审计于 2026-10-15 抓）。
    actions: (ctx) => [
      notifyAction(ctx, 'decision', typeof ctx.payload.notifyRevision === 'number' ? ctx.payload.notifyRevision : (ctx.decisionRevision ?? 0)),
    ],
    m0: true,
  },
];

function sessionActionP(ctx: TaskTransitionContext): EngineAction[] {
  return [sessionAction(ctx, 'planning')];
}

/**
 * BRK25：`needs_decision → planning` 的**重派**动作。
 * 幂等键必须与首轮 `dispatch_planning:…:0` 及打回轮次区分：用 `planRevision*1000 + decisionRevision + 1`。
 * 仅 resumeState=planning 时生效；其它恢复态保持原语义（不凭空造规划会话）。
 */
function decisionResumeAction(ctx: TaskTransitionContext): EngineAction[] {
  const revision = (ctx.planRevision ?? 0) * 1000 + (ctx.decisionRevision ?? 0) + 1;
  if (ctx.resumeState === 'planning') {
    return [
      act('dispatch_planning', 'task', ctx.taskId, revision, ctx.taskId, {
        phase: 'planning',
        via: 'decision_resume',
      }),
    ];
  }
  // 验证中被模型/Key 门升级：答卡回 verifying 时必须重派 verifier（否则停在 verifying 无人验收）。
  if (ctx.resumeState === 'verifying') {
    return [
      act('dispatch_verifier', 'task', ctx.taskId, revision, ctx.taskId, {
        phase: 'verifier',
        via: 'decision_resume',
      }),
    ];
  }
  return [];
}

/**
 * C2（真拆派）：**规划产出工作项**（`FLOWS §3.1.2` 首行口径）——计划**成终稿**当刻登记：
 * L0 直通＝`plan_drafted` 当刻；L1/L2＝`plan_approved`（老板点头后，重规划不会留下孤儿工作项）。
 * 引擎侧建行（`loop.spawnPlanWorkItems`；幂等键 `plan_work_items:task:<id>:0`）。
 */
function planWorkItemsAction(ctx: TaskTransitionContext): EngineAction[] {
  return [act('plan_work_items', 'task', ctx.taskId, 0, ctx.taskId, {})];
}
function sessionActionC(ctx: TaskTransitionContext): EngineAction[] {
  return [sessionAction(ctx, 'critic')];
}
function sessionActionV(ctx: TaskTransitionContext): EngineAction[] {
  return [sessionAction(ctx, 'verifier')];
}

export class UnknownTransitionError extends Error {
  constructor(scope: 'task' | 'work_item', from: string, event: string) {
    super(`[engine] 未定义的迁移：${scope} ${from} --(${event})--> ?（对照 FLOWS §3.1，不得自造）`);
    this.name = 'UnknownTransitionError';
  }
}

/**
 * 「员工并发=1」硬守卫失败（FLOWS §0 第 4 条 / §3.1.2）。
 *
 * 引擎层显式守卫：某员工已有 `running` work item 时，任何把它引向 `running` 的迁移
 * （`dispatch` / `redispatch` / `retry`）都被拒绝——即使绕开调度器直接注入事件也一样。
 * 正常路径由 `core/scheduler` 的占用队列在派发前剔除忙员工，本错误只在旁路/回归时出现。
 */
export class EmployeeBusyError extends Error {
  constructor(
    readonly employeeId: number,
    readonly runningWorkItemId: number,
    readonly rejectedWorkItemId: number,
  ) {
    super(
      `[engine] 员工并发=1 守卫：员工 ${employeeId} 已有 running work item ${runningWorkItemId}，` +
        `拒绝将 work item ${rejectedWorkItemId} 置为 running（FLOWS §0 第 4 条 / §3.1.2）`,
    );
    this.name = 'EmployeeBusyError';
  }
}

function matchesFrom(rowFrom: TaskTransition['from'], from: TaskFrom): boolean {
  const list = Array.isArray(rowFrom) ? rowFrom : [rowFrom];
  return list.includes(from);
}

export function resolveTaskTransition(
  from: TaskState,
  event: string,
  ctx: TaskTransitionContext,
): TaskTransition | undefined {
  return TASK_TRANSITIONS.find(
    (row) =>
      (matchesFrom(row.from, from) || (matchesFrom(row.from, '*') && !isTerminalTaskState(from))) &&
      row.event === event &&
      (!row.guard || row.guard(ctx)),
  );
}

/** 解析 `to`：普通状态 / KEEP / 回边字段。 */
export function resolveTaskTarget(row: TaskTransition, ctx: TaskTransitionContext): TaskState | null {
  switch (row.to) {
    case 'KEEP':
      return null;
    case 'resume_state':
      return ctx.resumeState && NON_TERMINAL_STATES.has(ctx.resumeState) ? ctx.resumeState : 'inbox';
    case 'state_before_close': {
      const prev = ctx.stateBeforeClose;
      // 「原 executing → ready」：executing 需要 work item，不能直接复活，回 ready（FLOWS §3.1.1）
      if (prev == null) return 'ready';
      if (prev === 'executing') return 'ready';
      return TERMINAL_STATES.has(prev) ? 'ready' : prev;
    }
    default:
      return row.to;
  }
}

// ─────────────────────────── 工作项机（FLOWS §3.1.2，16 行） ───────────────────────────

export interface WorkItemTransitionContext {
  workItemId: number;
  taskId: number;
  attempt: number;
  from: WorkItemState;
  now: number;
  actor: string;
  payload: Record<string, unknown>;
  /** 会话结束前是否已调用 submit_work_item（agent_settled 的守卫）。 */
  submitted?: boolean;
  /** 任务当前状态（queued→running 守卫：所属任务 executing）。 */
  taskState?: TaskState;
}

export interface WorkItemTransition {
  from: WorkItemState | 'NEW' | '*';
  event: string;
  guard?: (ctx: WorkItemTransitionContext) => boolean;
  to: WorkItemState | 'KEEP';
  kinds: string[];
  actions?: (ctx: WorkItemTransitionContext) => EngineAction[];
  /** B9：WI 迁移可带的行级 patch（如 retry 的 `{ attempt: ctx.attempt + 1 }`）→ loop 写库。 */
  patch?: (ctx: WorkItemTransitionContext) => Record<string, unknown>;
  m0: boolean;
  note?: string;
}

const wiAction = (ctx: WorkItemTransitionContext, kind: string, revision: number): EngineAction =>
  act(kind, 'work_item', ctx.workItemId, revision, ctx.taskId, { attempt: ctx.attempt });

/** BRK7：改派必须换员工并递增 attempt（新 dispatch 幂等键）；无有效 employeeId → 拒绝（不静默不动）。 */
const reassignPatch = (ctx: WorkItemTransitionContext): Record<string, unknown> => {
  const raw = (ctx.payload as { employeeId?: unknown } | undefined)?.employeeId;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error('[engine] reassign 需要有效 employeeId（同角色在职员工）');
  }
  return { employee_id: raw, attempt: ctx.attempt + 1 };
};

export const WORK_ITEM_TRANSITIONS: readonly WorkItemTransition[] = [
  { from: 'NEW', event: 'work_item_created', to: 'queued', kinds: ['work_item_created'], m0: true },
  {
    from: 'queued',
    event: 'dispatch',
    guard: (ctx) => ctx.taskState === 'executing',
    to: 'running',
    kinds: ['work_item_assigned', 'work_item_started'],
    actions: (ctx) => [wiAction(ctx, 'dispatch', ctx.attempt)],
    m0: true,
  },
  { from: 'queued', event: 'reassign', to: 'queued', kinds: ['work_item_created'], patch: reassignPatch, m0: true },
  { from: 'running', event: 'submit_work_item', to: 'submitted', kinds: ['work_item_submitted'], m0: true },
  {
    from: 'running',
    event: 'agent_settled',
    guard: (ctx) => ctx.submitted === true,
    to: 'submitted',
    kinds: ['agent_settled'],
    m0: true,
  },
  {
    from: 'running',
    event: 'agent_settled',
    guard: (ctx) => ctx.submitted !== true,
    to: 'failed',
    kinds: ['agent_settled', 'work_item_failed'],
    m0: false,
  },
  { from: 'running', event: 'error', to: 'failed', kinds: ['work_item_failed'], m0: true },
  { from: 'running', event: 'heartbeat_timeout', to: 'failed', kinds: ['work_item_failed'], m0: true },
  { from: 'running', event: 'pause_task', to: 'interrupted', kinds: ['work_item_interrupted'], m0: true },
  { from: 'running', event: 'crash', to: 'interrupted', kinds: ['work_item_interrupted'], m0: true, note: '启动恢复批量置 interrupted' },
  // 阻塞式 mailbox（M2 尾）：件等同事答复时退出 running（不占员工并发槽位）；
  // 答复到达 → 回 queued（下一拍调度重派，答复由未读回灌进下一轮简报）。
  { from: 'running', event: 'ask_blocked', to: 'blocked', kinds: ['work_item_blocked'], m0: true },
  { from: 'blocked', event: 'answer_received', to: 'queued', kinds: ['work_item_unblocked'], m0: true },
  { from: 'blocked', event: 'pause_task', to: 'interrupted', kinds: ['work_item_interrupted'], m0: true },
  { from: 'blocked', event: 'crash', to: 'interrupted', kinds: ['work_item_interrupted'], m0: true },
  { from: 'submitted', event: 'review_accept', to: 'done', kinds: ['work_item_done'], m0: true },
  { from: 'submitted', event: 'review_reject', to: 'rejected', kinds: ['work_item_rejected'], m0: true },
  {
    from: 'rejected',
    event: 'redispatch',
    to: 'running',
    kinds: ['work_item_started'],
    // MF2：rejected 重派也必须真的再派员工（此前只改状态、无 dispatch 动作）。
    patch: (ctx) => ({ attempt: ctx.attempt + 1 }),
    actions: (ctx) => [act('dispatch', 'work_item', ctx.workItemId, ctx.attempt + 1, ctx.taskId, { attempt: ctx.attempt + 1 })],
    m0: true,
  },
  {
    from: 'failed',
    event: 'retry',
    to: 'running',
    kinds: ['work_item_started'],
    m0: true,
    // B9：**重派** — attempt+1 作 revision（新幂等键）+ **patch 真递增 attempt**（否则幂等键永远不变 = 静默 no-op）。
    patch: (ctx) => ({ attempt: ctx.attempt + 1 }),
    actions: (ctx) => [act('dispatch', 'work_item', ctx.workItemId, ctx.attempt + 1, ctx.taskId, { attempt: ctx.attempt + 1 })],
  },
  { from: 'failed', event: 'reassign', to: 'queued', kinds: ['work_item_created'], patch: reassignPatch, m0: true },
  {
    from: 'interrupted',
    event: 'redispatch',
    to: 'queued',
    kinds: ['work_item_created'],
    patch: (ctx) => ({ attempt: ctx.attempt + 1 }),
    m0: true,
    note: 'BRK4：暂停恢复重派必须递增 attempt——否则 dispatch 幂等键与首次相同，被 OR IGNORE 吞掉 ⇒ 件永远 queued',
  },
  { from: 'interrupted', event: 'reassign', to: 'queued', kinds: ['work_item_created'], patch: reassignPatch, m0: true, note: 'BRK7：员工不可用先中断再改派' },
  { from: 'interrupted', event: 'ask_user', to: 'KEEP', kinds: ['decision_requested'], m0: true },
];

export function resolveWorkItemTransition(
  from: WorkItemState,
  event: string,
  ctx: WorkItemTransitionContext,
): WorkItemTransition | undefined {
  return WORK_ITEM_TRANSITIONS.find(
    (row) =>
      (row.from === from || (row.from === '*' && from !== 'done')) &&
      row.event === event &&
      (!row.guard || row.guard(ctx)),
  );
}

export type TaskTransitionOutcome = {
  row: TaskTransition;
  to: TaskState | null;
  patch: TaskPatch;
  kinds: string[];
  actions: EngineAction[];
};

/** 纯函数：给定任务上下文与事件，算出迁移结果（不写库）。 */
export function planTaskTransition(ctx: TaskTransitionContext, event: string): TaskTransitionOutcome {
  const row = resolveTaskTransition(ctx.from, event, ctx);
  if (!row) {
    // 给出比"未知迁移"更准确的拒因（否则超窗/已归档会被误报为"未定义迁移"）
    if (event === 'undo_finish' && ctx.from === 'done') {
      if (ctx.archived === true) {
        throw new Error('[engine] 已归档任务不允许撤销结束（只能续办）（FLOWS §3.1.1）');
      }
      throw new Error('[engine] 撤销结束超出 7 天窗口（FLOWS §3.1.1）');
    }
    throw new UnknownTransitionError('task', ctx.from, event);
  }
  const to = resolveTaskTarget(row, ctx);
  const patch: TaskPatch = { ...(row.patch ? row.patch(ctx) : {}) };
  if (to) patch.state = to;
  return { row, to, patch, kinds: row.kinds, actions: row.actions ? row.actions(ctx) : [] };
}

export type WorkItemTransitionOutcome = {
  row: WorkItemTransition;
  to: WorkItemState | null;
  kinds: string[];
  actions: EngineAction[];
  /** B9：行级 patch（如 retry 的 `attempt+1`）；loop 会合并进 `updateWorkItem`。 */
  patch: Record<string, unknown>;
};

export function planWorkItemTransition(
  ctx: WorkItemTransitionContext,
  event: string,
): WorkItemTransitionOutcome {
  const row = resolveWorkItemTransition(ctx.from, event, ctx);
  if (!row) throw new UnknownTransitionError('work_item', ctx.from, event);
  return {
    row,
    to: row.to === 'KEEP' ? null : row.to,
    kinds: row.kinds,
    actions: row.actions ? row.actions(ctx) : [],
    patch: row.patch ? row.patch(ctx) : {},
  };
}

export { TERMINAL_STATES as TASK_TERMINAL_STATES, NON_TERMINAL_STATES as TASK_RESUMABLE_STATES };
