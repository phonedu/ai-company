/**
 * RM-2（D4 must-fix 2）：任务离开待决策/待批准后清同任务 pending ask 卡的**纯判据**。
 *
 * 用 statemachine 的**真实事件名**，不猜 `task_started`/`task_completed` 这类不存在的名字；
 * 仍保留任务状态门：`needs_decision`/`awaiting_approval` 期间不动卡。
 * `pause`/`block`/`budget_exceeded` 等不清卡（可能还有合法的权限/决策卡在等）。
 */
const CLEAR_EVENT_NAMES = new Set([
  'plan_approved',
  'askcard_timeout',
  'revise',
  'decision_made',
  'start_task',
  'all_work_items_done',
  'verification_completed',
  'finish_manual',
  'finish',
  'fail',
  'cancel',
  'discard',
]);

export function shouldClearPendingAsks(
  event: { scope: string; event: string },
  taskState: string | null | undefined,
): boolean {
  if (event.scope !== 'task') return false;
  if (!CLEAR_EVENT_NAMES.has(event.event)) return false;
  return taskState !== 'needs_decision' && taskState !== 'awaiting_approval';
}
