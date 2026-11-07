/**
 * B0-5（ADV-1 P0-2）：毒事件整批回滚 + 事件永久丢失的回归测试。
 *
 * 旧实现：`processBatch` 整批一个事务，任一事件抛错 → 全批 ROLLBACK；而 `drain` 已把整批
 * 从队列 splice 走 ⇒ **同批其余事件直接消失**，只在 tick 的 catch 里发一个全仓无消费者的
 * `engine_error` 事件（不落库、不上卡）。老板的批准/作答/定时器触发可随批无声蒸发。
 *
 * 新口径：整批失败 → 逐事件独立事务隔离重试；毒事件回滚自己、写 `engine_error` 事件流＋
 * 异常卡（notify alert），同批其他事件照常提交。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  listReports,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function setup(): { db: SqliteDb; readyTaskId: number; doneTaskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run();
  const ready = createTask(db, new SqliteCounterStore(db), {
    projectId: 1,
    title: '可暂停',
    goal: 'g',
    state: 'ready',
    now: 1,
  });
  const done = createTask(db, new SqliteCounterStore(db), {
    projectId: 1,
    title: '已结束',
    goal: 'g',
    state: 'done',
    now: 1,
  });
  return { db, readyTaskId: ready.id, doneTaskId: done.id };
}

const stateOf = (db: SqliteDb, taskId: number): string =>
  (db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state;

test('B0-5：同批一个毒事件（非法迁移）不拖死其他事件——其余事件必须提交', async () => {
  const { db, readyTaskId, doneTaskId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false });
    engine.enqueue({ scope: 'task', id: doneTaskId, event: 'pause', actor: 'system' });
    engine.enqueue({ scope: 'task', id: readyTaskId, event: 'pause', actor: 'system' });
    await engine.drain(); // 旧实现这里整批 ROLLBACK，任务仍 ready
    assert.equal(stateOf(db, readyTaskId), 'paused', '同批的合法事件必须落库（不能被毒事件连坐）');
    assert.equal(stateOf(db, doneTaskId), 'done', '毒事件对自己的状态零改动');
  } finally {
    db.close();
  }
});

test('B0-5：毒事件必须落库留痕（engine_error 事件）＋上异常卡，不静默', async () => {
  const { db, doneTaskId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false });
    engine.enqueue({ scope: 'task', id: doneTaskId, event: 'pause', actor: 'system' });
    await engine.drain();
    const errors = listTaskEvents(db, doneTaskId).filter((e) => e.kind === 'engine_error');
    assert.equal(errors.length, 1, '毒事件必须写 engine_error 事件（审计可查）');
    const payload = JSON.parse(errors[0]!.payload) as { event?: string; error?: string };
    assert.equal(payload.event, 'pause');
    assert.ok((payload.error ?? '').length > 0, '错误原因必须落库');
    const cards = listReports(db).filter((r) => r.kind === 'alert');
    assert.equal(cards.length, 1, '必须给老板一张异常卡（不只是控制台）');
    assert.match(String((JSON.parse(cards[0]!.payload) as { title?: string }).title ?? ''), /引擎/);
  } finally {
    db.close();
  }
});

test('B0-5：同一毒事件重复出现不刷屏（异常卡按事件键幂等）', async () => {
  const { db, doneTaskId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false });
    engine.enqueue({ scope: 'task', id: doneTaskId, event: 'pause', actor: 'system' });
    await engine.drain();
    engine.enqueue({ scope: 'task', id: doneTaskId, event: 'pause', actor: 'system' });
    await engine.drain();
    const cards = listReports(db).filter((r) => r.kind === 'alert');
    assert.equal(cards.length, 1, '同一毒事件（同任务同事件同原因）只提示一次');
  } finally {
    db.close();
  }
});
