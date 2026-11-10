/**
 * （57 D 路 P1）：LLM 故障零退避、预算预检只覆盖规划派发、未定价模型成本被当 $0 的回归测试。
 *
 * 旧实现：
 *  - `runSessionWithFallback` 链内**立即**换模型重跑——单供应商一次 5 分钟限流打满整条链，任务直接失败；
 *  - 规划派发有预算预检，但工作项 `dispatch` 没有 ⇒ 预算见底后仍开新会话烧钱；
 *  - `costUsd ?? 0`：未定价模型的花费显示为 $0，美元预算闸形同虚设且无告警。
 *
 * 新口径：链内指数退避（`AICO_LLM_BACKOFF_MS` 基值可配，0=关）；dispatch 动作也做预算预检（不足→escalate）；
 * 未定价用量写 `cost_unpriced` 事件＋日志（不静默当 0）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  listCosts,
  listReports,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor, toPersistedAction } from '../src/main/engine/index.js';
import {
  EmployeeSessionRuntime,
  createEmployeeExecutor,
  makeFakeAgentRuntime,
} from '../src/main/agent/index.js';
import { providerBackoffMs, setFallbackChain } from '../src/main/agent/model-policy.js';
import type { AgentEvent, AgentRunInput, AgentRunResult, AgentRuntime } from '../src/main/agent/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';

type AgentEventLike = EngineEvent;

test('B0-11：退避序列指数增长、有上限、可配 0 关闭', () => {
  const saved = process.env.AICO_LLM_BACKOFF_MS;
  try {
    delete process.env.AICO_LLM_BACKOFF_MS;
    assert.deepEqual([0, 1, 2, 3, 4, 9].map((h) => providerBackoffMs(h)), [500, 1000, 2000, 4000, 8000, 8000]);
    process.env.AICO_LLM_BACKOFF_MS = '10';
    assert.deepEqual([0, 1, 2].map((h) => providerBackoffMs(h)), [10, 20, 40]);
    process.env.AICO_LLM_BACKOFF_MS = '0';
    assert.equal(providerBackoffMs(3), 0, '0＝关闭退避（测试/特殊装配）');
    process.env.AICO_LLM_BACKOFF_MS = 'oops';
    assert.equal(providerBackoffMs(0), 500, '非法 env 回落默认');
  } finally {
    if (saved == null) delete process.env.AICO_LLM_BACKOFF_MS;
    else process.env.AICO_LLM_BACKOFF_MS = saved;
  }
});

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

test('B0-11：限流（429）→ 等待后换链重试，最终成功（不再一次打满整链就失败）', async () => {
  const { db, taskId, wiId } = setup();
  const savedBackoff = process.env.AICO_LLM_BACKOFF_MS;
  process.env.AICO_LLM_BACKOFF_MS = '5';
  setFallbackChain(['deepseek/deepseek-v4-pro']);
  let calls = 0;
  const flaky: AgentRuntime = {
    async run(_input: AgentRunInput): Promise<AgentRunResult> {
      calls += 1;
      if (calls === 1) throw new Error('429 rate limit exceeded');
      return {
        text: '',
        toolCalls: [{ id: 's1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
      };
    },
    steer: () => true,
    dispose: () => undefined,
  };
  try {
    const events: AgentEventLike[] = [];
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(flaky),
      dispatch: (e) => void events.push(e),
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, JSON.stringify({ attempt: 0 })));
    assert.equal(calls, 2, '第一次 429 后必须换链重试一次（旧实现也会重试，但无退避；此断言锁住成功路径）');
    const fallback = listTaskEvents(db, taskId).filter((e) => e.kind === 'agent_model_fallback');
    assert.equal(fallback.length, 1, '降级必须留痕（模型从主档换到链上档）');
    assert.ok(events.some((e) => e.event === 'submit_work_item'), '重试成功后正常提交');
  } finally {
    if (savedBackoff == null) delete process.env.AICO_LLM_BACKOFF_MS;
    else process.env.AICO_LLM_BACKOFF_MS = savedBackoff;
    setFallbackChain([]);
    db.close();
  }
});

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

test('B0-11：dispatch 动作也做预算预检——不足时不开新会话、出决策卡', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const recorder = makeRecordingExecutor();
    const engine = new Engine(db, recorder, { now: () => 1000 });
    await engine.dispatch(ev(taskId, 'triage')); // 规划前预检：此刻无预算 ⇒ 放行
    // 规划完成后预算见底：执行派发必须被拦住（旧实现无 dispatch 预检）。
    db.prepare('UPDATE tasks SET budget_tokens = 1000, cost_tokens = 950 WHERE id = ?').run(taskId);
    await engine.dispatch(ev(taskId, 'plan_drafted')); // L0 → executing + plan_work_items/dispatch
    const wi = getWorkItem(db, wiId);
    assert.equal(wi?.state, 'queued', '预算不足时件保持 queued（可见等待，不先迁 running 再挂死）');
    assert.ok(
      !recorder.state.calls.some((c) => c.startsWith('dispatch:work_item:')),
      `预算不足不得开执行会话（实际动作：${JSON.stringify(recorder.state.calls)}）`,
    );
    assert.equal(engine.dispatchHold(wiId)?.reason, 'budget', '等待原因必须是 budget（UI 可解释）');
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'needs_decision', '必须停下问老板（escalate），而不是继续烧');
    const asks = listReports(db).filter((r) => r.kind === 'ask');
    assert.ok(asks.length >= 1, '预算不足必须有决策卡（不是静默排队）');
  } finally {
    db.close();
  }
});

test('B0-11：未定价模型（无 costUsd）写 cost_unpriced 事件，不静默当 $0', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [{ id: 's1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
        usage: { model: 'mystery-model', inputTokens: 20, outputTokens: 5 },
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, JSON.stringify({ attempt: 0 })));
    const unpriced = listTaskEvents(db, taskId).filter((e) => e.kind === 'cost_unpriced');
    assert.equal(unpriced.length, 1, '未定价用量必须留痕（模型名＋token）');
    const payload = JSON.parse(unpriced[0]!.payload) as { model?: string; tokens?: number };
    assert.equal(payload.model, 'mystery-model');
    assert.equal(payload.tokens, 25);
    const costs = listCosts(db, taskId);
    assert.equal(costs.length, 1, '成本行仍要落（tokens 事实不能丢）');
    assert.equal(costs[0]!.usd, 0, 'USD 仍是 0（未定价），但事件已告警');
  } finally {
    db.close();
  }
});
