/**
 * N3 · 并发闸门（P20 任务内 / P22 公司级）＋ C2 公司级开销（迁移 `005`）。
 *
 * 判据（本文件头注即真源）：
 *  - **P20**：同一任务内**同时在跑**的 work item ≤ 上限（缺省 3；`tasks.max_parallel_work_items` 可按任务覆盖）；
 *  - **P22**：**公司级**同时在跑的 work item ≤ 上限（缺省 6）——「卡正在工作的数量，不卡人头」；
 *  - **幕僚长天然豁免**：它**不持 work item**（老板频道会话）⇒ 闸门天然不约束它，无需特判（口径断言见行）；
 *  - 达上限 ⇒ 新派发 `queued` ＋ 等待原因 `concurrency_limit`（**可见**）；**在跑任务不打断**；
 *  - **C2**：`recordCost({taskId:null})` ⇒ `costs` 行 `task_id IS NULL`（公司级），**不碰 `tasks.cost_tokens`、不写 `task_events`**；
 *    `summarizeCosts().companyUsd` 如实反映；**有牙**：把上限放宽 → 不再排队（证明判定承重）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { summarizeCosts } from '../src/main/db/costs.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function setup(employeeCount = 9): { db: SqliteDb; projectId: number; employeeIds: number[] } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  const employeeIds: number[] = [];
  for (let i = 1; i <= employeeCount; i += 1) {
    employeeIds.push(Number(db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?,'standard',1)").run(`E${i}`).lastInsertRowid));
  }
  return { db, projectId, employeeIds };
}
const taskEvent = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });
async function driveToExecuting(engine: Engine, taskId: number): Promise<void> {
  await engine.dispatch(taskEvent(taskId, 'triage'));
  await engine.dispatch(taskEvent(taskId, 'plan_drafted'));
  await engine.dispatch(taskEvent(taskId, 'plan_reviewed'));
  await engine.dispatch(taskEvent(taskId, 'plan_approved'));
}
const runningCount = (db: SqliteDb, taskId?: number): number =>
  (db
    .prepare("SELECT COUNT(*) AS n FROM work_items WHERE state='running'" + (taskId === undefined ? '' : ' AND task_id = ?'))
    .get(...(taskId === undefined ? [] : [taskId])) as { n: number }).n;

test('N3-P20：同一任务内并发 ≤3（第 4 件排队 + 原因可见）', async () => {
  const { db, projectId, employeeIds } = setup();
  try {
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    const wids = employeeIds.slice(0, 5).map((eid, i) => insertWorkItem(db, { taskId, employeeId: eid, title: `w${i}`, brief: 'b', now: i + 1 }).id);
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    await driveToExecuting(engine, taskId);

    assert.equal(runningCount(db, taskId), 3, '任务内同时在跑 = 上限 3（不卡人头：名册有 9 人）');
    const held = wids.filter((id) => engine.dispatchHold(id)?.reason === 'concurrency_limit');
    assert.equal(held.length, 2, '第 4/5 件应因 `concurrency_limit` 排队');
    assert.ok(held.every((id) => getWorkItem(db, id)?.state === 'queued'), '被拦的件保持 queued（在跑的不打断）');
    // R3-2：等待原因带**数字**（决策点直给；UI 不需要猜上限）
    assert.deepEqual(
      engine.dispatchHold(held[0]!)?.detail,
      '同任务并发已达上限 3',
      'R3-2：同任务并发 detail 必须含数字 3',
    );
    // R3-2：顶栏槽位真读数＝正在 executing 的任务数 / 上限
    assert.deepEqual(engine.schedulerSlots(), { running: 1, total: 3 }, 'R3-2：槽位读数（1 个 executing / 上限 3）');
  } finally {
    db.close();
  }
});

test('N3-P20 "有牙"：把任务内上限放宽到 99 → 5 件全跑（证明判定承重）', async () => {
  const { db, projectId, employeeIds } = setup();
  try {
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    employeeIds.slice(0, 5).forEach((eid, i) => insertWorkItem(db, { taskId, employeeId: eid, title: `w${i}`, brief: 'b', now: i + 1 }));
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000, concurrency: { maxPerTask: 99, maxCompany: 99 } });
    await driveToExecuting(engine, taskId);
    assert.equal(runningCount(db, taskId), 5, '上限放宽 ⇒ 全跑（判定真承重）');
  } finally {
    db.close();
  }
});

test('N3-P20：`tasks.max_parallel_work_items` 可按任务覆盖（1 ⇒ 只跑 1 件）', async () => {
  const { db, projectId, employeeIds } = setup();
  try {
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    db.prepare('UPDATE tasks SET max_parallel_work_items = 1 WHERE id = ?').run(taskId);
    employeeIds.slice(0, 3).forEach((eid, i) => insertWorkItem(db, { taskId, employeeId: eid, title: `w${i}`, brief: 'b', now: i + 1 }));
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    await driveToExecuting(engine, taskId);
    assert.equal(runningCount(db, taskId), 1, '列覆盖生效：任务内只跑 1 件');
  } finally {
    db.close();
  }
});

test('N3-P22：公司级并发 ≤6（跨任务合计；第 7 件起排队）', async () => {
  const { db, projectId, employeeIds } = setup();
  try {
    const taskIds = [0, 1, 2].map((i) => createTask(db, new SqliteCounterStore(db), { projectId, title: `T${i}`, goal: 'g' }).id);
    let e = 0;
    for (const t of taskIds) for (let i = 0; i < 3; i += 1) insertWorkItem(db, { taskId: t, employeeId: employeeIds[e++]!, title: `w`, brief: 'b', now: e });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });
    for (const t of taskIds) await driveToExecuting(engine, t);

    assert.equal(runningCount(db), 6, '公司级同时在跑 = 上限 6（3 任务 × 3 件 = 9 个尝试，闸门兜住）');
    assert.ok(engine.listDispatchHolds().some((h) => h.reason === 'concurrency_limit'), '被拦的件有可见等待原因');
    // R3-2：公司级 detail 同样带数字；槽位读数＝3 个 executing 任务
    const companyHold = engine.listDispatchHolds().find((h) => h.reason === 'concurrency_limit');
    assert.equal(companyHold?.detail, '公司级并发已达上限 6', 'R3-2：公司级并发 detail 必须含数字 6');
    assert.deepEqual(engine.schedulerSlots(), { running: 3, total: 3 }, 'R3-2：槽位读数（3 个 executing / 上限 3）');
  } finally {
    db.close();
  }
});

test('N3-C2：公司级开销可记账（task_id NULL；不碰 cost_tokens／不写事件；汇总单列 companyUsd）', async () => {
  const { db, projectId, employeeIds } = setup();
  try {
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000 });

    const r = await engine.recordCost({ taskId: null, employeeId: employeeIds[0]!, model: 'm', tokensIn: 10, tokensOut: 5, usd: 0.02, now: 1000 });
    assert.deepEqual(r, { costTotal: null, budgetExceeded: false }, '公司级无任务可回写 ⇒ costTotal=null（不假报 0）');

    const row = db.prepare('SELECT task_id, usd FROM costs ORDER BY id DESC LIMIT 1').get() as { task_id: number | null; usd: number };
    assert.equal(row.task_id, null, '公司级行 task_id 为空');
    assert.equal(row.usd, 0.02);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='cost_recorded'").get() as { n: number }).n,
      0,
      '公司级无 task_events 落点（没有任务可挂——如实如此）',
    );
    assert.equal((db.prepare('SELECT cost_tokens FROM tasks WHERE id = ?').get(taskId) as { cost_tokens: number }).cost_tokens, 0, '不碰任务预算口径');

    const s = summarizeCosts(db, { now: 1000 });
    assert.equal(s.companyUsd, 0.02, '汇总单列公司级');
    assert.equal(s.usd, 0.02, '总额含公司级（费率读数也应算上它）');
  } finally {
    db.close();
  }
});
