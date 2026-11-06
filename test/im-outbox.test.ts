import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { enqueueImOutbox, insertReport } from '../src/main/db/index.js';
import { ImOutbox } from '../src/main/im/outbox.js';
import { ImWindowClosedError, type ImAdapter, type ImSendResult, type ImSendTarget } from '../src/main/im/types.js';

const AT = 1_700_000_000_000;

class FakeAdapter implements ImAdapter {
  readonly channel = 'im:wechat' as const;
  sends: string[] = [];
  fail: Error | null = null;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async login(): Promise<void> {}
  async logout(): Promise<void> {}
  async sendText(_target: ImSendTarget, text: string): Promise<ImSendResult> {
    if (this.fail) throw this.fail;
    this.sends.push(text);
    return { platformMsgId: `wx-${this.sends.length}` };
  }
  getOwnerId(): string | null {
    return 'boss-1';
  }
  getAccountId(): string | null {
    return 'bot-1';
  }
}

function setup(): { db: SqliteDb; adapter: FakeAdapter; outbox: ImOutbox; now: { value: number } } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const adapter = new FakeAdapter();
  const now = { value: AT };
  const outbox = new ImOutbox({
    db,
    channel: 'im:wechat',
    conversationRef: () => 'boss-1',
    adapter: () => adapter,
    now: () => now.value,
    maxAttempts: 3,
  });
  return { db, adapter, outbox, now };
}

function card(db: SqliteDb, title: string): number {
  return insertReport(db, {
    taskId: null,
    kind: 'report',
    payload: { card: 'report', title, summary: `${title} 的摘要` },
    now: AT,
  }).id;
}

function outboxRow(db: SqliteDb, reportId: number): { state: string; attempts: number; platform_msg_id: string | null } {
  return db
    .prepare('SELECT state, attempts, platform_msg_id FROM im_outbox WHERE report_id=?')
    .get(reportId) as { state: string; attempts: number; platform_msg_id: string | null };
}

test('IM outbox：新卡入队 → 发送成功 → 写 outbound_refs', async () => {
  const { db, adapter, outbox } = setup();
  const reportId = card(db, '完成：T-1001');

  outbox.enqueueReport(reportId);
  await outbox.tick();

  assert.equal(adapter.sends.length, 1);
  assert.match(adapter.sends[0]!, /【完成】T-1001/);
  assert.equal(outboxRow(db, reportId).state, 'sent');
  assert.equal(outboxRow(db, reportId).platform_msg_id, 'wx-1');
  const ref = db
    .prepare('SELECT report_id, platform_msg_id FROM outbound_refs WHERE channel=? AND platform_msg_id=?')
    .get('im:wechat', 'wx-1') as { report_id: number; platform_msg_id: string } | undefined;
  assert.equal(ref?.report_id, reportId);
});

test('IM outbox：窗口关闭 → blocked；下次入站/唤醒后补发', async () => {
  const { db, adapter, outbox } = setup();
  const reportId = card(db, '等你拍板：T-1002');
  adapter.fail = new ImWindowClosedError();
  outbox.enqueueReport(reportId);

  await outbox.tick();
  assert.equal(adapter.sends.length, 0);
  assert.equal(outboxRow(db, reportId).state, 'blocked');

  adapter.fail = null;
  await outbox.wake();
  assert.equal(adapter.sends.length, 1);
  assert.equal(outboxRow(db, reportId).state, 'sent');
});

test('IM outbox：换绑 owner 后旧会话卡片不得发到新会话（隐私边界）', async () => {
  const { db, adapter, outbox } = setup(); // 当前会话 boss-1
  const reportId = card(db, '旧会话的卡');
  enqueueImOutbox(db, {
    channel: 'im:wechat',
    conversationRef: 'old-owner',
    reportId,
    now: AT,
  });

  await outbox.tick();

  assert.equal(adapter.sends.length, 0, '旧会话卡不得发到新 owner');
  const row = db
    .prepare('SELECT state, conversation_ref FROM im_outbox WHERE report_id=?')
    .get(reportId) as { state: string; conversation_ref: string };
  assert.equal(row.state, 'pending', '旧会话行保持原状，等旧会话恢复');
  assert.equal(row.conversation_ref, 'old-owner');
  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM outbound_refs').get() as { c: number }).c,
    0,
    '不得把旧卡写进新会话的 outbound_refs',
  );
});

test('IM outbox：blocked 不被定时 tick 反复重试；只有 wake 才补发', async () => {
  const { db, adapter, outbox } = setup();
  const reportId = card(db, '等你拍板：T-1006');
  adapter.fail = new ImWindowClosedError();
  outbox.enqueueReport(reportId);
  await outbox.tick();
  assert.equal(outboxRow(db, reportId).state, 'blocked');

  adapter.fail = null;
  await outbox.tick();
  assert.equal(adapter.sends.length, 0, '定时轮询不应撞 blocked');

  await outbox.wake();
  assert.equal(adapter.sends.length, 1, '入站/登录唤醒后补发');
  assert.equal(outboxRow(db, reportId).state, 'sent');
});

test('IM outbox：卡片已被桌面处理 → 取消，不补发', async () => {
  const { db, adapter, outbox } = setup();
  const reportId = card(db, '完成：T-1003');
  outbox.enqueueReport(reportId);
  db.prepare("UPDATE reports SET state='resolved' WHERE id=?").run(reportId);

  await outbox.tick();
  assert.equal(adapter.sends.length, 0);
  assert.equal(outboxRow(db, reportId).state, 'cancelled');
});

test('IM outbox：瞬时错误 → 退避重试；成功后不再重发', async () => {
  const { db, adapter, outbox, now } = setup();
  const reportId = card(db, '完成：T-1004');
  adapter.fail = new Error('network');
  outbox.enqueueReport(reportId);

  await outbox.tick();
  assert.equal(outboxRow(db, reportId).state, 'pending');
  assert.equal(outboxRow(db, reportId).attempts, 1);
  assert.equal(adapter.sends.length, 0);

  adapter.fail = null;
  now.value = AT + 6_000;
  await outbox.tick();
  assert.equal(adapter.sends.length, 1);
  assert.equal(outboxRow(db, reportId).state, 'sent');

  await outbox.tick();
  assert.equal(adapter.sends.length, 1, 'sent 不再重发');
});

test('IM outbox：连续失败到上限 → failed（停止自动重试）', async () => {
  const { db, adapter, outbox, now } = setup();
  const reportId = card(db, '完成：T-1005');
  adapter.fail = new Error('network');
  outbox.enqueueReport(reportId);

  for (let i = 0; i < 3; i += 1) {
    await outbox.tick();
    now.value += 60_000;
  }
  assert.equal(outboxRow(db, reportId).state, 'failed');
  assert.equal(outboxRow(db, reportId).attempts, 3);
});


test('IM outbox：backfill 按报告创建顺序旧→新入队（手机卡序不反）', async () => {
  const { db, adapter, outbox } = setup();
  const first = insertReport(db, {
    taskId: null,
    kind: 'report',
    payload: { card: 'report', title: '第一张', summary: '1' },
    now: AT,
  }).id;
  const second = insertReport(db, {
    taskId: null,
    kind: 'report',
    payload: { card: 'report', title: '第二张', summary: '2' },
    now: AT + 1,
  }).id;

  outbox.backfill(AT - 1);
  const queued = db
    .prepare('SELECT report_id FROM im_outbox ORDER BY id')
    .all()
    .map((row) => (row as { report_id: number }).report_id);
  assert.deepEqual(queued, [first, second], 'backfill 必须旧卡先入队，否则手机显示 2→1');

  await outbox.tick();
  assert.match(adapter.sends[0] ?? '', /第一张/);
  assert.match(adapter.sends[1] ?? '', /第二张/);
});
