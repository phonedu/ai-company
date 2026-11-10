/**
 * 公司级日预算（可选，默认关）——达线暂停 executing 任务、提示去重、
 * 重启后按真库支出继续生效、未设预算不产生假读数；新派发在超线时 hold。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SqliteCounterStore,
  createTask,
  insertEmployee,
  insertWorkItem,
  openMemoryDatabase,
  readSetting,
  runMigrations,
  writeSetting,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

const AT = new Date(2026, 9, 19, 12, 0, 0).getTime(); // 本地正午，跨日窗口稳定

function setup(): { db: SqliteDb; projectId: number; employeeId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 1, name: '实施', role: 'engineer', now: AT });
  const projectId = Number(
    db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?)').run('P', 'D:/tmp/p', AT).lastInsertRowid,
  );
  return { db, projectId, employeeId: 1 };
}

function executingTask(db: SqliteDb, projectId: number, title: string): number {
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title,
    goal: 'g',
    state: 'executing',
    now: AT,
  });
  return task.id;
}

test('C4：未设预算 → 不暂停/不假读数；设预算达线 → 暂停所有 executing＋按天提示（dedupe）', async () => {
  const { db, projectId } = setup();
  try {
    const t1 = executingTask(db, projectId, 'A');
    const t2 = executingTask(db, projectId, 'B');
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
    assert.equal(engine.companyDailyBudgetState().budgetUsd, null);
    assert.equal(readSetting(db, 'budget.companyDailyUsd'), undefined);

    writeSetting(db, 'budget.companyDailyUsd', 1);
    await engine.recordCost({ taskId: t1, model: 'm', usd: 0.4, now: AT });
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(t1) as { state: string }).state, 'executing');
    await engine.recordCost({ taskId: t2, model: 'm', usd: 0.7, now: AT }); // 累计 1.1 ≥ 1
    for (const id of [t1, t2]) {
      assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(id) as { state: string }).state, 'paused');
    }
    assert.ok(
      (db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='budget_exceeded' AND task_id IN (?,?)").get(t1, t2) as { n: number }).n >= 2,
    );
    const notes = db
      .prepare("SELECT dedupe_key FROM notifications WHERE dedupe_key LIKE 'budget:company-daily:%'")
      .all() as Array<{ dedupe_key: string }>;
    assert.equal(notes.length, 1, '公司级提示按天 dedupe');
    // 反复结算不重复提示
    await engine.recordCost({ taskId: t1, model: 'm', usd: 0.1, now: AT + 1 });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE 'budget:company-daily:%'").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
});

test('C4：重启保留（预算在 settings、支出在 costs；新引擎 tick 继续暂停）', async () => {
  const { db, projectId } = setup();
  try {
    const t = executingTask(db, projectId, 'A');
    writeSetting(db, 'budget.companyDailyUsd', 1);
    db.prepare("INSERT INTO costs(task_id, model, usd, created_at) VALUES(?, 'm', 2, ?)").run(t, AT);
    // 模拟重启：新引擎无内存状态，只读真库
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT + 10 });
    assert.equal(engine.companyDailyBudgetState().over, true);
    await engine.tick();
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(t) as { state: string }).state, 'paused');
  } finally {
    db.close();
  }
});

test('C4：超线时新派发 hold（reason=budget，带真读数）；ready 任务不会被派工', async () => {
  const { db, projectId, employeeId } = setup();
  try {
    const t = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '排队任务',
      goal: 'g',
      state: 'ready',
      now: AT,
    });
    const wi = insertWorkItem(db, { taskId: t.id, employeeId, title: 'w', brief: 'b', now: AT });
    writeSetting(db, 'budget.companyDailyUsd', 1);
    db.prepare("INSERT INTO costs(task_id, model, usd, created_at) VALUES(?, 'm', 2, ?)").run(t.id, AT);
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT + 1 });
    await engine.tick();
    const holds = engine.listDispatchHolds();
    const hold = holds.find((h) => h.workItemId === wi.id);
    assert.ok(hold, JSON.stringify(holds));
    assert.equal(hold!.reason, 'budget');
    assert.match(hold!.detail ?? '', /公司日预算已用尽/);
    assert.equal((db.prepare('SELECT state FROM work_items WHERE id=?').get(wi.id) as { state: string }).state, 'queued');
  } finally {
    db.close();
  }
});
