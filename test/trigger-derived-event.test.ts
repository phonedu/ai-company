/**
 *  联动修复 P1：派生自动完成事件必须到达 config.onEvent（trigger service 的入口）。
 * 旧实现只在 enqueue 时调 onEvent；L0/未抽验 L1 的 `verification_completed` 是派生事件，
 * trigger 永远看不到 ⇒「当 T1 完成」不触发。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';

test('L0 自动完成：派生 verification_completed 经 config.onEvent 发布', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1','standard',1)").run();
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','C:/p',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: 'L0',
      goal: 'g',
      riskLevel: 0,
      now: 1,
    });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    const events: EngineEvent[] = [];
    const engine = new Engine(db, makeRecordingExecutor(), {
      now: () => 1_000,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const ev = (event: string) => ({ scope: 'task' as const, id: task.id, event, actor: 'boss' });
    // L0 直通：plan_drafted 后自动 ready→executing（没有人工评审/批准）。
    await engine.dispatch(ev('triage'));
    await engine.dispatch(ev('plan_drafted'));
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'submit_work_item', actor: 'employee:1', payload: { result: { ok: true } } });

    const autoPass = events.find(
      (e) => e.event === 'verification_completed' && (e.payload as { via?: string } | undefined)?.via === 'no_verification_required',
    );
    assert.ok(autoPass, '派生自动完成事件必须出现在 onEvent（否则 trigger 链断）');
  } finally {
    db.close();
  }
});
