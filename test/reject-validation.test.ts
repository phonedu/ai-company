/**
 * M3 联动修复 P1：打回必须带批注；没有可返工件时显式拒（不能落到 executing 空转）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations, updateWorkItem } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskTransition, type IpcDeps } from '../src/main/ipc/ipc.js';
import type { EngineEvent } from '../src/main/engine/types.js';

function setup(withSubmitted: boolean) {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(1, 'E', 'standard', 1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','C:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
  db.prepare("UPDATE tasks SET state='verifying' WHERE id=?").run(task.id);
  if (withSubmitted) updateWorkItem(db, wi.id, { state: 'submitted' });
  const dispatched: EngineEvent[] = [];
  const deps: IpcDeps = {
    repo: createSqliteChatRepo(db),
    db,
    engine: { dispatch: async (event) => void dispatched.push(event) },
  };
  return { db, task, wi, deps, dispatched };
}

test('打回无批注 → bad_request，不派事件', async () => {
  const { db, task, deps, dispatched } = setup(true);
  try {
    const res = await handleTaskTransition(deps, {
      taskId: task.id,
      event: 'verification_completed',
      payload: { verdict: 'fail' },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'bad_request');
    assert.equal(dispatched.length, 0);
  } finally {
    db.close();
  }
});

test('有批注 + submitted 件 → 放行并补 workItemId', async () => {
  const { db, task, wi, deps, dispatched } = setup(true);
  try {
    const res = await handleTaskTransition(deps, {
      taskId: task.id,
      event: 'verification_completed',
      payload: { verdict: 'fail', notes: '这里不对' },
    });
    assert.equal(res.ok, true);
    assert.equal(dispatched.length, 1);
    assert.equal((dispatched[0]?.payload as { workItemId?: number }).workItemId, wi.id);
  } finally {
    db.close();
  }
});

test('无 submitted 件 → no_work_item（不空转 executing）', async () => {
  const { db, task, deps, dispatched } = setup(false);
  try {
    const res = await handleTaskTransition(deps, {
      taskId: task.id,
      event: 'verification_completed',
      payload: { verdict: 'fail', notes: '这里不对' },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'no_work_item');
    assert.equal(dispatched.length, 0);
  } finally {
    db.close();
  }
});
