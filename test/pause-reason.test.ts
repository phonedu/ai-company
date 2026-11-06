/**
 * M3 联动修复 P1：`paused` 来源落库（manual / task_budget / company_budget）。
 * 加预算只自动恢复 task_budget；手动/公司预算必须显式「继续」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteCounterStore, createTask, getTaskById, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','C:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
  const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000, autoSchedule: false });
  return { db, task, engine };
}

async function transition(engine: Engine, db: ReturnType<typeof setup>['db'], taskId: number, event: string, payload?: Record<string, unknown>) {
  db.prepare("UPDATE tasks SET state = 'executing' WHERE id = ?").run(taskId);
  await engine.dispatch({ scope: 'task', id: taskId, event, actor: 'system', ...(payload ? { payload } : {}) });
}

test('pause → manual；resume 清空', async () => {
  const { db, task, engine } = setup();
  try {
    await transition(engine, db, task.id, 'pause');
    assert.equal(getTaskById(db, task.id)?.pause_reason, 'manual');
    await engine.dispatch({ scope: 'task', id: task.id, event: 'resume', actor: 'boss' });
    assert.equal(getTaskById(db, task.id)?.pause_reason, null);
  } finally {
    db.close();
  }
});

test('budget_exceeded → task_budget；company_daily_budget → company_budget', async () => {
  const { db, task, engine } = setup();
  try {
    await transition(engine, db, task.id, 'budget_exceeded');
    assert.equal(getTaskById(db, task.id)?.pause_reason, 'task_budget');
    await transition(engine, db, task.id, 'budget_exceeded', { reason: 'company_daily_budget' });
    assert.equal(getTaskById(db, task.id)?.pause_reason, 'company_budget');
  } finally {
    db.close();
  }
});
