/**
 * `human_messages` DAO —— 老板频道唯一 transcript（schema.sql）。
 * 入站（in）/ 出站（out）都落这里；`attachments` 为 JSON。
 */
import type { SqliteDb } from './open.js';

export interface HumanMessageRow {
  id: number;
  direction: 'in' | 'out' | string;
  task_id: number | null;
  content: string;
  attachments: string;
  inbox_item_id: number | null;
  created_at: number;
}

export interface InsertHumanMessageInput {
  direction: 'in' | 'out' | string;
  taskId?: number | null;
  content: string;
  attachments?: unknown[];
  inboxItemId?: number | null;
  now?: number;
}

const COLUMNS = 'id, direction, task_id, content, attachments, inbox_item_id, created_at';

export function insertHumanMessage(db: SqliteDb, input: InsertHumanMessageInput): HumanMessageRow {
  const row = db
    .prepare(
      `INSERT INTO human_messages(direction, task_id, content, attachments, inbox_item_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      input.direction,
      input.taskId ?? null,
      input.content,
      JSON.stringify(input.attachments ?? []),
      input.inboxItemId ?? null,
      input.now ?? Date.now(),
    ) as HumanMessageRow;
  return row;
}

export interface ListHumanMessagesOptions {
  taskId?: number;
  limit?: number;
  /** 取**最新** N 条（仍按时间升序返回）；缺省＝最旧 N 条（历史口径）。 */
  latest?: boolean;
}

export function listHumanMessages(db: SqliteDb, options: ListHumanMessagesOptions = {}): HumanMessageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.taskId !== undefined) {
    where.push('task_id = ?');
    params.push(options.taskId);
  }
  const order = options.latest === true ? 'DESC' : 'ASC';
  const limit = options.limit != null ? ' LIMIT ?' : '';
  if (options.limit != null) params.push(options.limit);
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM human_messages${clause} ORDER BY created_at ${order}, id ${order}${limit}`)
    .all(...params) as HumanMessageRow[];
  return options.latest === true ? rows.reverse() : rows;
}

export function getHumanMessage(db: SqliteDb, id: number): HumanMessageRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM human_messages WHERE id = ?`).get(id) as HumanMessageRow | undefined;
}
