/**
 * `action_log` DAO —— 副作用动作的幂等台账（schema.sql / PLAN §19.3）。
 *
 * 幂等键规范：`<kind>:<subject_kind>:<subject_id>:<revision>`
 *   例：`dispatch:work_item:42:2` · `notify:report:88:0`
 * 流程：事务内先登记（pending）→ 事务外执行 → 置 done。
 * 崩溃重启：扫 pending 幂等重放；`execute` 开头再查一次，done 则跳过。
 */
import type { SqliteDb } from './open.js';

export type ActionState = 'pending' | 'done' | 'failed';

export interface ActionLogRow {
  id: number;
  action_key: string;
  kind: string;
  task_id: number | null;
  payload: string;
  state: ActionState;
  created_at: number;
  done_at: number | null;
}

export interface RegisterActionInput {
  actionKey: string;
  kind: string;
  taskId?: number | null;
  payload?: unknown;
  now: number;
}

const COLUMNS = 'id, action_key, kind, task_id, payload, state, created_at, done_at';

/** 登记一个副作用动作（pending）。已存在同键则不改动；返回 true 表示本次新插入。 */
export function registerPendingAction(db: SqliteDb, input: RegisterActionInput): boolean {
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO action_log(action_key, kind, task_id, payload, state, created_at) VALUES(?, ?, ?, ?, \'pending\', ?)',
    )
    .run(input.actionKey, input.kind, input.taskId ?? null, JSON.stringify(input.payload ?? {}), input.now);
  return info.changes > 0;
}

export function getAction(db: SqliteDb, actionKey: string): ActionLogRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM action_log WHERE action_key = ?`).get(actionKey) as
    | ActionLogRow
    | undefined;
}

export function listPendingActions(db: SqliteDb): ActionLogRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM action_log WHERE state = 'pending' ORDER BY id`)
    .all() as ActionLogRow[];
}

export function listActions(db: SqliteDb): ActionLogRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM action_log ORDER BY id`).all() as ActionLogRow[];
}

/** MP1-F15：是否存在挂起动作（轻量存在性探测——tick 的 schedulePass 据此在会话期间也排水）。 */
export function hasPendingActions(db: SqliteDb): boolean {
  return db.prepare("SELECT 1 FROM action_log WHERE state = 'pending' LIMIT 1").get() != null;
}

/** pending → done（仅当仍为 pending）。返回 true 表示本次完成迁移。 */
export function markActionDone(db: SqliteDb, actionKey: string, now: number): boolean {
  const info = db
    .prepare("UPDATE action_log SET state = 'done', done_at = ? WHERE action_key = ? AND state = 'pending'")
    .run(now, actionKey);
  return info.changes > 0;
}

/** pending → failed（仅当仍为 pending）。 */
export function markActionFailed(db: SqliteDb, actionKey: string, now: number): boolean {
  const info = db
    .prepare("UPDATE action_log SET state = 'failed', done_at = ? WHERE action_key = ? AND state = 'pending'")
    .run(now, actionKey);
  return info.changes > 0;
}

export function countActions(db: SqliteDb, state?: ActionState): number {
  const row =
    state == null
      ? (db.prepare('SELECT count(*) AS c FROM action_log').get() as { c: number })
      : (db.prepare('SELECT count(*) AS c FROM action_log WHERE state = ?').get(state) as { c: number });
  return row.c;
}
