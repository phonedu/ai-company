/**
 * OPT- · `notifications` DAO（投递记录；`schema.sql` 001 已建表）。
 *
 * 用途：给某个**通道**记录一次投递（幂等）。员工间 mailbox（``）复用本表：
 * `channel='employee:<id>'`（**绝不落 `im:*`/`desktop`** → 不污染人类频道）；
 * `dedupe_key='ask:<from>:<to>:<work_item>:<seq>'`（`UNIQUE` → 同键重放直接丢弃）。
 */
import type { SqliteDb } from './open.js';

export interface NotificationRow {
  id: number;
  report_id: number | null;
  channel: string;
  conversation_ref: string | null;
  dedupe_key: string;
  sent_at: number;
  /** R2-2（迁移 006）：答复被提问者会话消费的时刻；NULL = 未读（desktop/im 投递恒 NULL）。 */
  read_at: number | null;
  merged_into: number | null;
}

const COLUMNS = 'id, report_id, channel, conversation_ref, dedupe_key, sent_at, read_at, merged_into';

export interface InsertNotificationInput {
  reportId?: number | null;
  channel: string;
  conversationRef?: string | null;
  dedupeKey: string;
  sentAt: number;
}

/** 幂等投递登记：同 `dedupe_key` 重放不新增行（返回是否本次新插入）。 */
export function insertNotification(db: SqliteDb, input: InsertNotificationInput): boolean {
  const info = db
    .prepare('INSERT OR IGNORE INTO notifications(report_id, channel, conversation_ref, dedupe_key, sent_at) VALUES(?, ?, ?, ?, ?)')
    .run(input.reportId ?? null, input.channel, input.conversationRef ?? null, input.dedupeKey, input.sentAt);
  return info.changes > 0;
}

export function getNotificationByDedupeKey(db: SqliteDb, dedupeKey: string): NotificationRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE dedupe_key = ?`).get(dedupeKey) as NotificationRow | undefined;
}

export function listNotifications(db: SqliteDb, options: { channel?: string } = {}): NotificationRow[] {
  if (options.channel != null) {
    return db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE channel = ? ORDER BY id`).all(options.channel) as NotificationRow[];
  }
  return db.prepare(`SELECT ${COLUMNS} FROM notifications ORDER BY id`).all() as NotificationRow[];
}

/**
 * R2-2（G7）：把给定的投递标记为已读（`read_at`，幂等——已读的不再覆盖时刻）。
 * 返回本次真正写入的行数（供测试断言/观测；0 = 全都已读过）。
 */
export function markNotificationsRead(db: SqliteDb, dedupeKeys: readonly string[], readAt: number): number {
  if (dedupeKeys.length === 0) return 0;
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE dedupe_key = ? AND read_at IS NULL');
  let changed = 0;
  for (const key of dedupeKeys) changed += stmt.run(readAt, key).changes;
  return changed;
}
