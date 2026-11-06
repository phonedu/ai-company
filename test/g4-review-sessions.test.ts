/**
 * G4（RC-5）· critic / verifier 真会话（两个独立验收点）。fake runtime + fake dispatch，零真调。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertPlanStep,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { setFallbackChain, setRoleMap } from '../src/main/agent/model-policy.js';
import {
  EmployeeSessionRuntime,
  createEmployeeExecutor,
  makeFakeAgentRuntime,
  parseReviewAction,
} from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(9,'验证者','reviewer','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  db.prepare('UPDATE work_items SET verifier_employee_id = 9 WHERE id = ?').run(wi.id);
  return { db, taskId: task.id, wiId: wi.id };
}

const reviewAction = (kind: 'dispatch_critic' | 'dispatch_verifier', taskId: number) =>
  toPersistedAction(`${kind}:task:${taskId}:0`, kind, taskId, '{}');

test('G4: parseReviewAction 只认 critic/verifier；work_item dispatch 不受影响', () => {
  assert.deepEqual(parseReviewAction(reviewAction('dispatch_critic', 3)), { role: 'critic', taskId: 3 });
  assert.deepEqual(parseReviewAction(reviewAction('dispatch_verifier', 3)), { role: 'verifier', taskId: 3 });
  assert.equal(parseReviewAction(toPersistedAction('dispatch:work_item:1:0', 'dispatch', 3, '{}')), null);
});

test('C4: critic 计划评审尚无工作项 → 用项目默认执行员工做 peer，异供应商仍可叠加', async () => {
  const { db } = setup();
  try {
    const projectId = (db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number }).id;
    db.prepare('UPDATE projects SET default_employee_ids = ? WHERE id = ?').run(JSON.stringify([7]), projectId);
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'no-wi', goal: 'g', riskLevel: 1 });
    const fake = makeFakeAgentRuntime([
      { text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve' }, isError: false }] },
    ]);
    setRoleMap({ critic: { model: 'deepseek/deepseek-flash' } });
    setFallbackChain(['xiaomi/mimo-v2.6-flash']);
    try {
      const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake) });
      await exec.execute(reviewAction('dispatch_critic', task.id));
      assert.equal(
        fake.runs[0]?.model,
        'xiaomi/mimo-v2.6-flash',
        '无工作项时按项目默认执行员工取 peer，critic 应走异供应商',
      );
    } finally {
      setRoleMap(null);
      setFallbackChain(null);
    }
  } finally {
    db.close();
  }
});

test('G4-A critic 会话：approve → plan_reviewed；revise → plan_reviewed + revise（既有打回路径）', async () => {
  const { db, taskId } = setup();
  try {
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: 'ok', toolCalls: [{ id: 'r1', name: 'submit_review', input: { verdict: 'approve', notes: 'n' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_critic', taskId));
    assert.deepEqual(events.map((e) => e.event), ['plan_reviewed']);
    assert.equal((events[0]!.payload as { verdict: string }).verdict, 'approve');
    assert.equal(events[0]!.actor, 'employee:9', 'critic 必须独立于规划者(0)与实现者(7)');
    // 会话键分角色
    assert.match(fake.runs[0]!.sessionKey, /^role:critic:task:/);

    const events2: EngineEvent[] = [];
    const fake2 = makeFakeAgentRuntime([
      { text: 'no', toolCalls: [{ id: 'r2', name: 'submit_review', input: { verdict: 'revise' }, isError: false }] },
    ]);
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake2), dispatch: (e) => void events2.push(e) });
    await exec2.execute(reviewAction('dispatch_critic', taskId));
    assert.deepEqual(events2.map((e) => e.event), ['plan_reviewed', 'revise']);
  } finally {
    db.close();
  }
});

test('F-01: 规划者/实现者占满名册 → 自动补一名评审员工后继续评审（绝不自评）', async () => {
  const { db, taskId } = setup();
  try {
    // 只剩规划者(0)＋实现者(7)：没有独立 critic。2026-11-05 终验真机暴露：
    // 这里若直接升级，新手会拿到一张只有「取消任务」的死卡（D-20 的自动补评审只在建工作项阶段跑）。
    db.prepare('UPDATE employees SET active = 0 WHERE id = 9').run();
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_critic', taskId));
    assert.deepEqual(events.map((e) => e.event), ['plan_reviewed'], '补到评审后应正常评审');
    const recruited = db
      .prepare("SELECT id FROM employees WHERE active = 1 AND is_assistant = 0 AND role LIKE '%评审%'")
      .all() as Array<{ id: number }>;
    assert.equal(recruited.length, 1, '应自动补一名评审员工');
    assert.notEqual(recruited[0]!.id, 7, '评审不得由实现者兼任');
    assert.equal(fake.runs.length, 1, '评审会话必须真跑（不是自评）');
    // 2026-11-06（D4 复核）：只排除实现者不够——规划者(0)自评也会通过。必须绑到新招的评审本人。
    assert.equal(
      events[0]!.actor,
      `employee:${recruited[0]!.id}`,
      '评审必须由新招的评审员工执行（规划者/实现者都不算）',
    );
  } finally {
    db.close();
  }
});

test('F-01 边界：在职非幕僚长 ≥2 但仍无独立人选 → 升级 critic_unavailable，不招人、不自评', async () => {
  const { db, taskId } = setup();
  try {
    // 规划者=8、实现者=7：在职非幕僚长恰好 2 人（不满足「<2」→ 不自动补）；
    // 幕僚长(0)与验证者(9)停用后，pickIndependentCritic 无人可选 → 必须升级老板裁定。
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(8,'规划者','dev','standard',1)").run();
    db.prepare('UPDATE tasks SET owner_id = 8 WHERE id = ?').run(taskId);
    db.prepare('UPDATE employees SET active = 0 WHERE id IN (0, 9)').run();
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n);
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_critic', taskId));
    assert.deepEqual(events.map((e) => e.event), ['escalate'], '无人可独立评审时必须升级，不得静默通过');
    assert.equal((events[0]!.payload as { reason: string }).reason, 'critic_unavailable');
    const after = Number((db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n);
    assert.equal(after, before, '名额已满时不应再自动招评审（该由老板裁定）');
    assert.equal(fake.runs.length, 0, '无人可选时不许起会话（绝不自评）');
  } finally {
    db.close();
  }
});

test('G4-B verifier 会话：pass → verification_completed{pass}；无 verdict → escalate（绝不默认通过；BRK3 修）', async () => {
  const { db, taskId } = setup();
  try {
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v1', name: 'submit_review', input: { verdict: 'pass', notes: '证据齐' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.deepEqual(events.map((e) => e.event), ['verification_completed']);
    assert.equal((events[0]!.payload as { verdict: string }).verdict, 'pass');
    assert.equal(events[0]!.actor, 'employee:9', 'verifier 会话由 verifier_employee_id 扮演');
    assert.match(fake.runs[0]!.sessionKey, /^role:verifier:task:/);

    const events2: EngineEvent[] = [];
    const fake2 = makeFakeAgentRuntime([{ text: '想不出来', toolCalls: [] }]);
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake2), dispatch: (e) => void events2.push(e) });
    await exec2.execute(reviewAction('dispatch_verifier', taskId));
    assert.deepEqual(events2.map((e) => e.event), ['escalate'], '无 verdict 绝不默认通过；BRK3 修：派任务机真事件 `escalate`（可见决策卡）');
    assert.equal((events2[0]!.payload as { reason: string }).reason, 'no_verdict');
  } finally {
    db.close();
  }
});

test('F-02：pass + 有未完成计划步骤 + 未填 planStepsNote 交代 → 宿主改 fail（不设全 done 硬门）', async () => {
  const { db, taskId } = setup();
  try {
    insertPlanStep(db, { taskId, idx: 1, text: '搭底座', state: 'done' });
    insertPlanStep(db, { taskId, idx: 2, text: '补文档', state: 'pending' });
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v1', name: 'submit_review', input: { verdict: 'pass', notes: '产物合格' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.deepEqual(events.map((e) => e.event), ['verification_completed']);
    const payload = events[0]!.payload as { verdict: string; notes: string; unfinishedSteps: Array<{ idx: number }> };
    assert.equal(payload.verdict, 'fail', '未交代未完成步骤的 pass 必须被宿主改 fail');
    assert.match(payload.notes, /宿主校验 F-02/);
    assert.match(payload.notes, /第 2 步/);
    assert.equal(payload.unfinishedSteps.length, 1);
    // 报告也落同样口径（可审计，不只是事件）
    const row = db.prepare('SELECT verdict, payload FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as {
      verdict: string;
      payload: string;
    };
    assert.equal(row.verdict, 'fail');
    const report = JSON.parse(row.payload) as { planStepsNote: string | null; verdict: string };
    assert.equal(report.planStepsNote, null);
    assert.equal(report.verdict, 'fail');
  } finally {
    db.close();
  }
});

test('F-02：pass + 未完成步骤 + 已填 planStepsNote 交代 → 保持 pass（交代写进报告/事件）', async () => {
  const { db, taskId } = setup();
  try {
    insertPlanStep(db, { taskId, idx: 1, text: '搭底座', state: 'done' });
    insertPlanStep(db, { taskId, idx: 2, text: '补文档', state: 'running' });
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [
          {
            id: 'v1',
            name: 'submit_review',
            input: {
              verdict: 'pass',
              notes: '验收标准 3/3 有证据',
              planStepsNote: '第 2 步：running→按计划调整取消（发布不以该文档为前置），结论：不影响验收。',
            },
            isError: false,
          },
        ],
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    const payload = events[0]!.payload as { verdict: string; notes: string; planStepsNote: string; unfinishedSteps: unknown[] };
    assert.equal(payload.verdict, 'pass', '已交代时不得阻断');
    assert.equal(payload.unfinishedSteps.length, 1);
    assert.match(payload.notes, /\[计划步骤交代\]/);
    assert.match(payload.notes, /不影响验收/);
    assert.match(payload.planStepsNote, /第 2 步/);
  } finally {
    db.close();
  }
});

test('F-02：计划全部 done 时不要求 planStepsNote（pass 不被改）', async () => {
  const { db, taskId } = setup();
  try {
    insertPlanStep(db, { taskId, idx: 1, text: '搭底座', state: 'done' });
    insertPlanStep(db, { taskId, idx: 2, text: '补文档', state: 'done' });
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v1', name: 'submit_review', input: { verdict: 'pass', notes: '证据齐' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.equal((events[0]!.payload as { verdict: string }).verdict, 'pass');
    assert.doesNotMatch((events[0]!.payload as { notes: string }).notes, /宿主校验 F-02/);
  } finally {
    db.close();
  }
});

test('M3-DOC-4 P6: acceptance.check 失败=硬门——跳过 verifier 模型、落 fail 报告（模型不得翻案）', async () => {
  const { db, taskId } = setup();
  try {
    db.prepare('UPDATE projects SET root_dir = ?').run(process.cwd());
    db.prepare('UPDATE tasks SET acceptance = ? WHERE id = ?').run(
      JSON.stringify([{ text: '失败命令', check: 'node -e "process.exit(2)"' }]),
      taskId,
    );
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: '模型本来想通过', toolCalls: [{ id: 'v1', name: 'submit_review', input: { verdict: 'pass', notes: '模型通过' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.equal(fake.runs.length, 0, '硬门失败不得起 verifier 模型（省成本且不可翻案）');
    assert.deepEqual(events.map((e) => e.event), ['verification_completed']);
    assert.equal((events[0]!.payload as { verdict: string }).verdict, 'fail');
    const report = db.prepare('SELECT verdict, payload FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as
      | { verdict: string; payload: string }
      | undefined;
    assert.equal(report?.verdict, 'fail');
    assert.match(report?.payload ?? '', /机器检查未通过/);
    assert.match(report?.payload ?? '', /失败命令/);
  } finally {
    db.close();
  }
});

test('G4-B verifier 缺失（未指派/＝实现者）→ escalate（BRK3 修，原非法 `verification_blocked`），不发会话、不假装验过', async () => {
  const { db, taskId, wiId } = setup();
  try {
    db.prepare('UPDATE work_items SET verifier_employee_id = NULL WHERE id = ?').run(wiId);
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([{ text: 'x', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.deepEqual(events.map((e) => e.event), ['escalate']);
    assert.equal((events[0]!.payload as { reason: string }).reason, 'no_verifier');
    assert.equal(fake.runs.length, 0, '不得起会话');
  } finally {
    db.close();
  }
});

test('F-G4-B: verifier pass/fail 必须落 `reports.verdict` + `verifier_employee_id`（不只发事件）', async () => {
  const { db, taskId } = setup();
  try {
    // 手种一条 report（模拟 requestReview 产生的验证单）
    db.prepare("INSERT INTO reports(task_id, kind, payload, state, created_at) VALUES(?, 'report', '{}', 'pending', 1)").run(taskId);
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v9', name: 'submit_review', input: { verdict: 'pass', notes: 'ok' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    const rep = db.prepare('SELECT verdict, verifier_employee_id FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as {
      verdict: string | null;
      verifier_employee_id: number | null;
    };
    assert.equal(rep.verdict, 'pass', 'reports.verdict 必须落库');
    assert.equal(rep.verifier_employee_id, 9, 'verifier_employee_id 必须写');
    assert.equal((events[0]!.payload as { reportId: number }).reportId > 0, true, '事件带 reportId');

    // fail 同理
    const fake2 = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v10', name: 'submit_review', input: { verdict: 'fail', notes: 'no' }, isError: false }] },
    ]);
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake2), dispatch: () => undefined });
    await exec2.execute(reviewAction('dispatch_verifier', taskId));
    assert.equal(
      (db.prepare('SELECT verdict FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { verdict: string }).verdict,
      'fail',
    );

    // 无 report 存在 → 也必须先建后写（verdict 不落空地）
    const { db: db2, taskId: t2 } = setup();
    const fake3 = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'v11', name: 'submit_review', input: { verdict: 'pass' }, isError: false }] },
    ]);
    const exec3 = createEmployeeExecutor({ db: db2, runtime: new EmployeeSessionRuntime(fake3), dispatch: () => undefined });
    await exec3.execute(reviewAction('dispatch_verifier', t2));
    const r2 = db2.prepare('SELECT verdict FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(t2) as { verdict: string | null };
    assert.equal(r2.verdict, 'pass', '无既有 report 时也应落 verdict');
    db2.close();
  } finally {
    db.close();
  }
});

test('G4 "有牙": 会话没调 submit_review → critic 也走 escalate（而不是被当成 approve；BRK3 修：真事件名）', async () => {
  const { db, taskId } = setup();
  try {
    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([{ text: '我看看（但没提交结论）', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(reviewAction('dispatch_critic', taskId));
    assert.deepEqual(events.map((e) => e.event), ['escalate']);
  } finally {
    db.close();
  }
});

test('M3-CR：每次 verifier 验证独立 report（fail→pass 不复写历史）', async () => {
  const { db, taskId } = setup();
  try {
    const failFake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'vf1', name: 'submit_review', input: { verdict: 'fail', notes: '第一次失败' }, isError: false }] },
    ]);
    const failExec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(failFake), dispatch: () => undefined });
    await failExec.execute(reviewAction('dispatch_verifier', taskId));

    const passFake = makeFakeAgentRuntime([
      { text: '', toolCalls: [{ id: 'vf2', name: 'submit_review', input: { verdict: 'pass', notes: '返工后通过' }, isError: false }] },
    ]);
    const passExec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(passFake), dispatch: () => undefined });
    await passExec.execute(reviewAction('dispatch_verifier', taskId));

    const rows = db
      .prepare('SELECT id, verdict, payload FROM reports WHERE task_id = ? ORDER BY id')
      .all(taskId) as Array<{ id: number; verdict: string | null; payload: string }>;
    assert.equal(rows.length, 2, '两次验证必须两条 report，不能复用同一行');
    assert.deepEqual(rows.map((r) => r.verdict), ['fail', 'pass'], '历史 fail 不能被改写成 pass');
    assert.match(rows[0]!.payload, /第一次失败/);
    assert.match(rows[1]!.payload, /返工后通过/);
    assert.ok(
      (db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'review_completed'").get(taskId) as { n: number }).n >= 2,
      '每次验证落 review_completed',
    );
  } finally {
    db.close();
  }
});

test('S1 回归：verifier submit_review 成功后 terminated → 仍落 verification_completed{pass}', async () => {
  const { db, taskId } = setup();
  try {
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(_input: unknown, onEvent: (e: unknown) => void): Promise<never> {
        onEvent({
          type: 'tool_call_start',
          toolCallId: 'v-terminated',
          toolName: 'submit_review',
          input: { verdict: 'pass', notes: '证据齐（terminated 前已提交）' },
        });
        onEvent({ type: 'tool_call_end', toolCallId: 'v-terminated', toolName: 'submit_review', isError: false });
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
    await exec.execute(reviewAction('dispatch_verifier', taskId));
    assert.deepEqual(events.map((e) => e.event), ['verification_completed'], '提交后 terminated 不得吞掉验证结论');
    assert.equal((events[0]!.payload as { verdict: string }).verdict, 'pass');
    assert.equal(events[0]!.actor, 'employee:9');
  } finally {
    db.close();
  }
});
