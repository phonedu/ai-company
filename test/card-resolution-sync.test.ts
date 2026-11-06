/**
 * RM-2（2026-10-19 真机）：老板在频道里解决决策后，「待我处理」的同任务 ask 卡必须同步消失。
 *
 * 两条断言：
 * ① DB 层只清同任务 pending/delivered 的 ask 卡，不误伤 report/alert；重复调用幂等。
 * ② 引擎只在**提交后**回调 `onCommitted`（入队时不算）；main 用它清卡，不能靠 `onEvent`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgePendingAsksIfTaskSettled,
  acknowledgePendingAsksForTask,
  createTask,
  getReport,
  insertReport,
  openMemoryDatabase,
  runMigrations,
  SqliteCounterStore,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { shouldClearPendingAsks } from '../src/main/ipc/card-sync.js';

const AT = 1_700_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',?)").run(AT).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '同步测试',
    goal: 'g',
    now: AT,
  });
  return { db, task };
}

test('RM-2 DB：只清同任务 pending/delivered 的 ask；report 不动；重复调用幂等', () => {
  const { db, task } = setup();
  try {
    const ask = insertReport(db, { taskId: task.id, kind: 'ask', payload: { question: '去吗' }, state: 'pending', now: AT });
    const delivered = insertReport(db, {
      taskId: task.id,
      kind: 'ask',
      payload: { question: '也去吗' },
      state: 'delivered',
      now: AT,
    });
    const report = insertReport(db, { taskId: task.id, kind: 'report', payload: { tldr: '完成' }, state: 'pending', now: AT });

    assert.equal(acknowledgePendingAsksForTask(db, task.id, AT + 1), 2, '两张 ask 都清');
    assert.equal(getReport(db, ask.id)?.state, 'acknowledged');
    assert.equal(getReport(db, delivered.id)?.state, 'acknowledged');
    assert.equal(getReport(db, report.id)?.state, 'pending', 'report 不得被误清');
    assert.equal(acknowledgePendingAsksForTask(db, task.id, AT + 2), 0, '重复调用幂等');
  } finally {
    db.close();
  }
});

test('RM-2 权限卡：决策清卡不得误清同任务 pending permission；终态才清', () => {
  const { db, task } = setup();
  try {
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    const decision = insertReport(db, {
      taskId: task.id,
      kind: 'ask',
      payload: { card: 'decision', question: '继续吗' },
      state: 'pending',
      now: AT,
    });
    const permission = insertReport(db, {
      taskId: task.id,
      kind: 'ask',
      payload: { card: 'permission', question: '允许 bash 吗' },
      state: 'pending',
      now: AT,
    });
    assert.equal(acknowledgePendingAsksForTask(db, task.id, AT + 1), 1, '只清决策卡');
    assert.equal(getReport(db, decision.id)?.state, 'acknowledged');
    assert.equal(getReport(db, permission.id)?.state, 'pending', '权限卡必须保留');
    assert.equal(
      acknowledgePendingAsksForTask(db, task.id, AT + 2, { includePermission: true }),
      1,
      '终态才清权限卡',
    );
    assert.equal(getReport(db, permission.id)?.state, 'acknowledged');
  } finally {
    db.close();
  }
});

test('RM-2 事件判据：真实事件名才清；不存在的 task_started 不清；等待态不清', () => {
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'plan_approved' }, 'executing'), true);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'decision_made' }, 'planning'), true);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'start_task' }, 'executing'), true);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'all_work_items_done' }, 'verifying'), true);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'askcard_timeout' }, 'ready'), true, '超时自动通过后清卡');
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'finish' }, 'done'), true);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'task_started' }, 'executing'), false, '旧错名不得再生效');
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'plan_approved' }, 'awaiting_approval'), false);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'decision_made' }, 'needs_decision'), false);
  assert.equal(shouldClearPendingAsks({ scope: 'task', event: 'pause' }, 'paused'), false, '暂停不清卡');
  assert.equal(shouldClearPendingAsks({ scope: 'work_item', event: 'plan_approved' }, 'executing'), false);
});

test('RM-2 状态门：仍在 needs_decision/awaiting_approval 不清；离开后才清（不猜事件名）', () => {
  const { db, task } = setup();
  try {
    insertReport(db, { taskId: task.id, kind: 'ask', payload: { question: '去吗' }, state: 'pending', now: AT });
    db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
    assert.equal(acknowledgePendingAsksIfTaskSettled(db, task.id, AT + 1), 0, '待批准不得清卡');
    db.prepare("UPDATE tasks SET state='needs_decision' WHERE id=?").run(task.id);
    assert.equal(acknowledgePendingAsksIfTaskSettled(db, task.id, AT + 2), 0, '待决策不得清卡');
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    assert.equal(acknowledgePendingAsksIfTaskSettled(db, task.id, AT + 3), 1, '离开等待态后清卡');
  } finally {
    db.close();
  }
});

test('RM-2 引擎：onCommitted 只在提交后回调；非法事件回滚不回调', async () => {
  const { db, task } = setup();
  try {
    const seen: string[] = [];
    const engine = new Engine(db, makeRecordingExecutor(), {
      autoSchedule: false,
      onCommitted: (event) => seen.push(event.event),
    });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss' });
    assert.ok(seen.includes('triage'), '合法事件提交后必须回调');

    const before = seen.length;
    await assert.rejects(
      engine.dispatch({ scope: 'task', id: task.id, event: 'not_a_real_event', actor: 'boss' }),
      '非法事件应拒绝',
    );
    assert.equal(seen.length, before, '回滚/入队失败不得触发 onCommitted');
  } finally {
    db.close();
  }
});
