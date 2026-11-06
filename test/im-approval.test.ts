import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertApproval, insertOutboundRef, insertReport } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import {
  findPendingApprovalForInbound,
  handleImApprovalReply,
  parseApprovalChoice,
} from '../src/main/im/approval.js';
import type { ImInbound } from '../src/main/im/types.js';

const AT = 1_700_000_000_000;
const OPTIONS = [
  { key: 'approve', label: '批准（推荐）', recommended: true },
  { key: 'revise', label: '打回，改计划' },
];

function setup(): { db: SqliteDb; deps: IpcDeps; projectId: number; taskId: number; events: unknown[] } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const project = db
    .prepare('INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?,?,?,?) RETURNING id')
    .get('记账系统', '记账', 'D:/proj', AT) as { id: number };
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId: project.id,
    title: '竞品简报',
    goal: '整理竞品动态',
    now: AT,
  });
  db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
  const events: unknown[] = [];
  return {
    db,
    deps: {
      repo: createSqliteChatRepo(db),
      db,
      engine: { dispatch: async (event) => { events.push(event); } },
    },
    projectId: project.id,
    taskId: task.id,
    events,
  };
}

function seedApproval(db: SqliteDb, taskId: number): { reportId: number; approvalId: number } {
  const report = insertReport(db, {
    taskId,
    kind: 'ask',
    payload: { card: 'approval', title: '等你批准：T-1001 的计划', question: '批准计划？', options: OPTIONS },
    now: AT,
  });
  const approval = insertApproval(db, {
    taskId,
    reportId: report.id,
    question: '批准计划？',
    options: OPTIONS,
  });
  insertOutboundRef(db, {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    platformMsgId: 'wx-card-1',
    taskId,
    reportId: report.id,
    now: AT,
  });
  return { reportId: report.id, approvalId: approval.id };
}

function inbound(overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    senderId: 'boss-1',
    senderName: '微信 boss-1',
    text: '1',
    platformMsgId: 'wx-reply-1',
    replyToMsgId: 'wx-card-1',
    receivedAt: AT,
    ...overrides,
  };
}

test('IM 审批：选项解析只认显式答案，自然语言不猜', () => {
  assert.equal(parseApprovalChoice('1', OPTIONS), 'approve');
  assert.equal(parseApprovalChoice('2', OPTIONS), 'revise');
  assert.equal(parseApprovalChoice('批准', OPTIONS), 'approve');
  assert.equal(parseApprovalChoice('打回', OPTIONS), 'revise');
  assert.equal(parseApprovalChoice('我觉得可以', OPTIONS), null);
  assert.equal(parseApprovalChoice('3', OPTIONS), null);
});

test('IM 审批：引用卡片回 1 → 写 approvals + 推 plan_approved', async () => {
  const { db, deps, taskId, events } = setup();
  const { reportId, approvalId } = seedApproval(db, taskId);

  const result = await handleImApprovalReply(deps, inbound({ text: '1' }), AT);

  assert.equal(result.handled, true);
  assert.equal(result.approvalId, approvalId);
  assert.match(result.reply ?? '', /已批准/);
  const approval = db.prepare('SELECT chosen, decided_by FROM approvals WHERE id=?').get(approvalId) as {
    chosen: string | null;
    decided_by: string | null;
  };
  assert.equal(approval.chosen, 'approve');
  assert.equal(approval.decided_by, 'boss');
  const report = db.prepare('SELECT state FROM reports WHERE id=?').get(reportId) as { state: string };
  assert.equal(report.state, 'resolved', '一处处理、两处消除');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { event: string }).event, 'plan_approved');
});

test('IM 审批：不引用卡片、直接回 2 → 取该私聊最近未决卡并推 revise', async () => {
  const { db, deps, taskId, events } = setup();
  const { approvalId } = seedApproval(db, taskId);

  const result = await handleImApprovalReply(deps, inbound({ text: '2', replyToMsgId: null }), AT);

  assert.equal(result.handled, true);
  const approval = db.prepare('SELECT chosen FROM approvals WHERE id=?').get(approvalId) as { chosen: string };
  assert.equal(approval.chosen, 'revise');
  assert.equal((events[0] as { event: string }).event, 'revise');
});

test('IM 审批：自然语言不写审批（交回普通消息链）', async () => {
  const { db, deps, taskId } = setup();
  const { approvalId } = seedApproval(db, taskId);

  const result = await handleImApprovalReply(deps, inbound({ text: '我觉得可以，但再改改' }), AT);

  assert.equal(result.handled, false);
  const approval = db.prepare('SELECT chosen FROM approvals WHERE id=?').get(approvalId) as { chosen: string | null };
  assert.equal(approval.chosen, null);
});

test('IM 审批：最近一张是完成汇报 → 回 1 不误答更早的审批', async () => {
  const { db, deps, taskId } = setup();
  const { approvalId } = seedApproval(db, taskId);
  const report = insertReport(db, {
    taskId,
    kind: 'report',
    payload: { card: 'report', title: '完成：T-1001', summary: '已产出' },
    now: AT + 1,
  });
  insertOutboundRef(db, {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    platformMsgId: 'wx-report-2',
    taskId,
    reportId: report.id,
    now: AT + 1,
  });

  const result = await handleImApprovalReply(deps, inbound({ text: '1', replyToMsgId: null }), AT + 1);

  assert.equal(result.handled, false);
  const approval = db.prepare('SELECT chosen FROM approvals WHERE id=?').get(approvalId) as { chosen: string | null };
  assert.equal(approval.chosen, null, '最近的卡是汇报卡，不能误答更早的审批');
});

test('IM 审批：引用非卡片消息 → 仍按最近未决卡兜底（1:1 单卡语义）', async () => {
  const { db, deps, taskId } = setup();
  const { approvalId } = seedApproval(db, taskId);
  insertOutboundRef(db, {
    channel: 'im:wechat',
    conversationRef: 'boss-1',
    platformMsgId: 'wx-plain-1',
    taskId,
    reportId: null,
    now: AT + 1,
  });

  const pending = findPendingApprovalForInbound(db, inbound({ replyToMsgId: 'wx-plain-1' }));
  // 引用链命中不了 report；但同一私聊的“最近一张”兜底会命中——这是预期（1:1 单卡语义）。
  assert.equal(pending?.approvalId, approvalId);
  const result = await handleImApprovalReply(deps, inbound({ text: '1', replyToMsgId: 'wx-nope' }), AT);
  assert.equal(result.handled, true);
});
