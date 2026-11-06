import test from 'node:test';
import assert from 'node:assert/strict';

import { insertApproval, listTaskEvents, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  handleTaskApprove,
  handleTaskCreate,
  handleTaskList,
  handleTaskTransition,
  type IpcDeps,
} from '../src/main/ipc/ipc.js';

// ───────────── T0.6：手工建任务 + 状态机全走（经 IPC 处理器） ─────────────
// 验收：① 每步 tasks.state 终值 + task_events 新增对应 kind（逐条对照 05 §3.1）；
//       ③ 进入 ready 时 ready_since 被写入；④ 主链 + paused 往返。

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  // C2（真拆派）：缺省链最后一环＝幕僚长（0 号）——生产首启必种；测试库同样要有（否则拆派动作响亮失败）。
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(0, '幕僚长', 'assistant', 1)").run();
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  return { db, deps: { repo, engine } };
}

test('R3-1: 建任务档位透传 —— riskLevel 0/2 显式入档；缺省/非法 → L1（审计划）；非法不静默写怪值', async () => {
  const { db, deps } = setup();
  const l0 = await handleTaskCreate(deps, { goal: '小活：翻译一句话', riskLevel: 0 });
  assert.equal(l0.riskLevel, 0, '直通档显式可建（R3-1 可达性：UI 选「直通 L0」）');
  const l2 = await handleTaskCreate(deps, { goal: '大活', riskLevel: 2 });
  assert.equal(l2.riskLevel, 2);
  const dflt = await handleTaskCreate(deps, { goal: '默认档' });
  assert.equal(dflt.riskLevel, 1, '缺省＝L1 审计划（`06 §3.3` 口径）');
  const bad = await handleTaskCreate(deps, { goal: '非法档', riskLevel: 9 });
  assert.equal(bad.riskLevel, 1, '越界档 → 不透传（回落缺省，不静默写 9）');
  const badFrac = await handleTaskCreate(deps, { goal: '非法小数', riskLevel: 0.5 });
  assert.equal(badFrac.riskLevel, 1, '非整数 → 不透传');
  const badStr = await handleTaskCreate(deps, { goal: '非法字符串', riskLevel: '0' });
  assert.equal(badStr.riskLevel, 1, '字符串 → 不透传（不当 number 用）');
  db.close();
});

test('D2 批准即推进：awaiting_approval 批准 → plan_approved（真推状态机）；打回 → revise；未知选项 → 不猜（有牙）', async () => {
  const { db, deps } = setup();
  const created = await handleTaskCreate(deps, { goal: 'D2 用例' }); // D1：建完已进 planning
  for (const event of ['plan_drafted', 'plan_reviewed']) {
    assert.equal((await handleTaskTransition(deps, { taskId: created.id, event })).ok, true, `${event} 应成功`);
  }
  assert.equal(deps.repo.getTask(created.id)?.state, 'awaiting_approval');

  // 未知选项：作答落台账，但**不推状态机**（不猜）
  const a1 = insertApproval(db, {
    taskId: created.id,
    question: '批准计划？',
    options: [{ key: 'approve' }, { key: 'revise' }],
    defaultAction: 'approve',
  });
  await handleTaskApprove(deps, { approvalId: a1.id, chosen: 'nonsense' }, AT);
  assert.equal(deps.repo.getTask(created.id)?.state, 'awaiting_approval', '未知选项 → 不动（有牙）');

  // 打回：revise → 回 planning 重规划
  const a2 = insertApproval(db, { taskId: created.id, question: '批准计划？', options: [], defaultAction: null });
  await handleTaskApprove(deps, { approvalId: a2.id, chosen: 'revise' }, AT + 1);
  assert.equal(deps.repo.getTask(created.id)?.state, 'planning', 'revise → 重规划');

  // 再走回 awaiting_approval，批准 → ready（D2 前：点批准任务不动）
  for (const event of ['plan_drafted', 'plan_reviewed']) {
    assert.equal((await handleTaskTransition(deps, { taskId: created.id, event })).ok, true, `${event} 应成功`);
  }
  const a3 = insertApproval(db, { taskId: created.id, question: '批准计划？', options: [{ key: 'approve' }], defaultAction: 'approve' });
  await handleTaskApprove(deps, { approvalId: a3.id, chosen: 'approve' }, AT + 2);
  assert.equal(deps.repo.getTask(created.id)?.state, 'ready', '批准 → ready（此前卡死在 awaiting_approval）');
  db.close();
});

test('T0.6: 建任务 → 主链全走 + paused 往返（逐步对照 05 §3.1）', async () => {
  const { db, deps } = setup();

  // 受理建任务：**D1 建任务即分诊**（老板明确要建 ⇒ 直接 triage 进 planning）＋ 短号 T-1001
  const created = await handleTaskCreate(deps, { goal: '把对账脚本跑通', acceptance: [{ text: 'a' }] });
  assert.equal(created.state, 'planning', 'D1：建完即分诊（不再停在 inbox）');
  assert.equal(created.shortId, 'T-1001');
  assert.deepEqual(
    listTaskEvents(db, created.id).map((e) => e.kind),
    ['task_created', 'task_triaged'],
  );

  const steps: Array<{ event: string; state: string; kinds: string }> = [];
  const step = async (event: string, payload?: Record<string, unknown>): Promise<void> => {
    const before = listTaskEvents(db, created.id).length;
    const result = await handleTaskTransition(deps, { taskId: created.id, event, payload });
    assert.equal(result.ok, true, `task:transition ${event} 应成功`);
    const kinds = listTaskEvents(db, created.id)
      .slice(before)
      .map((e) => e.kind);
    steps.push({ event, state: deps.repo.getTask(created.id)?.state ?? '?', kinds: kinds.join('+') });
  };

  await step('plan_drafted');
  await step('plan_reviewed');
  await step('plan_approved');
  // ③ 进入 ready 时 ready_since 写入
  assert.equal(deps.repo.getTask(created.id)?.readySince, AT, 'ready_since 应在进入 ready 时写入');
  await step('start_task');
  await step('pause');
  await step('resume');
  await step('start_task');
  await step('all_work_items_done');
  await step('verification_completed', { verdict: 'pass' });

  // ① 逐条对照 05 §3.1 主链（state 终值 + 新增 kind）
  assert.deepEqual(steps, [
    { event: 'plan_drafted', state: 'planning', kinds: 'plan_drafted' },
    { event: 'plan_reviewed', state: 'awaiting_approval', kinds: 'plan_reviewed' },
    // C2：`plan_approved` 当刻建工作项（`05 §3.1.2`「规划产出 work item」）→ 同批落 `work_item_created`
    { event: 'plan_approved', state: 'ready', kinds: "plan_approved+work_item_created" },
    { event: 'start_task', state: 'executing', kinds: 'task_started' },
    { event: 'pause', state: 'paused', kinds: 'task_paused' },
    { event: 'resume', state: 'ready', kinds: 'task_resumed' },
    { event: 'start_task', state: 'executing', kinds: 'task_started' },
    { event: 'all_work_items_done', state: 'verifying', kinds: 'verification_started' },
    { event: 'verification_completed', state: 'done', kinds: 'verification_completed+task_completed' },
  ]);

  // task:list 供左栏分组（终态 done）
  const tasks = handleTaskList(deps, {});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, 'done');
  assert.equal(tasks[0].shortId, 'T-1001');
});

test('T0.6: task:transition 入参校验 + engine 缺失时的降级', async () => {
  const { db, deps } = setup();
  const bad = await handleTaskTransition(deps, { taskId: 1 });
  assert.equal(bad.ok, false);

  const noEngine = await handleTaskTransition({ repo: deps.repo }, { taskId: 1, event: 'triage' });
  assert.equal(noEngine.ok, false);
  if (!noEngine.ok) assert.equal(noEngine.code, 'engine_unavailable');

  db.close();
});
