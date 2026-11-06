// ─────────────────────────────────────────────────────────────────────────────
// 任务详情「详情可见操作」条件渲染表（**FLOWS §3 的逐行落点**；D2/C3）
//   真源：`docs/FLOWS.md §3`（状态 × 界面映射表）「任务详情可见操作」列。
//   口径（本仓库既有约束）：
//     ① **未实现的动作不许假装可点** —— `implemented !== true` 的按钮一律 `disabled` + 显式理由
//        （与 M7-1/L26 同族：不做"看起来能用"的死按钮）；
//     ② `implemented` **不是自说自话**：由 `test/task-actions.test.ts` 对照
//        `src/main/engine/statemachine.ts` 的 **`m0: true`** 行**逐条核**（doc-driven 守卫）；
//     ③ 未知/缺省的 state → **返回空数组**（不臆造按钮）。
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskActionDTO {
  /** 稳定 id（选择器/测试用）。 */
  id: string;
  /** 按钮文案（FLOWS §3 的中文标签）。 */
  label: string;
  /** 触发的引擎事件；`null` = FLOWS 有此项但**无独立事件**（如「改计划」「合并」）→ 必 disabled。 */
  event: string | null;
  /** 事件载荷（如验收 `verdict`）。 */
  payload?: Record<string, unknown>;
  /** 是否已实现：**只有 `true` 才可点**；其余一律 disabled + `reason`。 */
  implemented: boolean;
  /** 非状态机事件的 IPC 动作（如 `task:merge`）；有值时 `event` 为 null，由容器单独派发。 */
  ipcAction?: 'task:merge';
  /** disabled 时的说明（`title`），必须写清"为什么不能点"。 */
  reason?: string;
  /**
   * GAP8：点了**打开计划编辑器**（不直接发事件）——`event` 保留为 `plan_edited` 供
   * 「已实现 ↔ 状态机 m0:true」守卫核对；真正保存由 PlanPanel 调 `task:edit-plan`。
   */
  opensPlanEditor?: boolean;
  /**
   * BRK17（挂载 3 余·取消小步，D-9）：**危险动作**（不可回退的中止）——UI 走**行内二次确认**
   * （点一次进确认条，默认焦点在「返回」、Esc 退回），不直发。其余动作保持直点（四态既有风格）。
   */
  danger?: boolean;
}

const NO_EVENT = '本轮无对应事件（M2）';

/** FLOWS §3「任务详情可见操作」逐行落点。 */
const TABLE: Record<string, TaskActionDTO[]> = {
  inbox: [
    { id: 'confirm-as-task', label: '确认为任务', event: 'confirm_as_task', implemented: true },
    { id: 'discard', label: '丢弃', event: 'discard', implemented: true },
  ],
  planning: [{ id: 'cancel', label: '取消', event: 'cancel', implemented: true }],
  awaiting_approval: [
    { id: 'approve', label: '批准', event: 'plan_approved', implemented: true },
    { id: 'revise', label: '打回', event: 'revise', implemented: true },
    // GAP8：批准前编辑计划（增删/排序）；点按进入计划编辑器，保存时发 plan_edited（可再批准）。
    { id: 'revise-approve', label: '改计划再批准', event: 'plan_edited', implemented: true, opensPlanEditor: true },
  ],
  ready: [
    { id: 'pause', label: '暂停', event: 'pause', implemented: true },
    { id: 'cancel', label: '取消', event: 'cancel', implemented: true },
  ],
  executing: [
    { id: 'pause', label: '暂停', event: 'pause', implemented: true },
    { id: 'add-budget', label: '加预算', event: null, implemented: false, reason: NO_EVENT },
    { id: 'set-priority', label: '改优先级', event: null, implemented: false, reason: NO_EVENT },
    { id: 'finish', label: '结束', event: 'finish_manual', implemented: true },
    // 挂载 3 余（BRK17·取消小步，D-9）：真中止（停件/停会话/收尾卡）已接线 → 解禁；
    // 危险动作 ≡ 行内二次确认（`danger`，TaskDetail 渲染确认条）。
    { id: 'cancel', label: '取消', event: 'cancel', implemented: true, danger: true },
  ],
  paused: [
    { id: 'resume', label: '继续', event: 'resume', implemented: true },
    { id: 'finish', label: '结束', event: 'finish', implemented: true },
  ],
  // blocked：FLOWS 要求「[取消] + 阻塞原因」；阻塞原因由 waits 条（`task-waits`）承担。
  // BRK6：老板可手动解除外部阻塞（依赖未满足仍会被调度器再次 block——不绕过依赖）。
  blocked: [
    { id: 'unblock', label: '解除阻塞', event: 'unblock', implemented: true },
    { id: 'cancel', label: '取消', event: 'cancel', implemented: true },
  ],
  verifying: [
    { id: 'accept', label: '通过', event: 'verification_completed', payload: { verdict: 'pass' }, implemented: true },
    // GAP12：手动打回＝verifier 同口径 fail；UI 先收文字批注，再带 notes/workItemId 发事件。
    { id: 'reject', label: '打回', event: 'verification_completed', payload: { verdict: 'fail' }, implemented: true },
    // M3-P-4 / BRK16-b：合并走独立 IPC（不是任务机事件）；有待合并变更集才真正可合并。
    { id: 'merge', label: '合并', event: null, implemented: true, ipcAction: 'task:merge' },
    // 取消余两态（BRK17，2026-10-16）：验证中真中止——已提交的件不再验证（收尾卡如实）；verifier 会话真停。
    { id: 'cancel', label: '取消', event: 'cancel', implemented: true, danger: true },
  ],
  // needs_decision：「问题上下文 + 选项」由 AskCard 提供（不是固定事件按钮）→ 本表**不出按钮**。
  needs_decision: [],
  done: [
    { id: 'renew', label: '续办', event: 'renew', implemented: true },
    // 挂载 3（BRK17）：7 天窗口/未归档由状态机守卫把关（超窗点按 → 引擎拒绝 → 人话回执，不静默）。
    { id: 'undo-finish', label: '撤销结束', event: 'undo_finish', implemented: true },
  ],
  failed: [
    { id: 'retry', label: '重试', event: 'retry', implemented: true },
    { id: 'renew', label: '续办', event: 'renew', implemented: true },
  ],
  cancelled: [{ id: 'renew', label: '续办', event: 'renew', implemented: true }],
};

/** 某 state 的可见操作；**未知 state → 空数组**（不臆造）。 */
export function taskActionsOf(state: string | null | undefined): TaskActionDTO[] {
  if (typeof state !== 'string') return [];
  return TABLE[state] ?? [];
}

/**
 * BRK17（挂载 3 余·取消小步，D-9）：危险动作「取消」的**行内二次确认文案**。
 *
 * 口径：**件数取真读数**（`workItemCounts`）——查不到/为 0 ⇒ **不写数字**（不臆造）；
 * 语义写清三件事：在跑的件与会话会停 · 已提交的件不再验证 · 不可回退（只能续办）。
 */
export function cancelConfirmText(input: {
  shortId?: string | null;
  counts?: Record<string, number> | null;
}): string {
  const running = input.counts?.running ?? 0;
  const submitted = input.counts?.submitted ?? 0;
  const inFlight = running > 0 ? `在跑的 ${running} 个件与员工会话会停` : '在跑的件（如有）与员工会话会停';
  const pending = submitted > 0 ? `已提交的 ${submitted} 个件不再验证` : null;
  return `中止 ${input.shortId ?? '本任务'}？${inFlight}${pending != null ? ` · ${pending}` : ''} · 不可回退（只能续办）。`;
}

/**
 * GAP12：把「打回」动作与批注合成为可发事件的动作。
 * `notes` trim 后写入；`workItemId` 有则带（服务端仍会兜底补最近 submitted 件）。
 */
export function rejectActionWithNotes(
  action: TaskActionDTO,
  notes: string,
  workItemId?: number | null,
): TaskActionDTO {
  return {
    ...action,
    payload: {
      ...(action.payload ?? {}),
      verdict: 'fail',
      notes: notes.trim(),
      ...(workItemId != null ? { workItemId } : {}),
    },
  };
}

/** 该 state 是否有**可点**的操作（用于决定是否渲染操作条）。 */
export function hasEnabledAction(state: string | null | undefined): boolean {
  return taskActionsOf(state).some((action) => action.implemented);
}

/**
 * 2026-10-16（任务详情批）：**插话命令**——详情页入口走高置信直通同一路径（`#短号 要说的话`；
 * 与频道里手打等价，`ipc.ts parseSteerCommand` 吃这两种形态）。短号缺失回落 `#id`（不臆造短号）。
 */
export function steerCommand(shortId: string | null | undefined, id: number, text: string): string {
  const ref = shortId != null && shortId.length > 0 ? shortId : String(id);
  return `#${ref} ${text}`;
}

/** 测试/守卫用：整张表（只读）。 */
export const TASK_ACTIONS_TABLE = TABLE;
