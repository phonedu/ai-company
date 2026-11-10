/**
 * （模型无关部分）测试：幕僚长会话运行时 + 工具事件落库 + plan_steps 投影。
 * 用 fake AgentRuntime，不花真金、不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask,
  listHumanMessages,
  listPlanSteps,
  listTaskEvents,
  openMemoryDatabase,
  planStepProgress,
  runMigrations,
  SqliteCounterStore,
  upsertPlanStepsFromDraft,
  type SqliteDb,
} from '../src/main/db/index.js';
import { AssistantRuntime, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import type { RunGateContext, SessionToolGate } from '../src/main/agent/session-tool-gate.js';

function fresh(): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('p', 'D:/tmp/p', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '幕僚长用例',
    goal: 'g',
  });
  return { db, taskId: task.id };
}

test('T0.4: 一轮对话落 human_messages(out)，text_delta 推流不落库', async () => {
  const { db, taskId } = fresh();
  try {
    const runtime = makeFakeAgentRuntime([{ text: '收到，我来安排。', toolCalls: [] }]);
    const deltas: string[] = [];
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 100, onTextDelta: (d) => deltas.push(d) });

    const turn = await assistant.runTurn({ text: '帮我做一个周报', taskId });
    assert.equal(turn.reply, '收到，我来安排。');
    assert.deepEqual(deltas, ['收到，我来安排。']);

    const out = listHumanMessages(db, { taskId }).filter((m) => m.direction === 'out');
    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, '收到，我来安排。');
    assert.equal(out[0]?.id, turn.replyMessageId);

    // text_delta 不产生 task_events
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'tool_call').length, 0);
  } finally {
    db.close();
  }
});

test('T0.4: tool_call（start/end）落 task_events.kind=tool_call', async () => {
  const { db, taskId } = fresh();
  try {
    const runtime = makeFakeAgentRuntime([
      {
        text: '已查阅。',
        toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' }, isError: false }],
      },
    ]);
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 200 });
    await assistant.runTurn({ text: '看看 a.txt', taskId });

    const toolEvents = listTaskEvents(db, taskId).filter((e) => e.kind === 'tool_call');
    assert.equal(toolEvents.length, 2, 'start + end 各一条');
    assert.deepEqual(
      toolEvents.map((e) => JSON.parse(e.payload).phase),
      ['start', 'end'],
    );
    const startPayload = JSON.parse(toolEvents[0]!.payload) as { toolName: string; input: unknown };
    assert.equal(startPayload.toolName, 'read_file');
    assert.deepEqual(startPayload.input, { path: 'a.txt' });
  } finally {
    db.close();
  }
});

test('T0.4: report_progress → progress_reported 事件 + plan_steps 投影（进度条源）', async () => {
  const { db, taskId } = fresh();
  try {
    upsertPlanStepsFromDraft(db, taskId, ['收集资料', '写初稿', '校对'], 1);
    assert.deepEqual(planStepProgress(db, taskId), { done: 0, total: 3 });

    const runtime = makeFakeAgentRuntime([
      {
        text: '第一步完成。',
        toolCalls: [{ id: 'p1', name: 'report_progress', input: { stepIdx: 1, state: 'done', note: '资料齐了' }, isError: false }],
      },
    ]);
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 300 });
    await assistant.runTurn({ text: '报告进度', taskId });

    const steps = listPlanSteps(db, taskId);
    assert.equal(steps.find((s) => s.idx === 1)?.state, 'done');
    assert.equal(steps.find((s) => s.idx === 2)?.state, 'pending');
    assert.deepEqual(planStepProgress(db, taskId), { done: 1, total: 3 });

    const progressEvents = listTaskEvents(db, taskId).filter((e) => e.kind === 'progress_reported');
    assert.equal(progressEvents.length, 1);
    assert.deepEqual(JSON.parse(progressEvents[0]!.payload), { stepIdx: 1, state: 'done', note: '资料齐了' });
  } finally {
    db.close();
  }
});

test('T0.4: report_progress 参数非法 → 不静默（end 事件标 error），且回复仍落库', async () => {
  const { db, taskId } = fresh();
  try {
    upsertPlanStepsFromDraft(db, taskId, ['步骤一'], 1);
    const runtime = makeFakeAgentRuntime([
      {
        text: '我试试。',
        toolCalls: [{ id: 'bad', name: 'report_progress', input: { stepIdx: 1, state: '乱写' }, isError: false }],
      },
    ]);
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 400 });
    await assistant.runTurn({ text: '报个进度', taskId });

    const ends = listTaskEvents(db, taskId).filter(
      (e) => e.kind === 'tool_call' && JSON.parse(e.payload).phase === 'end',
    );
    assert.equal(ends.length, 1);
    const payload = JSON.parse(ends[0]!.payload) as { isError: boolean; error?: string };
    assert.equal(payload.isError, true, '非法参数应标 isError');
    assert.match(payload.error ?? '', /report_progress\.state 非法/);
    // 无 progress_reported 事件、plan_steps 未变
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'progress_reported').length, 0);
    assert.equal(listPlanSteps(db, taskId)[0]?.state, 'pending');
    // 回复仍落库
    assert.equal(listHumanMessages(db, { taskId }).filter((m) => m.direction === 'out').length, 1);
  } finally {
    db.close();
  }
});

test('T0.4: 无任务上下文（全局对话）不写 task_events，但仍落 out 消息', async () => {
  const { db } = fresh();
  try {
    const runtime = makeFakeAgentRuntime([
      { text: '你好呀。', toolCalls: [{ id: 'g1', name: 'report_progress', input: { stepIdx: 1, state: 'done' }, isError: false }] },
    ]);
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 500 });
    await assistant.runTurn({ text: '你好' }); // 无 taskId
    assert.equal(listHumanMessages(db).filter((m) => m.direction === 'out').length, 1);
    // 全局对话没有 task 上下文 → 不产生 tool_call / progress_reported 事件
    assert.equal(
      (db.prepare("SELECT count(*) c FROM task_events WHERE kind IN ('tool_call','progress_reported')").get() as { c: number }).c,
      0,
    );
  } finally {
    db.close();
  }
});

test('T0.4: steer 透传到会话运行时', () => {
  const { db } = fresh();
  try {
    const runtime = makeFakeAgentRuntime([]);
    const assistant = new AssistantRuntime({ db, runtime, sessionKey: 'boss-channel:assistant' });
    assert.equal(assistant.steer('先停一下'), true);
    assert.deepEqual(runtime.steers, [{ sessionKey: 'boss-channel:assistant', text: '先停一下' }]);
    assistant.dispose();
    assert.equal(runtime.disposed, true);
  } finally {
    db.close();
  }
});

test('OPT-M3-1: request_review 工具 → 落 review_requested 事件（信号→宿主落库）', async () => {
  const { db, taskId } = fresh();
  try {
    const runtime = makeFakeAgentRuntime([
      { text: '已请求复核。', toolCalls: [{ id: 'rv1', name: 'request_review', input: { reason: '检查边界' }, isError: false }] },
    ]);
    const assistant = new AssistantRuntime({ db, runtime, clock: () => 600 });
    await assistant.runTurn({ text: '请复核', taskId });
    const events = listTaskEvents(db, taskId).filter((e) => e.kind === 'review_requested');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.payload), { reason: '检查边界' });
  } finally {
    db.close();
  }
});

test('D-19: 幕僚长按项目根设 cwd/gate；无项目用应用 cwd＋sandbox 只读', async () => {
  const { db, taskId } = fresh();
  try {
    const projectId = Number((db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: number }).project_id);
    const seen: Array<{ id: string; ctx: RunGateContext }> = [];
    const cleared: string[] = [];
    const fakeGate = {
      setRun: (id: string, ctx: RunGateContext) => seen.push({ id, ctx }),
      clearRun: (id: string) => cleared.push(id),
    } as unknown as SessionToolGate;
    const runs: Array<{ sessionKey: string; cwd?: string }> = [];
    const runtime = {
      async run(input: { sessionKey: string; cwd?: string }) {
        runs.push(input);
        return { text: 'ok', toolCalls: [] };
      },
      steer: () => false,
      sessionIdFor: ({ sessionKey, cwd }: { sessionKey: string; cwd?: string }) => `${sessionKey}@${cwd}`,
      dispose: () => undefined,
    };
    const assistant = new AssistantRuntime({
      db,
      runtime: runtime as never,
      cwd: 'D:/app',
      toolGate: fakeGate,
      clock: () => 1,
    });

    await assistant.runTurn({ text: '项目内', projectId });
    assert.equal(runs[0]!.cwd, 'D:/tmp/p', '有项目：cwd＝项目根');
    assert.equal(seen[0]!.ctx.projectRoot, 'D:/tmp/p');
    assert.equal(seen[0]!.ctx.capabilityTier, 'standard');
    assert.equal(seen[0]!.ctx.projectId, projectId);

    await assistant.runTurn({ text: '无项目' });
    assert.equal(runs[1]!.cwd, 'D:/app', '无项目：cwd＝应用目录');
    assert.equal(seen[1]!.ctx.capabilityTier, 'sandbox', '无项目：sandbox（只读）');
    assert.equal(seen[1]!.ctx.projectId, null);
    assert.deepEqual(cleared, ['boss-channel:assistant@D:/tmp/p', 'boss-channel:assistant@D:/app']);
  } finally {
    db.close();
  }
});
