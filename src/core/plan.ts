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

/**
 * B2-3/D-30②：planner 结构化多工作项校验（`submit_plan.workItems`）。
 *
 * 口径：1–6 件；每件 title 必填（≤200 字）、brief 可选；deps＝**1-based 件序号**数组、
 * 必须有界；成环拒绝（含自依赖）；允许 1 件（回落单件现状）。**不静默丢非法输入**——
 * 整体拒绝，规划会话据此重交（与 normalizePlanSteps 同一哲学）。
 */
export const PLAN_WORK_ITEMS_MAX = 6;
export const PLAN_WORK_ITEM_TITLE_MAX_CHARS = 200;

export interface PlanWorkItemInput {
  title: string;
  brief?: string;
  dependsOn?: number[];
}

export interface NormalizedPlanWorkItem {
  title: string;
  brief: string | null;
  dependsOn: number[];
}

export type PlanWorkItemsValidation =
  | { ok: true; items: NormalizedPlanWorkItem[] }
  | { ok: false; code: 'invalid_work_items' | 'too_many_work_items' | 'deps_out_of_range' | 'deps_cycle'; message: string };

export function normalizePlanWorkItems(raw: unknown): PlanWorkItemsValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid_work_items', message: 'workItems 必须是数组' };
  }
  if (raw.length === 0 || raw.length > PLAN_WORK_ITEMS_MAX) {
    return {
      ok: false,
      code: raw.length > PLAN_WORK_ITEMS_MAX ? 'too_many_work_items' : 'invalid_work_items',
      message: raw.length > PLAN_WORK_ITEMS_MAX ? `workItems 最多 ${PLAN_WORK_ITEMS_MAX} 件` : 'workItems 至少 1 件',
    };
  }
  const items: NormalizedPlanWorkItem[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'invalid_work_items', message: 'workItems 每件必须是对象（title 必填）' };
    }
    const rec = item as Record<string, unknown>;
    const title = typeof rec['title'] === 'string' ? rec['title'].trim() : '';
    if (title.length === 0 || title.length > PLAN_WORK_ITEM_TITLE_MAX_CHARS) {
      return { ok: false, code: 'invalid_work_items', message: `每件 title 必填（≤${PLAN_WORK_ITEM_TITLE_MAX_CHARS} 字）` };
    }
    const brief = typeof rec['brief'] === 'string' && rec['brief'].trim().length > 0 ? rec['brief'].trim() : null;
    const depsRaw = rec['dependsOn'];
    const deps = Array.isArray(depsRaw)
      ? [...new Set(depsRaw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d)))]
      : [];
    if (depsRaw != null && !Array.isArray(depsRaw)) {
      return { ok: false, code: 'invalid_work_items', message: 'dependsOn 必须是数组（1-based 件序号）' };
    }
    items.push({ title, brief, dependsOn: deps });
  }
  for (const [i, item] of items.entries()) {
    for (const d of item.dependsOn) {
      if (!Number.isInteger(d) || d < 1 || d > items.length || d === i + 1) {
        return { ok: false, code: 'deps_out_of_range', message: `第 ${i + 1} 件 dependsOn 越界/自依赖（1–${items.length}）` };
      }
    }
  }
  // 环检测（DFS）
  const visited = new Set<number>();
  const done = new Set<number>();
  const stack = [...items.keys()];
  const visit = (idx: number, path: Set<number>): boolean => {
    if (path.has(idx)) return false;
    if (done.has(idx)) return true;
    path.add(idx);
    for (const d of items[idx]!.dependsOn) {
      if (!visit(d - 1, path)) return false;
    }
    path.delete(idx);
    done.add(idx);
    return true;
  };
  for (const s of stack) {
    if (!visit(s, new Set())) {
      return { ok: false, code: 'deps_cycle', message: 'workItems 依赖成环' };
    }
    visited.add(s);
  }
  return { ok: true, items };
}
