/**
 * `needs_decision` 的 AskCard 超时默认动作 —— **fail-closed 白名单**（`keep` / `pause`）。
 *
 * 覆盖三件事（3435 裁定）：
 * ① 进 `needs_decision` **也排** askcard_timeout（含 `planTimersFromState` 重启重建）；
 * ② 消费端**不硬编码 `approve`** —— 读真实 `default_action`；
 * ③ 判据 = 白名单：`null`（一直等）/ 白名单外（含 `variant:'danger'`）⇒ 到期**只留痕、不迁移**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SqliteCounterStore,
  createTask,
  getApproval,
  insertApproval,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  updateTask,
  type SqliteDb,
} from '../src/main/db/index.js';
import {
  Engine,
  TIMEOUT_AUTO_ACTIONS,
  resolveDefaultActionKind,
  makeRecordingExecutor,
} from '../src/main/engine/index.js';
import { listDueTimers, planTimersFromState, scheduleTimer } from '../src/main/engine/timers.js';

function setup(state: string, resumeState: string | null): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/tmp/p', 1)").run();
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId: 1,
    title: 'T',
    goal: 'g',
    state,
    now: 1,
  });
  if (resumeState) db.prepare('UPDATE tasks SET resume_state = ? WHERE id = ?').run(resumeState, task.id);
  return { db, taskId: task.id };
}

const stateOf = (db: SqliteDb, taskId: number) =>
  (db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state;

function armTimeout(db: SqliteDb, taskId: number, at: number): void {
  scheduleTimer(db, { kind: 'askcard_timeout', taskId, dueAt: at - 1, dedupeKey: 'askcard', payload: {} });
}

test('B6: 默认动作在白名单内（keep）⇒ 到期**自动执行**回 resume_state，并记 decided_by=timeout', async () => {
  const { db, taskId } = setup('needs_decision', 'executing');
  try {
    const approval = insertApproval(db, {
      taskId,
      reportId: null,
      question: '对账单用哪个口径？',
      options: [{ key: 'keep', label: '保持现状' }, { key: 'abort', label: '中止', variant: 'danger' }],
      defaultAction: 'keep',
      timeoutAt: 50,
    });
    armTimeout(db, taskId, 100);
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    assert.equal(engine.fireDueTimers(), 1, '到期应消费该 timer');
    await engine.drain();
    assert.equal(stateOf(db, taskId), 'executing', '回 resume_state');
    const ev = listTaskEvents(db, taskId).filter((e) => e.kind === 'decision_made');
    assert.equal(ev.length, 1, '落 decision_made');
    assert.equal((JSON.parse(String(ev[0]!.payload)) as { defaultAction?: string }).defaultAction, 'keep');
    const row = getApproval(db, approval.id)!;
    assert.equal(row.chosen, 'keep');
    assert.equal(row.decided_by, 'timeout', '只有自动执行才记 decided_by=timeout');
  } finally {
    db.close();
  }
});

test('B6: `default_action = null`（一直等）⇒ 到期**不迁移**、不记 decided_by；卡保持待决', async () => {
  const { db, taskId } = setup('needs_decision', 'executing');
  try {
    const approval = insertApproval(db, {
      taskId,
      reportId: null,
      question: 'q',
      options: [{ key: 'keep', label: '保持现状' }],
      defaultAction: null,
      timeoutAt: 50,
    });
    armTimeout(db, taskId, 100);
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    assert.equal(engine.fireDueTimers(), 0, '不可自动 ⇒ 不计入 fired');
    await engine.drain();
    assert.equal(stateOf(db, taskId), 'needs_decision', '原地不动');
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'decision_made').length, 0, '无 decision_made');
    const row = getApproval(db, approval.id)!;
    assert.equal(row.chosen, null, '卡保持待决（老板在待办里仍看得到）');
    assert.equal(row.decided_by, null, '未自动执行 ⇒ 不记 timeout');
  } finally {
    db.close();
  }
});

test('B6: 白名单外（破坏性 `abort`/danger）⇒ 到期**不迁移**（超时 ≠ 老板批准了取消）', async () => {
  const { db, taskId } = setup('needs_decision', 'executing');
  try {
    insertApproval(db, {
      taskId,
      reportId: null,
      question: 'q',
      options: [{ key: 'abort', label: '中止', variant: 'danger' }],
      defaultAction: 'abort',
      timeoutAt: 50,
    });
    armTimeout(db, taskId, 100);
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    assert.equal(engine.fireDueTimers(), 0);
    await engine.drain();
    assert.equal(stateOf(db, taskId), 'needs_decision');
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'decision_made').length, 0);
  } finally {
    db.close();
  }
});

test('B6: 进 `needs_decision` 会排 askcard_timeout；`planTimersFromState` 重启重建也覆盖它', async () => {
  const { db, taskId } = setup('inbox', null);
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'ask_owner', actor: 'system' });
    assert.equal(stateOf(db, taskId), 'needs_decision');
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) n FROM timers WHERE task_id=? AND kind='askcard_timeout' AND fired_at IS NULL")
          .get(taskId) as { n: number }
      ).n,
      1,
      '进入 needs_decision 必须排 AskCard 超时',
    );
    // 重启重建：needs_decision 在计划内
    const rebuilt = planTimersFromState([{ id: taskId, state: 'needs_decision' }], 1000);
    assert.equal(rebuilt.filter((t) => t.kind === 'askcard_timeout').length, 1, 'planTimersFromState 覆盖 needs_decision');
    // 出该状态 → 清残留 timer
    await engine.dispatch({ scope: 'task', id: taskId, event: 'cancel', actor: 'boss' });
    assert.equal(listDueTimers(db, 10 ** 12).filter((t) => t.task_id === taskId).length, 0, '离开后无残留');
  } finally {
    db.close();
  }
});

test('B6: 判据函数本身（白名单 fail-closed）', () => {
  assert.deepEqual([...TIMEOUT_AUTO_ACTIONS], ['keep', 'pause'], '白名单初值 = keep/pause');
  assert.equal(resolveDefaultActionKind(null), 'none');
  assert.equal(resolveDefaultActionKind(''), 'none');
  assert.equal(resolveDefaultActionKind('keep'), 'auto');
  assert.equal(resolveDefaultActionKind('pause'), 'auto');
  assert.equal(resolveDefaultActionKind('abort'), 'blocked', '不在白名单 = 不自动');
  assert.equal(resolveDefaultActionKind('approve'), 'blocked', 'approve 不是「保守项」');
  assert.equal(resolveDefaultActionKind('keep', [{ key: 'keep', variant: 'danger' }]), 'blocked', '显式 danger 双保险');
  assert.equal(resolveDefaultActionKind('pause', [{ key: 'pause' }]), 'auto');
  assert.equal(resolveDefaultActionKind('keep', null), 'auto');
});
