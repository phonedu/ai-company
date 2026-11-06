/**
 * 腾讯官方微信 iLink 传输层（B）。
 *
 * 协议移植自 `@tencent-weixin/openclaw-weixin@2.4.10`（MIT，Copyright (C) 2026 Tencent）：
 * 只保留本产品 1:1 文本所需的扫码登录、getUpdates 长轮询、sendMessage、context_token
 * 与 get_updates_buf 持久化；不引入 OpenClaw 插件运行时/媒体/群聊链路。
 * MIT 许可与来源见仓库根 `THIRD_PARTY_NOTICES.md`。
 */
import { randomBytes, randomUUID } from 'node:crypto';

export interface WeChatSdkMessage {
  message_id?: string | number;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  create_time_ms?: number;
  context_token?: string;
  /** 官方协议用 group_id 标识群消息；本产品只做 1:1，收到即丢弃。 */
  group_id?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    ref_msg?: {
      message_item?: { msg_id?: string; svr_id?: string };
      svr_id?: string;
    };
  }>;
}

export interface WeChatSdkLoginResult {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

export interface WeChatSdkLoginOptions {
  timeoutMs?: number;
  botType?: string;
  maxRefreshes?: number;
  /** 平台要求验证码时由调用方提供；当前桌面入口未接输入，缺省会明确报错。 */
  verifyCode?: string;
  onQRCode?: (url: string) => void | Promise<void>;
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}

export interface WeChatSdkStartOptions {
  longPollTimeoutMs?: number;
  signal?: AbortSignal;
  loadSyncBuf?: () => string | undefined | Promise<string | undefined>;
  saveSyncBuf?: (buf: string) => void | Promise<void>;
}

/** 官方客户端的最小结构子集（测试用假 client 实现同一接口）。 */
export interface WeChatSdkClient {
  login(opts?: WeChatSdkLoginOptions): Promise<WeChatSdkLoginResult>;
  start(opts?: WeChatSdkStartOptions): Promise<void>;
  stop(): void;
  sendText(to: string, text: string, contextToken?: string): Promise<string>;
  getContextToken?(userId: string): string | undefined;
  /** 平台要求数字验证码时由设置页提交；客户端在登录轮询中等待它。 */
  submitVerifyCode?(code: string): void;
  on(event: string, handler: (...args: never[]) => void): unknown;
}

export interface WeChatSdkClientOptions {
  token?: string;
  accountId?: string;
  baseUrl?: string;
  channelVersion?: string;
  routeTag?: string;
  /** 测试注入；缺省使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
  qrPollIntervalMs?: number;
  loginBaseUrl?: string;
  botAgent?: string;
}

export type WeChatClientFactory = (opts: WeChatSdkClientOptions) => WeChatSdkClient;

const FIXED_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CHANNEL_VERSION = '2.4.10';
const DEFAULT_BOT_AGENT = 'ai-company/0.0.1';
const ILINK_APP_ID = 'bot';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 15_000;
const DEFAULT_QR_REFRESH_LIMIT = 3;

type LoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

interface QRCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QRStatusResponse {
  status: LoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeChatSdkMessage[];
  get_updates_buf?: string;
}

interface SendMessageResponse {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/**
 * 官方协议把 uint64 消息 id 放在 JSON number 里；直接 JSON.parse 会丢精度。
 * 只给 id 字段加引号，其余数字原样保留（移植自官方 `parseWeixinApiJson`）。
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index] ?? '';
      index += 1;
      continue;
    }

    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index];
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++] ?? '';

    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

export class OfficialWechatClient implements WeChatSdkClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly qrPollIntervalMs: number;
  private readonly loginBaseUrl: string;
  private readonly channelVersion: string;
  private readonly routeTag: string | null;
  private readonly botAgent: string;
  private readonly token: string | undefined;
  private readonly baseUrl: string;

  private readonly handlers = new Map<string, Set<(...args: never[]) => void>>();
  private readonly contextTokens = new Map<string, string>();
  private running = false;
  private abort: AbortController | null = null;
  private pendingVerifyCode: string | null = null;
  private verifyCodeWaiter: ((code: string | null) => void) | null = null;

  constructor(options: WeChatSdkClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.qrPollIntervalMs = Math.max(1, options.qrPollIntervalMs ?? 1_000);
    this.loginBaseUrl = options.loginBaseUrl ?? FIXED_LOGIN_BASE_URL;
    this.channelVersion = options.channelVersion ?? DEFAULT_CHANNEL_VERSION;
    this.routeTag = options.routeTag?.trim() || null;
    this.botAgent = options.botAgent ?? DEFAULT_BOT_AGENT;
    this.token = options.token?.trim() || undefined;
    this.baseUrl = options.baseUrl?.trim() || FIXED_LOGIN_BASE_URL;
  }

  on(event: string, handler: (...args: never[]) => void): unknown {
    const list = this.handlers.get(event) ?? new Set<(...args: never[]) => void>();
    list.add(handler);
    this.handlers.set(event, list);
    return this;
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  submitVerifyCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) return;
    if (this.verifyCodeWaiter) {
      const waiter = this.verifyCodeWaiter;
      this.verifyCodeWaiter = null;
      waiter(trimmed);
      return;
    }
    // 用户可能比轮询更早提交：先存着，下一次 need_verifycode 直接取。
    this.pendingVerifyCode = trimmed;
  }

  private waitForVerifyCode(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.pendingVerifyCode) {
      const code = this.pendingVerifyCode;
      this.pendingVerifyCode = null;
      return Promise.resolve(code);
    }
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (code: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.verifyCodeWaiter === finish) this.verifyCodeWaiter = null;
        resolve(code);
      };
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.verifyCodeWaiter = finish;
    });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...(args as never[]));
    }
  }

  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(encodeClientVersion(this.channelVersion)),
    };
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    return headers;
  }

  private postHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.commonHeaders(),
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent };
  }

  private async request(params: {
    method: 'GET' | 'POST';
    baseUrl: string;
    endpoint: string;
    body?: string;
    token?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
  }): Promise<string> {
    const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)).toString();
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: params.method,
        headers: params.method === 'GET' ? this.commonHeaders() : this.postHeaders(params.token),
        ...(params.body !== undefined ? { body: params.body } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${params.label} HTTP ${response.status}`);
      }
      return text;
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async fetchQr(botType: string): Promise<QRCodeResponse> {
    const raw = await this.request({
      method: 'POST',
      baseUrl: this.loginBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: JSON.stringify({ local_token_list: this.token ? [this.token] : [] }),
      timeoutMs: LOGIN_REQUEST_TIMEOUT_MS,
      label: 'get_bot_qrcode',
    });
    const parsed = JSON.parse(raw) as QRCodeResponse;
    if (!parsed.qrcode || !parsed.qrcode_img_content) {
      throw new Error('微信登录二维码响应不完整');
    }
    return parsed;
  }

  private async pollQr(
    baseUrl: string,
    qrcode: string,
    opts: WeChatSdkLoginOptions,
    verifyCode: string | undefined,
  ): Promise<QRStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      const raw = await this.request({
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: QR_POLL_TIMEOUT_MS,
        label: 'get_qrcode_status',
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return JSON.parse(raw) as QRStatusResponse;
    } catch (error) {
      if (opts.signal?.aborted || !isAbortError(error)) throw error;
      // 长轮询超时是正常控制流：回到 wait，继续等扫码。
      return { status: 'wait' };
    }
  }

  async login(opts: WeChatSdkLoginOptions = {}): Promise<WeChatSdkLoginResult> {
    const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1_000);
    const deadline = this.now() + timeoutMs;
    const botType = opts.botType ?? '3';
    const refreshLimit = Math.max(0, opts.maxRefreshes ?? DEFAULT_QR_REFRESH_LIMIT);
    let refreshCount = 0;
    let apiBaseUrl = this.loginBaseUrl;
    let verifyCode = opts.verifyCode?.trim() || undefined;
    let verifyTried = false;
    let qr = await this.fetchQr(botType);
    await opts.onQRCode?.(qr.qrcode_img_content!);

    while (this.now() < deadline) {
      if (opts.signal?.aborted) throw abortError();
      const status = await this.pollQr(apiBaseUrl, qr.qrcode!, opts, verifyCode);
      opts.onStatus?.(status.status);

      switch (status.status) {
        case 'wait':
        case 'scaned':
          break;
        case 'scaned_but_redirect':
          if (status.redirect_host) apiBaseUrl = `https://${status.redirect_host}`;
          break;
        case 'expired': {
          refreshCount += 1;
          if (refreshCount > refreshLimit) {
            throw new Error('微信二维码多次失效，请重新绑定');
          }
          qr = await this.fetchQr(botType);
          await opts.onQRCode?.(qr.qrcode_img_content!);
          break;
        }
        case 'need_verifycode': {
          if (verifyCode && !verifyTried) {
            verifyTried = true;
            break;
          }
          const entered = await this.waitForVerifyCode(
            Math.max(1_000, deadline - this.now()),
            opts.signal,
          );
          if (!entered) {
            throw new Error('微信要求输入验证码，等待输入超时；请重新扫码');
          }
          verifyCode = entered;
          verifyTried = true;
          break;
        }
        case 'verify_code_blocked':
          throw new Error('微信验证码多次错误，请稍后重试');
        case 'binded_redirect':
          throw new Error('该微信已绑定过其他实例；请先在原实例解绑，或换一个微信号');
        case 'confirmed': {
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
            throw new Error('微信登录已确认，但服务器未返回完整凭证');
          }
          return {
            connected: true,
            botToken: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl || apiBaseUrl,
            userId: status.ilink_user_id,
            message: '已连接微信',
          };
        }
        default:
          break;
      }

      await sleep(this.qrPollIntervalMs, opts.signal);
    }

    throw new Error('扫码登录超时，请重试');
  }

  private async getUpdates(
    syncBuf: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    try {
      const raw = await this.request({
        method: 'POST',
        baseUrl: this.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        body: JSON.stringify({
          get_updates_buf: syncBuf,
          base_info: this.baseInfo(),
        }),
        token: this.token,
        timeoutMs,
        signal,
        label: 'getUpdates',
      });
      return parseWeixinApiJson<GetUpdatesResponse>(raw);
    } catch (error) {
      if (isAbortError(error)) return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      throw error;
    }
  }

  async start(opts: WeChatSdkStartOptions = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.abort = controller;
    const external = opts.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    let syncBuf = (await opts.loadSyncBuf?.()) ?? '';
    try {
      while (this.running && !controller.signal.aborted) {
        const response = await this.getUpdates(
          syncBuf,
          opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          controller.signal,
        );
        if (!this.running || controller.signal.aborted) return;

        if (response.ret === -14 || response.errcode === -14) {
          this.running = false;
          this.emit('sessionExpired');
          return;
        }
        if (
          (response.ret !== undefined && response.ret !== 0) ||
          (response.errcode !== undefined && response.errcode !== 0)
        ) {
          throw new Error(
            `getUpdates ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} ${response.errmsg ?? ''}`.trim(),
          );
        }

        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== '') {
          syncBuf = response.get_updates_buf;
          await opts.saveSyncBuf?.(syncBuf);
        }
        for (const message of response.msgs ?? []) {
          if (message.from_user_id && message.context_token) {
            this.contextTokens.set(message.from_user_id, message.context_token);
          }
          this.emit('message', message);
        }
      }
    } catch (error) {
      if (!this.running || controller.signal.aborted) return;
      throw error;
    } finally {
      if (this.abort === controller) this.abort = null;
      this.running = false;
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  async sendText(to: string, text: string, contextToken?: string): Promise<string> {
    if (!this.token) throw new Error('微信登录凭证缺失，请重新扫码');
    const clientId = `ai-company-${randomUUID()}`;
    const raw = await this.request({
      method: 'POST',
      baseUrl: this.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: this.baseInfo(),
      }),
      token: this.token,
      timeoutMs: SEND_TIMEOUT_MS,
      label: 'sendMessage',
    });
    const response = parseWeixinApiJson<SendMessageResponse>(raw);
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`sendMessage ret=${response.ret} ${response.errmsg ?? ''}`.trim());
    }
    return response.message_id ?? clientId;
  }
}

export function createOfficialWechatClient(opts: WeChatSdkClientOptions): WeChatSdkClient {
  return new OfficialWechatClient(opts);
}
