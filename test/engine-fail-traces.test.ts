/**
 * OPT-M8-2 ①：失败/中断必须留痕（`task_events`）。
 *  - 副作用动作执行失败 → `action_failed`（含 actionKey/kind/error）；
 *  - 工作项失败 → `work_item_failed` payload 带 `reason`（= 触发事件名）；
 *  - 崩潰恢复 → `work_item_interrupted` payload 带 `reason='restart'`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  getAction,
  getWorkItem,
  insertWorkItem,
  listTaskEvents,
  openDatabase,
  openMemoryDatabase,
  runMigrations,
  updateWorkItem,
  type SqliteDb,
} from '../src/main/db/index.js';
import { registerPendingAction } from '../src/main/db/action_log.js';
import { Engine, executePendingActions, makeRecordingExecutor } from '../src/main/engine/index.js';

function fresh(): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0 });
  return { db, taskId: task.id };
}

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

test('OPT-M8-2①: 副作用动作执行失败 → `action_failed` 留痕（含 actionKey/kind/error）+ action_log failed', async () => {
  const { db, taskId } = fresh();
  try {
    registerPendingAction(db, { actionKey: 'dispatch:work_item:1:0', kind: 'dispatch', taskId, now: 1 });
    const boom = { execute: () => { throw new Error('executor exploded'); } };
    const res = await executePendingActions(db, boom, 2);
    assert.deepEqual(res.failed.map((f) => f.actionKey), ['dispatch:work_item:1:0']);
    assert.equal(getAction(db, 'dispatch:work_item:1:0')?.state, 'failed');

    const evs = listTaskEvents(db, taskId).filter((e) => e.kind === 'action_failed');
    assert.equal(evs.length, 1, '失败必须留痕');
    const payload = JSON.parse(evs[0]!.payload) as { actionKey: string; kind: string; error: string };
    assert.equal(payload.actionKey, 'dispatch:work_item:1:0');
    assert.equal(payload.kind, 'dispatch');
    assert.match(payload.error, /executor exploded/);
  } finally {
    db.close();
  }
});

test('OPT-M8-2①: 工作项失败 → `work_item_failed` payload 带 reason（= 触发事件名）', async () => {
  const { db, taskId } = fresh();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted')); // L0 → ready → 自动 executing + dispatch
    assert.equal(getWorkItem(db, wi.id)?.state, 'running');

    // 会话结束但未提交结果 → B2-3/D-30② 单件重派（attempt+1，running）；work_item_failed 事件留痕
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'agent_settled', actor: 'employee:1' });
    assert.equal(getWorkItem(db, wi.id)?.state, 'running', '业务失败 → 单件重派（D-30②）');
    assert.equal(getWorkItem(db, wi.id)?.attempt, 1);
    const failed = listTaskEvents(db, taskId).filter((e) => e.kind === 'work_item_failed');
    assert.equal(failed.length, 1);
    assert.equal((JSON.parse(failed[0]!.payload) as { reason: string }).reason, 'agent_settled');
  } finally {
    db.close();
  }
});

test('OPT-M8-2①: 崩潰恢复 → `work_item_interrupted` payload 带 reason=restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-failtrace-'));
  const db = openDatabase(join(dir, 'aico.db'));
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1','standard',1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    updateWorkItem(db, wi.id, { state: 'running', started_at: 1 });

    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100 });
    const report = await engine.recover();
    assert.equal(report.interrupted, 1);
    const ints = listTaskEvents(db, task.id).filter((e) => e.kind === 'work_item_interrupted');
    assert.equal(ints.length, 1);
    assert.equal((JSON.parse(ints[0]!.payload) as { reason: string }).reason, 'restart');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
