/**
 * （ADV-1 P0-9）：inplace 项目路径并发保护恒失效的回归测试。
 *
 * 旧实现：`spawnPlanWorkItems` 产**纯文本** brief → `parseTouchedPaths` 返回 [] ⇒ 所有件的
 * claim.paths=[] ⇒ `pathConflictWith` 恒不相交 ⇒ inplace（共享工作树）下两个任务可同时改同一文件。
 * `setWorkItemTouchedPaths` 早已存在，但无接线点。
 *
 * 新口径：inplace 项目派生的第一版工作项**整体认领项目根**（`touchedPaths:['.']`，'.'＝整棵树）；
 * 同一项目内两个 inplace 件因此串行（hold 原因 path_conflict）。staging 有独占 worktree，brief 保持纯文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listWorkItemsByTask,
  openMemoryDatabase,
  parseTouchedPaths,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor, pathsIntersect } from '../src/main/engine/index.js';
import { listRunningPathClaims } from '../src/main/db/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';

function setup(accessMode: 'inplace' | 'staging', employees = 2): { db: SqliteDb; projectId: number; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db
      .prepare('INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES(?,?,?,1)')
      .run('P', `D:/repo-${accessMode}`, accessMode).lastInsertRowid,
  );
  for (let i = 1; i <= employees; i += 1) {
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?,'standard',1)").run(`E${i}`);
  }
  // riskLevel 1：走「审计划」路径（plan_drafted→awaiting_approval→plan_reviewed→plan_approved）；
  // L0 会在 plan_drafted 直接 executing，后续 plan_reviewed 成为非法迁移。
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1 });
  return { db, projectId, taskId: task.id };
}

const taskEvent = (taskId: number, event: string): EngineEvent => ({ scope: 'task', id: taskId, event, actor: 'boss' });
async function driveToExecuting(engine: Engine, taskId: number): Promise<void> {
  await engine.dispatch(taskEvent(taskId, 'triage'));
  await engine.dispatch(taskEvent(taskId, 'plan_drafted'));
  await engine.dispatch(taskEvent(taskId, 'plan_reviewed'));
  await engine.dispatch(taskEvent(taskId, 'plan_approved'));
}

test('B2-4/D-30：inplace 预言退役为提示——brief 不再带整树认领；实测认领由引擎登记', async () => {
  const { db, projectId, taskId } = setup('inplace');
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    await driveToExecuting(engine, taskId);
    const wi = db.prepare("SELECT * FROM work_items WHERE task_id = ?").get(taskId) as { id: number; brief: string };
    assert.ok(wi, 'inplace 首件已派生');
    // brief 纯文本（预言退役）＋提示在场；认领为空（不凭空拦）
    assert.ok(!wi.brief.trimStart().startsWith('{'), 'brief 不再是 JSON 认领载体');
    assert.match(wi.brief, /实测/, 'brief 保留「路径按实测」提示');
    assert.deepEqual(parseTouchedPaths(wi.brief) ?? [], [], '无预言认领');
    // 实测登记 → 认领生效（listRunningPathClaims 可见）
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wi.id);
    engine.recordWorkItemTouchedPaths(wi.id, ['src/a.ts']);
    const claims = listRunningPathClaims(db).filter((c) => c.workItemId === wi.id);
    assert.ok(claims[0]?.paths.includes('src/a.ts'), '实测认领在 running 集合可见');
    void projectId;
  } finally {
    db.close();
  }
});

test('B0-7：staging 保持纯文本 brief（独占 worktree，不认领）', async () => {
  const { db, taskId } = setup('staging');
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    await driveToExecuting(engine, taskId);
    const items = listWorkItemsByTask(db, taskId);
    assert.equal(items.length, 1);
    assert.deepEqual(parseTouchedPaths(items[0]!.brief), [], 'staging 走 worktree 隔离，不靠路径认领');
    assert.match(items[0]!.brief, /执行要求/, '纯文本 brief 仍保留原文');
  } finally {
    db.close();
  }
});

test('B0-7：同项目两个 inplace 任务 → 第二个因 path_conflict 排队（不再并行改同一工作树）', async () => {
  const { db, projectId } = setup('inplace');
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    const a = createTask(db, new SqliteCounterStore(db), { projectId, title: 'A', goal: 'g', riskLevel: 1 });
    const b = createTask(db, new SqliteCounterStore(db), { projectId, title: 'B', goal: 'g', riskLevel: 1 });
    // 预置工作项（派给不同员工）：让「路径冲突」成为唯一可拦的原因（员工忙会先拦住，掩盖判定）。
    const wa = insertWorkItem(db, {
      taskId: a.id,
      employeeId: 1,
      title: 'A1',
      brief: JSON.stringify({ text: '做 A', touchedPaths: ['.'] }),
      now: 1,
    });
    const wb = insertWorkItem(db, {
      taskId: b.id,
      employeeId: 2,
      title: 'B1',
      brief: JSON.stringify({ text: '做 B', touchedPaths: ['.'] }),
      now: 1,
    });
    await driveToExecuting(engine, a.id);
    await driveToExecuting(engine, b.id);
    assert.equal((db.prepare('SELECT state FROM work_items WHERE id=?').get(wa.id) as { state: string }).state, 'running');
    const hold = engine.dispatchHold(wb.id);
    assert.equal(hold?.reason, 'path_conflict', `第二个 inplace 件必须排队（实际：${JSON.stringify(hold)}）`);
  } finally {
    db.close();
  }
});

test('B0-7：认领整棵树与任何路径都相交（不同 root 除外）', () => {
  assert.equal(pathsIntersect(['.'], ['src/a.ts']), true);
  assert.equal(pathsIntersect(['.'], ['docs']), true);
  assert.equal(pathsIntersect(['src'], ['src/a.ts']), true);
  assert.equal(pathsIntersect(['src'], ['docs']), false);
});
