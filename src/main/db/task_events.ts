/**
 * `task_events` DAO —— 单一事实来源的写入/读取（DEV §4.2、FLOWS §3.1 硬约定 1）。
 *
 * 约定：状态迁移必须在**同一事务**内写一条 `task_events`（kind 见 schema v1 枚举）。
 * 本模块只负责行的读写，不含事务边界（事务由 `engine/loop.ts` 掌控）。
 */
import type { SqliteDb } from './open.js';

export interface TaskEventRow {
  id: number;
  task_id: number;
  work_item_id: number | null;
  ts: number;
  kind: string;
  actor: string;
  payload: string;
  session_ref: string | null;
}

export interface InsertTaskEventInput {
  taskId: number;
  workItemId?: number | null;
  kind: string;
  actor: string;
  ts: number;
  payload?: unknown;
  sessionRef?: string | null;
}

const COLUMNS = 'id, task_id, work_item_id, ts, kind, actor, payload, session_ref';

export function insertTaskEvent(db: SqliteDb, input: InsertTaskEventInput): number {
  const info = db
    .prepare(
      'INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload, session_ref) VALUES(?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.taskId,
      input.workItemId ?? null,
      input.ts,
      input.kind,
      input.actor,
      JSON.stringify(input.payload ?? {}),
      input.sessionRef ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function listTaskEvents(db: SqliteDb, taskId: number): TaskEventRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM task_events WHERE task_id = ? ORDER BY id`).all(taskId) as TaskEventRow[];
}

export function listTaskEventsByKind(db: SqliteDb, kind: string): TaskEventRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM task_events WHERE kind = ? ORDER BY id`).all(kind) as TaskEventRow[];
}

export function countTaskEvents(db: SqliteDb, taskId?: number): number {
  const row =
    taskId == null
      ? (db.prepare('SELECT count(*) AS c FROM task_events').get() as { c: number })
      : (db.prepare('SELECT count(*) AS c FROM task_events WHERE task_id = ?').get(taskId) as { c: number });
  return row.c;
}
