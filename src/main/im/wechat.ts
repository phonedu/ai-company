/**
 * 微信 1:1 adapter（官方 B 传输层）。
 *
 * 传输层在 `wechat-official.ts`：协议移植自腾讯官方 `Tencent/openclaw-weixin`（MIT），
 * 不再加载第三方 C 客户端，也不引入 OpenClaw 运行时。上层 `ImAdapter` 接口不变。
 *
 * 只做文本 1:1：媒体入站直接忽略（老板口径：只传文字、不做附件）。
 */
import type { ImAdapter, ImAdapterCallbacks, ImInbound, ImSendResult, ImSendTarget } from './types.js';
import { IM_WECHAT, ImAuthExpiredError, ImWindowClosedError } from './types.js';
import type { ImCredentialStore, WeChatCredentials } from './store.js';
import { createOfficialWechatClient } from './wechat-official.js';
import type {
  WeChatClientFactory,
  WeChatSdkClient,
  WeChatSdkLoginOptions,
  WeChatSdkLoginResult,
  WeChatSdkMessage,
  WeChatSdkStartOptions,
} from './wechat-official.js';

export type {
  WeChatClientFactory,
  WeChatSdkClient,
  WeChatSdkClientOptions,
  WeChatSdkLoginOptions,
  WeChatSdkLoginResult,
  WeChatSdkMessage,
  WeChatSdkStartOptions,
} from './wechat-official.js';

export interface WeChatIlinkAdapterOptions {
  store: ImCredentialStore;
  callbacks: ImAdapterCallbacks;
  /** 测试注入；缺省懒加载 C SDK。 */
  clientFactory?: WeChatClientFactory;
  /** 二维码渲染（缺省原样返回 URL；主进程注入 qrcode → data URL）。 */
  qrEncoder?: (url: string) => Promise<string>;
  now?: () => number;
  /** CR12：长轮询失败后的退避基数（默认 1000ms；测试可调小）。 */
  reconnectBaseMs?: number;
  log?: (message: string, error?: unknown) => void;
}

const USER_MESSAGE_TYPE = 1;

function extractText(msg: WeChatSdkMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    const text = item.text_item?.text;
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join('\n').trim();
}

function extractRefMsgId(msg: WeChatSdkMessage): string | null {
  for (const item of msg.item_list ?? []) {
    const ref = item.ref_msg;
    const id = ref?.message_item?.msg_id ?? ref?.message_item?.svr_id ?? ref?.svr_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

export class WeChatIlinkAdapter implements ImAdapter {
  readonly channel = IM_WECHAT;
  private readonly store: ImCredentialStore;
  private readonly callbacks: ImAdapterCallbacks;
  private readonly clientFactory: WeChatClientFactory | null;
  private readonly qrEncoder: ((url: string) => Promise<string>) | null;
  private readonly now: () => number;
  private readonly reconnectBaseMs: number;
  private readonly log: (message: string, error?: unknown) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorAttempt = 0;

  private client: WeChatSdkClient | null = null;
  private handledClient: WeChatSdkClient | null = null;
  private started = false;
  private qr: string | null = null;
  private qrStatus: string | null = null;
  private ownerId: string | null = null;
  private accountId: string | null = null;
  private loginInFlight = false;
  /** unbind/logout 时递增；晚到的 login 成功不得把已解绑的凭证重新写回。 */
  private loginGeneration = 0;

  constructor(options: WeChatIlinkAdapterOptions) {
    this.store = options.store;
    this.callbacks = options.callbacks;
    this.clientFactory = options.clientFactory ?? null;
    this.qrEncoder = options.qrEncoder ?? null;
    this.now = options.now ?? (() => Date.now());
    this.reconnectBaseMs = Math.max(10, options.reconnectBaseMs ?? 1_000);
    this.log = options.log ?? ((message, error) => console.warn(message, error ?? ''));
    const state = this.store.load();
    this.ownerId = state.credentials?.userId ?? null;
    this.accountId = state.credentials?.accountId ?? null;
  }

  getOwnerId(): string | null {
    return this.ownerId;
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  private async resolveFactory(): Promise<WeChatClientFactory> {
    return this.clientFactory ?? createOfficialWechatClient;
  }

  private async ensureClient(credentials?: WeChatCredentials | null): Promise<WeChatSdkClient> {
    if (this.client) return this.client;
    const factory = await this.resolveFactory();
    const stored = credentials ?? this.store.load().credentials;
    this.client = factory(
      stored
        ? { token: stored.botToken, accountId: stored.accountId, baseUrl: stored.baseUrl }
        : {},
    );
    this.attachHandlers(this.client);
    return this.client;
  }

  private attachHandlers(client: WeChatSdkClient): void {
    if (this.handledClient === client) return;
    this.handledClient = client;
    client.on('message', ((msg: WeChatSdkMessage) => {
      void this.handleMessage(msg);
    }) as (...args: never[]) => void);
    client.on('sessionExpired', (() => {
      this.started = false;
      this.log('[im] 微信登录态失效（-14），需要重新扫码');
      this.callbacks.onState('login_required', 'session_expired');
    }) as (...args: never[]) => void);
    client.on('error', ((error: Error) => {
      this.log('[im] 微信长轮询错误（继续尝试）', error);
      // CR12：运行中错误也必须上屏（此前 `started=true` 时只写日志）。
      this.callbacks.onState('error', error.message);
    }) as (...args: never[]) => void);
  }

  async start(): Promise<void> {
    const state = this.store.load();
    if (!state.credentials) {
      this.callbacks.onState('login_required');
      return;
    }
    this.ownerId = state.credentials.userId;
    this.accountId = state.credentials.accountId;
    const client = await this.ensureClient(state.credentials);
    this.startMonitor(client, state.credentials, state.syncBuf);
  }

  private startMonitor(client: WeChatSdkClient, credentials: WeChatCredentials, initialSyncBuf: string): void {
    this.started = true;
    this.monitorAttempt = 0;
    void this.runMonitor(client, credentials, initialSyncBuf, true);
    // 与旧行为一致：进入长轮询即视为已连接；后续失败会由 error 状态覆盖。
    this.callbacks.onState('connected');
  }

  /**
   * CR12：长轮询失败 → 指数退避重连（1s/2s/4s…封顶 30s），错误状态经 `onState('error')` 上屏；
   * 稳定运行 >60s 后失败则重置退避。`stop/unbind/logout` 会清定时器并停循环。
   */
  private async runMonitor(
    client: WeChatSdkClient,
    credentials: WeChatCredentials,
    initialSyncBuf: string,
    announce: boolean,
  ): Promise<void> {
    if (!this.started) return;
    if (announce) this.callbacks.onState('connecting');
    const startedAt = this.now();
    try {
      await client.start({
        // RM-3（2026-10-19 真机）：长轮询窗口过长会让桌面端延迟半分钟才看到手机已发的消息。
        // 5s 一轮；SDK 仍以 `stop()`/signal 正常收尾，不用 30s 默认值。
        longPollTimeoutMs: 5_000,
        loadSyncBuf: () => this.store.load().syncBuf || initialSyncBuf,
        saveSyncBuf: (buf) => {
          const current = this.store.load();
          this.store.save({ credentials: current.credentials ?? credentials, syncBuf: buf });
        },
      });
      if (!this.started) return;
      this.started = false;
      this.monitorAttempt = 0;
      this.callbacks.onState('disabled', 'monitor_stopped');
    } catch (error) {
      if (!this.started) return;
      if (this.now() - startedAt > 60_000) this.monitorAttempt = 0;
      const message = error instanceof Error ? error.message : String(error);
      this.log('[im] 微信长轮询启动失败，准备重连', error);
      this.callbacks.onState('error', message);
      const delay = Math.min(30_000, this.reconnectBaseMs * 2 ** Math.min(this.monitorAttempt, 5));
      this.monitorAttempt += 1;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.started) void this.runMonitor(client, credentials, this.store.load().syncBuf || initialSyncBuf, true);
      }, delay);
    }
  }

  async login(): Promise<void> {
    if (this.loginInFlight) return;
    this.loginInFlight = true;
    const generation = ++this.loginGeneration;
    this.callbacks.onState('login_pending');
    try {
      const client = await this.ensureClient();
      const result = await client.login({
        timeoutMs: 480_000,
        onQRCode: async (url: string) => {
          const rendered = this.qrEncoder ? await this.qrEncoder(url) : url;
          this.qr = rendered;
          this.qrStatus = 'wait';
          this.callbacks.onQr(rendered, 'wait');
        },
        onStatus: (status: string) => {
          this.qrStatus = status;
          if (this.qr) this.callbacks.onQr(this.qr, status);
          this.callbacks.onState(status === 'confirmed' ? 'connecting' : 'login_pending', status);
        },
      });
      if (
        !result.connected ||
        !result.botToken ||
        !result.accountId ||
        !result.userId
      ) {
        throw new Error(result.message || '扫码登录未完成');
      }
      // 扫码期间已经被解绑/换绑：丢弃这次登录结果，不写回凭证、不启动 monitor。
      if (generation !== this.loginGeneration) return;
      const credentials: WeChatCredentials = {
        botToken: result.botToken,
        accountId: result.accountId,
        baseUrl: result.baseUrl ?? 'https://ilinkai.weixin.qq.com',
        userId: result.userId,
      };
      const previous = this.store.load();
      this.store.save({ credentials, syncBuf: previous.syncBuf });
      this.ownerId = credentials.userId;
      this.accountId = credentials.accountId;
      this.qr = null;
      this.qrStatus = null;
      // 真机 2026-10-20：登录用的 client 是空凭据构造的（token=undefined）；若直接拿它 start，
      // getUpdates 无 token → 服务端回 -14，扫码后立刻掉回 login_required。必须用新凭证重建 client。
      const factory = await this.resolveFactory();
      const authenticatedClient = factory({
        token: credentials.botToken,
        accountId: credentials.accountId,
        baseUrl: credentials.baseUrl,
      });
      this.attachHandlers(authenticatedClient);
      this.client = authenticatedClient;
      this.startMonitor(authenticatedClient, credentials, previous.syncBuf);
    } catch (error) {
      if (generation === this.loginGeneration) {
        this.callbacks.onState('error', error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      this.loginInFlight = false;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.client?.stop();
    } catch (error) {
      this.log('[im] 停止微信长轮询失败', error);
    }
  }

  submitVerifyCode(code: string): void {
    this.client?.submitVerifyCode?.(code);
  }

  async logout(): Promise<void> {
    this.loginGeneration += 1;
    await this.stop();
    this.store.clear();
    this.client = null;
    this.handledClient = null;
    this.ownerId = null;
    this.accountId = null;
    this.qr = null;
    this.qrStatus = null;
    this.callbacks.onState('disabled');
  }

  async sendText(target: ImSendTarget, text: string): Promise<ImSendResult> {
    if (!this.client || !this.started) throw new ImAuthExpiredError('IM 未连接，无法发送');
    const contextToken =
      target.replyContext ?? this.client.getContextToken?.(target.conversationRef) ?? undefined;
    if (!contextToken) {
      throw new ImWindowClosedError('微信回复窗口已关闭（没有可用的 context_token）');
    }
    try {
      const platformMsgId = await this.client.sendText(target.conversationRef, text, contextToken);
      return { platformMsgId: platformMsgId || null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/-14|session.*expired|登录态失效/i.test(message)) throw new ImAuthExpiredError(message);
      if (/context|token|window|expired/i.test(message)) throw new ImWindowClosedError(message);
      throw error;
    }
  }

  private async handleMessage(msg: WeChatSdkMessage): Promise<void> {
    if (msg.message_type !== USER_MESSAGE_TYPE) return;
    const senderId = msg.from_user_id;
    if (typeof senderId !== 'string' || senderId.length === 0) return;
    // 产品没有群聊。若平台消息带房间/群标识，直接丢弃——绝不把群消息当 1:1 回复。
    const room = msg as unknown as {
      room_id?: unknown;
      chatroom_id?: unknown;
      roomId?: unknown;
      chat_id?: unknown;
      group_id?: unknown;
    };
    const roomId = room.room_id ?? room.chatroom_id ?? room.roomId ?? room.chat_id ?? room.group_id;
    if (typeof roomId === 'string' && roomId.trim().length > 0) {
      this.log('[im] 忽略群消息（产品只做老板↔幕僚长 1:1）');
      return;
    }
    const text = extractText(msg);
    if (text.length === 0) {
      // 文字-only：媒体/空消息不导入，留一行日志（不静默吞成“没收到”）。
      this.log(`[im] 忽略非文字消息 from=${senderId}（本轮只做文字 1:1）`);
      return;
    }
    const inbound: ImInbound = {
      channel: IM_WECHAT,
      conversationRef: senderId,
      senderId,
      senderName: `微信 ${senderId}`,
      text,
      platformMsgId: msg.message_id != null ? String(msg.message_id) : (msg.client_id ?? null),
      replyToMsgId: extractRefMsgId(msg),
      ...(typeof msg.context_token === 'string' && msg.context_token.length > 0
        ? { replyContext: msg.context_token }
        : {}),
      receivedAt: msg.create_time_ms ?? this.now(),
    };
    try {
      await this.callbacks.onInbound(inbound);
    } catch (error) {
      this.log('[im] 入站处理失败', error);
    }
  }
}

