/**
 * `plan_steps` DAO + materialized 投影（DEV §4 第 8 条；1191 裁决 F=(a)）。
 *
 * `plan_steps` 是 `task_events` 的物化投影（唯一事实来源仍是事件）：
 *  - `plan_drafted.payload.steps[]` → `replacePlanSteps(taskId, steps)`
 *  - `plan_edited.payload.steps[]` → `replacePlanSteps(taskId, steps)`（GAP8：批准前老板编辑；仍是全量替换）
 *  - `progress_reported.payload={stepIdx,state}` → `updatePlanStepState(taskId, stepIdx, state)`
 * 投影由引擎在**事务内**做（可随事件重放；重复应用不产生重复行——replace 是全量替换、update 是幂等 set）。
 * 进度条 = `count(state='done') / count(*)`（按 idx 排序，docs/UI.md §7 / T0.7）。
 */
import type { SqliteDb } from './open.js';

export type PlanStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export const PLAN_STEP_STATES: readonly PlanStepState[] = ['pending', 'running', 'done', 'skipped', 'failed'];

export interface PlanStepRow {
  id: number;
  task_id: number;
  idx: number;
  text: string;
  state: PlanStepState;
  work_item_id: number | null;
  evidence_ref: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, task_id, idx, text, state, work_item_id, evidence_ref, created_at, updated_at';

export function listPlanSteps(db: SqliteDb, taskId: number): PlanStepRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM plan_steps WHERE task_id = ? ORDER BY idx`).all(taskId) as PlanStepRow[];
}

export function getPlanStep(db: SqliteDb, id: number): PlanStepRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM plan_steps WHERE id = ?`).get(id) as PlanStepRow | undefined;
}

export interface InsertPlanStepInput {
  taskId: number;
  idx: number;
  text: string;
  state?: PlanStepState;
  workItemId?: number | null;
  evidenceRef?: string | null;
  now?: number;
}

/** 插入单步（seed / demo / 投影共用）。 */
export function insertPlanStep(db: SqliteDb, input: InsertPlanStepInput): PlanStepRow {
  const now = input.now ?? Date.now();
  const info = db
    .prepare(
      `INSERT INTO plan_steps(task_id, idx, text, state, work_item_id, evidence_ref, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.idx,
      input.text,
      input.state ?? 'pending',
      input.workItemId ?? null,
      input.evidenceRef ?? null,
      now,
      now,
    );
  const row = getPlanStep(db, Number(info.lastInsertRowid));
  if (!row) throw new Error('[db] insertPlanStep 后读回失败');
  return row;
}

/**
 * 全量替换某任务的计划步骤（`plan_drafted` 投影）。
 * 幂等：重复应用同一 steps 结果一致（先 delete 再按序 insert），不产生重复行。
 * **不自行开事务**——引擎在 loop 的事务内调用；独立 seed 时如需原子性请调用方 `db.tx` 包裹。
 * 返回写入的步数。
 */
export function replacePlanSteps(db: SqliteDb, taskId: number, steps: string[], now: number = Date.now()): number {
  db.prepare('DELETE FROM plan_steps WHERE task_id = ?').run(taskId);
  const insert = db.prepare(
    `INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(?, ?, ?, 'pending', ?, ?)`,
  );
  steps.forEach((text, i) => insert.run(taskId, i + 1, text, now, now));
  return steps.length;
}

export interface UpdatePlanStepStateInput {
  taskId: number;
  stepIdx: number;
  state: PlanStepState;
  workItemId?: number | null;
  evidenceRef?: string | null;
  now?: number;
}

/** 更新某一步的状态（`progress_reported` 投影）。返回是否有行被更新（步骤不存在则 false）。幂等。 */
export function updatePlanStepState(db: SqliteDb, input: UpdatePlanStepStateInput): boolean {
  const now = input.now ?? Date.now();
  const info = db
    .prepare(
      `UPDATE plan_steps SET state = ?, updated_at = ?,
         work_item_id = COALESCE(?, work_item_id),
         evidence_ref = COALESCE(?, evidence_ref)
       WHERE task_id = ? AND idx = ?`,
    )
    .run(input.state, now, input.workItemId ?? null, input.evidenceRef ?? null, input.taskId, input.stepIdx);
  return info.changes > 0;
}

/** 兼容别名（旧的 `setPlanStepState` 语义相同）。 */
export const setPlanStepState = updatePlanStepState;

/** 由 `plan_drafted.payload.steps[]` **补缺**（不删除已有；用于 seed）。**不自行开事务**。返回新增条数。 */
export function upsertPlanStepsFromDraft(db: SqliteDb, taskId: number, steps: string[], now: number = Date.now()): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO plan_steps(task_id, idx, text, state, created_at, updated_at)
     VALUES(?, ?, ?, 'pending', ?, ?)`,
  );
  let added = 0;
  steps.forEach((text, i) => {
    added += insert.run(taskId, i + 1, text, now, now).changes;
  });
  return added;
}

export interface PlanProgress {
  done: number;
  total: number;
}

export function planStepProgress(db: SqliteDb, taskId: number): PlanProgress {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
         COUNT(*) AS total
       FROM plan_steps WHERE task_id = ?`,
    )
    .get(taskId) as { done: number | null; total: number };
  return { done: Number(row.done ?? 0), total: Number(row.total ?? 0) };
}

export interface ProjectPlanStepEventInput {
  taskId: number;
  kind: string;
  payload: Record<string, unknown>;
  now?: number;
}

/**
 * 把一条 `task_events` 投影进 `plan_steps`（**只改 plan_steps，不写事件**）。
 * 由引擎 loop 在写事件后调用，也由 `report_progress` 工具路径复用 —— 单一投影逻辑。
 * 只认 `plan_drafted` / `plan_edited` / `progress_reported`；其它 kind 为 no-op。
 */
export function projectPlanStepEvent(db: SqliteDb, input: ProjectPlanStepEventInput): void {
  const now = input.now ?? Date.now();
  if (input.kind === 'plan_drafted' || input.kind === 'plan_edited') {
    const steps = input.payload.steps;
    if (Array.isArray(steps) && steps.every((s) => typeof s === 'string')) {
      replacePlanSteps(db, input.taskId, steps as string[], now);
    }
    return;
  }
  if (input.kind === 'progress_reported') {
    const stepIdx = Number(input.payload.stepIdx);
    const state = input.payload.state as PlanStepState;
    if (Number.isInteger(stepIdx) && stepIdx >= 1 && PLAN_STEP_STATES.includes(state)) {
      updatePlanStepState(db, { taskId: input.taskId, stepIdx, state, now });
    }
  }
}
