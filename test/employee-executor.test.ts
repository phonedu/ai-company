/**
 *  · 员工真会话执行器 + 会话生命周期（RC-1/RC-4）。
 * 口径：work_item `dispatch` → 员工会话；`submit_work_item` 才提交；未提交 `agent_settled`→failed（含最后输出）；
 * `ask_colleague` → mailbox。每条断言可被弄红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listNotifications,
  listPlanSteps,
  listTaskEvents,
  openMemoryDatabase,
  replacePlanSteps,
  runMigrations,
  setProjectModelPolicy,
  type SqliteDb,
} from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import {
  EmployeeSessionRuntime,
  createEmployeeExecutor,
  employeeSessionKey,
  makeFakeAgentRuntime,
  parseDispatchAction,
} from '../src/main/agent/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number, attempt = 0) =>
  toPersistedAction(`dispatch:work_item:${wiId}:${attempt}`, 'dispatch', taskId, JSON.stringify({ attempt }));

test('OPT-AI-1: 会话调 submit_work_item → 引擎事件 submit_work_item（payload 带结果）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      { text: 'done!', toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }] },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'submit_work_item');
    // 宿主侧**归一化后**再落 payload（trim ＋ 空数组缺省 ＋ 契约外字段进 extra）
    assert.deepEqual(events[0]!.payload, {
      result: { summary: 'ok', artifacts: [], evidence: [], assumptions: [], unclosed: [], extra: {} },
    });
    // 会话输入：sessionKey 按员工×任务×工作项；cwd = 项目根
    assert.equal(fake.runs[0]!.sessionKey, employeeSessionKey({ employeeId: 7, taskId, workItemId: wiId }));
    assert.ok(fake.runs[0]!.cwd);
    assert.ok(fake.runs[0]!.systemPrompt && fake.runs[0]!.prompt);
  } finally {
    db.close();
  }
});

test('D-22 assistant: LLM 选型结果进入员工会话，并写 model_selected 理由', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const projectId = Number((db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number }).id);
    setProjectModelPolicy(db as never, {
      projectId,
      policy: 'assistant',
      defaultModel: 'deepseek/deepseek-flash',
      allowedModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
    });
    const fake = makeFakeAgentRuntime([
      { text: 'done', toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }] },
    ]);
    let asked = 0;
    let seenSelector = '';
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: () => undefined,
      assistantCandidates: () => [
        { model: 'deepseek/deepseek-flash', contextWindow: 1_000_000, reasoning: false, inputCost: 0.3, outputCost: 1.2 },
        { model: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000, reasoning: true, inputCost: 1.32, outputCost: 3.96 },
      ],
      chooseAssistantModel: async (choiceInput) => {
        asked += 1;
        seenSelector = choiceInput.selectorModel ?? '';
        return { model: 'deepseek/deepseek-v4-pro', reason: '核心模块改动' };
      },
    });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(fake.runs[0]!.model, 'deepseek/deepseek-v4-pro', 'LLM 选择覆盖 L0 规则（否则会选便宜档）');
    assert.equal(asked, 1, '同任务同角色只问一次');
    assert.equal(seenSelector, 'deepseek/deepseek-flash', '选型调用使用项目默认（边界内）');
    const selected = listTaskEvents(db, taskId).find((e) => e.kind === 'model_selected');
    const payload = selected ? (JSON.parse(selected.payload) as { source?: string; reason?: string }) : undefined;
    assert.equal(payload?.source, 'assistant');
    assert.match(payload?.reason ?? '', /幕僚长：核心模块改动/);
  } finally {
    db.close();
  }
});

test('D-22: 选择期 Key 缺 → 派发前硬拒（会话不启动，错误带 API Key 原因）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([{ text: 'should not run', toolCalls: [] }]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: (e) => void events.push(e),
      modelKeyConfigured: () => false,
    });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(fake.runs.length, 0, 'Key 硬拒发生在会话启动前');
    const error = events.find((e) => e.scope === 'work_item' && e.event === 'error');
    assert.ok(error, 'Key 硬拒必须落工作项 error（可见），不能只抛给引擎');
    assert.match(String((error?.payload as { reason?: string })?.reason ?? ''), /未配置 API Key/);
  } finally {
    db.close();
  }
});

test('D-22: 规划硬拒走 task escalate（决策卡），不启动会话', async () => {
  const { db, taskId } = setup();
  try {
    db.prepare("UPDATE projects SET model_policy='fixed', default_model='openai/gpt-5', allowed_models='[\"openai/gpt-5\"]' WHERE id=1").run();
    const fake = makeFakeAgentRuntime([{ text: 'should not run', toolCalls: [] }]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: (e) => void events.push(e),
      modelKeyConfigured: () => false,
    });
    await exec.execute(toPersistedAction(`dispatch_planning:task:${taskId}:0`, 'dispatch_planning', taskId, '{}'));
    assert.equal(fake.runs.length, 0, '规划硬拒不得启动会话');
    const escalate = events.find((e) => e.scope === 'task' && e.event === 'escalate');
    assert.ok(escalate, '规划硬拒必须 escalate（决策卡），不能停在 planning');
    const payload = escalate?.payload as { reason?: string; notifyRevision?: number } | undefined;
    assert.match(payload?.reason ?? '', /未配置 API Key/);
  } finally {
    db.close();
  }
});

test('F-2 断网：规划会话连接层错误（Connection error.）→ task error 可见，不停 planning', async () => {
  const { db, taskId } = setup();
  try {
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(): Promise<never> {
        throw new Error('Connection error.');
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
      modelKeyConfigured: () => true,
    });
    await exec.execute(toPersistedAction(`dispatch_planning:task:${taskId}:0`, 'dispatch_planning', taskId, '{}'));
    const error = events.find((e) => e.scope === 'task' && e.event === 'error');
    assert.ok(error, '连接层错误必须落 task error（异常卡），不能只留 action_failed 停在 planning');
    assert.match(String((error?.payload as { reason?: string })?.reason ?? ''), /Connection error/);
  } finally {
    db.close();
  }
});

test('提交成功后 SDK terminated：件已 submitted → 不再误写 failed（verifier 才能派）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(): Promise<never> {
        db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(wiId);
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
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(events.length, 0, '不得再派 error 事件');
    assert.equal((db.prepare('SELECT state FROM work_items WHERE id=?').get(wiId) as { state: string }).state, 'submitted');
  } finally {
    db.close();
  }
});

test('S1 回归：submit 工具已成功、随后 terminated，但提交事件尚未落库 → 不得写 failed，补发 submit_work_item', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(_input: unknown, onEvent: (e: unknown) => void): Promise<never> {
        onEvent({
          type: 'tool_call_start',
          toolCallId: 'submit-1',
          toolName: 'submit_work_item',
          input: { summary: 'ok after terminate' },
        });
        onEvent({
          type: 'tool_call_end',
          toolCallId: 'submit-1',
          toolName: 'submit_work_item',
          isError: false,
        });
        // 模拟宿主尚未来得及把 submitted 事件落库，SDK 就抛 terminated。
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
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(events.length, 1, '必须且只补发一次提交，不得再派 error/agent_settled');
    assert.equal(events[0]!.event, 'submit_work_item');
    assert.equal((events[0]!.payload as { result: { summary: string } }).result.summary, 'ok after terminate');
    assert.notEqual(
      (db.prepare('SELECT state FROM work_items WHERE id=?').get(wiId) as { state: string }).state,
      'failed',
      '测试注入的 dispatch 不改库；关键是不得写 failed',
    );
  } finally {
    db.close();
  }
});

test('S1 回归负例：submit 工具失败后 terminated → 仍走失败回写（不得误判为提交）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const runtime = {
      runs: [] as unknown[],
      steers: [] as unknown[],
      disposed: false,
      async run(_input: unknown, onEvent: (e: unknown) => void): Promise<never> {
        onEvent({
          type: 'tool_call_start',
          toolCallId: 'submit-1',
          toolName: 'submit_work_item',
          input: { summary: 'bad' },
        });
        onEvent({
          type: 'tool_call_end',
          toolCallId: 'submit-1',
          toolName: 'submit_work_item',
          isError: true,
        });
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
    await exec.execute(dispatchAction(taskId, wiId));
    assert.ok(events.some((e) => e.scope === 'work_item' && e.event === 'error'), '失败的 submit 不得被当成提交');
    assert.ok(!events.some((e) => e.event === 'submit_work_item'), '不得补发提交');
  } finally {
    db.close();
  }
});

test('MiMo 实测兜底：首次只回文字、无提交 → 自动补一次「现在提交」回合（只一次）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime((_input, index) =>
      index === 0
        ? { text: '15 × 3 = 45。', toolCalls: [] }
        : { text: '已提交', toolCalls: [{ id: 'n1', name: 'submit_work_item', input: { summary: '15×3=45' }, isError: false }] },
    );
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(fake.runs.length, 2, '只补一次（不无限重试）');
    assert.match(fake.runs[1]!.prompt, /系统提醒[\s\S]*submit_work_item/, '第二次带明确提交提醒');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'submit_work_item', '补提交后按正常提交回写');
    assert.equal((events[0]!.payload as { result: { summary: string } }).result.summary, '15×3=45');
  } finally {
    db.close();
  }
});

test('OPT-AI-1: 未调 submit_work_item → agent_settled{submitted:false, lastOutput}（失败可见、不静默）', async () => {  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([{ text: '我卡住了，没做完', toolCalls: [] }]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'agent_settled');
    assert.equal((events[0]!.payload as { submitted: boolean }).submitted, false);
    assert.match(String((events[0]!.payload as { lastOutput: string }).lastOutput), /卡住了/);
  } finally {
    db.close();
  }
});

test('OPT-AI-1: 会话调 ask_colleague → 走 mailbox（question_asked 事件 + notifications 行，不进人类频道）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'a1', name: 'ask_colleague', input: { to: 9, question: '契约用 v2 吗？' }, isError: false },
          { id: 'a2', name: 'submit_work_item', input: { summary: 'asked' }, isError: false },
        ],
      },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    const asked = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 1);
    assert.equal((JSON.parse(asked[0]!.payload) as { question: string }).question, '契约用 v2 吗？');
    assert.equal(listNotifications(db, { channel: 'employee:9' }).length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM human_messages').get() as { n: number }).n, 0);
    assert.equal(events[0]!.event, 'submit_work_item');
  } finally {
    db.close();
  }
});

test('OPT-AI-1: parseDispatchAction 边界 —— 只接管 work_item dispatch；任务级/其它 → null', () => {
  const t = parseDispatchAction(dispatchAction(5, 42));
  assert.deepEqual(t, { workItemId: 42, taskId: 5, employeeId: -1, attempt: 0 });
  assert.equal(parseDispatchAction(toPersistedAction('dispatch_planning:task:5:0', 'dispatch_planning', 5, '{}')), null);
  assert.equal(parseDispatchAction(toPersistedAction('dispatch_critic:task:5:0', 'dispatch_critic', 5, '{}')), null);
  assert.equal(parseDispatchAction(toPersistedAction('notify_report:task:5:0', 'notify_report', 5, '{}')), null);
  assert.equal(parseDispatchAction(toPersistedAction('dispatch:work_item:9:0', 'dispatch', null, '{}')), null);
});

test('OPT-AI-1: 会话键稳定且按工作项隔离（重试复用同键）', () => {
  const a = employeeSessionKey({ employeeId: 7, taskId: 1, workItemId: 2 });
  assert.equal(a, employeeSessionKey({ employeeId: 7, taskId: 1, workItemId: 2 }));
  assert.notEqual(a, employeeSessionKey({ employeeId: 7, taskId: 1, workItemId: 3 }));
  assert.notEqual(a, employeeSessionKey({ employeeId: 8, taskId: 1, workItemId: 2 }));
});

test('OPT-AI-1 "有牙": 去掉 submit 分支 → 已提交的会话也被判失败（证明断言有意义）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // 合成：模拟"submit 分支被删"（把 submit 视作未提交）→ 事件变成 agent_settled。
    // 注意：输入必须是**合法提交**——空 `{}` 现在会走校验失败路径，测不到"分支在场"。
    const fake = makeFakeAgentRuntime([
      { text: 'x', toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }] },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.notEqual(events[0]!.event, 'agent_settled', '有提交时应是 submit_work_item，而非 agent_settled');
  } finally {
    db.close();
  }
});

test('OPT-AI-7 宿主兜底 "有牙"：非法提交（无 summary）→ agent_settled ＋ submissionErrors 点名（不静默收下）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      { text: 'x', toolCalls: [{ id: 't1', name: 'submit_work_item', input: {}, isError: false }] },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(events[0]!.event, 'agent_settled', '非法提交不得进入 submitted');
    const errors = (events[0]!.payload as { submissionErrors?: string[] }).submissionErrors ?? [];
    assert.ok(
      errors.some((e) => e.includes('summary 必填')),
      `submissionErrors 应点名「summary 必填」，实际 ${JSON.stringify(errors)}`,
    );
  } finally {
    db.close();
  }
});

// ── （挂载 1 余）：员工侧 `report_progress` / `request_review` 的**宿主消费者** ──
// 此前两工具在员工会话注册、回执承诺"宿主会投影/指派"，但执行器只消费
// submit_work_item/ask_colleague/escalate_to_boss ⇒ 报进度静默丢弃、进度条不动、回执是假承诺。

test('BRK5: 员工会话调 report_progress → `progress_reported` 事件 ＋ `plan_steps` 真投影（进度条动）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    replacePlanSteps(db, taskId, ['第一步', '第二步'], 1);
    const fake = makeFakeAgentRuntime([
      {
        text: 'ok',
        toolCalls: [
          { id: 'g1', name: 'report_progress', input: { stepIdx: 2, state: 'done', note: '做完了' }, isError: false },
          { id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false },
        ],
      },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));

    const steps = listPlanSteps(db, taskId);
    assert.equal(steps[1]!.state, 'done', '第 2 步必须真进 done（进度条源）——此前无消费者＝工具回执是假承诺');
    assert.equal(steps[0]!.state, 'pending', '第 1 步不受影响');
    const prog = listTaskEvents(db, taskId).find((e) => e.kind === 'progress_reported');
    assert.ok(prog, '`progress_reported` 事件必须落库（审计可见；与幕僚长侧同一投影口径）');
    assert.equal(prog!.actor, 'employee:7', 'actor＝员工（不是 assistant）');
    assert.deepEqual(JSON.parse(prog!.payload), { stepIdx: 2, state: 'done', note: '做完了' });
    assert.deepEqual(events.map((e) => e.event), ['submit_work_item'], '投影不阻断提交');
  } finally {
    db.close();
  }
});

test('BRK5: 员工会话调 request_review → `review_requested` 事件落库（actor＝员工；不再是假承诺）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: 'ok',
        toolCalls: [
          { id: 'r1', name: 'request_review', input: { reason: '核对边界用例' }, isError: false },
          { id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false },
        ],
      },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));

    const rr = listTaskEvents(db, taskId).find((e) => e.kind === 'review_requested');
    assert.ok(rr, '`review_requested` 事件必须落库——「请求独立验证」由此可见；强制度仍按 risk_level（v1 口径）');
    assert.equal(rr!.actor, 'employee:7', 'actor＝员工（不是 assistant）');
    assert.equal((JSON.parse(rr!.payload) as { reason?: string }).reason, '核对边界用例');
    assert.deepEqual(events.map((e) => e.event), ['submit_work_item'], '落事件不阻断提交');
  } finally {
    db.close();
  }
});

test('BRK5 "有牙"：report_progress 参数非法 → 不投影 ＋ tool_call 标 error（响亮）＋ 不阻断提交', async () => {
  const { db, taskId, wiId } = setup();
  try {
    replacePlanSteps(db, taskId, ['第一步'], 1);
    const fake = makeFakeAgentRuntime([
      {
        text: 'ok',
        toolCalls: [
          { id: 'g-bad', name: 'report_progress', input: { stepIdx: 0, state: 'done' }, isError: false },
          { id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false },
        ],
      },
    ]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));

    assert.equal(listPlanSteps(db, taskId)[0]!.state, 'pending', '非法参数不得改动 plan_steps');
    assert.equal(
      listTaskEvents(db, taskId).some((e) => e.kind === 'progress_reported'),
      false,
      '非法参数不得落 progress_reported（不吞错、也不假装上报成功）',
    );
    const errEvent = listTaskEvents(db, taskId).find((e) => {
      if (e.kind !== 'tool_call') return false;
      try {
        return (JSON.parse(e.payload) as { isError?: boolean }).isError === true;
      } catch {
        return false;
      }
    });
    assert.ok(errEvent, '非法投影必须**响亮**（tool_call 标 error，与幕僚长侧同口径）——不得静默吞掉');
    assert.match(String((JSON.parse(errEvent!.payload) as { error?: string }).error), /stepIdx/);
    assert.deepEqual(events.map((e) => e.event), ['submit_work_item'], '响亮不阻断：提交照常');
  } finally {
    db.close();
  }
});

// ── RET-1 RET-：员工 tool_call_start 落库（白名单/截断） ──

test('RET-F-08: 员工 tool_call_start 落 task_events，只留 command/path 等白名单字段（不上传 content/密钥）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: 'done',
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            input: { command: 'rg needle src', path: 'src/a.ts', content: 'x'.repeat(2000), apiKey: 'sk-secret' },
            isError: false,
          },
          { id: 't2', name: 'submit_work_item', input: { summary: 'ok' }, isError: false },
        ],
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId));
    const starts = listTaskEvents(db, taskId)
      .filter((e) => e.kind === 'tool_call')
      .map((e) => JSON.parse(e.payload) as { phase?: string; toolName?: string; input?: Record<string, string> })
      .filter((p) => p.phase === 'start' && p.toolName === 'bash');
    assert.equal(starts.length, 1, '每次工具调用一条 start 事件');
    assert.deepEqual(starts[0]!.input, { command: 'rg needle src', path: 'src/a.ts' }, '只留白名单字段');
    assert.equal(JSON.stringify(starts[0]!.input).includes('sk-secret'), false, '不得落密钥');
    assert.equal(JSON.stringify(starts[0]!.input).includes('xxxx'), false, '不得落 content');
  } finally {
    db.close();
  }
});
