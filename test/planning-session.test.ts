/**
 * R3-1 · L0 直通（规划会话）：`dispatch_planning` 的消费者 ＋ 端到端
 * （`inbox → planning → ready → executing`，**无人工事件**）＋ L1 对照（不直通）。fake runtime ＋ 真引擎，零真调。
 *
 * 口径（施工图 §2.8）：可达性修复＝补 `plan_drafted` 的生产发出者（规划会话读 `submit_plan` → 宿主 dispatch）；
 * L0/L1 的分岔在状态机（`riskLevel===0 → ready`；`>=1 → KEEP + critic`），本测两条都钉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getAction,
  insertApproval,
  insertWorkItem,
  listPlanSteps,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskApprove, type IpcDeps } from '../src/main/ipc/ipc.js';
import { Engine, TASK_TRANSITIONS, toPersistedAction } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import {
  EmployeeSessionRuntime,
  buildPlanningContext,
  buildReviewContext,
  createEmployeeExecutor,
  makeFakeAgentRuntime,
  parsePlanningAction,
  type FakeAgentRuntime,
} from '../src/main/agent/index.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,is_assistant,created_at) VALUES(0,'幕僚长','assistant','standard',1,1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'研究员','dev','standard',1)").run();
  // L2（强制验证）需要 verifier ≠ 实现者 → 种子第三名员工
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(9,'验证者','reviewer','standard',1)").run();
  return { db, projectId };
}

/** 路由 fake：planner → 提交计划；critic → approve/revise；employee → 提交工作项；verifier → pass/无结论；其余 → 空转。 */
function routingRuntime(
  steps: string[],
  opts: { verifier?: 'pass' | 'none'; critic?: 'approve' | 'revise' } = {},
): FakeAgentRuntime {
  return makeFakeAgentRuntime((input) => {
    if (input.sessionKey?.startsWith('role:verifier')) {
      return opts.verifier === 'none'
        ? { text: '看不出来', toolCalls: [] }
        : {
            text: 'ok',
            toolCalls: [
              {
                id: 'v1',
                name: 'submit_review',
                // F-02（2026-11-06）：计划步骤常有未 done 的项——pass 必须带 planStepsNote 交代；
                // 不交代会被宿主改为 fail（该规则由 g4-review-sessions 的 F-02 用例单测）。
                input: { verdict: 'pass', planStepsNote: '计划步骤：按实际交付调整，未完成步骤不影响验收。' },
                isError: false,
              },
            ],
          };
    }
    if (input.sessionKey?.startsWith('role:planner')) {
      return { text: 'plan', toolCalls: [{ id: 'p1', name: 'submit_plan', input: { steps }, isError: false }] };
    }
    if (input.sessionKey?.startsWith('role:critic')) {
      return {
        text: 'ok',
        toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: opts.critic ?? 'approve' }, isError: false }],
      };
    }
    if (input.sessionKey?.startsWith('employee:')) {
      return { text: '', toolCalls: [{ id: 'w1', name: 'submit_work_item', input: { summary: '完成' }, isError: false }] };
    }
    return { text: '', toolCalls: [] };
  });
}

const planAction = (taskId: number) =>
  toPersistedAction(`dispatch_planning:task:${taskId}:0`, 'dispatch_planning', taskId, '{}');

test('R3-1: parsePlanningAction 只认 dispatch_planning；critic/工作项派发不受影响', () => {
  assert.deepEqual(parsePlanningAction(planAction(3)), { taskId: 3 });
  assert.equal(parsePlanningAction(toPersistedAction('dispatch_critic:task:3:0', 'dispatch_critic', 3, '{}')), null);
  assert.equal(parsePlanningAction(toPersistedAction('dispatch:work_item:1:0', 'dispatch', 3, '{}')), null);
});

test('R3-1-C 规划会话模型 401：task error（模型/凭据不可用）→ failed＋异常卡，不伪装 no_plan', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '坏 Key', goal: 'g', riskLevel: 0 });
    const events: EngineEvent[] = [];
    const throwing = {
      run: async () => {
        throw new Error('HTTP 401 Unauthorized（invalid api key）');
      },
      steer: () => false,
      dispose: () => undefined,
    };
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(throwing),
      dispatch: (e) => void events.push(e),
    });
    await exec.execute(planAction(task.id));

    assert.deepEqual(events.map((e) => e.event), ['error'], '401 必须派任务级 error，不得 escalate no_plan');
    assert.equal(events[0]!.scope, 'task');
    assert.match(
      String((events[0]!.payload as { reason?: string }).reason ?? ''),
      /模型\/凭据不可用：.*401/,
      '异常卡原因带人话前缀与 401',
    );
    const row = TASK_TRANSITIONS.find((r) => r.from === 'planning' && r.event === 'error');
    assert.equal(row?.to, 'failed', 'planning error → failed');
    assert.deepEqual(row?.kinds, ['task_failed']);
  } finally {
    db.close();
  }
});

test('R3-1-A 规划会话：submit_plan → plan_drafted{steps 已归一}（actor＝规划者）；无有效计划 → escalate（可见、不静默）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1 });
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: 'plan', toolCalls: [{ id: 'p1', name: 'submit_plan', input: { steps: [' 调研 ', '', '   ', '写稿'] }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(planAction(task.id));
    assert.deepEqual(events.map((e) => e.event), ['plan_drafted']);
    assert.deepEqual((events[0]!.payload as { steps: string[] }).steps, ['调研', '写稿'], 'trim ＋ 去空步');
    assert.equal(events[0]!.actor, 'employee:0', '缺省规划者＝幕僚长（owner_id 为空）');
    assert.match(fake.runs[0]!.sessionKey, /^role:planner:task:/, '规划会话独立分键（不污染员工会话）');

    const events2: EngineEvent[] = [];
    const fake2 = makeFakeAgentRuntime([{ text: '不会规划', toolCalls: [] }]);
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake2), dispatch: (e) => void events2.push(e) });
    await exec2.execute(planAction(task.id));
    assert.deepEqual(events2.map((e) => e.event), ['escalate'], '无计划 → escalate（BRK3 修：任务机真事件；绝不假装有计划）');
    assert.equal((events2[0]!.payload as { reason: string }).reason, 'no_plan');

    // 有牙：steps 全是空白串 ⇒ 等同无计划（不得把空计划当计划）
    const events3: EngineEvent[] = [];
    const fake3 = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'p3', name: 'submit_plan', input: { steps: [' ', ''] }, isError: false }] },
    ]);
    const exec3 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake3), dispatch: (e) => void events3.push(e) });
    await exec3.execute(planAction(task.id));
    assert.deepEqual(events3.map((e) => e.event), ['escalate']);
  } finally {
    db.close();
  }
});

test('R3-1-B 端到端（验收②）：L0 任务**无人工事件**走 inbox→planning→ready→executing（plan_steps 真投影）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '小活',
      goal: '把这句话翻译成英文',
      riskLevel: 0,
      ownerId: 7,
    });
    let engine: Engine | undefined;
    const fake = routingRuntime(['翻译', '自检']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    // **唯一**一次事件注入＝triage（老板侧随后不再有任何 approve/start_task 类人工事件）。
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.id) as { state: string };
    assert.equal(row.state, 'executing', 'L0：plan_drafted 直达 ready，调度器随即开工（无人工干预）');
    assert.deepEqual(
      listPlanSteps(db, task.id).map((s) => s.text),
      ['翻译', '自检'],
      'submit_plan 的 steps 真投影到 plan_steps（任务详情可见）',
    );
    assert.ok(fake.runs.some((r) => r.sessionKey?.startsWith('role:planner')), '规划会话真的跑了');

    // 工作项由 `plan_work_items` 动作（事务外）建行 → 下一拍（生产＝引擎 tick 每秒的 `schedulePass()`）才被派发。
    await engine.schedulePass();

    // C2 真拆派（D-6 缺省链）：计划成终稿当刻建**1 个工作项**，派给"任务负责人"（链条：规划者指定→项目默认员工
    // 〔未落地〕→ 负责人→幕僚长兜底），并被调度器真派发（员工会话真的跑了）。
    const items = db.prepare('SELECT id, employee_id, state, brief FROM work_items WHERE task_id = ?').all(task.id) as Array<{
      id: number;
      employee_id: number;
      state: string;
      brief: string;
    }>;
    assert.equal(items.length, 1, 'v1：1 任务 = 1 工作项（拆多件留后续 DAG 件）');
    assert.equal(items[0]!.employee_id, 7, '派给任务负责人（owner_id）');
    assert.equal(items[0]!.state, 'done', 'D3：L0 免验 ⇒ 提交即自动接受（review_accept）→ done');
    assert.match(items[0]!.brief, /目标：/, 'brief＝结构化工作简报（目标/验收/计划/预算）');
    assert.match(items[0]!.brief, /验收：|计划：/, '简报带验收或计划（有则写，无则省——不写空行）');
    assert.match(items[0]!.brief, /执行要求：计划已批准.*submit_work_item/, '简报必须写明直接执行并提交（MiMo 实测：不写会复述计划/等指令）');
    assert.ok(fake.runs.some((r) => r.sessionKey?.startsWith('employee:7')), '员工会话真跑了（真开工，不是只建行）');
    // D3 全链：自动接受 → 聚合 → verifying → **免验自动 pass**（`verificationNeeded:false` 不派 verifier）→ done
    assert.ok(
      !fake.runs.some((r) => r.sessionKey?.startsWith('role:verifier')),
      'L0（无事可验）**不派 verifier 会话**（派了也没人可当 verifier≠实现者）',
    );
    const kinds = listTaskEvents(db, task.id).map((e) => e.kind);
    assert.ok(kinds.includes('verification_started') && kinds.includes('verification_completed'), '任务级验收两事件在场');
    const passEvent = listTaskEvents(db, task.id).find((e) => e.kind === 'verification_completed');
    assert.match(
      JSON.stringify(passEvent?.payload ?? {}),
      /no_verification_required/,
      '自动 pass 必须如实标注来源（不假装跑过 verifier）',
    );
    const finalState = (db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.id) as { state: string }).state;
    assert.equal(finalState, 'done', 'L0 全链闭环：直达 done');
  } finally {
    db.close();
  }
});

test('重规划 v+1：打回 → **真再派规划**（新幂等键 revision=1）→ 再评审 → 再出批准卡（不从头再来）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '改一版', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    let variant = 1;
    // 规划器两版：第一版 ['初稿']；被老板打回后第二版 ['改稿A', '改稿B']。critic 两次都 approve。
    const fake = makeFakeAgentRuntime((input) => {
      if (input.sessionKey?.startsWith('role:planner')) {
        const steps = variant === 1 ? ['初稿'] : ['改稿A', '改稿B'];
        variant += 1;
        return { text: 'plan', toolCalls: [{ id: `p${variant}`, name: 'submit_plan', input: { steps }, isError: false }] };
      }
      if (input.sessionKey?.startsWith('role:critic')) {
        return { text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve' }, isError: false }] };
      }
      return { text: '', toolCalls: [] };
    });
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });
    const st = (): string => (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(st(), 'awaiting_approval', '前置：第一版计划已出、critic 过、等老板批');
    assert.deepEqual(listPlanSteps(db, task.id).map((s) => s.text), ['初稿']);

    // 老板打回（批准卡 [打回，改计划] 的同义事件；此处直接派发真实事件）
    await engine.dispatch({ scope: 'task', id: task.id, event: 'revise', actor: 'boss', payload: { role: 'boss', notes: '只写一句话就够' } });
    await engine.schedulePass();

    assert.equal(
      getAction(db, `dispatch_planning:task:${task.id}:1`)?.state,
      'done',
      '打回 ⇒ **真再派规划**（新幂等键 revision=1；此前 :0 已用 ⇒ 打回后无人再规划、任务永停 planning）',
    );
    assert.equal(st(), 'awaiting_approval', '重规划两版走完：再规划 → 再评审 → **再出批准卡**（回到等批）');
    assert.deepEqual(listPlanSteps(db, task.id).map((s) => s.text), ['改稿A', '改稿B'], 'plan_steps 换成第二版');
    const plannerRuns = fake.runs.filter((r) => r.sessionKey?.startsWith('role:planner'));
    assert.equal(plannerRuns.length, 2, '规划会话真跑了两次（v1＋v1+1）');
    assert.match(plannerRuns[1]!.prompt, /【打回意见】只写一句话就够/, '重规划要**带意见**（上一轮打回原因进规划输入）');
    assert.match(plannerRuns[1]!.prompt, /初稿/, '重规划要**看到上一版计划**（不从头再来）');
  } finally {
    db.close();
  }
});

test('重规划安全阀：critic 连续打回达上限 → escalate 交老板（不无限重规划烧真会话）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '反复打回', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步'], { critic: 'revise' }); // critic 永远打回
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const st = (): string => (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(st(), 'needs_decision', '达上限 ⇒ 交老板（needs_decision），不无限重规划');
    assert.ok(
      (db.prepare("SELECT COUNT(*) n FROM reports WHERE task_id=? AND kind='ask'").get(task.id) as { n: number }).n >= 1,
      '决策卡必须真出（老板要知道「计划反复被打回」）',
    );
    const drafts = listTaskEvents(db, task.id).filter((e) => e.kind === 'plan_drafted').length;
    assert.ok(drafts <= 3, `规划版数=${drafts}（安全阀：最多 3 版＝初次＋重规划 2 次）`);
    const plannerRuns = fake.runs.filter((r) => r.sessionKey?.startsWith('role:planner')).length;
    assert.ok(plannerRuns <= 3, `规划会话次数=${plannerRuns}——不得无限循环`);
  } finally {
    db.close();
  }
});

test('C2 真拆派 · 负责人缺失 → 首个可执行员工（幕僚长不执行）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '没人认领的活', goal: 'g', riskLevel: 0 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const items = db.prepare('SELECT employee_id FROM work_items WHERE task_id = ?').all(task.id) as Array<{ employee_id: number }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.employee_id, 7, 'owner 缺失 → 首个可执行员工（7），不是幕僚长 0');
  } finally {
    db.close();
  }
});

test('C2 真拆派 · 没有员工 → 自动招募执行员工（D-20；幕僚长仍不执行）', async () => {
  const { db, projectId } = setup();
  try {
    db.prepare('DELETE FROM employees WHERE id <> 0').run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '空公司任务', goal: 'g', riskLevel: 0 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const items = db.prepare('SELECT employee_id FROM work_items WHERE task_id = ?').all(task.id) as Array<{ employee_id: number }>;
    assert.equal(items.length, 1);
    assert.notEqual(items[0]!.employee_id, 0, '不得再兜底给幕僚长');
    const worker = db.prepare('SELECT name, role, is_assistant, active FROM employees WHERE id = ?').get(items[0]!.employee_id) as {
      name: string;
      role: string;
      is_assistant: number;
      active: number;
    };
    assert.equal(worker.name, '执行员工');
    assert.equal(worker.is_assistant, 0);
    assert.equal(worker.active, 1, '自动招募的员工必须在职、可在设置里细化');
    const reports = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'notification'")
      .all(task.id) as Array<{ payload: string }>;
    assert.ok(
      reports.some((r) => r.payload.includes('自动招募执行员工')),
      '自动招募必须有可见通知（B-5：不能只 console 留痕）',
    );
  } finally {
    db.close();
  }
});

test('C2 真拆派 · 空公司 L1：自动补独立评审员工（D-20）', async () => {
  const { db, projectId } = setup();
  try {
    db.prepare('DELETE FROM employees WHERE id <> 0').run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L1 空公司', goal: 'g', riskLevel: 1 });
    db.prepare("UPDATE tasks SET state = 'awaiting_approval' WHERE id = ?").run(task.id);
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'plan_approved', actor: 'boss', payload: {} });

    const items = db.prepare('SELECT employee_id FROM work_items WHERE task_id = ?').all(task.id) as Array<{
      employee_id: number;
    }>;
    assert.equal(items.length, 1);
    assert.notEqual(items[0]!.employee_id, 0, '执行员工不得是幕僚长');
    const nonAssistant = db
      .prepare('SELECT name, role FROM employees WHERE active = 1 AND is_assistant = 0 ORDER BY id')
      .all() as Array<{ name: string; role: string }>;
    assert.ok(nonAssistant.length >= 2, 'L1 空公司必须自动补执行＋评审两名员工');
    assert.ok(nonAssistant.some((e) => e.name === '执行员工'));
    assert.ok(nonAssistant.some((e) => e.name === '评审员工'));
    const reports = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'notification'")
      .all(task.id) as Array<{ payload: string }>;
    assert.ok(
      reports.some((r) => r.payload.includes('自动招募评审员工')),
      '评审员工自动招募必须有可见通知（B-5/D-20）',
    );
  } finally {
    db.close();
  }
});

test('C2 真拆派 · "有牙"：已有工作项 → 不建第二份（v1 不重算；重规划不留孤儿件）', async () => {
  const { db, projectId } = setup();
  try {
    // 直接种一个 planning 态任务 + 一个既有工作项（模拟"重规划/重放/返工"混合现场）
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, state: 'planning' });
    insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '既有件', brief: 'b', now: AT });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'plan_drafted', actor: 'system', payload: { steps: ['一步'] } });

    const items = db.prepare('SELECT id FROM work_items WHERE task_id = ?').all(task.id) as Array<{ id: number }>;
    assert.equal(items.length, 1, '已有件 → 不建第二份（幂等 + 显式跳过双保险）');
  } finally {
    db.close();
  }
});

test('R3-1-C L1 对照：同链路 plan_drafted 后**不直通**——critic 过 → 停在 awaiting_approval 等老板', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['调研', '实现']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.id) as { state: string };
    assert.equal(row.state, 'awaiting_approval', 'L1：critic 通过后仍等老板批准（与 L0 直通分岔由状态机决定）');
    assert.ok(fake.runs.some((r) => r.sessionKey?.startsWith('role:critic')), 'critic 会话真的跑了');
    const wi = db.prepare('SELECT id FROM work_items WHERE task_id = ?').all(task.id) as Array<{ id: number }>;
    assert.equal(wi.length, 0, '未批准前不派工（L1 的闸门真的在拦；C2：也不建工作项——计划未成终稿，不留孤儿件）');

    // C2：**批准当刻**才是计划终稿 → 此刻建工作项（plan_approved 行的 `planWorkItemsAction`）
    await engine.dispatch({ scope: 'task', id: task.id, event: 'plan_approved', actor: 'boss', payload: {} });
    const afterItems = db.prepare('SELECT employee_id FROM work_items WHERE task_id = ?').all(task.id) as Array<{
      employee_id: number;
    }>;
    assert.equal(afterItems.length, 1, '批准后建件（唯一时点，重规划不会留孤儿工作项）');
    assert.equal(afterItems[0]!.employee_id, 7, '派给任务负责人');
  } finally {
    db.close();
  }
});

test('D3 会话实测抓到的真 bug：动作**不得被重入执行**（planner 恰好 1 次；动作以 done 收尾，不得误标 failed）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const plannerRuns = fake.runs.filter((r) => r.sessionKey?.startsWith('role:planner')).length;
    assert.equal(plannerRuns, 1, '规划会话恰好 1 次（修前＝2 次：执行中动作被重入）');
    const action = getAction(db, `dispatch_planning:task:${task.id}:0`);
    assert.equal(action?.state, 'done', '动作以 done 收尾（修前：第二遍因状态已前进而失败 → 误标 failed ⇒ 恢复时会重放）');
  } finally {
    db.close();
  }
});

test('D2＋D3 全链（L2 强制验证）：批准 → 派工 → 提交 → verifier pass → **接受** → done（verifier ≠ 实现者）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L2 正例', goal: 'g', riskLevel: 2, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['调研', '实现']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    const deps = {
      repo: createSqliteChatRepo(db),
      engine: { dispatch: (e: EngineEvent) => engine!.dispatch(e) },
    } as unknown as IpcDeps;

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });
    const st = (): string => (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(st(), 'awaiting_approval', 'L2：critic 过 → 等老板批准（不直通）');

    // D2：老板批准 → ready（＋C2 建件）→ 下一拍派工
    const approval = insertApproval(db, { taskId: task.id, question: '批准计划？', options: [{ key: 'approve' }], defaultAction: null });
    await handleTaskApprove(deps, { approvalId: approval.id, chosen: 'approve' }, AT);
    await engine.schedulePass();

    // B2-6/D-30③：L2 pass 现迁 needs_decision（签收卡）——补老板签收步
    if (st() === 'needs_decision') {
      await engine!.dispatch({ scope: 'task', id: task.id, event: 'signoff', actor: 'boss', payload: { via: 'b26-regression' } });
      await engine!.schedulePass();
    }
    assert.equal(st(), 'done', 'L2 全链闭环：提交 → 强制验证 pass → 签收 → done');
    const items = db.prepare('SELECT state, employee_id, verifier_employee_id FROM work_items WHERE task_id=?').all(task.id) as Array<{
      state: string;
      employee_id: number;
      verifier_employee_id: number | null;
    }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.state, 'done', 'D3-B：verifier pass ⇒ 引擎对已提交件发 review_accept');
    assert.ok(
      items[0]!.verifier_employee_id != null && items[0]!.verifier_employee_id !== items[0]!.employee_id,
      'OPT-M3-1：L2 强制 ⇒ verifier ≠ 实现者',
    );
    assert.ok(fake.runs.some((r) => r.sessionKey?.startsWith('role:verifier')), 'L2 需要验证 ⇒ verifier 会话真的跑了');
  } finally {
    db.close();
  }
});

test('D3 "有牙"：L2 验证**无结论** → 件不得 done（未验证不得 done）；BRK3：任务转 needs_decision ＋ 决策卡（可见、不静默）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L2 有牙', goal: 'g', riskLevel: 2, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步'], { verifier: 'none' });
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'plan_approved', actor: 'boss', payload: {} });
    await engine.schedulePass();

    const item = (db.prepare('SELECT state FROM work_items WHERE task_id=?').all(task.id) as Array<{ state: string }>)[0]!;
    assert.equal(item.state, 'submitted', 'verifier 没给结论 ⇒ 件停在 submitted（未验证不得 done）');
    const taskState = (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.notEqual(taskState, 'done', '任务不得因"验证没结论"而完成');
    // BRK3 修：**响亮＝看得见的卡**（不再是"靠 action_failed 日志兜底"的静默停摆）
    assert.equal(taskState, 'needs_decision', 'verifier 无结论 ⇒ 任务 escalate 到 needs_decision（不静默停在 verifying）');
    assert.ok(
      (db.prepare("SELECT COUNT(*) n FROM reports WHERE task_id=? AND kind='ask'").get(task.id) as { n: number }).n >= 1,
      '决策卡必须真出（notify_decision）',
    );
    assert.ok(
      !listTaskEvents(db, task.id).some((e) => e.kind === 'action_failed'),
      '不再靠 action_failed 兜底——那是旧断链的症状（事件名不在任务机里）',
    );
  } finally {
    db.close();
  }
});

test('D4 闸门卡：L1 计划待批 → 真出决策卡（`kind=ask`）＋ 审批行（L1 超时默认＝approve）；失败 → 异常卡（urgent）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L1 卡', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });
    assert.equal(
      (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state,
      'awaiting_approval',
      'L1：critic 过 → 等老板批准',
    );

    // D4：`notify_approval` 动作 → 真卡（reports）＋ 审批行（approvals）＋ 通知台账（notifications）
    const cards = db.prepare('SELECT kind, state FROM reports WHERE task_id = ?').all(task.id) as Array<{ kind: string; state: string }>;
    assert.equal(cards.length, 1, '恰一张卡（不再"闸门弹不出来"）');
    assert.equal(cards[0]!.kind, 'ask', '批准＝决策卡（ask）');
    const appr = db.prepare('SELECT question, default_action, chosen, options FROM approvals WHERE task_id = ?').all(task.id) as Array<{
      question: string;
      default_action: string | null;
      chosen: string | null;
      options: string;
    }>;
    assert.equal(appr.length, 1, '审批行在场（作答映射与超时默认都读它）');
    assert.equal(appr[0]!.default_action, 'approve', 'L1 超时默认＝approve（`05 §3.1.1` L224）');
    assert.match(appr[0]!.question, /^批准计划？/, '审批行问题人话（含短号）');

    // V3 修（真机配方抓到的断链）：卡必须**自带选项**（渲染层按 `payload.options` 出按钮）＋ 审批行必须**挂到真卡**。
    // 此前 `runNotifyAction` 先插审批行（report_id=null）再落卡、payload 不写 options ⇒ 卡上无按钮；
    // 即便有按钮，`enrichReport` 取不到 approvalId ⇒ `task:approve` 直接 bad_request。两条一起钉。
    const cardRow = db.prepare('SELECT id, payload FROM reports WHERE task_id = ? AND kind = ?').get(task.id, 'ask') as {
      id: number;
      payload: string;
    };
    const payload = JSON.parse(cardRow.payload) as { options?: Array<{ key: string; label: string }> };
    assert.deepEqual(
      (payload.options ?? []).map((o) => o.key),
      ['approve', 'revise'],
      '批准卡 payload 必须带 options（approve/revise）——UI 按钮的唯一来源',
    );
    const apprRow = db.prepare('SELECT report_id FROM approvals WHERE task_id = ?').get(task.id) as { report_id: number | null };
    assert.equal(apprRow.report_id, cardRow.id, '审批行必须挂到真卡（卡 DTO 的 approvalId 靠它；否则点按钮 bad_request）');

    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?').get(`notify_approval:task:${task.id}:0`) as { n: number }).n,
      1,
      '通知台账 1 条（幂等键＝动作键 ⇒ 重放/重入不叠卡）',
    );

    // D4（异常卡）：另起一个直接处于 executing 的任务 → fail → 异常卡（kind=alert；urgent 语义见 notify/policy）
    const failing = createTask(db, new SqliteCounterStore(db), { projectId, title: '会挂的活', goal: 'g', riskLevel: 1, state: 'executing' });
    await engine.dispatch({ scope: 'task', id: failing.id, event: 'fail', actor: 'system', payload: { reason: '演示失败' } });
    const alert = db.prepare("SELECT kind FROM reports WHERE task_id = ? AND kind = 'alert'").get(failing.id) as { kind: string } | undefined;
    assert.ok(alert, '失败 ⇒ 异常卡在场（kind=alert）');
  } finally {
    db.close();
  }
});

test('V3 修・有牙：critic 打回**不产出幽灵批准卡**；重规划 v+1 后（第二次 approve）恰一张真卡', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L1 打回', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    // critic：第一次 revise（打回）→ 重规划后第二次 approve（收敛）；规划器两版
    let criticRound = 0;
    let planRound = 0;
    const fake = makeFakeAgentRuntime((input) => {
      if (input.sessionKey?.startsWith('role:planner')) {
        planRound += 1;
        return { text: 'plan', toolCalls: [{ id: `p${planRound}`, name: 'submit_plan', input: { steps: [`第${planRound}版`] }, isError: false }] };
      }
      if (input.sessionKey?.startsWith('role:critic')) {
        criticRound += 1;
        const verdict = criticRound === 1 ? 'revise' : 'approve';
        return { text: 'ok', toolCalls: [{ id: `c${criticRound}`, name: 'submit_review', input: { verdict, notes: verdict === 'revise' ? '第一步太笼统' : '可以开工' }, isError: false }] };
      }
      return { text: '', toolCalls: [] };
    });
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const st = (): string => (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(st(), 'awaiting_approval', '打回→重规划→再评审通过 ⇒ 停在等老板批准');
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM reports WHERE task_id = ? AND kind = 'ask'").get(task.id) as { n: number }).n,
      1,
      '恰一张批准卡——**打回那一轮不得留幽灵卡**（此前 planning＋卡 pending＋审批待答三方不一致）',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM approvals WHERE task_id = ?').get(task.id) as { n: number }).n,
      1,
      '恰一条审批行（「待我处理」里不得出现无人可答的题）',
    );
    const verdicts = listTaskEvents(db, task.id)
      .filter((e) => e.kind === 'plan_reviewed')
      .map((e) => (JSON.parse(e.payload) as { verdict?: string }).verdict);
    assert.ok(verdicts.includes('revise'), '打回真的发生过（revise 行在案）');
    assert.equal(planRound, 2, '重规划 v+1 真跑了第二版计划');
  } finally {
    db.close();
  }
});

test('BRK1 修：L1 超时自动批准（askcard_timeout）也建工作项——不再 ready→executing 空转', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'L1 超时', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    const fake = routingRuntime(['一步']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });
    assert.equal(
      (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state,
      'awaiting_approval',
      '前置：L1 停在等批准',
    );

    // 超时路径等价事件（真引擎会由 `fireDueTimers` 发；default_action 来自审批行＝approve，与真路径一致）
    await engine.dispatch({ scope: 'task', id: task.id, event: 'askcard_timeout', actor: 'system', payload: { defaultAction: 'approve' } });
    await engine.schedulePass();

    const items = db.prepare('SELECT id, state FROM work_items WHERE task_id=?').all(task.id) as Array<{ id: number; state: string }>;
    assert.ok(items.length >= 1, 'BRK1：超时批准必须建工作项（此前零件 ⇒ 永久空转、无派工、无聚合）');
    assert.equal(
      getAction(db, `plan_work_items:task:${task.id}:0`)?.state,
      'done',
      'plan_work_items 动作在场且已执行（与 plan_approved 行同一动作）',
    );
  } finally {
    db.close();
  }
});

test('BRK3 全链（真引擎）：planner 无计划 → 任务 needs_decision ＋ 决策卡（不再永停 planning、无卡）', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '不会规划', goal: 'g', riskLevel: 1, ownerId: 7 });
    let engine: Engine | undefined;
    // planner 不调 submit_plan（empty toolCalls）⇒ 无有效计划 ⇒ escalate（BRK3 修）
    const fake = makeFakeAgentRuntime([{ text: '不会规划', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });

    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss', payload: {} });

    const taskState = (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(taskState, 'needs_decision', '无计划 ⇒ 任务进 needs_decision（此前派非法 `error` ⇒ 永停 planning）');
    assert.ok(
      (db.prepare("SELECT COUNT(*) n FROM reports WHERE task_id=? AND kind='ask'").get(task.id) as { n: number }).n >= 1,
      '决策卡必须真出（notify_decision）——「响亮」＝看得见的卡',
    );
    assert.equal(
      (db.prepare('SELECT resume_state FROM tasks WHERE id=?').get(task.id) as { resume_state: string | null }).resume_state,
      'planning',
      'resume_state=当时状态（答完后回 planning——**重规划再派**属另一工单〔revise 后重规划 v+1〕，如实留痕）',
    );
    assert.ok(
      !listTaskEvents(db, task.id).some((e) => e.kind === 'action_failed'),
      '不得靠 action_failed 兜底（旧断链症状）',
    );
  } finally {
    db.close();
  }
});

test('提示词回归（真机暴露）：规划/评审上下文**必须带题目/目标/验收**（禁自建 systemPrompt 丢基线层）', () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '写简报',
      goal: '把竞品动态整理成一页',
      acceptance: [{ text: '含来源' }],
      riskLevel: 1,
      ownerId: 7,
    });
    const plan = buildPlanningContext(db, { taskId: task.id, plannerEmployeeId: 7, bossText: null });
    assert.match(plan.systemPrompt, /把竞品动态整理成一页/, '规划 system 段必须含目标（baselineLayer）');
    assert.match(plan.systemPrompt, /含来源/, '规划 system 段必须含验收');
    assert.match(plan.systemPrompt, /规划角色/, '规划角色层在场');
    assert.match(plan.userPrompt, /【本任务】写简报：把竞品动态整理成一页/, 'user 段冗余带上题目/目标');

    insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
    const review = buildReviewContext(db, { role: 'critic', taskId: task.id, reviewerEmployeeId: 9, bossText: null });
    assert.match(review.systemPrompt, /把竞品动态整理成一页/, '评审 system 段必须含目标（同一 bug 的另一半）');
    assert.match(review.systemPrompt, /评审角色/, '评审角色层在场');
  } finally {
    db.close();
  }
});

test('S1 回归：planner submit_plan 成功后 terminated → 仍 plan_drafted', async () => {
  const { db, projectId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: 'planner terminated',
      goal: 'g',
      riskLevel: 1,
      ownerId: 0,
    });
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(_input: unknown, onEvent: (e: unknown) => void): Promise<never> {
        onEvent({
          type: 'tool_call_start',
          toolCallId: 'p-terminated',
          toolName: 'submit_plan',
          input: { steps: ['读现状', '做最小改动', '跑测试'] },
        });
        onEvent({ type: 'tool_call_end', toolCallId: 'p-terminated', toolName: 'submit_plan', isError: false });
        throw new Error('terminated');
      },
      steer(): boolean {
        return true;
      },
      dispose(): void {
        runtime.disposed = true;
      },
    };
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(runtime as never),
      dispatch: (e) => void events.push(e),
    });
    await exec.execute(planAction(task.id));
    const drafted = events.find((e) => e.event === 'plan_drafted');
    assert.ok(drafted, '提交后 terminated 不得吞掉计划');
    assert.deepEqual((drafted.payload as { steps: string[] }).steps, ['读现状', '做最小改动', '跑测试']);
  } finally {
    db.close();
  }
});
