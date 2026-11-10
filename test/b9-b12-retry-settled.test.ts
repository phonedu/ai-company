/**
 * B9（retry 重派）+ B12（agent_settled 判据由**真实提交事实**决定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getAction,
  getWorkItem,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  updateTask,
  updateWorkItem,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor, WORK_ITEM_TRANSITIONS } from '../src/main/engine/index.js';
import { registerPendingAction } from '../src/main/db/action_log.js';

function setup(risk = 1): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: risk, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

test('B9: 任务 `failed --retry--> ready` 已激活（m0:true）', () => {
  const row = WORK_ITEM_TRANSITIONS.find((r) => r.from === 'failed' && r.event === 'retry');
  assert.ok(row, 'WI retry 行存在');
  assert.equal(row!.m0, true);
});

test('S1 回归：failed 任务 retry 后进入 executing，会重派 failed 工作项（attempt+1 + dispatch）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    updateTask(db, taskId, { state: 'failed' });
    updateWorkItem(db, wiId, { state: 'failed', attempt: 0, finished_at: 1 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: true });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'retry', actor: 'boss' });
    await engine.tick();
    const taskState = (db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state;
    const wi = getWorkItem(db, wiId);
    assert.equal(taskState, 'executing', '任务必须真的重新执行');
    assert.equal(wi?.state, 'running', 'failed 件必须被重派，而不是留在 failed 空转');
    assert.equal(wi?.attempt, 1, '重派必须递增 attempt（新 dispatch 键）');
    assert.ok(getAction(db, `dispatch:work_item:${wiId}:1`), '必须有新的 dispatch 动作落库');
  } finally {
    db.close();
  }
});

test('B9: 工作项 `failed --retry` 真**重派**；**连续两次失败+retry** 都真派（attempt 1→2→3、三把不同键、第二次不被 IGNORE）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const countDispatch = () =>
      (db.prepare("SELECT COUNT(*) n FROM action_log WHERE kind='dispatch'").get() as { n: number }).n;
    // 第一次失败（attempt=1）→ retry
    updateWorkItem(db, wiId, { state: 'failed', attempt: 1, finished_at: 1 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'retry', actor: 'boss' });
    assert.equal(getWorkItem(db, wiId)?.state, 'running');
    assert.equal(getWorkItem(db, wiId)?.attempt, 2, 'attempt 必须真递增（否则幂等键不变 = 静默 no-op）');
    assert.ok(getAction(db, `dispatch:work_item:${wiId}:2`), '第一次重派：键以 attempt=2 结尾');
    assert.equal(countDispatch(), 1);

    // **第二次**失败（attempt=2）→ retry → 必须**又拿到新键**、且**不被 IGNORE 吞掉**
    updateWorkItem(db, wiId, { state: 'failed', attempt: 2, finished_at: 2 });
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'retry', actor: 'boss' });
    assert.equal(getWorkItem(db, wiId)?.state, 'running');
    assert.equal(getWorkItem(db, wiId)?.attempt, 3, '第二次 retry attempt 也要递增');
    assert.ok(getAction(db, `dispatch:work_item:${wiId}:3`), '第二次重派：键以 attempt=3 结尾（新键）');
    assert.equal(countDispatch(), 2, '第二次重派必须真落一条（不得被 IGNORE 吞掉）');

    // 幂等：同一键重放不会新增
    const dup = registerPendingAction(db, { actionKey: `dispatch:work_item:${wiId}:3`, kind: 'dispatch', taskId, payload: { attempt: 3 }, now: 3 });
    assert.equal(dup, false);
    assert.equal(countDispatch(), 2);
  } finally {
    db.close();
  }
});

test('B12: `agent_settled` 的 `submitted` 判据**不看调用方 payload**，由真实状态决定', async () => {
  // ① 未提交（running + 无 result）→ 即便 payload 说 submitted:true，也必须走 failed
  {
    const { db, taskId, wiId } = setup();
    try {
      updateWorkItem(db, wiId, { state: 'running', started_at: 1 });
      const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
      await engine.dispatch({
        scope: 'work_item',
        id: wiId,
        event: 'agent_settled',
        actor: 'employee:7',
        payload: { submitted: true }, // ← 调用方撒谎
      });
      assert.equal(getWorkItem(db, wiId)?.state, 'failed', '调用方说 submitted:true 也不得被视为已提交');
      assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'work_item_failed'));
    } finally {
      db.close();
    }
  }
  // ② `result` 已写（真实提交事实）→ 即使 payload 没带 submitted，也应视为已提交
  {
    const { db, wiId } = setup();
    try {
      updateWorkItem(db, wiId, { state: 'running', result: JSON.stringify({ summary: 'ok' }), started_at: 1 });
      const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
      await engine.dispatch({ scope: 'work_item', id: wiId, event: 'agent_settled', actor: 'employee:7' });
      // 真实有 result ⇒ 视为已提交； 后：免验件（默认 L1 未命中抽验）提交即自动接受 → done
      assert.equal(getWorkItem(db, wiId)?.state, 'done', '视为已提交 ⇒（免验）自动接受 ⇒ done（不看 payload）');
    } finally {
      db.close();
    }
  }
});
