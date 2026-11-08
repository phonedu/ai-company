/**
 * wave 2 数据写入面（1658）：D4 `task_deps` 写入 / C6·D5 `deadline` 写入 / B3 `budget_exceeded` 触发链。
 * 每条都有"能被弄红"的断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  addTaskDependency,
  createTask,
  getTaskById,
  listCosts,
  listTaskDependencies,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  setTaskDeadline,
  toTaskSnapshot,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function fresh(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  return { db, projectId };
}

const mk = (db: SqliteDb, projectId: number, title: string, extra: Record<string, unknown> = {}) =>
  createTask(db, new SqliteCounterStore(db), { projectId, title, goal: 'g', ...extra }).id;

const ev = (taskId: number, event: string, payload?: Record<string, unknown>) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss', payload });

async function drive(engine: Engine, taskId: number, events: string[]): Promise<void> {
  for (const e of events) await engine.dispatch(ev(taskId, e));
}

const TO_DONE = ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved', 'all_work_items_done'];

test('D4: task_deps 写入面 → 阻塞任务依赖满足后自动激活（此前无写入者、路径不可达）', async () => {
  const { db, projectId } = fresh();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const a = mk(db, projectId, 'A');
    await drive(engine, a, TO_DONE); // A → executing → verifying
    await engine.dispatch(ev(a, 'verification_completed', { verdict: 'pass' }));
    // B2-6/D-30③：L1+ pass 现迁 needs_decision（签收卡）——补老板签收步
    if ((getTaskById(db, a) as { state: string }).state === 'needs_decision') {
      await engine.dispatch(ev(a, 'signoff', { via: 'b26-regression' }));
    }
    assert.equal(getTaskById(db, a)?.state, 'done');

    const b = mk(db, projectId, 'B');
    db.prepare("UPDATE tasks SET state = 'blocked' WHERE id = ?").run(b);
    assert.equal(addTaskDependency(db, b, a), true, '首次写入应新增');
    assert.equal(addTaskDependency(db, b, a), false, '重复写入应幂等');
    assert.deepEqual(listTaskDependencies(db, b), [a]);

    // 依赖全部满足 → 激活；用 0 槽位观察 ready（不自动起跑）
    const activator = new Engine(db, makeRecordingExecutor(), { scheduler: { maxActiveTasks: 0 }, now: () => 1_000 });
    await activator.tick();
    assert.equal(getTaskById(db, b)?.state, 'ready', '依赖满足后应 task_activated → ready');
    assert.ok(listTaskEvents(db, b).some((e) => e.kind === 'task_activated'));
  } finally {
    db.close();
  }
});

test('C6·D5: deadline 写入点 + 调度次级排序键生效（同优先级取更早截止）', async () => {
  const { db, projectId } = fresh();
  try {
    const t1 = mk(db, projectId, 'T1', { deadline: 2_000 });
    const t2 = mk(db, projectId, 'T2', { deadline: 1_000 });
    assert.equal(toTaskSnapshot(getTaskById(db, t1)!).deadline, 2_000, 'deadline 应被写入并可被调度器读到');

    // 用 autoSchedule:false 把两个任务都推到 ready（不自动占槽）
    const driver = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1_000 });
    await drive(driver, t1, ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved']);
    await drive(driver, t2, ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved']);
    assert.equal(getTaskById(db, t1)?.state, 'ready');
    assert.equal(getTaskById(db, t2)?.state, 'ready');

    // 单槽位：应取 deadline 更早的 T2
    const scheduler = new Engine(db, makeRecordingExecutor(), { scheduler: { maxActiveTasks: 1 }, now: () => 1_000 });
    await scheduler.tick();
    assert.equal(getTaskById(db, t2)?.state, 'executing', '更早 deadline 的任务应先占槽');
    assert.equal(getTaskById(db, t1)?.state, 'ready');

    setTaskDeadline(db, t1, 500, 1_000); // 写入点：改期
    assert.equal(toTaskSnapshot(getTaskById(db, t1)!).deadline, 500);
  } finally {
    db.close();
  }
});

test('B3: 成本写入触发点 → 预算超限发 budget_exceeded+task_paused（此前 costs 无写入者）', async () => {
  const { db, projectId } = fresh();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    // RW-27（老板裁 A）后：预算低于最小规划额度会在**规划前**被拦（needs_decision＋预算不足卡），
    // 走不到 executing——本用例验的是「执行期成本写入触发超预算暂停」，故预算给足够规划额度，
    // 超支由 recordCost 制造。
    const t = mk(db, projectId, 'T', { budgetTokens: 10_000 });
    await drive(engine, t, ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved']); // → executing
    assert.equal(getTaskById(db, t)?.state, 'executing');

    const r = await engine.recordCost({ taskId: t, model: 'deepseek-flash', tokensIn: 12_000, tokensOut: 0, now: 2_000 });
    assert.equal(r.costTotal, 12_000);
    assert.equal(r.budgetExceeded, true);
    assert.equal(getTaskById(db, t)?.state, 'paused', '超预算应暂停本任务');
    const kinds = listTaskEvents(db, t).map((e) => e.kind);
    assert.ok(kinds.includes('cost_recorded'));
    assert.ok(kinds.includes('budget_exceeded'));
    assert.ok(kinds.includes('task_paused'));
    assert.equal(listCosts(db, t).length, 1, 'costs 应有 1 行（此前无写入触发点）');

    // 未超预算的任务不受影响
    const t2 = mk(db, projectId, 'T2', { budgetTokens: 10_000 });
    await drive(engine, t2, ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved']);
    const r2 = await engine.recordCost({ taskId: t2, model: 'm', tokensIn: 10, tokensOut: 5, now: 3_000 });
    assert.equal(r2.budgetExceeded, false);
    assert.equal(getTaskById(db, t2)?.state, 'executing', '未超预算不得暂停');
  } finally {
    db.close();
  }
});
