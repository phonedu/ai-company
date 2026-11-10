import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnavailableExecutor, NO_CREDENTIAL_REASON } from '../src/main/agent/unavailable-executor.js';
import { createUnavailableExecutorInline } from '../src/main/agent/employee-factory.js';
import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { Engine } from '../src/main/engine/index.js';
import type { EngineEvent, PersistedAction } from '../src/main/engine/types.js';

// ──：无凭据 → 「不可用」执行器（派发即失败、绝不 mock 兜底） ──
//  修：事件名必须是工作项机**真事件** `error`（`running --error--> failed`，L284-285）；
// 此前派 `work_item_failed`（不在工作项机里）⇒ 真引擎抛 `UnknownTransitionError`、件卡 `running`、任务永停
// `executing`、无失败卡——只有行为日志里一条 `action_failed`（假绿测试用假 dispatch 断言"发了该事件"）。

const action = (over: Record<string, unknown>): PersistedAction =>
  ({ kind: 'dispatch', actionKey: 'dispatch:work_item:5:0', taskId: 1, ...over }) as unknown as PersistedAction;

test('AI-1 unavailable: work_item dispatch → `error`{no_credential} + error 日志（真事件名，BRK2）', async () => {
  const events: EngineEvent[] = [];
  const logs: string[] = [];
  const exec = createUnavailableExecutor({ dispatch: (e) => void events.push(e), log: (m) => void logs.push(m) });

  await exec.execute(action({}));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    scope: 'work_item',
    id: 5,
    event: 'error',
    actor: 'system',
    payload: { reason: NO_CREDENTIAL_REASON },
  });
  assert.equal(events[0].payload && (events[0].payload as { reason: string }).reason, 'no_credential');
  assert.match(logs.join('\n'), /无凭据 → 员工会话不可用/);
});

test('AI-1 unavailable（内置回退同款）：inline 执行器也派 `error`（两处事件名一致，BRK2）', async () => {
  const events: EngineEvent[] = [];
  const exec = createUnavailableExecutorInline(NO_CREDENTIAL_REASON)((e) => void events.push(e));
  await exec.execute(action({}));
  assert.equal(events.length, 1, 'inline 执行器也必须真派（不是只打日志）');
  assert.equal(events[0]!.event, 'error', 'inline 同款事件名（BRK2：此前两处都派非法 `work_item_failed`）');
  assert.equal((events[0]!.payload as { reason: string }).reason, NO_CREDENTIAL_REASON);
});

test('AI-1 unavailable: 非 dispatch / 非 work_item / 无 taskId → 不派发（不误伤）', async () => {
  const events: EngineEvent[] = [];
  const exec = createUnavailableExecutor({ dispatch: (e) => void events.push(e), log: () => undefined });
  await exec.execute(action({ kind: 'other' }));
  await exec.execute(action({ actionKey: 'dispatch:task:1:0' }));
  await exec.execute(action({ taskId: null }));
  assert.equal(events.length, 0);
});

test('BRK2 全链（**真引擎**，非假 dispatch）：无凭据派发 → 件 failed ＋ 任务 failed ＋ 异常卡（不再永停 executing）', async () => {
  const AT = 1_800_000_000_000;
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  try {
    // 置位到「派发前一刻」：任务 executing ＋ 1 件 queued（无凭据时规划会话也跑不了 ⇒ 这条链单独钉件派发失败）
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '无凭据',
      goal: 'g',
      riskLevel: 0,
      state: 'executing',
      ownerId: 0,
    });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 0, title: 'w', brief: 'b', now: AT });

    let engine: Engine | undefined;
    const exec = createUnavailableExecutor({ dispatch: (e) => engine!.dispatch(e), log: () => undefined });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.schedulePass();

    const wiState = (db.prepare('SELECT state FROM work_items WHERE id=?').get(wi.id) as { state: string }).state;
    const taskState = (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(wiState, 'failed', '件必须真 failed（BRK2：此前非法事件名 ⇒ 真引擎抛错、件卡 running）');
    assert.equal(taskState, 'failed', '任务必须进 failed（此前永停 executing、无卡）');
    const alert = db.prepare("SELECT id FROM reports WHERE task_id=? AND kind='alert'").get(task.id) as { id: number } | undefined;
    assert.ok(alert, '异常卡必须真出（任务机 executing --fail--> failed 的 notify_alert）');
    assert.ok(
      !listTaskEvents(db, task.id).some((e) => e.kind === 'action_failed'),
      '不得再靠 action_failed 兜底——那是断链的症状（BRK2 的旧症状）',
    );
  } finally {
    db.close();
  }
});

// ── 规划静默（2026-10-15 矩阵格 `no-credential×planning-stage` 抓； 同型）────────────────

test('C1b：装配期模型不存在（规划）→ task error（模型/凭据不可用），不升级为决策卡', async () => {
  const events: EngineEvent[] = [];
  const exec = createUnavailableExecutor({ dispatch: (e) => void events.push(e), log: () => undefined });
  await exec.execute({
    kind: 'dispatch_planning',
    actionKey: 'dispatch_planning:task:3:0',
    taskId: 3,
  } as unknown as PersistedAction);
  // 上面是 no_credential（C8）的既有路径；用模型错误重建执行器验证新分支。
  events.length = 0;
  const modelExec = createUnavailableExecutorInline('[agent] 模型不存在：deepseek/nonexistent-c1')(
    (e) => void events.push(e),
  );
  await modelExec.execute({
    kind: 'dispatch_planning',
    actionKey: 'dispatch_planning:task:4:0',
    taskId: 4,
  } as unknown as PersistedAction);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.scope, 'task');
  assert.equal(events[0]!.event, 'error');
  assert.match(String((events[0]!.payload as { reason: string }).reason), /^模型\/凭据不可用：.*模型不存在/);
});

test('C1b：装配期模型不存在（规划）→ task error（模型/凭据不可用），不升级为决策卡', async () => {
  const events: EngineEvent[] = [];
  const exec = createUnavailableExecutor({
    reason: '[agent] 模型不存在：deepseek/nonexistent-c1',
    dispatch: (e) => void events.push(e),
    log: () => undefined,
  });
  await exec.execute({
    kind: 'dispatch_planning',
    actionKey: 'dispatch_planning:task:4:0',
    taskId: 4,
  } as unknown as PersistedAction);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.scope, 'task');
  assert.equal(events[0]!.event, 'error');
  assert.match(String((events[0]!.payload as { reason: string }).reason), /^模型\/凭据不可用：.*模型不存在/);
});

test('无凭据 × 规划 phase 派发：不再静默跳过 —— 派 `escalate`（真事件名）＋ error 日志', async () => {
  const events: EngineEvent[] = [];
  const logs: string[] = [];
  const exec = createUnavailableExecutor({ dispatch: (e) => void events.push(e), log: (m) => void logs.push(m) });
  await exec.execute({
    kind: 'dispatch_planning',
    actionKey: 'dispatch_planning:task:1:0',
    taskId: 1,
  } as unknown as PersistedAction);
  assert.equal(events.length, 1, '必须真派（此前静默跳过：无卡/无件/不重试）');
  assert.deepEqual(events[0], {
    scope: 'task',
    id: 1,
    event: 'escalate',
    actor: 'system',
    payload: { reason: NO_CREDENTIAL_REASON, phase: 'planning' },
  });
  assert.match(logs.join('\n'), /升级给老板/);
  await exec.execute({
    kind: 'dispatch_verifier',
    actionKey: 'dispatch_verifier:task:1:0',
    taskId: 1,
  } as unknown as PersistedAction);
  assert.equal(events[1]?.event, 'escalate');
  assert.equal((events[1]?.payload as { phase: string }).phase, 'verifier');
  await exec.execute({ kind: 'dispatch_critic', actionKey: 'x', taskId: null } as unknown as PersistedAction);
  assert.equal(events.length, 2, '无 taskId 的 phase 派发：跳过（不误伤）');
});

test('无凭据 × 规划（内置回退同款）：inline 执行器也派 `escalate`（两处同款）', async () => {
  const events: EngineEvent[] = [];
  const exec = createUnavailableExecutorInline(NO_CREDENTIAL_REASON)((e) => void events.push(e));
  await exec.execute({
    kind: 'dispatch_planning',
    actionKey: 'dispatch_planning:task:2:0',
    taskId: 2,
  } as unknown as PersistedAction);
  assert.equal(events.length, 1, 'inline 也必须真派');
  assert.equal(events[0]!.event, 'escalate');
  assert.equal((events[0]!.payload as { reason: string }).reason, NO_CREDENTIAL_REASON);
});

test('无凭据 × 规划全链（**真引擎**）：建任务 → 分诊 → 规划派发失败 → `needs_decision` ＋ 决策卡（不再静默卡 planning）', async () => {
  const AT = 1_800_000_000_000;
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '无凭据规划',
      goal: 'g',
      acceptance: [],
      riskLevel: 0,
      ownerId: 0,
    });
    let engine: Engine | undefined;
    const exec = createUnavailableExecutor({ dispatch: (e) => engine!.dispatch(e), log: () => undefined });
    engine = new Engine(db, exec, { autoSchedule: true, now: () => AT });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage', actor: 'boss' });
    await engine.schedulePass();
    await engine.schedulePass();

    const state = (db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string }).state;
    assert.equal(state, 'needs_decision', '规划派发失败必须可见（此前静默卡 planning）');
    const card = db.prepare("SELECT id FROM reports WHERE task_id=? AND kind='ask'").get(task.id) as
      | { id: number }
      | undefined;
    assert.ok(card, '决策卡必须真出（escalate 的 notify_decision）');
    assert.equal(
      (db.prepare('SELECT resume_state FROM tasks WHERE id=?').get(task.id) as { resume_state: string | null })
        .resume_state,
      'planning',
      '恢复目标＝planning（答卡后再派规划属恢复面共缺口，已报备随批 R）',
    );
  } finally {
    db.close();
  }
});
