/**
 * OPT- · 员工间结构化 mailbox（`` 决定：复用 `notifications` + `task_events`，不新增表）。
 *
 * 验收：**员工问答走 mailbox；人类频道无员工间噪声**（不写 `human_messages`、不落 `im:*`/`desktop`）；
 * **未实现通道返回明确错误码**；**幂等重放不重复投递**。每条断言可被弄红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { registerPendingAction } from '../src/main/db/action_log.js';
import { requestAsk, answerAsk, listMailbox, routeChannel, MAILBOX_ERROR, MailboxError } from '../src/main/engine/index.js';
import { listOpenAsks } from '../src/main/engine/mailbox.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';

function setup(): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(1,'A','dev',1)").run();
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(2,'B','review',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0 });
  return { db, taskId: task.id };
}

const count = (db: SqliteDb, sql: string) => (db.prepare(sql).get() as { n: number }).n;

test('OPT-M10-1: requestAsk 落「消息主体」事件 + 「投递」记录（channel=employee:<to>）', () => {
  const { db, taskId } = setup();
  try {
    const r = requestAsk(db, { taskId, from: 1, to: 2, question: '表结构用 v2 吗？', now: 10 });
    assert.equal(r.channel, 'employee:2');
    assert.equal(r.delivered, true);
    assert.equal(r.dedupeKey, `ask:1:2:task${taskId}:0`);

    const asked = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 1);
    assert.equal((JSON.parse(asked[0]!.payload) as { question: string }).question, '表结构用 v2 吗？');

    const n = count(db, "SELECT COUNT(*) n FROM notifications WHERE channel='employee:2'");
    assert.equal(n, 1);
    assert.equal(listMailbox(db, 2).length, 1);
    assert.equal(listMailbox(db, 1).length, 0, '不是发给自己的');
  } finally {
    db.close();
  }
});

test('OPT-M10-1: 幂等 —— 同 dedupe_key 重放不重复投递、不重复写事件', () => {
  const { db, taskId } = setup();
  try {
    requestAsk(db, { taskId, from: 1, to: 2, question: 'q', now: 10 });
    const again = requestAsk(db, { taskId, from: 1, to: 2, question: 'q', now: 11 }); // 同 seq=0 → 同键
    assert.equal(again.delivered, false, '重放不得重复投递');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM notifications'), 1);
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked').length, 1, '不得重复写消息主体');

    // 不同 seq → 新的一条
    requestAsk(db, { taskId, from: 1, to: 2, question: 'q2', seq: 1, now: 12 });
    assert.equal(count(db, 'SELECT COUNT(*) n FROM notifications'), 2);
  } finally {
    db.close();
  }
});

test('OPT-M10-1: 人类频道零噪声 —— 不写 human_messages、不落 im:*/desktop', () => {
  const { db, taskId } = setup();
  try {
    // 先放一条普通动作，证明库本身可用
    registerPendingAction(db, { actionKey: 'dispatch:task:1:0', kind: 'dispatch', taskId, now: 1 });
    requestAsk(db, { taskId, from: 1, to: 2, question: 'q', now: 10 });
    assert.equal(count(db, 'SELECT COUNT(*) n FROM human_messages'), 0, '员工问答不得进人类频道');
    assert.equal(
      count(db, "SELECT COUNT(*) n FROM notifications WHERE channel LIKE 'im:%' OR channel='desktop'"),
      0,
      '不得投到 im:*/desktop',
    );
    // 人类频道内容为空（无员工间噪声）
    assert.equal(count(db, "SELECT COUNT(*) n FROM human_messages WHERE content LIKE '%question%'"), 0);
  } finally {
    db.close();
  }
});

test('OPT-M10-1: 未实现通道返回明确错误码（常量，不静默丢弃）', () => {
  assert.deepEqual(routeChannel('employee:2'), { ok: true, kind: 'employee', employeeId: 2 });
  assert.deepEqual(routeChannel('desktop'), { ok: true, kind: 'desktop' });
  const im = routeChannel('im:wechat');
  assert.equal(im.ok, false);
  assert.equal(im.code, MAILBOX_ERROR.CHANNEL_NOT_IMPLEMENTED);
  const bogus = routeChannel('carrier-pigeon');
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, MAILBOX_ERROR.CHANNEL_UNKNOWN);
});

test('OPT-M10-1: 阻塞式 ask 已支持（M2 尾）——照常投递并如实标记 blocking', () => {
  const { db, taskId } = setup();
  try {
    const blockedAsk = requestAsk(db, { taskId, from: 1, to: 2, question: 'q', blocking: true, now: 10 });
    assert.equal(blockedAsk.blocking, true);
    assert.equal(blockedAsk.delivered, true, '阻塞式提问照常投递（落 question_asked ＋ 投递行）');
    assert.equal(listOpenAsks(db)[0]?.blocking, true, '开放提问带 blocking（作答后宿主回队）');
    // 非阻塞是真实语义：默认 blocking=false 可正常投递（换 seq 避免与上一条幂等键相同）
    const ok = requestAsk(db, { taskId, from: 1, to: 2, question: 'q2', seq: 1, now: 10 });
    assert.equal(ok.blocking, false);
    assert.equal(ok.delivered, true);
  } finally {
    db.close();
  }
});

test('OPT-M10-1: answerAsk 写 question_answered，且重复作答同一 ask 幂等', () => {
  const { db, taskId } = setup();
  try {
    const ask = requestAsk(db, { taskId, from: 1, to: 2, question: 'q', now: 10 });
    const a1 = answerAsk(db, { taskId, from: 2, to: 1, askDedupeKey: ask.dedupeKey, answer: '用 v2', now: 20 });
    const a2 = answerAsk(db, { taskId, from: 2, to: 1, askDedupeKey: ask.dedupeKey, answer: '用 v2（重复）', now: 21 });
    assert.equal(a1.delivered, true);
    assert.equal(a2.delivered, false, '重复作答同一 ask 必须幂等忽略');
    const ans = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_answered');
    assert.equal(ans.length, 1, '不得重复写 question_answered');
    const p = JSON.parse(ans[0]!.payload) as { answer: string; askDedupeKey: string };
    assert.equal(p.answer, '用 v2');
    assert.equal(p.askDedupeKey, ask.dedupeKey);
  } finally {
    db.close();
  }
});

test('OPT-M10-1 "有牙": 去掉幂等短路 → 重放必然重复投递（证明上面幂等断言有意义）', () => {
  const { db, taskId } = setup();
  try {
    // 直插两次同 dedupe_key：靠 UNIQUE 只留 1 行；无该约束的第二张表则留 2 行
    insertTaskEvent(db, { taskId, kind: 'question_asked', actor: 'employee:1', ts: 1, payload: {} });
    db.exec('CREATE TABLE no_unique(id INTEGER PRIMARY KEY, k TEXT)');
    db.prepare('INSERT INTO no_unique(k) VALUES(?)').run('ask:1:2:task1:0');
    db.prepare('INSERT INTO no_unique(k) VALUES(?)').run('ask:1:2:task1:0');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM no_unique'), 2, '无唯一约束时重复可插入');
  } finally {
    db.close();
  }
});
