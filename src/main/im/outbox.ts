/**
 * IM 主动卡片投递器（微信 1:1）。
 *
 * 事实源：`reports`（卡片）。本类只做三件事：
 *  ① 把新卡入队（`im_outbox`，按 report 幂等）；
 *  ② 到点发送（失败按窗口/鉴权/瞬时错误分流，不假装成功）；
 *  ③ 发成功后写 `outbound_refs`（引用回复归位的锚点）。
 *
 * 平台窗口（微信 `context_token` / 24h）导致发不出 → `blocked`，等下一次入站后 `wake()` 再补。
 * 卡片已被桌面处理（state != pending）→ 取消未发行，不再骚扰手机。
 */
import type { SqliteDb } from '../db/open.js';
import {
  claimImOutbox,
  enqueueImOutbox,
  listDueImOutbox,
  markImOutboxBlocked,
  markImOutboxFailed,
  markImOutboxSent,
  recoverSendingImOutbox,
  wakeBlockedImOutbox,
} from '../db/im_outbox.js';
import { insertOutboundRef } from '../db/outbound_refs.js';
import { getReport, type ReportRow } from '../db/reports.js';
import { formatCardText } from './format.js';
import {
  ImAuthExpiredError,
  ImWindowClosedError,
  type ImAdapter,
  type ImChannel,
} from './types.js';

export interface ImOutboxOptions {
  db: SqliteDb;
  channel: ImChannel;
  /** 登录后才有；未登录返回 null（不入队、不发送）。 */
  conversationRef: () => string | null;
  adapter: () => ImAdapter | null;
  now?: () => number;
  intervalMs?: number;
  maxAttempts?: number;
  log?: (message: string, error?: unknown) => void;
}

const CARD_KINDS = new Set(['ask', 'report', 'alert']);

export class ImOutbox {
  private readonly db: SqliteDb;
  private readonly channel: ImChannel;
  private readonly conversationRef: () => string | null;
  private readonly adapter: () => ImAdapter | null;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly log: (message: string, error?: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ImOutboxOptions) {
    this.db = options.db;
    this.channel = options.channel;
    this.conversationRef = options.conversationRef;
    this.adapter = options.adapter;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 2_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.log = options.log ?? ((message, error) => console.warn(message, error ?? ''));
  }

  /** 新卡入队；未登录/非三类卡 → no-op。 */
  enqueueReport(reportId: number, taskId?: number | null): void {
    const conversationRef = this.conversationRef();
    if (!conversationRef) return;
    const report = getReport(this.db, reportId);
    if (!report || !CARD_KINDS.has(report.kind) || report.state !== 'pending') return;
    enqueueImOutbox(this.db, {
      channel: this.channel,
      conversationRef,
      reportId,
      taskId: taskId ?? report.task_id,
      now: this.now(),
    });
  }

  /**
   * 登录成功后的补发：最近窗口内仍 pending 的卡片。
   * 已入队过的（含 sent/cancelled）由 UNIQUE 幂等挡住；不重发已处理卡。
   */
  backfill(since: number, limit = 20): number {
    const conversationRef = this.conversationRef();
    if (!conversationRef) return 0;
    const rows = this.db
      .prepare(
        `SELECT id, task_id FROM reports
         WHERE state = 'pending' AND kind IN ('ask', 'report', 'alert') AND created_at >= ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(since, limit) as Array<{ id: number; task_id: number | null }>;
    for (const row of rows) this.enqueueReport(row.id, row.task_id);
    return rows.length;
  }

  pendingCount(): number {
    const conversationRef = this.conversationRef();
    if (!conversationRef) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM im_outbox
         WHERE channel = ? AND conversation_ref = ? AND state IN ('pending', 'blocked', 'sending')`,
      )
      .get(this.channel, conversationRef) as { c: number };
    return row.c;
  }

  start(): void {
    if (this.timer) return;
    const recovered = recoverSendingImOutbox(this.db);
    if (recovered > 0) this.log(`[im] outbox 崩溃恢复：${recovered} 行 sending → pending`);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 入站后/登录后唤醒：先把 blocked 放回 pending，再发一轮（调用方可 void）。
   *  RW-23：过期不补＋单次限量——老板首次回复不收到历史卡批量刷屏。 */
  async wake(): Promise<void> {
    const conversationRef = this.conversationRef();
    if (conversationRef) {
      const r = wakeBlockedImOutbox(this.db, this.channel, conversationRef, { now: this.now() });
      if (r.woken > 0 || r.expired > 0) {
        console.log(`[im-outbox] 唤醒补发 woken=${r.woken} expired=${r.expired}`);
      }
    }
    await this.tick();
  }

  /** 发送一轮；测试直接调用。 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const adapter = this.adapter();
      const conversationRef = this.conversationRef();
      if (!adapter || !conversationRef) return;
      const now = this.now();
      // 只取当前会话的到期行；旧 owner 的 pending 留在原会话，不得跨会话发送。
      const rows = listDueImOutbox(this.db, this.channel, conversationRef, now);
      for (const row of rows) {
        const report = getReport(this.db, row.report_id);
        if (!report || !CARD_KINDS.has(report.kind) || report.state !== 'pending') {
          const reason = report ? `report_${report.state}` : 'report_missing';
          this.db
            .prepare(
              `UPDATE im_outbox SET state='cancelled', last_error=?, next_attempt_at=NULL
               WHERE report_id=? AND state IN ('pending','blocked','sending')`,
            )
            .run(reason, row.report_id);
          continue;
        }
        if (!claimImOutbox(this.db, row.id, this.channel, conversationRef, now)) continue;
        // 写回该行自己的 conversation_ref（与当前会话相同；防御性取行值，不把旧卡写进新会话）。
        await this.sendOne(adapter, row.conversation_ref, row.id, row.attempts + 1, report);
      }
    } finally {
      this.running = false;
    }
  }

  private async sendOne(
    adapter: ImAdapter,
    conversationRef: string,
    outboxId: number,
    attempt: number,
    report: ReportRow,
  ): Promise<void> {
    try {
      const text = formatCardText(report.kind, report.payload);
      const sent = await adapter.sendText({ conversationRef }, text);
      markImOutboxSent(this.db, outboxId, sent.platformMsgId, this.now());
      insertOutboundRef(this.db, {
        channel: this.channel,
        conversationRef,
        // 平台不回传消息 id 时写合成 id：引用链用不了，但序号回复仍可用。
        platformMsgId: sent.platformMsgId ?? `outbox:${outboxId}`,
        taskId: report.task_id,
        reportId: report.id,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof ImWindowClosedError) {
        markImOutboxBlocked(this.db, outboxId, error.message);
        this.log(`[im] 卡片 ${report.id} 暂不可发（窗口关闭），等下次入站补发`);
        return;
      }
      if (error instanceof ImAuthExpiredError) {
        markImOutboxBlocked(this.db, outboxId, error.message);
        this.log(`[im] 卡片 ${report.id} 暂不可发（登录态失效），等重新扫码`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= this.maxAttempts) {
        markImOutboxFailed(this.db, outboxId, message, null, true);
        this.log(`[im] 卡片 ${report.id} 发送失败（已重试 ${attempt} 次，停止自动重试）`, error);
        return;
      }
      const next = this.now() + 5_000 * attempt;
      markImOutboxFailed(this.db, outboxId, message, next, false);
      this.log(`[im] 卡片 ${report.id} 发送失败（第 ${attempt} 次，稍后重试）`, error);
    }
  }
}
