/**
 * T0.5 依赖素材测试：human_messages / reports / approvals DAO + ResolverStore(SQLite)。
 * 在 T0.3 收口时提供（chat:send / 卡片渲染依赖这些）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerApproval,
  acknowledgeReport,
  createResolverStore,
  createTask,
  getApproval,
  getDefaultProject,
  getProjectByAlias,
  getReport,
  insertApproval,
  insertHumanMessage,
  insertReport,
  listHumanMessages,
  listReports,
  markReportDelivered,
  openMemoryDatabase,
  runMigrations,
  SqliteCounterStore,
  type SqliteDb,
} from '../src/main/db/index.js';
import { resolveInbound } from '../src/core/resolver.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function project(db: SqliteDb, name: string, alias: string | null = null): number {
  return Number(
    db
      .prepare('INSERT INTO projects(name, alias, root_dir, created_at) VALUES(?, ?, ?, 1)')
      .run(name, alias, `D:/tmp/${name}`).lastInsertRowid,
  );
}

function task(db: SqliteDb, projectId: number, over: { state?: string } = {}): { id: number; shortId: string } {
  const row = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 't',
    goal: 'g',
    state: over.state ?? 'inbox',
  });
  return { id: row.id, shortId: row.short_id as string };
}

// ───────────────────────── human_messages ─────────────────────────

test('dao: human_messages 插入/按任务过滤/limit', () => {
  const db = fresh();
  try {
    const pid = project(db, 'p');
    const t = task(db, pid);
    const m1 = insertHumanMessage(db, { direction: 'in', content: '你好', now: 10 });
    const m2 = insertHumanMessage(db, { direction: 'out', taskId: t.id, content: '收到', attachments: [], now: 20 });
    assert.equal(m1.direction, 'in');
    assert.equal(m1.task_id, null);
    assert.equal(m2.task_id, t.id);
    assert.equal(listHumanMessages(db).length, 2);
    assert.equal(listHumanMessages(db, { taskId: t.id }).length, 1);
    assert.equal(listHumanMessages(db, { limit: 1 })[0]?.content, '你好');
  } finally {
    db.close();
  }
});

// ───────────────────────── reports ─────────────────────────

test('dao: reports 插入/过滤/已阅幂等/投递标记', () => {
  const db = fresh();
  try {
    const pid = project(db, 'p');
    const t = task(db, pid);
    const r1 = insertReport(db, { taskId: t.id, kind: 'report', payload: { tldr: 'x' }, now: 1 });
    insertReport(db, { taskId: t.id, kind: 'alert', state: 'pending', now: 2 });
    assert.equal(listReports(db, { taskId: t.id }).length, 2);
    assert.equal(listReports(db, { kind: 'alert' }).length, 1);
    assert.equal(listReports(db, { state: 'pending' }).length, 2);

    const ack1 = acknowledgeReport(db, r1.id, 100);
    assert.equal(ack1.acknowledged_at, 100);
    assert.equal(ack1.state, 'acknowledged', '已阅同时把 state 推到 acknowledged');
    const ack2 = acknowledgeReport(db, r1.id, 200);
    assert.equal(ack2.acknowledged_at, 100, '已阅不得被覆盖');

    const delivered = markReportDelivered(db, r1.id, 300);
    assert.equal(delivered.delivered_at, 300);
    assert.equal(getReport(db, r1.id)?.state, 'delivered');
  } finally {
    db.close();
  }
});

// ───────────────────────── approvals ─────────────────────────

test('dao: approvals 回答幂等（已 decided 不覆盖、不重复副作用）+ 联动 reports.state', () => {
  const db = fresh();
  try {
    const pid = project(db, 'p');
    const t = task(db, pid);
    const rep = insertReport(db, { taskId: t.id, kind: 'ask', payload: { question: '批准计划？' }, now: 1 });
    const a = insertApproval(db, {
      taskId: t.id,
      reportId: rep.id,
      question: '批准计划？',
      options: [{ key: 'approve', recommended: true }, { key: 'revise' }],
      defaultAction: null,
      timeoutAt: null,
    });
    assert.equal(a.decided_at, null);

    const first = answerApproval(db, { approvalId: a.id, chosen: 'approve', decidedBy: 'boss', now: 50 });
    assert.equal(first.chosen, 'approve');
    assert.equal(first.decided_by, 'boss');
    assert.equal(first.decided_at, 50);
    assert.equal(getReport(db, rep.id)?.state, 'resolved', '回答审批联动把决策卡置 resolved');

    // 第二次（重复 IPC / 超时竞态）不得覆盖
    const second = answerApproval(db, { approvalId: a.id, chosen: 'revise', decidedBy: 'timeout', now: 99 });
    assert.equal(second.chosen, 'approve', '已决定不得被覆盖');
    assert.equal(second.decided_by, 'boss');
    assert.equal(second.decided_at, 50);
    assert.equal(getApproval(db, a.id)?.chosen, 'approve');
    assert.equal(getReport(db, rep.id)?.state, 'resolved', '幂等：第二次不改变报告状态');
  } finally {
    db.close();
  }
});

// ───────────────────────── ResolverStore + resolveInbound ─────────────────────────

test('resolver store: 别名/短号/焦点/回复链/pending list 接线可用', async () => {
  const db = fresh();
  try {
    const pid = project(db, '记账项目', '记账');
    const t = task(db, pid);
    const store = createResolverStore(db);

    // 别名 / 默认项目
    assert.equal(getProjectByAlias(db, '记账')?.id, pid);
    assert.equal(store.getProjectByAlias('记账')?.name, '记账项目');
    assert.equal(store.getDefaultProject(), null, '未设置默认项目 → null');

    // 短号
    assert.equal(store.getTaskByShortId(t.shortId)?.id, t.id);
    // 最近活跃只含非终态
    assert.equal(store.getRecentActiveTasks(10).length, 1);
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(t.id);
    assert.equal(store.getRecentActiveTasks(10).length, 0);

    // 显式地址：resolveInbound 命中 task_message 且写焦点（不调用 classify）
    db.prepare("UPDATE tasks SET state = 'inbox' WHERE id = ?").run(t.id);
    let classifyCalled = false;
    const resolution = await resolveInbound(
      {
        source: 'desktop',
        conversationRef: 'desktop:boss',
        platformMsgId: null,
        replyToMsgId: null,
        text: `#${t.shortId} 补充说明`,
        receivedAt: 1_000,
      },
      store,
      async () => {
        classifyCalled = true;
        return { intent: 'chat', confidence: 0.1 };
      },
    );
    assert.equal(resolution.kind, 'task_message');
    assert.equal(classifyCalled, false, '显式地址不得调用 LLM');
    const convo = store.getConversation('desktop', 'desktop:boss');
    assert.equal(convo?.focusTaskId, t.id);

    // 回复链：outbound_refs 精确归位
    db.prepare(
      'INSERT INTO outbound_refs(channel, conversation_ref, platform_msg_id, task_id, sent_at) VALUES(?, ?, ?, ?, ?)',
    ).run('desktop', 'desktop:boss', 'msg-9', t.id, 1);
    assert.deepEqual(store.findOutboundRef('desktop', 'msg-9'), { taskId: t.id, reportId: null });

    // pending list：读取 + 过期视为无 + 清除
    db.prepare(
      'INSERT INTO pending_lists(channel, conversation_ref, message_ref, items, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run('desktop', 'desktop:boss', 'm1', JSON.stringify([{ index: 1, taskId: t.id, reportId: null }]), 1, null);
    assert.equal(store.getPendingList('desktop', 'desktop:boss')?.items.length, 1);
    store.clearPendingList('desktop', 'desktop:boss');
    assert.equal(store.getPendingList('desktop', 'desktop:boss'), null);

    db.prepare(
      'INSERT INTO pending_lists(channel, conversation_ref, message_ref, items, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run('desktop', 'desktop:boss', 'm2', '[]', 1, 1);
    assert.equal(store.getPendingList('desktop', 'desktop:boss'), null, '过期 pending list 视为无');

    // 默认项目设置后可用
    db.prepare("INSERT INTO settings(key, value) VALUES('projects.default_id', ?)").run(JSON.stringify(pid));
    assert.equal(getDefaultProject(db)?.id, pid);
  } finally {
    db.close();
  }
});
