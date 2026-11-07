/**
 * B0-4（ADV-1 P0-1）：ask 协作幂等键跨轮碰撞——第二轮提问静默丢失的回归测试。
 *
 * 旧实现：幂等键 = `ask:from:to:wi<N>:<seq>`，`seq` 取「本轮工具调用数组下标」；
 * 每次会话的第一条 ask 都是 0 ⇒ 第二轮（含返工/重试/续跑）的新问题撞上一轮旧键，
 * `requestAsk` 返回 delivered:false，executor 不看返回值 ⇒ 问题静默消失。
 *
 * 新口径：序号带**动作版本**（`actionKey` 的 revision＝重试轮次），同一轮内仍按下标区分；
 * 重放同一动作仍幂等（键不变），不同轮/不同问题不再撞键。executor 对 delivered:false
 * 留痕（tool_call replay），不假装是新投递。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listNotifications,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number, attempt: number) =>
  toPersistedAction(`dispatch:work_item:${wiId}:${attempt}`, 'dispatch', taskId, JSON.stringify({ attempt }));

const askRun = (id: string, question: string) => ({
  text: '',
  toolCalls: [
    { id, name: 'ask_colleague', input: { to: 9, question }, isError: false },
    { id: `${id}-submit`, name: 'submit_work_item', input: { summary: 'asked' }, isError: false },
  ],
});

test('B0-4：两轮各自提问（同一调用下标 0）→ 两条问题都真投递，键不撞', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      askRun('a0', '第一轮：契约用 v2 吗？'),
      askRun('a1', '第二轮：那错误码呢？'),
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId, 0));
    await exec.execute(dispatchAction(taskId, wiId, 1));
    const asked = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 2, '两轮问题都必须落库（旧实现第二轮被幂等键吞掉）');
    const keys = asked.map((e) => (JSON.parse(e.payload) as { dedupeKey: string }).dedupeKey);
    assert.equal(new Set(keys).size, 2, `幂等键必须跨轮唯一：${JSON.stringify(keys)}`);
    for (const key of keys) assert.match(key, new RegExp(`^ask:7:9:wi${wiId}:`), '键前缀保持可读（ask:from:to:subject:round）');
    assert.equal(listNotifications(db, { channel: 'employee:9' }).length, 2, '两次投递各一行通知');
  } finally {
    db.close();
  }
});

test('B0-4：重放同一动作（同一 attempt）→ 幂等，不重复投递也不重复写问题', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // 重放＝同一动作被 at-least-once 重执行：脚本对每次调用都返回同一提问。
    const fake = makeFakeAgentRuntime(() => askRun('a0', '只问一次：契约用 v2 吗？'));
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId, 0));
    await exec.execute(dispatchAction(taskId, wiId, 0));
    const asked = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 1, '重放同一动作不得再写一条问题');
    assert.equal(listNotifications(db, { channel: 'employee:9' }).length, 1, '重放不得重复投递');
    // 重放留痕：tool_call 事件标 replay（不是新的 question_asked），老板/审计能看见。
    const replay = listTaskEvents(db, taskId).filter(
      (e) => e.kind === 'tool_call' && (JSON.parse(e.payload) as { replay?: boolean }).replay === true,
    );
    assert.equal(replay.length, 1, '幂等重放必须留痕（不静默）');
  } finally {
    db.close();
  }
});

test('B0-4：同一轮两条提问（下标 0/1）仍按下标区分', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'q0', name: 'ask_colleague', input: { to: 9, question: '问题甲' }, isError: false },
          { id: 'q1', name: 'ask_colleague', input: { to: 9, question: '问题乙' }, isError: false },
          { id: 'q2', name: 'submit_work_item', input: { summary: 'ok' }, isError: false },
        ],
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId, 2));
    const asked = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 2);
    const keys = asked.map((e) => (JSON.parse(e.payload) as { dedupeKey: string }).dedupeKey);
    assert.equal(new Set(keys).size, 2, '同轮多条也必须互不相同');
  } finally {
    db.close();
  }
});
