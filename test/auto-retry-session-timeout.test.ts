/**
 * （ADV-1 G3）：30 分钟会话帽不可配/无续期 ＋ 失败只判死不自动续跑的回归测试。
 *
 * 旧实现：
 *  - `EMPLOYEE_SESSION_TIMEOUT_MS` 写死 30 分钟，且是**挂钟**：活着但在长时间工具调用里的会话
 *    也会被一刀切（每半小时老板手动 retry 一次）。
 *  - 工作项因运行时错误 failed ⇒ 任务立刻 failed 出卡；落盘会话明明可续跑，却要老板手动重试。
 *
 * 新口径：
 *  - 超时可配（`AICO_EMPLOYEE_SESSION_TIMEOUT_MS`）且**有活动就续期**（onEvent 重置计时器）；
 *    只有「静默无进展」才判超时。
 *  - 运行时错误（event=error，不是业务失败 agent_settled）自动 retry，上限 `AICO_TASK_AUTO_RETRY`
 *    （默认 1，0=关）；用完才任务 failed 出卡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  listReports,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, employeeSessionTimeoutMs } from '../src/main/agent/index.js';
import type { AgentEvent, AgentRunInput, AgentRunResult, AgentRuntime } from '../src/main/agent/index.js';

test('B0-3：会话超时可配（默认 30 分钟；env 覆盖；0=关闭）', () => {
  const saved = process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS;
  try {
    delete process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS;
    assert.equal(employeeSessionTimeoutMs('employee:1:task:1:wi:1'), 30 * 60_000);
    process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS = '120000';
    assert.equal(employeeSessionTimeoutMs('employee:1:task:1:wi:1'), 120_000);
    process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS = '0';
    assert.equal(employeeSessionTimeoutMs('employee:1:task:1:wi:1'), 0, '0＝关闭超时（测试/特殊装配）');
    process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS = 'oops';
    assert.equal(employeeSessionTimeoutMs('employee:1:task:1:wi:1'), 30 * 60_000, '非法值回落默认');
    // 角色会话（评审）默认 10 分钟，同样吃 env 吗？——不：角色帽是独立安全阀，env 只调员工帽。
    assert.equal(employeeSessionTimeoutMs('role:critic:task:1'), 10 * 60_000);
  } finally {
    if (saved === undefined) delete process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS;
    else process.env.AICO_EMPLOYEE_SESSION_TIMEOUT_MS = saved;
  }
});

test('B0-3：有活动就续期——长会话不被挂钟一刀切（静默才超时）', async () => {
  const activityRuntime: AgentRuntime = {
    async run(_input: AgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult> {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 40));
        onEvent({ type: 'tool_call_start', toolCallId: `t${i}`, toolName: 'bash', input: {} });
      }
      return { text: 'ok', toolCalls: [] };
    },
    steer: () => true,
    dispose: () => undefined,
  };
  const runtime = new EmployeeSessionRuntime(activityRuntime, { sessionTimeoutMs: 100 });
  const res = await runtime.run(
    { employeeId: 1, taskId: 1, systemPrompt: 's', userPrompt: 'p' },
    () => undefined,
  );
  assert.equal(res.text, 'ok', '持续有工具活动 ⇒ 不能按时长判超时');
});

test('B0-3：完全静默的会话仍会超时中止（续期不取消安全阀）', async () => {
  const hangRuntime: AgentRuntime = {
    run: () => new Promise<AgentRunResult>(() => undefined),
    abortSession: () => true,
    steer: () => true,
    dispose: () => undefined,
  };
  const runtime = new EmployeeSessionRuntime(hangRuntime, { sessionTimeoutMs: 80 });
  await assert.rejects(
    () => runtime.run({ employeeId: 1, taskId: 1, systemPrompt: 's', userPrompt: 'p' }, () => undefined),
    /会话超时/,
  );
});

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(1,'E1','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}
const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });
async function driveToExecuting(engine: Engine, taskId: number): Promise<void> {
  await engine.dispatch(ev(taskId, 'triage'));
  await engine.dispatch(ev(taskId, 'plan_drafted'));
}

test('B0-3：运行时错误自动 retry 一次（任务不立刻 failed，会话可续跑）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000, autoRetry: 1 });
    await driveToExecuting(engine, taskId);
    assert.equal(getWorkItem(db, wiId)?.state, 'running');
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'error', actor: 'system', payload: { reason: '会话超时（1800000ms）' } });
    const wi = getWorkItem(db, wiId);
    assert.equal(wi?.state, 'running', '自动 retry 后应重新派发（attempt+1），而不是停在 failed');
    assert.equal(wi?.attempt, 1);
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'executing', '任务不得因第一次运行时错误就 failed');
    const retryTrace = listTaskEvents(db, taskId).filter(
      (e) => e.kind === 'work_item_started' || e.kind === 'work_item_failed',
    );
    assert.ok(retryTrace.length >= 2, '失败与重派都必须留痕');
  } finally {
    db.close();
  }
});

test('B0-3：retry 用尽 → 任务 failed ＋ 异常卡（老板可见）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000, autoRetry: 1 });
    await driveToExecuting(engine, taskId);
    const err = { scope: 'work_item' as const, id: wiId, event: 'error', actor: 'system', payload: { reason: '会话超时' } };
    await engine.dispatch(err);
    await engine.dispatch(err);
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'failed', 'retry 用尽后任务失败（不再无限重试）');
    const alerts = listReports(db).filter((r) => r.kind === 'alert');
    assert.ok(alerts.length >= 1, '任务失败必须有异常卡（不静默）');
  } finally {
    db.close();
  }
});

test('B0-3：autoRetry=0 关闭自动重试（保持旧行为）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000, autoRetry: 0 });
    await driveToExecuting(engine, taskId);
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'error', actor: 'system', payload: { reason: '会话超时' } });
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'failed');
  } finally {
    db.close();
  }
});

test('B2-3/D-30②：业务失败（agent_settled 未提交）同口径单件重派；重试耗尽才任务 failed', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1000, autoRetry: 1 });
    await driveToExecuting(engine, taskId);
    // 第一次业务失败 → 单件 attempt+1 重派（任务保持 executing；attempt/事件留痕，不掩盖）
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'agent_settled', actor: 'employee:1' });
    const wi1 = db.prepare('SELECT state, attempt FROM work_items WHERE id=?').get(wiId) as { state: string; attempt: number };
    assert.equal(wi1.attempt, 1, '业务失败 → attempt+1（D-30② 失败粒度=单件）');
    assert.equal(wi1.state, 'running', '重派后该件 running（任务未被整体判死）');
    // 重试耗尽 → 任务 failed 出异常卡
    await engine.dispatch({ scope: 'work_item', id: wiId, event: 'agent_settled', actor: 'employee:1' });
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'failed', '重试耗尽才任务 failed（D-30②）');
  } finally {
    db.close();
  }
});
