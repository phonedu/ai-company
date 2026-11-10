/**
 * 评审/验证结论上屏 + 手动打回批注进返工项。
 *
 * 断言：
 *  ① `task:get.reviews` 同时带 critic/verifier 结论与批注，`reports.verdict` 优先；
 *  ② `inbox:list` 的 ReportDTO 暴露 `verdict` / `verifierEmployeeId`（不再只有 payload）；
 *  ③ 手动打回不带 workItemId 时，服务端补最近 submitted 件；notes 真进返工项 brief。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertReport,
  insertTaskEvent,
  insertWorkItem,
  listTaskEvents,
  listWorkItemsByTask,
  openMemoryDatabase,
  runMigrations,
  setReportVerdict,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleInboxList, handleTaskGet, handleTaskTransition, type IpcDeps } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(9,'验证者','reviewer',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  return { db, deps: { repo, engine }, projectId };
}

test('GAP12: task:get.reviews 同时上屏 critic/verifier 结论；reports.verdict 优先；验证件 id 可定位证据', () => {
  const { db, deps, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '结论上屏',
      goal: 'g',
      riskLevel: 1,
    });
    const wi = insertWorkItem(db, {
      taskId: task.id,
      employeeId: 0,
      title: '实现',
      brief: '实现按钮',
      actor: 'system',
      now: AT,
    });
    db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(wi.id);
    const report = insertReport(db, {
      taskId: task.id,
      kind: 'report',
      payload: { role: 'verifier', verdict: 'fail', notes: '事件里的批注' },
      now: AT + 2,
    });
    setReportVerdict(db, report.id, 'fail', 9);
    insertTaskEvent(db, {
      taskId: task.id,
      ts: AT + 1,
      kind: 'plan_reviewed',
      actor: 'employee:2',
      payload: { role: 'critic', verdict: 'revise', notes: '第一步太笼统' },
    });
    insertTaskEvent(db, {
      taskId: task.id,
      ts: AT + 2,
      kind: 'verification_completed',
      actor: 'employee:9',
      payload: {
        role: 'verifier',
        verdict: 'reject',
        notes: '按钮文案应为「对账单」',
        workItemId: wi.id,
        reportId: report.id,
      },
    });
    // 同一 critic 打回还会落一条无 verdict 的 plan_reviewed（revise 迁移）——不得上屏成第二条结论。
    insertTaskEvent(db, {
      taskId: task.id,
      ts: AT + 3,
      kind: 'plan_reviewed',
      actor: 'employee:2',
      payload: { role: 'critic', notes: '第一步太笼统' },
    });

    const detail = handleTaskGet(deps, { taskId: task.id });
    assert.ok(detail);
    assert.equal(detail.reviews.length, 2, 'critic + verifier 各一条（无 verdict 的迁移行不重复上屏）');
    assert.deepEqual(
      detail.reviews.map((r) => [r.stage, r.verdict, r.notes]),
      [
        ['plan', 'revise', '第一步太笼统'],
        ['verification', 'fail', '按钮文案应为「对账单」'],
      ],
      'verifier 结论取 reports.verdict（fail）而非事件里的 reject',
    );
    assert.equal(detail.reviews[1]!.verifierEmployeeId, 9);
    assert.equal(detail.verificationWorkItemId, wi.id, '验证中可定位最近 submitted 件');

    const cards = handleInboxList(deps, {});
    const card = cards.find((c) => c.id === report.id);
    assert.equal(card?.verdict, 'fail', 'inbox DTO 必须暴露 reports.verdict');
    assert.equal(card?.verifierEmployeeId, 9);
  } finally {
    db.close();
  }
});

test('GAP12: 手动打回未带 workItemId → 服务端补最近 submitted 件；批注进返工项 brief', async () => {
  const { db, deps, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '手动打回',
      goal: 'g',
      riskLevel: 1,
    });
    db.prepare("UPDATE tasks SET state='verifying' WHERE id=?").run(task.id);
    const wi = insertWorkItem(db, {
      taskId: task.id,
      employeeId: 0,
      title: '实现',
      brief: '实现按钮',
      actor: 'system',
      now: AT,
    });
    db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(wi.id);

    const result = await handleTaskTransition(deps, {
      taskId: task.id,
      event: 'verification_completed',
      payload: { verdict: 'fail', notes: '按钮文案应为「对账单」；补一条回归测试' },
    });
    assert.equal(result.ok, true);
    assert.equal(deps.repo.getTask(task.id)?.state, 'executing', '打回回到执行中');

    const items = listWorkItemsByTask(db, task.id);
    assert.equal(items.length, 2, '生成一个返工项');
    const rework = items.find((item) => item.id !== wi.id);
    assert.ok(rework);
    assert.match(rework.brief, /按钮文案应为「对账单」；补一条回归测试/, '批注真进返工 brief');
    assert.match(rework.title, /返工：实现/, '返工项标题带来源');
    assert.equal(rework.employee_id, 0, '返工派回原实现者');

    const last = listTaskEvents(db, task.id).filter((e) => e.kind === 'verification_completed').at(-1);
    const payload = JSON.parse(last?.payload ?? '{}') as { workItemId?: number; notes?: string };
    assert.equal(payload.workItemId, wi.id, '服务端把来源件 id 补进事件（可审计）');
    assert.match(payload.notes ?? '', /对账单/);
  } finally {
    db.close();
  }
});
