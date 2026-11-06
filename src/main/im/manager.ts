/**
 * IM 通道管理器（本轮：微信 1:1）。
 *
 * 职责边界：
 *  - 生命周期：start/bind/unbind/stop；不创建任何群对象，只保证 1 个私聊会话行。
 *  - 安全：**只接受扫码登录者本人**；其他人消息直接丢弃并留日志（不回复、不落 transcript）。
 *  - 顺序：同一会话串行处理，避免两条消息并发建任务/并发作答。
 *  - 出站：幕僚长回复按平台上限切块；主动卡片交给 `ImOutbox`（窗口/失败可见）。
 */
import type { SqliteDb } from '../db/open.js';
import { chunkText } from './format.js';
import { ImOutbox } from './outbox.js';
import type {
  ImAdapter,
  ImAdapterCallbacks,
  ImBindPort,
  ImChannel,
  ImConnectionState,
  ImInbound,
  ImStatus,
} from './types.js';
import { IM_WECHAT } from './types.js';

export interface ImInboundHost {
  /** 立即回执（例如“收到，已交给幕僚长”）；失败只留日志，不打断处理。 */
  sendText(text: string): Promise<void>;
}

export type ImInboundHandler = (msg: ImInbound, host: ImInboundHost) => Promise<{ reply: string | null }>;

export interface ImManagerOptions {
  db: SqliteDb;
  createAdapter: (callbacks: ImAdapterCallbacks) => ImAdapter;
  onInbound: ImInboundHandler;
  now?: () => number;
  outboxIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

const DEDUP_LIMIT = 500;
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;

export class ImManager implements ImBindPort {
  readonly channel: ImChannel = IM_WECHAT;
  private readonly db: SqliteDb;
  private readonly adapter: ImAdapter;
  private readonly outbox: ImOutbox;
  private readonly onInbound: ImInboundHandler;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private state: ImConnectionState = 'disabled';
  private qr: string | null = null;
  private qrStatus: string | null = null;
  private lastError: string | null = null;
  private connectedOnce = false;
  private started = false;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: ImManagerOptions) {
    this.db = options.db;
    this.onInbound = options.onInbound;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message, error) => console.warn(message, error ?? ''));
    this.adapter = options.createAdapter({
      onInbound: (msg) => this.enqueueInbound(msg),
      onState: (state, detail) => this.handleState(state, detail),
      onQr: (qr, status) => this.handleQr(qr, status),
    });
    this.outbox = new ImOutbox({
      db: this.db,
      channel: this.channel,
      conversationRef: () => this.adapter.getOwnerId(),
      adapter: () => this.adapter,
      now: this.now,
      intervalMs: options.outboxIntervalMs ?? 2_000,
      log: this.log,
    });
  }

  status(): ImStatus {
    return {
      channel: this.channel,
      state: this.state,
      qr: this.qr,
      qrStatus: this.qrStatus,
      ownerId: this.adapter.getOwnerId(),
      accountId: this.adapter.getAccountId(),
      lastError: this.lastError,
      pendingOutbox: this.outbox.pendingCount(),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.outbox.start();
    try {
      await this.adapter.start();
    } catch (error) {
      this.started = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = 'error';
      this.log('[im] 启动失败', error);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.outbox.stop();
    await this.adapter.stop();
  }

  /** 开始扫码（后台跑；二维码经 status/onQr 推到设置页）。 */
  async bind(input?: { verifyCode?: string }): Promise<ImStatus> {
    if (input?.verifyCode && this.state === 'login_pending') {
      this.adapter.submitVerifyCode?.(input.verifyCode);
      this.lastError = null;
      return this.status();
    }
    this.lastError = null;
    this.qrStatus = 'wait';
    this.state = 'login_pending';
    // unbind 会停 outbox；重新绑定必须恢复定时补发/取消，并重置一次登录补发标记。
    this.connectedOnce = false;
    this.outbox.start();
    void this.adapter.login().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = 'login_required';
      this.log('[im] 扫码登录失败', error);
    });
    return this.status();
  }

  async unbind(): Promise<ImStatus> {
    await this.adapter.logout();
    this.outbox.stop();
    this.connectedOnce = false;
    this.qr = null;
    this.qrStatus = null;
    this.lastError = null;
    this.state = 'disabled';
    return this.status();
  }

  /** 新卡片 → 入队（未登录时 no-op；登录后补发窗口内的卡）。 */
  onReport(reportId: number, taskId?: number | null): void {
    this.outbox.enqueueReport(reportId, taskId);
    void this.outbox.wake();
  }

  /** 测试/收尾：等当前串行队列清空（生产不调用）。 */
  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()]);
    }
  }

  private handleState(state: ImConnectionState, detail?: string | null): void {
    this.state = state;
    if (state === 'connected') {
      this.lastError = null;
      this.qr = null;
      this.qrStatus = null;
      this.ensureConversation();
      if (!this.connectedOnce) {
        this.connectedOnce = true;
        const count = this.outbox.backfill(this.now() - BACKFILL_WINDOW_MS);
        if (count > 0) this.log(`[im] 登录后补发检查：${count} 张窗口内卡片`);
      }
      void this.outbox.wake();
      return;
    }
    if (state === 'login_required') {
      this.connectedOnce = false;
    }
    if (detail != null && detail.length > 0 && state === 'error') this.lastError = detail;
  }

  private handleQr(qr: string, status: string): void {
    this.qr = qr;
    this.qrStatus = status;
    if (this.state !== 'connected') this.state = 'login_pending';
  }

  /** 1 个绑定账号 = 1 个私聊会话；永远不写 kind='group'。 */
  private ensureConversation(): void {
    const owner = this.adapter.getOwnerId();
    if (!owner) return;
    this.db
      .prepare(
        `INSERT INTO im_conversations(channel, conversation_ref, kind, last_active_at)
         VALUES(?, ?, 'private', ?)
         ON CONFLICT(channel, conversation_ref) DO UPDATE SET last_active_at = excluded.last_active_at`,
      )
      .run(this.channel, owner, this.now());
  }

  private enqueueInbound(msg: ImInbound): void {
    const owner = this.adapter.getOwnerId();
    if (!owner) {
      this.log('[im] 收到消息但尚未完成扫码绑定：丢弃（fail-closed）');
      return;
    }
    if (msg.senderId !== owner) {
      this.log(`[im] 非 owner 消息已丢弃：sender=${msg.senderId}`);
      return;
    }
    if (msg.platformMsgId) {
      if (this.seen.has(msg.platformMsgId)) return;
      this.seen.add(msg.platformMsgId);
      this.seenOrder.push(msg.platformMsgId);
      while (this.seenOrder.length > DEDUP_LIMIT) {
        const oldest = this.seenOrder.shift();
        if (oldest) this.seen.delete(oldest);
      }
    }
    const key = msg.conversationRef;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.processInbound(msg)).catch((error: unknown) => {
      this.log('[im] 入站处理失败（消息已落库的部分不回滚）', error);
    });
    let tail: Promise<void>;
    tail = next.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    this.queues.set(key, tail);
  }

  private async processInbound(msg: ImInbound): Promise<void> {
    const host: ImInboundHost = {
      sendText: (text) => this.sendReply(msg, text),
    };
    const result = await this.onInbound(msg, host);
    if (result.reply && result.reply.trim().length > 0) {
      await this.sendReply(msg, result.reply);
    }
    // 本条入站刷新了 context_token：让被窗口挡住的卡片再试一次。
    void this.outbox.wake();
  }

  private async sendReply(msg: ImInbound, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      try {
        await this.adapter.sendText(
          { conversationRef: msg.conversationRef, ...(msg.replyContext ? { replyContext: msg.replyContext } : {}) },
          chunk,
        );
      } catch (error) {
        // 回复发不出去不假装成功；桌面 transcript 仍是事实源，日志留现场。
        this.log('[im] 回复发送失败（桌面仍有记录）', error);
        return;
      }
    }
  }
}
