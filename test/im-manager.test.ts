import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { ImManager } from '../src/main/im/manager.js';
import type {
  ImAdapter,
  ImAdapterCallbacks,
  ImConnectionState,
  ImInbound,
  ImSendResult,
  ImSendTarget,
} from '../src/main/im/types.js';

const AT = 1_700_000_000_000;

class FakeAdapter implements ImAdapter {
  readonly channel = 'im:wechat' as const;
  sends: Array<{ target: ImSendTarget; text: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async login(): Promise<void> {}
  async logout(): Promise<void> {}
  async sendText(target: ImSendTarget, text: string): Promise<ImSendResult> {
    this.sends.push({ target, text });
    return { platformMsgId: `wx-${this.sends.length}` };
  }
  getOwnerId(): string | null {
    return 'boss-1';
  }
  getAccountId(): string | null {
    return 'bot-1';
  }
}

function setup(): {
  db: SqliteDb;
  manager: ImManager;
  adapter: FakeAdapter;
  callbacks: () => ImAdapterCallbacks;
  received: ImInbound[];
} {
  const db = openMemoryDatabase();
  runMigrations(db);
  const adapter = new FakeAdapter();
  const received: ImInbound[] = [];
  let cb: ImAdapterCallbacks | null = null;
  const manager = new ImManager({
    db,
    createAdapter: (callbacks) => {
      cb = callbacks;
      return adapter;
    },
    onInbound: async (msg) => {
      received.push(msg);
      return { reply: '好的' };
    },
    outboxIntervalMs: 60_000,
  });
  return {
    db,
    manager,
    adapter,
    received,
    callbacks: () => {
      if (!cb) throw new Error('adapter callbacks 未装配');
      return cb;
    },
  };
}

function msg(overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    senderId: 'boss-1',
    senderName: '微信 boss-1',
    text: '#记账 做竞品简报',
    platformMsgId: 'wx-in-1',
    replyToMsgId: null,
    receivedAt: AT,
    ...overrides,
  };
}

test('IM manager：非 owner 消息直接丢弃，不回复、不落 transcript', async () => {
  const { manager, adapter, received, callbacks } = setup();
  await manager.start();
  callbacks().onState('connected');

  callbacks().onInbound(msg({ senderId: 'stranger', platformMsgId: 'wx-stranger' }));
  await manager.drain();

  assert.equal(received.length, 0);
  assert.equal(adapter.sends.length, 0);
  await manager.stop();
});

test('IM manager：owner 消息串行处理并回发幕僚长回复；同消息 id 去重', async () => {
  const { manager, adapter, received, callbacks } = setup();
  await manager.start();
  callbacks().onState('connected');

  callbacks().onInbound(msg());
  callbacks().onInbound(msg()); // 同 platformMsgId：应被去重
  await manager.drain();

  assert.equal(received.length, 1);
  assert.equal(adapter.sends.length, 1);
  assert.equal(adapter.sends[0]!.text, '好的');
  assert.equal(adapter.sends[0]!.target.conversationRef, 'boss-1');
  await manager.stop();
});

test('IM manager：已连接只建 1 个私聊会话（kind=private，不建群对象）', async () => {
  const { db, manager, callbacks } = setup();
  await manager.start();
  callbacks().onState('connected');
  callbacks().onInbound(msg());
  await manager.drain();

  const rows = db.prepare('SELECT channel, conversation_ref, kind FROM im_conversations').all() as Array<{
    channel: string;
    conversation_ref: string;
    kind: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.conversation_ref, 'boss-1');
  assert.equal(rows[0]!.kind, 'private');
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM im_conversations WHERE kind='group'").get() as { c: number }).c,
    0,
    '不建群对象',
  );
  await manager.stop();
});

test('IM manager：扫码状态/二维码经 status 可见；解绑回到 disabled', async () => {
  const { manager, callbacks } = setup();
  await manager.start();
  callbacks().onState('login_required');
  assert.equal(manager.status().state, 'login_required');

  callbacks().onQr('data:image/png;base64,xxx', 'wait');
  assert.equal(manager.status().state, 'login_pending');
  assert.equal(manager.status().qr, 'data:image/png;base64,xxx');

  await manager.unbind();
  assert.equal(manager.status().state, 'disabled');
  await manager.stop();
});
