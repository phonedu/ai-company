/**
 * OPT- · 独立验证：强制度分级（L0 免 / L1 抽验 / L2 强制）+ 实现者≠验证者 + 未验证不得 done。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertReport,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  assignWorkItemVerifier,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor, verificationStrength } from '../src/main/engine/index.js';

function fresh(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  for (const n of ['Impl', 'Verifier', 'Third']) {
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?, 'standard', 1)").run(n);
  }
  // 真实名册有幕僚长（id=0, is_assistant=1）；验证者选人必须排除它。
  db.prepare(
    "INSERT INTO employees(id, name, role, is_assistant, capability_tier, created_at) VALUES(0, '幕僚长', 'assistant', 1, 'standard', 1)",
  ).run();
  return { db, projectId };
}

const mkTask = (db: SqliteDb, projectId: number, riskLevel: number) =>
  createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel }).id;

const ev = (taskId: number, event: string, payload?: Record<string, unknown>) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss', payload });

async function toExecuting(engine: Engine, taskId: number, riskLevel: number): Promise<void> {
  await engine.dispatch(ev(taskId, 'triage'));
  await engine.dispatch(ev(taskId, 'plan_drafted'));
  if (riskLevel >= 1) {
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));
  }
  // L0：plan_drafted 直接到 ready，fixpoint 自动 start_task → executing
}

test('OPT-M3-1: 强制度分级（纯函数）—— L0 免 / L1 抽验 / L2 强制', () => {
  assert.equal(verificationStrength(0, 5), 'none', 'L0 免');
  assert.equal(verificationStrength(2, 5), 'required', 'L2 强制');
  assert.equal(verificationStrength(1, 3, 3), 'sampled', 'L1 命中抽验');
  assert.equal(verificationStrength(1, 4, 3), 'none', 'L1 未命中');
});

test('OPT-M3-1: L2 未指派验证者 → 不得 done；指派 verifier≠实现者后 → done；verdict 落 reports', async () => {
  const { db, projectId } = fresh();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const taskId = mkTask(db, projectId, 2);
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'impl', brief: 'b', now: 1 });
    await toExecuting(engine, taskId, 2);
    assert.equal(getWorkItem(db, wi.id)?.state, 'running');

    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'submit_work_item', actor: 'employee:1', payload: { result: { ok: true } } });
    // D3（链路审计）后：**派工时引擎会按强度自动指派 verifier**（requestReview 已接线）——
    // 本测要看的是"未指派/不合规 verifier 时不得 done"的守卫，故显式清掉以复现旁路现场。
    db.prepare('UPDATE work_items SET verifier_employee_id = NULL WHERE id = ?').run(wi.id);
    // 未验证 → 拒绝
    await assert.rejects(
      () => engine.dispatch({ scope: 'work_item', id: wi.id, event: 'review_accept', actor: 'verifier' }),
      /未验证不得 done/,
    );
    assert.equal(getWorkItem(db, wi.id)?.state, 'submitted');

    // 指派验证者（默认≠实现者）
    const r = engine.requestReview(wi.id);
    assert.equal(r.strength, 'required');
    assert.equal(r.verifierEmployeeId, 2);
    assert.equal(getWorkItem(db, wi.id)?.verifier_employee_id, 2);
    assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'review_requested'));

    // 现在可 accept → done
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'review_accept', actor: 'employee:2' });
    assert.equal(getWorkItem(db, wi.id)?.state, 'done');

    // verdict 落 reports + review_completed 事件
    const report = insertReport(db, { taskId, kind: 'report', payload: {}, now: 2 });
    engine.recordVerdict({ taskId, reportId: report.id, workItemId: wi.id, verdict: 'pass', verifierEmployeeId: 2 });
    const rep = db.prepare('SELECT verdict, verifier_employee_id FROM reports WHERE id = ?').get(report.id) as {
      verdict: string;
      verifier_employee_id: number;
    };
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.verifier_employee_id, 2);
    assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'review_completed'));
  } finally {
    db.close();
  }
});

test('OPT-M3-1: 验证者不得与实现者同一人（应用层断言）', () => {
  const { db, projectId } = fresh();
  try {
    const taskId = mkTask(db, projectId, 2);
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'impl', brief: 'b', now: 1 });
    assert.throws(() => assignWorkItemVerifier(db, wi.id, 1), /不得与实现者同一人/);
    assert.equal(assignWorkItemVerifier(db, wi.id, 2).verifier_employee_id, 2);
  } finally {
    db.close();
  }
});

test('OPT-M3-1: 幕僚长只协调不验收——L2 无其他员工时留空，不回退给幕僚长', () => {
  const { db, projectId } = fresh();
  try {
    // 只剩幕僚长(0)＋实现者(1)：没有合格 verifier。
    db.prepare('UPDATE employees SET active = 0 WHERE id IN (2, 3)').run();
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const taskId = mkTask(db, projectId, 2);
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'impl', brief: 'b', now: 1 });

    const r = engine.requestReview(wi.id);
    assert.equal(r.strength, 'required');
    assert.equal(r.verifierEmployeeId, null, '幕僚长(is_assistant=1)不得被选为 verifier');
    assert.equal(getWorkItem(db, wi.id)?.verifier_employee_id, null, '不落任何 verifier，留给验证阶段升级');
    assert.equal(
      listTaskEvents(db, taskId).some((e) => e.kind === 'review_requested'),
      false,
      '没有合格验者就不发 review_requested（避免假验收）',
    );
  } finally {
    db.close();
  }
});

test('OPT-M3-1: L0 免验 → 提交即自动接受；review_reject → rejected → redispatch → running（reject 属需验件）', async () => {
  const { db, projectId } = fresh();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const taskId = mkTask(db, projectId, 0); // L0
    const wiA = insertWorkItem(db, { taskId, employeeId: 1, title: 'a', brief: 'b', now: 1 });
    await toExecuting(engine, taskId, 0);

    // L0：免验 → **提交即自动接受**（D3；不再手写 review_accept——写了会撞"已完成"的未定义迁移）
    await engine.dispatch({ scope: 'work_item', id: wiA.id, event: 'submit_work_item', actor: 'employee:1' });
    assert.equal(getWorkItem(db, wiA.id)?.state, 'done', 'D3：免验件提交即接受');

    // reject → rejected → redispatch → running：**reject 只对"需验件"可达**（后免验件不停在 submitted）
    // ⇒ 另起一个 L2 任务上的工作项来走这条路径。
    const taskId2 = mkTask(db, projectId, 2);
    const wiB = insertWorkItem(db, { taskId: taskId2, employeeId: 1, title: 'b', brief: 'b', now: 2 });
    await toExecuting(engine, taskId2, 2);
    await engine.dispatch({ scope: 'work_item', id: wiB.id, event: 'submit_work_item', actor: 'employee:1' });
    assert.equal(getWorkItem(db, wiB.id)?.state, 'submitted', 'L2：需验件停在 submitted（等验证）');
    await engine.dispatch({ scope: 'work_item', id: wiB.id, event: 'review_reject', actor: 'verifier' });
    assert.equal(getWorkItem(db, wiB.id)?.state, 'rejected');
    assert.ok(listTaskEvents(db, taskId2).some((e) => e.kind === 'work_item_rejected'));
    await engine.dispatch({ scope: 'work_item', id: wiB.id, event: 'redispatch', actor: 'system' });
    assert.equal(getWorkItem(db, wiB.id)?.state, 'running');
  } finally {
    db.close();
  }
});
