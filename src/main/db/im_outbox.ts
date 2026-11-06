/**
 * `im_outbox` DAO —— IM 主动卡片投递队列（迁移 013）。
 *
 * 卡片事实源仍是 `reports`；本表只回答「这张卡送到哪个私聊会话、现在到哪一步」。
 * 平台窗口导致发不出时置 `blocked`（等下一次入站补发），不假装已送达。
 */
import type { SqliteDb } from './open.js';

export type ImOutboxState =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ImOutboxRow {
  id: number;
  channel: string;
  conversation_ref: string;
  report_id: number;
  task_id: number | null;
  state: ImOutboxState;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  platform_msg_id: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface EnqueueImOutboxInput {
  channel: string;
  conversationRef: string;
  reportId: number;
  taskId?: number | null;
  now?: number;
}

const COLUMNS =
  'id, channel, conversation_ref, report_id, task_id, state, attempts, last_error, next_attempt_at, platform_msg_id, created_at, sent_at';

/** 幂等入队：同 `(channel, conversation_ref, report_id)` 只留一行。 */
export function enqueueImOutbox(db: SqliteDb, input: EnqueueImOutboxInput): ImOutboxRow {
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO im_outbox(channel, conversation_ref, report_id, task_id, state, created_at)
     VALUES(?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(channel, conversation_ref, report_id) DO NOTHING`,
  ).run(input.channel, input.conversationRef, input.reportId, input.taskId ?? null, now);
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM im_outbox WHERE channel = ? AND conversation_ref = ? AND report_id = ?`)
    .get(input.channel, input.conversationRef, input.reportId) as ImOutboxRow | undefined;
  if (!row) throw new Error('[db] enqueueImOutbox: 入队后读不到行');
  return row;
}

/**
 * 到期待发（只发 `pending`；`sending` 由崩溃恢复处理，`blocked` 等下一次入站/登录显式唤醒）。
 * **必须按 `(channel, conversation_ref)` 取行**：换绑 owner 后，旧会话的卡不得发到新会话。
 */
export function listDueImOutbox(
  db: SqliteDb,
  channel: string,
  conversationRef: string,
  now: number,
  limit = 20,
): ImOutboxRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM im_outbox
       WHERE channel = ? AND conversation_ref = ? AND state = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, id
       LIMIT ?`,
    )
    .all(channel, conversationRef, now, limit) as ImOutboxRow[];
}

/**
 * 入站/登录成功：把 `blocked` 行放回 `pending`，由本轮 tick 再试一次。
 *
 * RW-23（S10 真机，2026-10-28）：补发**不得刷屏**——
 * ① 过期不补：`created_at` 早于 `now - maxAgeMs`（缺省 24h）→ `cancelled`（last_error 留痕）；
 * ② 单次限量：只唤醒**最新** `limit` 张（缺省 5），其余留 blocked，下次入站再陆续补。
 * 老板首次在手机发消息打开 48h 回推窗口时，此前积压几十张卡不会一次性推到手机上。
 */
export function wakeBlockedImOutbox(
  db: SqliteDb,
  channel: string,
  conversationRef: string,
  opts: { now?: number; maxAgeMs?: number; limit?: number } = {},
): { woken: number; expired: number } {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
  const limit = Math.max(1, opts.limit ?? 5);
  const expired = db
    .prepare(
      `UPDATE im_outbox SET state = 'cancelled', last_error = ?, next_attempt_at = NULL
       WHERE channel = ? AND conversation_ref = ? AND state = 'blocked' AND created_at < ?`,
    )
    .run('补发过期（超过 24 小时未推送，不再补发）', channel, conversationRef, now - maxAgeMs);
  const ids = (
    db
      .prepare(
        `SELECT id FROM im_outbox
         WHERE channel = ? AND conversation_ref = ? AND state = 'blocked'
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(channel, conversationRef, limit) as Array<{ id: number }>
  ).map((row) => row.id);
  if (ids.length > 0) {
    db.prepare(
      `UPDATE im_outbox SET state = 'pending', next_attempt_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).run(...ids);
  }
  return { woken: ids.length, expired: expired.changes };
}

/**
 * 抢占一行：`pending → sending`，attempts+1。返回 false = 已被别的循环拿走。
 * **同时校验 `(channel, conversation_ref)`**：防止旧会话行被当前 owner 的 tick 抢走。
 */
export function claimImOutbox(
  db: SqliteDb,
  id: number,
  channel: string,
  conversationRef: string,
  now: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE im_outbox
       SET state = 'sending', attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL
       WHERE id = ? AND channel = ? AND conversation_ref = ? AND state = 'pending'`,
    )
    .run(id, channel, conversationRef);
  void now;
  return result.changes === 1;
}

export function markImOutboxSent(db: SqliteDb, id: number, platformMsgId: string | null, now: number): void {
  db.prepare(
    `UPDATE im_outbox SET state = 'sent', platform_msg_id = ?, sent_at = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?`,
  ).run(platformMsgId, now, id);
}

/** 可重试失败：回 `pending` 并排下一次；`terminal=true` → `failed`（不再自动重试）。 */
export function markImOutboxFailed(
  db: SqliteDb,
  id: number,
  error: string,
  nextAttemptAt: number | null,
  terminal: boolean,
): void {
  db.prepare(
    `UPDATE im_outbox
     SET state = ?, last_error = ?, next_attempt_at = ?
     WHERE id = ?`,
  ).run(terminal ? 'failed' : 'pending', error, terminal ? null : nextAttemptAt, id);
}

/** 平台窗口/未连接：不明目张胆重试，等下次入站或登录成功后唤醒。 */
export function markImOutboxBlocked(db: SqliteDb, id: number, reason: string): void {
  db.prepare(`UPDATE im_outbox SET state = 'blocked', last_error = ?, next_attempt_at = NULL WHERE id = ?`).run(
    reason,
    id,
  );
}

/** 卡片已处理/已过期：取消所有未发/阻塞行（sent 不动，已发出的消息无法撤回）。 */
export function cancelImOutboxForReport(db: SqliteDb, reportId: number, reason: string): number {
  const result = db
    .prepare(
      `UPDATE im_outbox
       SET state = 'cancelled', last_error = ?, next_attempt_at = NULL
       WHERE report_id = ? AND state IN ('pending', 'blocked', 'sending')`,
    )
    .run(reason, reportId);
  return result.changes;
}

/** 崩溃恢复：`sending` 行回到 `pending`（可能已发出但未落账；由平台侧消息 id 去重兜底）。 */
export function recoverSendingImOutbox(db: SqliteDb): number {
  const result = db
    .prepare(
      `UPDATE im_outbox SET state = 'pending', last_error = 'recovered_after_restart' WHERE state = 'sending'`,
    )
    .run();
  return result.changes;
}

export function getImOutboxByReport(
  db: SqliteDb,
  channel: string,
  conversationRef: string,
  reportId: number,
): ImOutboxRow | null {
  return (
    (db
      .prepare(`SELECT ${COLUMNS} FROM im_outbox WHERE channel = ? AND conversation_ref = ? AND report_id = ?`)
      .get(channel, conversationRef, reportId) as ImOutboxRow | undefined) ?? null
  );
}

export function listPendingImOutboxForConversation(
  db: SqliteDb,
  channel: string,
  conversationRef: string,
): ImOutboxRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM im_outbox
       WHERE channel = ? AND conversation_ref = ? AND state IN ('pending', 'blocked')
       ORDER BY created_at, id`,
    )
    .all(channel, conversationRef) as ImOutboxRow[];
}
