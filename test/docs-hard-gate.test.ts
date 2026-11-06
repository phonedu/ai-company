/**
 * M3 联动修复 P1：挂了 `acceptance[].check` 的任务必须走 verifier（DOC-4 硬门），
 * 不能被 L1 抽验（未命中）绕过成自动 pass。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';

test('L1 未抽验 + 机器检查 → all_work_items_done.verificationNeeded=true', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1','standard',1)").run();
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','C:/p',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: 'L1 check',
      goal: 'g',
      riskLevel: 1,
      acceptance: [{ text: '文档检查', check: 'node -e "process.exit(0)"' }],
      now: 1,
    });
    // 工作项 id=1：L1 抽验规则（每 3 个抽 1 个）下未命中 ⇒ 旧逻辑会免验自动 pass。
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    assert.equal(wi.id % 3, 1);
    const events: EngineEvent[] = [];
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000, onEvent: (e) => events.push(e) });
    const ev = (event: string) => ({ scope: 'task' as const, id: task.id, event, actor: 'boss' });
    await engine.dispatch(ev('triage'));
    await engine.dispatch(ev('plan_drafted'));
    await engine.dispatch(ev('plan_reviewed'));
    await engine.dispatch(ev('plan_approved'));
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'submit_work_item', actor: 'employee:1', payload: { result: { ok: true } } });

    const aggregate = events.find((e) => e.event === 'all_work_items_done');
    assert.ok(aggregate, '应发出聚合事件');
    assert.equal((aggregate.payload as { verificationNeeded?: boolean }).verificationNeeded, true, '机器检查强制 verifier');
  } finally {
    db.close();
  }
});
