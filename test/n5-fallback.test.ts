/**
 * N5 余账（2026-10-16）· **运行时兜底链**——主模型不可用（401/429/5xx/模型不存在…）⇒ 按
 * `models.fallback_chain` 逐级降级（≤5）＋**降级记事件**（`agent_model_fallback`）；非分类错误不降级。
 *
 * 口径＝08 §10.3「主模型不可用（故障/限流/Key 失效）→ 自动降级到下一个，降级记事件」。
 * 真库（内存）＋真执行器；runtime 用可控抛错假件；只断事实（调用序列/事件行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTask, insertWorkItem, openMemoryDatabase, runMigrations, SqliteCounterStore, type SqliteDb } from '../src/main/db/index.js';
import { Engine, toPersistedAction } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskTransition } from '../src/main/ipc/ipc.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, parseDispatchAction } from '../src/main/agent/index.js';
import { normalModelName, setFallbackChain } from '../src/main/agent/model-policy.js';
import type { AgentRunInput, AgentRunResult, AgentRuntime } from '../src/main/agent/types.js';
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

/** 可控假件：前 N 次调用抛指定错，之后返回成功（含一次合法提交）。 */
function makeFlakyRuntime(failures: string[]): { runtime: AgentRuntime; runs: string[] } {
  const runs: string[] = [];
  const runtime: AgentRuntime = {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      runs.push(input.model ?? '');
      const idx = runs.length - 1;
      if (idx < failures.length) throw new Error(failures[idx] as string);
      return {
        text: 'ok',
        toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
      } as unknown as AgentRunResult;
    },
    steer: () => true,
    dispose: () => undefined,
  };
  return { runtime, runs };
}

const dispatchAction = (taskId: number, wiId: number, attempt = 0) =>
  toPersistedAction(`dispatch:work_item:${wiId}:${attempt}`, 'dispatch', taskId, JSON.stringify({ attempt }));

test('兜底链：裸名与 provider/model 同模型不重复尝试', async () => {
  const { db, taskId, wiId } = setup();
  try {
    setFallbackChain(['deepseek-flash', 'xiaomi/mimo-v2.6-flash']);
    const { runtime, runs } = makeFlakyRuntime(['HTTP 401 Unauthorized（invalid api key）']);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(runtime) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.deepEqual(runs, [normalModelName(), 'xiaomi/mimo-v2.6-flash'], '同模型的裸名/前缀写法只能出现一次');
  } finally {
    setFallbackChain(null);
    db.close();
  }
});

test('兜底链：主模型 401 → 降级重跑（按链序）＋`agent_model_fallback` 事件留痕；提交经降级模型完成', async () => {
  const { db, taskId, wiId } = setup();
  try {
    setFallbackChain(['deepseek/deepseek-flash', 'anthropic/claude-x']);
    const { runtime, runs } = makeFlakyRuntime(['HTTP 401 Unauthorized（invalid api key）']);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(runtime), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));

    assert.deepEqual(
      runs,
      [normalModelName(), 'anthropic/claude-x'],
      '链首与主模型只是裸名/前缀不同 ⇒ 去重后走下一个真正不同的模型',
    );
    const rows = db.prepare("SELECT payload FROM task_events WHERE kind='agent_model_fallback'").all() as Array<{ payload: string }>;
    assert.equal(rows.length, 1, '降级**记事件**（每跳一条）');
    const payload = JSON.parse(rows[0]?.payload ?? '{}') as { role: string; from: string; to: string; reason: string };
    assert.equal(payload.role, 'employee');
    assert.equal(payload.from, normalModelName());
    assert.equal(payload.to, 'anthropic/claude-x', '同模型裸名被去重，实际降级到下一供应商');
    assert.match(payload.reason, /401/, '事件带原因（如实）');
    assert.ok(events.some((e) => e.event === 'submit_work_item'), '降级后照常提交（链是手段，不是降级的降级）');
  } finally {
    setFallbackChain(null);
    db.close();
  }
});

test('D-22：运行期降级也不得越过项目 allowed_models（清单外备选不尝试）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    db.prepare("UPDATE projects SET model_policy='fixed', default_model=?, allowed_models=? WHERE id=1").run(
      'deepseek/deepseek-flash',
      JSON.stringify(['deepseek/deepseek-flash']),
    );
    setFallbackChain(['anthropic/claude-x']);
    const { runtime, runs } = makeFlakyRuntime(['HTTP 401 Unauthorized（invalid api key）']);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(runtime), dispatch: (e) => void events.push(e) });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.deepEqual(runs, ['deepseek/deepseek-flash'], '清单外备选不得顶替');
    assert.ok(!db.prepare("SELECT 1 FROM task_events WHERE kind='agent_model_fallback'").get(), '不应留下降级事件');
    assert.ok(events.some((e) => e.scope === 'work_item' && e.event === 'error'), '主模型失败照常可见');
  } finally {
    setFallbackChain(null);
    db.close();
  }
});

test('D-22：运行期降级备选缺 Key 不尝试（清单内也不能顶替）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    db.prepare("UPDATE projects SET model_policy='fixed', default_model=?, allowed_models=? WHERE id=1").run(
      'deepseek/deepseek-flash',
      JSON.stringify(['deepseek/deepseek-flash', 'anthropic/claude-x']),
    );
    setFallbackChain(['anthropic/claude-x']);
    const { runtime, runs } = makeFlakyRuntime(['HTTP 401 Unauthorized（invalid api key）']);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(runtime),
      dispatch: (e) => void events.push(e),
      modelKeyConfigured: (model) => model.startsWith('deepseek'),
    });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.deepEqual(runs, ['deepseek/deepseek-flash'], '备选在清单内但缺 Key → 不尝试');
    assert.ok(!db.prepare("SELECT 1 FROM task_events WHERE kind='agent_model_fallback'").get());
    assert.ok(events.some((e) => e.scope === 'work_item' && e.event === 'error'));
  } finally {
    setFallbackChain(null);
    db.close();
  }
});

test('兜底链：整链耗尽 → **件进 failed（error 事件，异常卡通路）**；非分类错误 → 不降级、经 error 上报', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // ① 全链失败（主 + 两跳都 503）→ 件按真值表进 failed（`running --error--> failed`）⇒ 异常卡经
    //   任务级失败聚合（BRK2 通路）；**401/503 从此可见**（此前只有 action_failed 日志）。
    setFallbackChain(['a/one', 'b/two']);
    const all = makeFlakyRuntime(['HTTP 503 overloaded', 'HTTP 503 overloaded', 'HTTP 503 overloaded']);
    const events: EngineEvent[] = [];
    const exec1 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(all.runtime), dispatch: (e) => void events.push(e) });
    await exec1.execute(dispatchAction(taskId, wiId)); // 不再抛：失败经 `error` 事件上报（可见）
    assert.deepEqual(all.runs, [normalModelName(), 'a/one', 'b/two'], '链上限内逐跳尝试后放弃');
    const err = events.find((e) => e.scope === 'work_item' && e.event === 'error');
    assert.ok(err, '全链耗尽 → 件 `error` 事件（⇒ failed ⇒ 任务聚合 ⇒ 异常卡）');
    assert.match(String((err?.payload as { reason?: string })?.reason ?? ''), /模型\/凭据不可用/, 'reason 带人话前缀（401/503 类可见）');

    // ①b 无 dispatch 可报（旧装配/测试）＋无兜底可救 → 照旧抛（action_failed 可见，绝不静默）
    setFallbackChain(null);
    const noDeps = makeFlakyRuntime(['HTTP 503 overloaded']);
    const execNoDeps = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(noDeps.runtime) });
    await assert.rejects(async () => { await execNoDeps.execute(dispatchAction(taskId, wiId)); }, /503/);

    // ② 非分类错误（内部断言）→ 不降级：只跑一次；仍经 error 上报（失败可见）
    const wi2 = insertWorkItem(db, { taskId, employeeId: 7, title: 'w2', brief: 'x', now: 2 });
    const notProvider = makeFlakyRuntime(['内部断言失败：证据不足']);
    const events2: EngineEvent[] = [];
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(notProvider.runtime), dispatch: (e) => void events2.push(e) });
    await exec2.execute(dispatchAction(taskId, wi2.id));
    assert.deepEqual(notProvider.runs, [normalModelName()], '非供应商类错误不走降级（不把真 bug 拖去换模型重跑）');
    const err2 = events2.find((e) => e.scope === 'work_item' && e.event === 'error');
    assert.ok(err2, '非分类错误同样经 error 上报（失败可见）');
    assert.doesNotMatch(String((err2?.payload as { reason?: string })?.reason ?? ''), /模型\/凭据不可用/, '非供应商错不加限流前缀（如实）');
  } finally {
    setFallbackChain(null);
    db.close();
  }
});

test('降级标注：收尾卡在发生过 `agent_model_fallback` 时如实加注（无降级不加注）', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0 });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    db.prepare(
      "INSERT INTO task_events(task_id, ts, kind, actor, payload) VALUES(?, 1, 'agent_model_fallback', 'system', '{}')",
    ).run(task.id);

    const engine = new Engine(db, { execute: async () => undefined }, { autoSchedule: false, now: () => 1_800_000_000_000 });
    const deps = { repo: createSqliteChatRepo(db), engine };
    const res = await handleTaskTransition(deps, { taskId: task.id, event: 'finish_manual' });
    assert.deepEqual(res, { ok: true });
    const card = deps.repo.listReports({ taskId: task.id }).find((c) => c.kind === 'report');
    assert.match(JSON.stringify(card?.payload), /含模型降级 ×1/, '卡题如实加注（08 §10.3）');

    // 无降级的任务：不加注（不臆造）
    const task2 = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T2', goal: 'g', riskLevel: 0 });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task2.id);
    await handleTaskTransition(deps, { taskId: task2.id, event: 'finish_manual' });
    const card2 = deps.repo.listReports({ taskId: task2.id }).find((c) => c.kind === 'report');
    assert.doesNotMatch(JSON.stringify(card2?.payload), /含模型降级/, '无降级 ⇒ 不写');
  } finally {
    db.close();
  }
});
