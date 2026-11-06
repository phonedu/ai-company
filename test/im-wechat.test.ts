import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryCredentialStore } from '../src/main/im/store.js';
import type { WeChatIlinkAdapter } from '../src/main/im/wechat.js';
import { WeChatIlinkAdapter as Adapter } from '../src/main/im/wechat.js';
import type { ImAdapterCallbacks, ImConnectionState, ImInbound } from '../src/main/im/types.js';
import type {
  WeChatSdkClient,
  WeChatSdkClientOptions,
  WeChatSdkLoginOptions,
  WeChatSdkLoginResult,
  WeChatSdkMessage,
} from '../src/main/im/wechat.js';
import { ImWindowClosedError } from '../src/main/im/types.js';

const AT = 1_700_000_000_000;

class FakeSdkClient implements WeChatSdkClient {
  handlers = new Map<string, Array<(...args: never[]) => void>>();
  sent: Array<{ to: string; text: string; contextToken?: string }> = [];
  submittedVerifyCodes: string[] = [];
  contextToken: string | null = 'ctx-1';
  stopResolve: (() => void) | null = null;
  lastOptions: WeChatSdkClientOptions | null = null;
  lastStartOptions: { longPollTimeoutMs?: number } | null = null;

  async login(opts?: WeChatSdkLoginOptions): Promise<WeChatSdkLoginResult> {
    await opts?.onQRCode?.('https://qr.example/abc');
    opts?.onStatus?.('confirmed');
    return {
      connected: true,
      botToken: 'bot-token',
      accountId: 'acc-1',
      baseUrl: 'https://ilink.example',
      userId: 'boss-1',
      message: 'ok',
    };
  }

  start(opts?: { longPollTimeoutMs?: number }): Promise<void> {
    this.lastStartOptions = opts ?? null;
    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  stop(): void {
    this.stopResolve?.();
  }

  async sendText(to: string, text: string, contextToken?: string): Promise<string> {
    this.sent.push({ to, text, ...(contextToken ? { contextToken } : {}) });
    return 'wx-out-1';
  }

  getContextToken(): string | undefined {
    return this.contextToken ?? undefined;
  }

  submitVerifyCode(code: string): void {
    this.submittedVerifyCodes.push(code);
  }

  on(event: string, handler: (...args: never[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(arg as never);
  }
}

function setup(): {
  adapter: WeChatIlinkAdapter;
  client: FakeSdkClient;
  store: ReturnType<typeof createMemoryCredentialStore>;
  loginClient: FakeSdkClient;
  received: ImInbound[];
  states: ImConnectionState[];
  qr: { value: string | null; status: string | null };
} {
  const store = createMemoryCredentialStore();
  const loginClient = new FakeSdkClient();
  const monitorClient = new FakeSdkClient();
  let factoryCalls = 0;
  const client = monitorClient;
  const received: ImInbound[] = [];
  const states: ImConnectionState[] = [];
  const qr = { value: null as string | null, status: null as string | null };
  const callbacks: ImAdapterCallbacks = {
    onInbound: async (msg) => {
      received.push(msg);
    },
    onState: (state) => {
      states.push(state);
    },
    onQr: (value, status) => {
      qr.value = value;
      qr.status = status;
    },
  };
  const adapter = new Adapter({
    store,
    callbacks,
    clientFactory: (opts) => {
      // 第一次＝登录用空凭据 client；登录成功后 adapter 必须用新凭证重建 client 再 start。
      const target = factoryCalls === 0 ? loginClient : monitorClient;
      factoryCalls += 1;
      target.lastOptions = opts;
      return target;
    },
    qrEncoder: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
    now: () => AT,
    log: () => {},
  });
  return { adapter, client, loginClient, store, received, states, qr };
}

function userMessage(overrides: Partial<WeChatSdkMessage> = {}): WeChatSdkMessage {
  return {
    message_type: 1,
    from_user_id: 'boss-1',
    message_id: 101,
    create_time_ms: AT,
    context_token: 'ctx-2',
    item_list: [{ type: 1, text_item: { text: '  #记账 做竞品简报  ' } }],
    ...overrides,
  };
}

test('微信 adapter：无凭证 start → login_required；扫码后保存凭证并 connected', async () => {
  const { adapter, client, loginClient, store, qr } = setup();
  await adapter.start();
  assert.equal(adapter.getOwnerId(), null);

  await adapter.login();

  assert.equal(store.peek().credentials?.userId, 'boss-1');
  assert.equal(store.peek().credentials?.botToken, 'bot-token');
  assert.equal(loginClient.lastOptions?.token, undefined, '登录用 client 不应带旧 token');
  assert.equal(client.lastOptions?.token, 'bot-token', '扫码后必须用新凭证重建 client 再长轮询（回归：空 token 直接 start → -14）');
  assert.equal(client.lastStartOptions?.longPollTimeoutMs, 5_000, 'RM-3：长轮询 5s，避免桌面端延迟半分钟');
  assert.equal(adapter.getOwnerId(), 'boss-1');
  assert.match(qr.value ?? '', /^data:image\/png;base64,/);
  assert.equal(qr.status, 'confirmed');
});

test('微信 adapter：USER 文本入站归一（只取文字；引用消息 id 归位）', async () => {
  const { adapter, client, received } = setup();
  await adapter.login();

  client.emit(
    'message',
    userMessage({
      item_list: [
        { type: 1, text_item: { text: ' #记账 做竞品简报 ' } },
        { type: 1, ref_msg: { message_item: { msg_id: 'quoted-1' } } },
      ],
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 1);
  assert.equal(received[0]!.text, '#记账 做竞品简报');
  assert.equal(received[0]!.conversationRef, 'boss-1');
  assert.equal(received[0]!.platformMsgId, '101');
  assert.equal(received[0]!.replyToMsgId, 'quoted-1');
  assert.equal(received[0]!.replyContext, 'ctx-2');
});

test('微信 adapter：非文字消息不入站；非 USER 消息不入站', async () => {
  const { adapter, client, received } = setup();
  await adapter.login();

  client.emit('message', userMessage({ item_list: [{ type: 2 }] }));
  client.emit('message', userMessage({ message_type: 2 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 0);
});

test('微信 adapter：发送用 context_token；没有窗口 → ImWindowClosedError', async () => {
  const { adapter, client } = setup();
  await adapter.login();

  const result = await adapter.sendText({ conversationRef: 'boss-1' }, '你好');
  assert.equal(result.platformMsgId, 'wx-out-1');
  assert.equal(client.sent[0]!.contextToken, 'ctx-1');

  client.contextToken = null;
  await assert.rejects(
    adapter.sendText({ conversationRef: 'boss-1' }, '再来一条'),
    (error: unknown) => error instanceof ImWindowClosedError,
  );
});

test('微信 adapter：数字验证码透传给官方客户端', async () => {
  const { adapter, client } = setup();
  await adapter.login();
  adapter.submitVerifyCode('123456');
  assert.deepEqual(client.submittedVerifyCodes, ['123456']);
});

test('微信 adapter：sessionExpired → login_required；logout 清凭证', async () => {
  const { adapter, client, store, states } = setup();
  await adapter.login();

  client.emit('sessionExpired');
  assert.equal(states.at(-1), 'login_required');

  await adapter.logout();
  assert.equal(store.peek().credentials, null);
  assert.equal(adapter.getOwnerId(), null);
  assert.equal(states.at(-1), 'disabled');
});

test('CR12：长轮询启动失败 → error 上屏 + 退避重连（不伪装仅日志）', async () => {
  const store = createMemoryCredentialStore();
  store.save({
    credentials: { botToken: 'b', accountId: 'a', baseUrl: 'https://x', userId: 'u' },
    syncBuf: '',
  });
  const states: Array<{ state: ImConnectionState; detail?: string | null }> = [];
  let calls = 0;
  const client = {
    start: async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return new Promise<void>(() => undefined);
    },
    stop: () => undefined,
    sendText: async () => 'x',
    getContextToken: () => undefined,
    on: () => undefined,
  } as unknown as WeChatSdkClient;
  const adapter = new Adapter({
    store,
    callbacks: {
      onInbound: () => undefined,
      onState: (state, detail) => states.push({ state, detail }),
      onQr: () => undefined,
    },
    clientFactory: () => client,
    reconnectBaseMs: 10,
  });
  await adapter.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls >= 2, `应退避重连，实际 start 次数 ${calls}`);
  assert.ok(states.some((s) => s.state === 'error' && /network down/.test(s.detail ?? '')), '错误必须上屏');
  assert.ok(states.some((s) => s.state === 'connecting'), '重连中状态可见');
  await adapter.stop();
});
