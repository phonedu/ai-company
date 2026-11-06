/**
 * `outbound_refs` DAO —— 出站消息 → 任务/卡片的回复链锚点。
 *
 * IM 主动卡片发送成功后写一行；老板「引用那条消息回复」时，resolver 第 3 步据此归位。
 * 平台不回传可用消息 id 时，调用方写合成 id（如 `outbox:<id>`），序号回复仍走 pending_lists。
 */
import type { SqliteDb } from './open.js';

export interface InsertOutboundRefInput {
  channel: string;
  conversationRef: string;
  platformMsgId: string;
  taskId?: number | null;
  reportId?: number | null;
  now?: number;
}

export function insertOutboundRef(db: SqliteDb, input: InsertOutboundRefInput): void {
  db.prepare(
    `INSERT INTO outbound_refs(channel, conversation_ref, platform_msg_id, task_id, report_id, sent_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, platform_msg_id) DO NOTHING`,
  ).run(
    input.channel,
    input.conversationRef,
    input.platformMsgId,
    input.taskId ?? null,
    input.reportId ?? null,
    input.now ?? Date.now(),
  );
}

export interface OutboundRefRow {
  id: number;
  channel: string;
  conversation_ref: string;
  platform_msg_id: string;
  task_id: number | null;
  report_id: number | null;
  sent_at: number;
}

/** 最近出站引用（审批序号兜底：同一私聊只保留最近几条）。 */
export function listRecentOutboundRefs(
  db: SqliteDb,
  channel: string,
  conversationRef: string,
  limit = 5,
): OutboundRefRow[] {
  return db
    .prepare(
      `SELECT id, channel, conversation_ref, platform_msg_id, task_id, report_id, sent_at
       FROM outbound_refs
       WHERE channel = ? AND conversation_ref = ?
       ORDER BY sent_at DESC, id DESC
       LIMIT ?`,
    )
    .all(channel, conversationRef, limit) as OutboundRefRow[];
}
