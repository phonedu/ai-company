/**
 * 决策卡作答 → 引擎事件的唯一映射（自 ipc.ts 迁出至 core，供卡片工具/审批入口共用）。
 *
 * - `awaiting_approval`：`approve` → `plan_approved`；`revise`/`reject` → `revise`（带意见重规划）；
 *   **其它选项 → `null`（不猜、不推状态机；作答已落台账）**。
 * - `needs_decision`：作答 → `decision_made`（payload 带 chosen；回 `resume_state` 继续）；
 *   **`cancel` → 真 `cancel` 事件**（needs_decision+cancel→cancelled 是机器真边）；**`proceed` → `decision_proceed_latest`**
 *   （最新稿视同批准，不重规划——机器边仅规划期升级有效，验证期由 guard 拦下）。
 * - 其它任务态（如执行中工具权限审批）→ `null`（权限由 `answerApproval` 的授权路径处理，不动任务机）。
 */
export function approvalAnswerEvent(
  taskState: string | null | undefined,
  chosen: string,
): { event: string; payload?: Record<string, unknown> } | null {
  if (taskState === 'awaiting_approval') {
    if (chosen === 'approve') return { event: 'plan_approved' };
    if (chosen === 'revise' || chosen === 'reject') return { event: 'revise' };
    return null;
  }
  if (taskState === 'needs_decision') {
    // RW-21 收尾：三个卡选项各走机器真边——cancel→真取消；proceed→最新稿视同批准（不重规划）；
    // 其余（revise 等）→ decision_made（回 resume_state，规划期自动重派规划）。
    // B2-6/D-30③：签收卡机器真边——sign→signoff（done）；rework:<wiId>→signoff_reject（单件返工）。
    if (chosen === 'sign') return { event: 'signoff' };
    if (chosen.startsWith('rework:')) {
      const wi = Number(chosen.slice('rework:'.length));
      if (Number.isInteger(wi) && wi > 0) return { event: 'signoff_reject', payload: { workItemId: wi } };
      return null;
    }
    if (chosen === 'cancel') return { event: 'cancel' };
    if (chosen === 'proceed') return { event: 'decision_proceed_latest' };
    return { event: 'decision_made', payload: { chosen } };
  }
  return null;
}
