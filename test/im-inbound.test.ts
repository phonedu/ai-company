import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertApproval, insertOutboundRef, insertReport } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import { handleImInbound } from '../src/main/im/bridge.js';
import type { ImInbound } from '../src/main/im/types.js';

const AT = 1_700_000_000_000;

function setup(): {
  db: SqliteDb;
  deps: IpcDeps;
  assistantCalls: Array<{ text: string; taskId?: number | null }>;
  inboxChanges: number[];
} {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?,?,?,?)').run(
    '记账系统',
    '记账',
    'D:/proj',
    AT,
  );
  const repo = createSqliteChatRepo(db);
  const assistantCalls: Array<{ text: string; taskId?: number | null }> = [];
  const inboxChanges: number[] = [];
  const deps: IpcDeps = {
    repo,
    db,
    onInboxChanged: () => {
      inboxChanges.push(Date.now());
    },
    classify: async () => ({ intent: 'new_task', confidence: 0.95, titleGuess: '竞品简报' }),
    triageMode: 'classifier', // B2-2：本测试锁定旧分诊器链路（可回退面）
    assistant: {
      runTurn: async (input) => {
        assistantCalls.push(input);
        return { replyMessageId: 1, reply: '好的，已安排。' };
      },
    },
  };
  return { db, deps, assistantCalls, inboxChanges };
}

function inbound(text: string, overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    senderId: 'boss-1',
    senderName: '微信 boss-1',
    text,
    platformMsgId: 'wx-in-1',
    replyToMsgId: null,
    receivedAt: AT,
    ...overrides,
  };
}

test('IM 入站：#项目别名 → 建任务到对应项目；即时受理，不再跑频道幕僚长', async () => {
  const { db, deps, assistantCalls, inboxChanges } = setup();
  const acks: string[] = [];

  const result = await handleImInbound(deps, inbound('#记账 把竞品动态整理成一页简报'), AT, async (text) => {
    acks.push(text);
  });

  assert.deepEqual(acks, [], '建任务不再先发“收到，已交给幕僚长”');
  assert.match(String(result.reply), /已受理 T-\d+/);
  assert.equal(assistantCalls.length, 0, '建任务消息不得再让频道幕僚长重复执行（真机 2026-10-20 回归）');
  assert.ok(inboxChanges.length >= 2, '入站消息与受理回执都必须触发频道刷新事件');

  const task = db.prepare('SELECT id, project_id, title FROM tasks ORDER BY id DESC LIMIT 1').get() as {
    id: number;
    project_id: number;
    title: string;
  };
  const project = db.prepare("SELECT id FROM projects WHERE alias='记账'").get() as { id: number };
  assert.equal(task.project_id, project.id, '任务必须落在 #记账 项目下');
  assert.equal(task.title, '把竞品动态整理成一页简报', '标题不带上 #项目别名');

  const message = db
    .prepare("SELECT task_id, content FROM human_messages WHERE direction='in' ORDER BY id DESC LIMIT 1")
    .get() as { task_id: number | null; content: string };
  assert.equal(message.task_id, task.id);
  assert.equal(message.content, '#记账 把竞品动态整理成一页简报');
  const receipt = db
    .prepare("SELECT task_id, content FROM human_messages WHERE direction='out' ORDER BY id DESC LIMIT 1")
    .get() as { task_id: number | null; content: string };
  assert.equal(receipt.task_id, task.id);
  assert.match(receipt.content, /已受理 T-\d+/);
  const listed = deps.repo.listMessages({ limit: 10, latest: true });
  assert.ok(
    listed.some((m) => m.direction === 'in' && m.content === '#记账 把竞品动态整理成一页简报'),
    '频道列表必须能读到 IM 入站原话（真机反馈：老板频道看不到）',
  );
});

test('IM 普通聊天：仍走频道幕僚长（只对建任务跳过）', async () => {
  const { deps, assistantCalls } = setup();
  deps.classify = async () => ({ intent: 'chat', confidence: 0.8 });
  const result = await handleImInbound(deps, inbound('你好'), AT);
  assert.equal(assistantCalls.length, 1, '普通聊天必须交给幕僚长');
  assert.equal(result.reply, '好的，已安排。');
});

test('IM 未知 #别名 → 明确报错，不落到默认项目建任务', async () => {
  const { db, deps } = setup();
  const result = await handleImInbound(deps, inbound('#不存在 做一页简报'), AT);
  assert.match(String(result.reply), /没有找到项目别名/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
});

test('IM 命令：列表直接执行，不再先发“已交给幕僚长”', async () => {
  const { db, deps } = setup();
  insertReport(db, { taskId: null, kind: 'ask', payload: { title: '待批' }, state: 'pending', now: AT });
  const acks: string[] = [];
  const result = await handleImInbound(deps, inbound('列表'), AT, async (text) => {
    acks.push(text);
  });
  assert.deepEqual(acks, [], '命令有即时回执，不应再发“收到”');
  assert.match(String(result.reply), /待你处理/);
});

test('IM 入站：审批卡回 1 → 先作答，不再跑幕僚长；返回批准确认', async () => {
  const { db, deps, assistantCalls, inboxChanges } = setup();
  const project = db.prepare("SELECT id FROM projects WHERE alias='记账'").get() as { id: number };
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId: project.id,
    title: '竞品简报',
    goal: '整理竞品',
    now: AT,
  });
  db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
  const report = insertReport(db, {
    taskId: task.id,
    kind: 'ask',
    payload: {
      card: 'approval',
      title: '等你批准：T-1001 的计划',
      question: '批准计划？',
      options: [
        { key: 'approve', label: '批准（推荐）', recommended: true },
        { key: 'revise', label: '打回，改计划' },
      ],
    },
    now: AT,
  });
  const approval = insertApproval(db, {
    taskId: task.id,
    reportId: report.id,
    question: '批准计划？',
    options: [
      { key: 'approve', label: '批准（推荐）' },
      { key: 'revise', label: '打回，改计划' },
    ],
  });
  insertOutboundRef(db, {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    platformMsgId: 'wx-card-1',
    taskId: task.id,
    reportId: report.id,
    now: AT,
  });

  const acks: string[] = [];
  const result = await handleImInbound(
    deps,
    inbound('1', { platformMsgId: 'wx-reply-1', replyToMsgId: 'wx-card-1' }),
    AT,
    async (text) => {
      acks.push(text);
    },
  );

  assert.equal(acks.length, 0, '审批回复不先发“收到”再发确认');
  assert.match(result.reply ?? '', /已批准/);
  assert.equal(assistantCalls.length, 0, '拍板回复不跑幕僚长');
  const chosen = db.prepare('SELECT chosen FROM approvals WHERE id=?').get(approval.id) as { chosen: string };
  assert.equal(chosen.chosen, 'approve');
  // 手机回的 1 必须进老板频道同一任务线程，并触发频道刷新（真机：审批回复偶发不上屏）。
  const inboundRows = db
    .prepare("SELECT direction, task_id, content FROM human_messages WHERE content='1' ORDER BY id")
    .all() as Array<{ direction: string; task_id: number | null; content: string }>;
  assert.equal(inboundRows.length, 1, '手机审批回复必须落 human_messages 一条');
  assert.equal(inboundRows[0]!.direction, 'in');
  assert.equal(inboundRows[0]!.task_id, task.id);
  assert.ok(inboxChanges.length >= 1, '手机审批回复必须触发 evt:inbox 刷新');
  const outRow = db
    .prepare("SELECT content FROM human_messages WHERE direction='out' ORDER BY id DESC LIMIT 1")
    .get() as { content: string } | undefined;
  assert.match(outRow?.content ?? '', /已批准/);
});

test('IM 入站：幕僚长不可用 → 明确告知，不静默', async () => {
  const { deps } = setup();
  deps.assistant = null;

  const result = await handleImInbound(deps, inbound('你好'), AT);

  assert.match(result.reply ?? '', /幕僚长暂不可用/);
});
