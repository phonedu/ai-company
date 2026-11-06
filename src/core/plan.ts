/**
 * 计划步骤共享校验（GAP8：批准前可编辑）。
 *
 * 同一份口径同时供三处使用，避免「UI 放行、服务端拒」的口径漂移：
 *  - 规划会话 `submit_plan` 的步数上限；
 *  - `task:edit-plan`（老板在批准卡前改计划）；
 *  - 渲染层计划编辑器（保存前先挡明显非法输入）。
 *
 * 只做纯校验，不碰 DB/网络。
 */
export const PLAN_STEPS_MAX = 12;
export const PLAN_STEP_MAX_CHARS = 500;

export type PlanStepsValidation =
  | { ok: true; steps: string[] }
  | { ok: false; code: 'invalid_steps' | 'too_many_steps'; message: string };

/**
 * 归一化计划步骤：必须是 1–12 条非空字符串，逐条 trim 后写入。
 * **不静默丢空项**：数组里混入空串/非字符串 → 整体拒绝（否则用户以为保存了 N 步，实际少一步）。
 */
export function normalizePlanSteps(raw: unknown): PlanStepsValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid_steps', message: '计划步骤必须是数组' };
  }
  if (raw.length === 0) {
    return { ok: false, code: 'invalid_steps', message: '计划至少要有 1 步' };
  }
  if (raw.length > PLAN_STEPS_MAX) {
    return { ok: false, code: 'too_many_steps', message: `计划最多 ${PLAN_STEPS_MAX} 步` };
  }
  const steps: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, code: 'invalid_steps', message: '每一步都必须是文字' };
    }
    const text = item.trim();
    if (text.length === 0) {
      return { ok: false, code: 'invalid_steps', message: '每一步都要有内容（不能留空）' };
    }
    if (text.length > PLAN_STEP_MAX_CHARS) {
      return { ok: false, code: 'invalid_steps', message: `单步最多 ${PLAN_STEP_MAX_CHARS} 字` };
    }
    steps.push(text);
  }
  return { ok: true, steps };
}
