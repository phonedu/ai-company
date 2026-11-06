/**
 * BRK12（M3-R-5）：员工真互答——被问员工看到点名问、用 answer_colleague 作答；阻塞件真唤醒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  updateWorkItem,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor, toPersistedAction } from '../src/main/engine/index.js';
import {
  MAILBOX_ERROR,
  MailboxError,
  answerAsk,
  listOpenAsks,
  listOpenAsksForEmployee,
  requestAsk,
} from '../src/main/engine/mailbox.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; projectId: number; taskA: number; wiA: number; taskB: number; wiB: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,active,capability_tier,created_at) VALUES(7,'A','dev',1,'standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,active,capability_tier,created_at) VALUES(9,'B','ops',1,'standard',1)").run();
  const taskA = createTask(db, new SqliteCounterStore(db), { projectId, title: 'A', goal: 'g', riskLevel: 0, state: 'executing', ownerId: 7 });
  const wiA = insertWorkItem(db, { taskId: taskA.id, employeeId: 7, title: 'A 件', brief: 'b', now: AT });
  updateWorkItem(db, wiA.id, { state: 'blocked' });
  const taskB = createTask(db, new SqliteCounterStore(db), { projectId, title: 'B', goal: 'g', riskLevel: 0, state: 'executing', ownerId: 9 });
  const wiB = insertWorkItem(db, { taskId: taskB.id, employeeId: 9, title: 'B 件', brief: 'b', now: AT });
  updateWorkItem(db, wiB.id, { state: 'running' });
  return { db, projectId, taskA: taskA.id, wiA: wiA.id, taskB: taskB.id, wiB: wiB.id };
}

test('BRK12：自己问自己 / A↔B 双向未结互问被拒（防死循环）', () => {
  const f = setup();
  try {
    assert.throws(
      () => requestAsk(f.db, { taskId: f.taskA, workItemId: f.wiA, from: 7, to: 7, question: '自问', now: AT }),
      (e: unknown) => e instanceof MailboxError && e.code === MAILBOX_ERROR.SELF_ASK,
    );
    const ask = requestAsk(f.db, { taskId: f.taskA, workItemId: f.wiA, from: 7, to: 9, question: 'A 问 B', blocking: true, now: AT });
    assert.throws(
      () => requestAsk(f.db, { taskId: f.taskB, workItemId: f.wiB, from: 9, to: 7, question: 'B 反问问 A', now: AT + 1 }),
      (e: unknown) => e instanceof MailboxError && e.code === MAILBOX_ERROR.MUTUAL_ASK,
    );
    assert.equal(listOpenAsksForEmployee(f.db, 9).length, 1);
    assert.equal(listOpenAsksForEmployee(f.db, 9)[0]?.askDedupeKey, ask.dedupeKey);
    assert.equal(listOpenAsksForEmployee(f.db, 7).length, 0);
  } finally {
    f.db.close();
  }
});

test('BRK12：B 的上下文带点名问；answer_colleague 作答 → 事件 via=employee＋A 阻塞件 answer_received', async () => {
  const f = setup();
  try {
    const ask = requestAsk(f.db, {
      taskId: f.taskA,
      workItemId: f.wiA,
      from: 7,
      to: 9,
      question: '术语用哪个？',
      blocking: true,
      now: AT,
    });
    const ctx = buildEmployeeContext(f.db, {
      employeeId: 9,
      taskId: f.taskB,
      workItemId: f.wiB,
      mailboxAsks: listOpenAsksForEmployee(f.db, 9).map((a) => ({
        askDedupeKey: a.askDedupeKey,
        from: a.from,
        question: a.question,
        blocking: a.blocking,
      })),
    });
    assert.match(ctx.userPrompt, /同事提问/);
    assert.match(ctx.userPrompt, new RegExp(ask.dedupeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const fake = makeFakeAgentRuntime([
      {
        text: 'ok',
        toolCalls: [
          {
            id: 'ans1',
            name: 'answer_colleague',
            input: { askDedupeKey: ask.dedupeKey, answer: '用「对账单」。' },
            isError: false,
          },
          {
            id: 'sub1',
            name: 'submit_work_item',
            input: { summary: 'B 完成' },
            isError: false,
          },
        ],
      },
    ]);
    const engine = new Engine(f.db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT + 2 });
    const exec = createEmployeeExecutor({
      db: f.db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: (e) => engine.dispatch(e),
      now: () => AT + 2,
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${f.wiB}:0`, 'dispatch', f.taskB, JSON.stringify({ attempt: 0 })));

    const answered = listTaskEvents(f.db, f.taskA).filter((e) => e.kind === 'question_answered');
    assert.equal(answered.length, 1);
    assert.equal(answered[0]?.actor, 'employee:9', '员工作答 actor 如实');
    const payload = JSON.parse(String(answered[0]?.payload)) as { via: string; answer: string; to: number };
    assert.equal(payload.via, 'employee');
    assert.equal(payload.answer, '用「对账单」。');
    assert.equal(payload.to, 7, '答复给提问者');
    assert.equal(getWorkItem(f.db, f.wiA)?.state, 'queued', '阻塞提问者的件被 answer_received 唤醒回 queued');
    assert.equal(listOpenAsks(f.db).length, 0, '答后不再开放');
  } finally {
    f.db.close();
  }
});

test('BRK12：只能答「问我的」ask；答别人的 ask 不落答复（工具调用标 error）', async () => {
  const f = setup();
  try {
    const ask = requestAsk(f.db, { taskId: f.taskA, workItemId: f.wiA, from: 7, to: 9, question: '问 B', now: AT });
    // 用 A（员工 7）去答一条问 B（9）的 ask。
    const fake = makeFakeAgentRuntime([
      {
        text: 'ok',
        toolCalls: [
          { id: 'bad', name: 'answer_colleague', input: { askDedupeKey: ask.dedupeKey, answer: '越权答' }, isError: false },
          { id: 'sub', name: 'submit_work_item', input: { summary: 'A 完成' }, isError: false },
        ],
      },
    ]);
    const exec = createEmployeeExecutor({ db: f.db, runtime: new EmployeeSessionRuntime(fake), now: () => AT + 1 });
    await exec.execute(toPersistedAction(`dispatch:work_item:${f.wiA}:0`, 'dispatch', f.taskA, JSON.stringify({ attempt: 0 })));
    assert.equal(listTaskEvents(f.db, f.taskA).filter((e) => e.kind === 'question_answered').length, 0);
    const toolError = listTaskEvents(f.db, f.taskA).find(
      (e) => e.kind === 'tool_call' && String(e.payload).includes('answer_colleague'),
    );
    assert.ok(toolError, '越权作答必须留 tool_call error（不静默）');
    // 兜底：直接 answerAsk 仍可被调用，但宿主路径已拒；ask 未关闭
    assert.equal(listOpenAsks(f.db).length, 1);
    answerAsk(f.db, { taskId: f.taskA, workItemId: f.wiA, from: 9, to: 7, askDedupeKey: ask.dedupeKey, answer: '正确答', now: AT + 2 });
  } finally {
    f.db.close();
  }
});
