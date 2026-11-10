/**
 * 员工不可用 → 同角色/在职/未试过的改派；无候选才失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertTaskEvent,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createUnavailableExecutor } from '../src/main/agent/unavailable-executor.js';
import { createUnavailableReassigner } from '../src/main/agent/reassign.js';
import type { EngineEvent, PersistedAction } from '../src/main/engine/types.js';

const AT = 1_800_000_000_000;

function setup(): { db: ReturnType<typeof openMemoryDatabase>; taskId: number; workItemId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,active,capability_tier,created_at) VALUES(7,'实现者A','dev',1,'standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,active,capability_tier,created_at) VALUES(8,'实现者B','dev',1,'standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'BRK7',
    goal: 'g',
    riskLevel: 0,
    state: 'executing',
  });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '打工', brief: 'b', now: AT });
  // 初始持有人也算“试过”（真实链路由 work_item_created payload 记录；测试补同形事件）。
  insertTaskEvent(db, {
    taskId: task.id,
    workItemId: wi.id,
    ts: AT,
    kind: 'work_item_created',
    actor: 'system',
    payload: { employeeId: 7 },
  });
  db.prepare("UPDATE work_items SET state='running', started_at=? WHERE id=?").run(AT, wi.id);
  return { db, taskId: task.id, workItemId: wi.id };
}

test('改派：running → pause_task → reassign 到同角色在职 B；再试无候选 → false（不循环）', async () => {
  const f = setup();
  try {
    const engine = new Engine(f.db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
    const reassign = createUnavailableReassigner(f.db, (e) => engine.dispatch(e));
    const ok = await reassign({ workItemId: f.workItemId, taskId: f.taskId, reason: 'no_credential' });
    assert.equal(ok, true, '有同角色候选应改派');
    const wi = getWorkItem(f.db, f.workItemId);
    assert.equal(wi?.state, 'queued', '改派后回 queued 等调度（不能留 running）');
    assert.equal(wi?.employee_id, 8, '换到同角色在职员工 B');
    assert.equal(wi?.attempt, 1, 'after 递增（新 dispatch 幂等键）');

    const again = await reassign({ workItemId: f.workItemId, taskId: f.taskId, reason: 'no_credential' });
    assert.equal(again, false, 'A/B 都试过 → 不再改派（由调用方落 error/异常卡）');
    assert.equal(getWorkItem(f.db, f.workItemId)?.employee_id, 8);
  } finally {
    f.db.close();
  }
});

test('不可用执行器：回调已改派 → 不再派 error；回调拒绝 → 保持 error 可见', async () => {
  const handledEvents: EngineEvent[] = [];
  let calls = 0;
  const handled = createUnavailableExecutor({
    dispatch: (e) => void handledEvents.push(e),
    log: () => undefined,
    onWorkItemUnavailable: () => {
      calls += 1;
      return true;
    },
  });
  await handled.execute({
    kind: 'dispatch',
    actionKey: 'dispatch:work_item:5:0',
    taskId: 1,
  } as unknown as PersistedAction);
  assert.equal(calls, 1);
  assert.equal(handledEvents.length, 0, '已改派就不得再落 error');

  const errorEvents: EngineEvent[] = [];
  const unhandled = createUnavailableExecutor({
    dispatch: (e) => void errorEvents.push(e),
    log: () => undefined,
    onWorkItemUnavailable: () => false,
  });
  await unhandled.execute({
    kind: 'dispatch',
    actionKey: 'dispatch:work_item:6:0',
    taskId: 1,
  } as unknown as PersistedAction);
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0]?.event, 'error');
  assert.equal(errorEvents[0]?.scope, 'work_item');
});
