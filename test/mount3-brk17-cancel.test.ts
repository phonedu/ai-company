/**
 * BRK17（挂载 3 余·取消小步，裁决 `D-9`，2026-10-16）——任务级「取消」**真中止**全链守据。
 *
 * 口径（05 §3.1.1 executing.cancel：「中止会话、释放槽位；收尾卡」；本批兑现）：
 *  - 任务级取消 → **在跑的件真中断**（按真值表走 `pause_task`：`running → interrupted`）；
 *  - 已提交（`submitted`）的件不动（不再验证——收尾卡如实交代）；`queued` 件随终态不再派发；
 *  - 逐件回调 `onWorkItemInterrupted`（main 接线 → 真停员工会话 `AgentSession.abort()`）；
 *  - 收尾卡＝`kind:'report'` 且卡题「已取消：…」（**不是**谎报「完成」）。
 *
 * 真库（内存）＋真引擎（`handleTaskTransition` 走真 dispatch→drain→机器）；只断事实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { insertWorkItem, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { Engine } from '../src/main/engine/index.js';
import { handleTaskTransition } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import { roleSessionKeysForCancel } from '../src/main/agent/employee-runtime.js';

const AT = 1_800_000_000_000;
const noopExecutor = { execute: async (): Promise<void> => undefined };
type Db = ReturnType<typeof openMemoryDatabase>;

test('C2 卡面纪律：只有模型/凭据异常卡的 reason 进 summary；no_plan 决策卡不上屏代码词', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const repo = createSqliteChatRepo(db);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => AT });
    const task = repo.createTask({ title: 'no-plan-card', goal: 'g' });
    db.prepare("UPDATE tasks SET state='planning' WHERE id=?").run(task.id);
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'escalate',
      actor: 'system',
      payload: { role: 'planner', reason: 'no_plan' },
    });
    const card = repo.listReports({ taskId: task.id }).find((c) => c.kind === 'ask');
    assert.ok(card, '决策卡应在场');
    const payload = card.payload as { reason?: string; summary?: string; title?: string };
    assert.equal(payload.reason, 'no_plan');
    assert.equal(payload.summary, undefined, 'no_plan 是代码词，不得作 summary 上屏');
    assert.equal(String(payload.title).includes('no_plan'), false, '卡题也不得露代码词');
  } finally {
    db.close();
  }
});

test('C7：取消角色会话键必须带 verifier 的 wi（否则 abort 不会命中）', () => {
  const keys = roleSessionKeysForCancel({ taskId: 11, workItemIds: [7, 8] });
  assert.deepEqual(keys, [
    'role:planner:task:11',
    'role:critic:task:11',
    'role:verifier:task:11:wi:7',
    'role:verifier:task:11:wi:8',
  ]);
});

test('取消 executing：在跑件→interrupted＋事件；queued/submitted 不动；逐件回调；收尾卡「已取消」', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const repo = createSqliteChatRepo(db);
    const interruptedCalls: Array<{ workItemId: number; employeeId: number; taskId: number }> = [];
    const taskCancelledCalls: Array<{ taskId: number }> = [];
    const engine = new Engine(db, noopExecutor, {
      autoSchedule: false,
      now: () => AT,
      onWorkItemInterrupted: (info) => interruptedCalls.push(info),
      onTaskCancelled: (info) => taskCancelledCalls.push(info),
    });
    const deps: IpcDeps = { repo, engine };

    const task = repo.createTask({ title: '要取消的任务', goal: 'g' });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();

    const running = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '在跑件', brief: 'b', now: AT - 5000 });
    const queued = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '排队件', brief: 'b', now: AT - 4000 });
    const submitted = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '待验件', brief: 'b', now: AT - 3000 });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(running.id);
    db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(submitted.id);

    const res = await handleTaskTransition(deps, { taskId: task.id, event: 'cancel' });
    assert.deepEqual(res, { ok: true }, '执行中任务可取消（UI 解禁的前提）');

    const taskRow = db.prepare('SELECT state, closed_at FROM tasks WHERE id=?').get(task.id) as {
      state: string;
      closed_at: number | null;
    };
    assert.equal(taskRow.state, 'cancelled');
    assert.equal(taskRow.closed_at, AT, 'close 补丁写 closed_at');

    const wiState = (id: number): string =>
      (db.prepare('SELECT state FROM work_items WHERE id=?').get(id) as { state: string }).state;
    assert.equal(wiState(running.id), 'interrupted', '在跑的件真中断（running --pause_task--> interrupted）');
    assert.equal(wiState(queued.id), 'queued', '排队件不动（随终态不再派发）');
    assert.equal(wiState(submitted.id), 'submitted', '已提交的件不动（不再验证——收尾卡如实交代）');

    const wiEvent = db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE work_item_id=? AND kind='work_item_interrupted'")
      .get(running.id) as { n: number };
    assert.equal(wiEvent.n, 1, '中断审计事件落账');

    assert.deepEqual(
      interruptedCalls,
      [{ workItemId: running.id, employeeId: 7, taskId: task.id }],
      '逐件回调（main 接线 → 真停员工会话）；仅对在跑的件',
    );
    assert.deepEqual(taskCancelledCalls, [{ taskId: task.id }], '按任务回调一次（角色会话 planner/critic/verifier 的停靠此）');

    const cards = repo.listReports({ taskId: task.id });
    const closing = cards.find((c) => c.kind === 'report');
    assert.ok(closing, '收尾卡落库');
    assert.match(JSON.stringify(closing?.payload), /已取消/, '卡题「已取消：…」（不是谎报「完成」）');

    const again = await handleTaskTransition(deps, { taskId: task.id, event: 'cancel' });
    assert.equal(again.ok, false, '重复取消＝未知迁移 → 人话回执（不静默）');
    if (!again.ok) assert.equal(again.code, 'transition_failed');
  } finally {
    db.close();
  }
});

test('取消 verifying（余两态）：已提交的件不动＋verifier 会话停回调＋收尾卡「已取消」；重复取消拒', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const repo = createSqliteChatRepo(db);
    const taskCancelledCalls: number[] = [];
    const engine = new Engine(db, noopExecutor, {
      autoSchedule: false,
      now: () => AT,
      onTaskCancelled: ({ taskId }) => taskCancelledCalls.push(taskId),
    });
    const deps: IpcDeps = { repo, engine };

    const task = repo.createTask({ title: '验证中的任务', goal: 'g' });
    db.prepare("UPDATE tasks SET state='verifying' WHERE id=?").run(task.id);
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();
    const submitted = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '待验件', brief: 'b', now: AT - 3000 });
    db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(submitted.id);

    const res = await handleTaskTransition(deps, { taskId: task.id, event: 'cancel' });
    assert.deepEqual(res, { ok: true }, '验证中可取消（UI 解禁的前提）');
    const taskRow = db.prepare('SELECT state, closed_at FROM tasks WHERE id=?').get(task.id) as {
      state: string;
      closed_at: number | null;
    };
    assert.equal(taskRow.state, 'cancelled');
    assert.equal(taskRow.closed_at, AT);

    const wiState = (db.prepare('SELECT state FROM work_items WHERE id=?').get(submitted.id) as { state: string }).state;
    assert.equal(wiState, 'submitted', '已提交的件不动（不再验证——收尾卡如实交代）');
    assert.deepEqual(taskCancelledCalls, [task.id], 'verifier 角色会话的停靠本回调（main 按 `role:verifier:…` 真停）');

    const cards = repo.listReports({ taskId: task.id });
    assert.ok(
      cards.some((c) => c.kind === 'report' && JSON.stringify(c.payload).includes('已取消')),
      '收尾卡「已取消：…」落库',
    );

    const again = await handleTaskTransition(deps, { taskId: task.id, event: 'cancel' });
    assert.equal(again.ok, false, '重复取消＝未知迁移 → 人话回执（不静默）');
    if (!again.ok) assert.equal(again.code, 'transition_failed');
  } finally {
    db.close();
  }
});

test('取消快照：无在跑件也成立（queued 任务取消 → 无回调、无中断事件、收尾卡照发）', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const repo = createSqliteChatRepo(db);
    const interruptedCalls: number[] = [];
    const engine = new Engine(db, noopExecutor, {
      autoSchedule: false,
      now: () => AT,
      onWorkItemInterrupted: ({ workItemId }) => interruptedCalls.push(workItemId),
    });
    const deps: IpcDeps = { repo, engine };
    const task = repo.createTask({ title: '排队中的任务', goal: 'g' });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();
    insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '排队件', brief: 'b', now: AT - 1000 });

    const res = await handleTaskTransition(deps, { taskId: task.id, event: 'cancel' });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(interruptedCalls, [], '没有在跑的件 ⇒ 不回调（不臆造中止）');
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind='work_item_interrupted'")
      .get(task.id) as { n: number };
    assert.equal(n.n, 0);
    assert.ok(repo.listReports({ taskId: task.id }).some((c) => c.kind === 'report'), '收尾卡照发');
  } finally {
    db.close();
  }
});
