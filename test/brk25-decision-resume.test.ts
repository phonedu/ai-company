/**
 * 验收后复查 B（BRK25）：答决策卡回 planning 必须真的重派规划；回 executing 不凭空派规划。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { SqliteDb } from '../src/main/db/index.js';

function setup(): { db: SqliteDb; taskId: number; engine: Engine } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1 });
  return { db, taskId: task.id, engine };
}

function dispatchPlanningActions(db: SqliteDb, taskId: number) {
  return db
    .prepare("SELECT action_key, payload FROM action_log WHERE task_id = ? AND kind = 'dispatch_planning' ORDER BY id")
    .all(taskId) as Array<{ action_key: string; payload: string }>;
}

test('BRK25：needs_decision + resume=planning 答卡后登记新的 dispatch_planning', async () => {
  const { db, taskId, engine } = setup();
  try {
    db.prepare("UPDATE tasks SET state='needs_decision', resume_state='planning' WHERE id=?").run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_made', actor: 'boss', payload: { chosen: '继续' } });

    const actions = dispatchPlanningActions(db, taskId);
    assert.equal(actions.length, 1, '必须重派一次规划');
    assert.match(actions[0]!.action_key, /:1$/, '重派键必须区别于首轮 :0');
    assert.equal(JSON.parse(actions[0]!.payload).via, 'decision_resume');
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state, 'planning');
  } finally {
    db.close();
  }
});

test('BRK25：resume=executing 的答卡不重派规划', async () => {
  const { db, taskId, engine } = setup();
  try {
    db.prepare("UPDATE tasks SET state='needs_decision', resume_state='executing' WHERE id=?").run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_made', actor: 'boss', payload: { chosen: '继续' } });
    assert.equal(dispatchPlanningActions(db, taskId).length, 0, 'executing 恢复不应派 planner');
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state, 'executing');
  } finally {
    db.close();
  }
});

test('BRK25：resume=verifying 答卡后重派 verifier（不再停在 verifying）', async () => {
  const { db, taskId, engine } = setup();
  try {
    db.prepare("UPDATE tasks SET state='needs_decision', resume_state='verifying' WHERE id=?").run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_made', actor: 'boss', payload: { chosen: '继续' } });
    const actions = db
      .prepare("SELECT action_key, payload FROM action_log WHERE task_id = ? AND kind = 'dispatch_verifier' ORDER BY id")
      .all(taskId) as Array<{ action_key: string; payload: string }>;
    assert.equal(actions.length, 1, '必须重派一次 verifier');
    assert.match(actions[0]!.action_key, /:1$/, '重派键必须区别于首轮 :0');
    assert.equal(JSON.parse(actions[0]!.payload).via, 'decision_resume');
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state, 'verifying');
  } finally {
    db.close();
  }
});

test('BRK25：同一任务二次 escalate 用决策轮次出新的卡（重放不重复）', async () => {
  const { db, taskId, engine } = setup();
  try {
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { reason: 'first' } });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_made', actor: 'boss', payload: { chosen: '继续' } });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'escalate', actor: 'system', payload: { reason: 'second' } });
    const keys = db
      .prepare("SELECT action_key FROM action_log WHERE task_id = ? AND kind = 'notify_decision' ORDER BY id")
      .all(taskId) as Array<{ action_key: string }>;
    assert.equal(keys.length, 2, '两次 escalate 必须各登记一次决策动作');
    assert.match(keys[0]!.action_key, /:0$/, '首轮 revision=0');
    assert.match(keys[1]!.action_key, /:1$/, '二次用 decisionRevision=1，不会命中首轮动作');
  } finally {
    db.close();
  }
});
