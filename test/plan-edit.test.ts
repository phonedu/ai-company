/**
 * 批准前计划可编辑。
 *
 * 断言四层：
 *  ① 状态机：`awaiting_approval --plan_edited--> KEEP`（合法迁移，不越级）；
 *  ② 事件投影：`plan_edited.payload.steps[]` → `plan_steps` 全量替换（无重复行）；
 *  ③ 卡同步：待批卡 payload.planSteps 随编辑刷新，选项/题面不丢；
 *  ④ 真派工：`保存并批准` → 工作项 brief 带**改后**计划（不是旧计划）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getReport,
  latestPendingApproval,
  listPlanSteps,
  listTaskEvents,
  listWorkItemsByTask,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, TASK_TRANSITIONS, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskCreate, handleTaskEditPlan, type IpcDeps } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(0, '幕僚长', 'assistant', 1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  return { db, deps: { repo, engine }, projectId };
}

async function awaitingApproval(
  deps: IpcDeps,
  projectId: number,
  steps: string[],
): Promise<{ id: number; shortId: string | null }> {
  const created = await handleTaskCreate(deps, { projectId, goal: '验证计划编辑', riskLevel: 1 });
  await deps.engine!.dispatch({
    scope: 'task',
    id: created.id,
    event: 'plan_drafted',
    actor: 'employee:0',
    payload: { steps },
  });
  await deps.engine!.dispatch({
    scope: 'task',
    id: created.id,
    event: 'plan_reviewed',
    actor: 'employee:0',
    payload: { verdict: 'approve' },
  });
  assert.equal(deps.repo.getTask(created.id)?.state, 'awaiting_approval');
  return { id: created.id, shortId: created.shortId };
}

test('GAP8: plan_edited 是合法迁移（awaiting_approval → KEEP），不派会话/不建工作项', () => {
  const row = TASK_TRANSITIONS.find((r) => r.from === 'awaiting_approval' && r.event === 'plan_edited');
  assert.ok(row, '缺 awaiting_approval + plan_edited 迁移');
  assert.equal(row.to, 'KEEP');
  assert.deepEqual(row.kinds, ['plan_edited']);
  assert.equal(row.m0, true);
  assert.equal(row.actions, undefined);
});

test('GAP8: 编辑事件投影 plan_steps + 待批卡同步；选项不丢；重复编辑不叠行', async () => {
  const { db, deps, projectId } = setup();
  try {
    const task = await awaitingApproval(deps, projectId, ['读需求', '写实现', '跑验收']);
    const planBefore = latestPendingApproval(db, task.id);
    assert.ok(planBefore?.report_id, '批准卡必须回挂审批行');
    const cardBefore = JSON.parse(getReport(db, planBefore.report_id)!.payload) as {
      options?: Array<{ key: string }>;
      planSteps?: string[];
      question?: string;
    };
    assert.deepEqual(cardBefore.planSteps, ['读需求', '写实现', '跑验收']);
    assert.deepEqual(cardBefore.options?.map((o) => o.key), ['approve', 'revise']);

    const result = await handleTaskEditPlan(deps, { taskId: task.id, steps: ['读需求（改）', '写实现', '跑验收', '补回归'] }, AT + 10);
    assert.deepEqual(result, { ok: true, steps: ['读需求（改）', '写实现', '跑验收', '补回归'], approved: false });
    assert.equal(deps.repo.getTask(task.id)?.state, 'awaiting_approval', '编辑不推进状态');
    assert.deepEqual(
      listPlanSteps(db, task.id).map((s) => [s.idx, s.text, s.state]),
      [
        [1, '读需求（改）', 'pending'],
        [2, '写实现', 'pending'],
        [3, '跑验收', 'pending'],
        [4, '补回归', 'pending'],
      ],
      'plan_steps 全量替换（按新顺序、不重复）',
    );
    assert.equal(listTaskEvents(db, task.id).filter((e) => e.kind === 'plan_edited').length, 1);
    const cardAfter = JSON.parse(getReport(db, planBefore.report_id)!.payload) as typeof cardBefore;
    assert.deepEqual(cardAfter.planSteps, ['读需求（改）', '写实现', '跑验收', '补回归'], '待批卡反映新计划');
    assert.deepEqual(cardAfter.options?.map((o) => o.key), ['approve', 'revise'], '卡选项不丢');
    assert.equal(cardAfter.question, cardBefore.question, '题面不被覆盖');

    const again = await handleTaskEditPlan(deps, { taskId: task.id, steps: ['唯一一步'] }, AT + 20);
    assert.equal(again.ok, true);
    assert.deepEqual(listPlanSteps(db, task.id).map((s) => s.text), ['唯一一步'], '再编辑仍全量替换');
    assert.equal(
      listTaskEvents(db, task.id).filter((e) => e.kind === 'plan_edited').length,
      2,
      '每次编辑留痕（不吞事件）',
    );
  } finally {
    db.close();
  }
});

test('GAP8: 保存并批准 → 工作项 brief 用改后计划（派工读真投影）', async () => {
  const { db, deps, projectId } = setup();
  try {
    const task = await awaitingApproval(deps, projectId, ['旧第一步', '旧第二步']);
    const result = await handleTaskEditPlan(
      deps,
      { taskId: task.id, steps: ['新第一步：核对需求', '新第二步：写实现'], approve: true },
      AT + 10,
    );
    assert.equal(result.ok, true);
    assert.equal((result as { approved: boolean }).approved, true);
    assert.equal(deps.repo.getTask(task.id)?.state, 'ready', '保存并批准 → ready');

    const items = listWorkItemsByTask(db, task.id);
    assert.equal(items.length, 1, '批准当刻建工作项');
    assert.match(items[0]!.brief, /新第一步：核对需求/, 'brief 带改后计划');
    assert.match(items[0]!.brief, /新第二步：写实现/);
    assert.doesNotMatch(items[0]!.brief, /旧第一步/, '旧计划不得进入派工');
    assert.deepEqual(
      listTaskEvents(db, task.id).map((e) => e.kind).filter((k) => k === 'plan_edited' || k === 'plan_approved'),
      ['plan_edited', 'plan_approved'],
      '编辑与批准按顺序留痕',
    );
  } finally {
    db.close();
  }
});

test('GAP8: 非待批准/非法步骤显式拒绝（不静默截断、不丢空项）', async () => {
  const { db, deps, projectId } = setup();
  try {
    const task = await awaitingApproval(deps, projectId, ['A', 'B']);
    for (const [steps, code] of [
      [[], 'invalid_steps'],
      [['A', '  '], 'invalid_steps'],
      [['A', 3], 'invalid_steps'],
      [Array.from({ length: 13 }, (_, i) => `第 ${i + 1} 步`), 'too_many_steps'],
    ] as const) {
      const result = await handleTaskEditPlan(deps, { taskId: task.id, steps }, AT + 10);
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, code);
    }
    assert.deepEqual(listPlanSteps(db, task.id).map((s) => s.text), ['A', 'B'], '拒绝后计划不变');

    const approved = await handleTaskEditPlan(deps, { taskId: task.id, steps: ['新 A', '新 B'], approve: true }, AT + 20);
    assert.equal(approved.ok, true);
    const afterApprove = await handleTaskEditPlan(deps, { taskId: task.id, steps: ['再改'] }, AT + 30);
    assert.equal(afterApprove.ok, false);
    assert.equal((afterApprove as { code: string }).code, 'invalid_state', '已批准/已派工后不再允许改计划');
    assert.deepEqual(listPlanSteps(db, task.id).map((s) => s.text), ['新 A', '新 B']);
  } finally {
    db.close();
  }
});

test('GAP8: 纯校验 shared normalize —— trim、混合空项整体拒绝、上限 12', async () => {
  const { normalizePlanSteps } = await import('../src/core/plan.js');
  assert.deepEqual(normalizePlanSteps(['  a  ', 'b']), { ok: true, steps: ['a', 'b'] });
  assert.equal(normalizePlanSteps(['a', '']).ok, false, '混入空项不得静默丢弃');
  assert.equal(normalizePlanSteps(['a', 1]).ok, false);
  assert.equal(normalizePlanSteps(Array.from({ length: 13 }, (_, i) => `s${i}`)).ok, false);
  assert.equal(normalizePlanSteps('a').ok, false);
});
