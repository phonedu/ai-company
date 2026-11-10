/**
 *  · 截止提醒 / 逾期卡（只提醒，不自动暂停）。
 *
 * 覆盖：
 *  - 重启重计划：有截止的非终态任务生成 remind + overdue 两条 timer；
 *  - 到期消费：onDeadline 收到 overdue/remind 标记，任务状态不变；
 *  - 终态任务：残留 timer 丢弃、不回调（不打扰）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  openMemoryDatabase,
  runMigrations,
  updateTask,
  type SqliteDb,
} from '../src/main/db/index.js';
import {
  Engine,
  makeRecordingExecutor,
  scheduleTaskDeadlineTimers,
  scheduleTimer,
  planTimersFromState,
} from '../src/main/engine/index.js';

const HOUR = 60 * 60 * 1000;
const DEADLINE = Date.UTC(2026, 10, 1, 12, 0, 0);

function setup(deadline: number): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?)').run('截止测试', 'D:/tmp/deadline', 1)
      .lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '截止测试任务',
    goal: '验证截止提醒',
    riskLevel: 0,
    deadline,
  });
  return { db, taskId: task.id };
}

test('UG-02 重计划：非终态 + 有截止 ⇒ remind + overdue 两条 timer', () => {
  const now = DEADLINE - 48 * HOUR;
  const planned = planTimersFromState([{ id: 7, state: 'executing', deadline: DEADLINE }], now);
  const kinds = planned.map((item) => item.kind);
  assert.deepEqual(kinds, ['task_deadline_remind', 'task_deadline_overdue']);
  const remind = planned.find((item) => item.kind === 'task_deadline_remind');
  const overdue = planned.find((item) => item.kind === 'task_deadline_overdue');
  assert.equal(remind?.dueAt, DEADLINE - 24 * HOUR);
  assert.equal(overdue?.dueAt, DEADLINE);
  assert.equal(remind?.dedupeKey, 'deadline:remind');
  assert.equal(overdue?.dedupeKey, 'deadline:overdue');
});

test('UG-02 登记：同一任务重复登记幂等（UPSERT，不叠行）', () => {
  const { db, taskId } = setup(DEADLINE);
  const before = (db.prepare('SELECT COUNT(*) AS n FROM timers').get() as { n: number }).n;
  scheduleTaskDeadlineTimers(db, { taskId, deadline: DEADLINE, now: DEADLINE - 48 * HOUR });
  const first = (db.prepare('SELECT COUNT(*) AS n FROM timers').get() as { n: number }).n;
  scheduleTaskDeadlineTimers(db, { taskId, deadline: DEADLINE, now: DEADLINE - 47 * HOUR });
  const second = (db.prepare('SELECT COUNT(*) AS n FROM timers').get() as { n: number }).n;
  assert.equal(before, 0);
  assert.equal(first, 2);
  assert.equal(second, 2, '重登不新增行');
  db.close();
});

test('UG-02 逾期：onDeadline(overdue=true) 被调用，任务状态不变', () => {
  const { db, taskId } = setup(DEADLINE);
  scheduleTimer(db, {
    kind: 'task_deadline_overdue',
    taskId,
    dueAt: DEADLINE,
    dedupeKey: 'deadline:overdue',
    payload: { deadline: DEADLINE },
  });
  const calls: Array<{ taskId: number; overdue: boolean; deadline: number }> = [];
  const engine = new Engine(db, makeRecordingExecutor(), {
    autoSchedule: false,
    now: () => DEADLINE,
    onDeadline: (info) => calls.push({ taskId: info.taskId, overdue: info.overdue, deadline: info.deadline }),
  });
  assert.equal(engine.fireDueTimers(), 1);
  assert.deepEqual(calls, [{ taskId, overdue: true, deadline: DEADLINE }]);
  const state = (db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as { state: string }).state;
  assert.equal(state, 'inbox', '截止卡不改任务状态（不自动暂停）');
  db.close();
});

test('UG-02 提醒：onDeadline(overdue=false)；终态任务残留 timer 不回调', () => {
  const { db, taskId } = setup(DEADLINE);
  scheduleTimer(db, {
    kind: 'task_deadline_remind',
    taskId,
    dueAt: DEADLINE - 24 * HOUR,
    dedupeKey: 'deadline:remind',
    payload: { deadline: DEADLINE },
  });
  const calls: Array<{ overdue: boolean }> = [];
  const engine = new Engine(db, makeRecordingExecutor(), {
    autoSchedule: false,
    now: () => DEADLINE - 24 * HOUR,
    onDeadline: (info) => calls.push({ overdue: info.overdue }),
  });
  assert.equal(engine.fireDueTimers(), 1);
  assert.deepEqual(calls, [{ overdue: false }]);

  // 终态：同任务再放一条逾期 timer → 丢弃且不回调。
  updateTask(db, taskId, { state: 'done' }, DEADLINE);
  scheduleTimer(db, {
    kind: 'task_deadline_overdue',
    taskId,
    dueAt: DEADLINE,
    dedupeKey: 'deadline:overdue',
    payload: { deadline: DEADLINE },
  });
  const doneEngine = new Engine(db, makeRecordingExecutor(), {
    autoSchedule: false,
    now: () => DEADLINE,
    onDeadline: (info) => calls.push({ overdue: info.overdue }),
  });
  assert.equal(doneEngine.fireDueTimers(), 0, '终态任务不回调');
  assert.deepEqual(calls, [{ overdue: false }]);
  db.close();
});
