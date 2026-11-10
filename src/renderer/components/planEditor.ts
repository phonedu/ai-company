/**
 *  计划编辑器纯函数（可单测，无副作用）。
 *
 * 只在批准前使用：老板对计划做增删/排序。保存时仍走 `normalizePlanSteps` 的同一口径
 * （1–12 步、非空、单步上限），渲染层不发明第二套规则。
 */
import { PLAN_STEPS_MAX } from '../../core/plan.js';

/** 把某一步上移/下移（delta=-1/+1）；越界或非法下标 → 原样返回。 */
export function movePlanStep(steps: readonly string[], index: number, delta: number): string[] {
  const next = [...steps];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as string);
  return next;
}

/** 追加一个空步骤（到上限 → 原样返回；上限由共享常量决定）。 */
export function appendPlanStep(steps: readonly string[]): string[] {
  if (steps.length >= PLAN_STEPS_MAX) return [...steps];
  return [...steps, ''];
}

/** 删除一步；只剩一步时拒绝删除（计划至少要有 1 步）。 */
export function removePlanStep(steps: readonly string[], index: number): string[] {
  if (steps.length <= 1 || index < 0 || index >= steps.length) return [...steps];
  return steps.filter((_, i) => i !== index);
}

/** 修改某一步文本（越界 → 原样返回）。 */
export function updatePlanStep(steps: readonly string[], index: number, text: string): string[] {
  if (index < 0 || index >= steps.length) return [...steps];
  return steps.map((step, i) => (i === index ? text : step));
}
