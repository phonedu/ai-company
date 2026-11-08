/**
 * B3-6（58 §4.3/§4.4；D-31②）：输出治理＋critic 限档＋verifier 补 diff。
 *
 * 口径：
 *  - **critic 限档**：L0 免（现状）＋**L1 默认跳**（plan_drafted 直出批准卡——老板仍可在
 *    卡上打回，重规划链不变）；**L2 保留** critic。省下的双会话成本入台账。
 *  - **输出治理**：交付纪律层新增「长文（>2000 字）直接 write 文件、submit 只给路径与要点」
 *    ——写进 DELIVERY_DISCIPLINE_LAYER（写进提示词＝所有模型同一口径）。
 *  - **verifier 补 diff**：verifier 材料在有 changeset 时附 diff 摘要（buildReviewContext
 *    读 changesets 表拼入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask,
  insertEmployee,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  listTaskEvents,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { Engine } from '../src/main/engine/index.js';
import { DELIVERY_DISCIPLINE_LAYER, buildReviewContext } from '../src/main/agent/context.js';
import { createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { EmployeeSessionRuntime } from '../src/main/agent/employee-runtime.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seed(db: SqliteDb, risk: 0 | 1 | 2): { taskId: number } {
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
  insertEmployee(db, { id: 9, name: '评审', role: 'reviewer', now: 1 });
  const projectId = Number(
    (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    riskLevel: risk,
    ownerId: 7,
  });
  return { taskId: task.id };
}

test('B3-6: L1 跳 critic 会话——dispatch_critic 被合成 plan_reviewed（skipped=risk_tier 留痕，无 LLM 会话）', async () => {
  const db = fresh();
  try {
    const { taskId } = seed(db, 1);
    let engine: Engine | undefined;
    // planner 必须提交计划（否则 no_plan→escalate→needs_decision，轮不到 critic）
    const fake = makeFakeAgentRuntime([
      { text: 'plan', toolCalls: [{ id: 'p1', name: 'submit_plan', input: { steps: ['s1'] }, isError: false }] },
    ]);
    const dispatched: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => { dispatched.push({ event: e.event, payload: e.payload }); void engine?.dispatch(e); } });
    const engine2 = new Engine(db, exec, { autoSchedule: false, now: () => 1 });
    engine = engine2;
    await engine2.dispatch({ scope: 'task', id: taskId, event: 'triage', actor: 'boss' });
    // triage 已自动派 planning 会话（fake planner 提交 → plan_drafted → critic 短路）——轮询到批准卡
    for (let i = 0; i < 100; i += 1) {
      const stNow = (db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state;
      if (stNow === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    // dispatch_critic 动作被执行后：合成 plan_reviewed（跳过）→ awaiting_approval；无 role:critic 会话
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
    assert.equal(task.state, 'awaiting_approval', 'L1 经合成 plan_reviewed 到批准卡（链路不变）');
    assert.ok(!fake.runs.some((r: { sessionKey?: string }) => r.sessionKey?.startsWith('role:critic')), 'L1 无 critic 会话（D-31② 省双会话）');
    const reviewed = listTaskEvents(db, taskId).find((e) => e.kind === 'plan_reviewed');
    const rp = reviewed != null ? (JSON.parse(String(reviewed.payload ?? '{}')) as { skipped?: string }) : null;
    assert.equal(rp?.skipped, 'risk_tier', '跳过标记如实留痕');
    const approval = db.prepare('SELECT id FROM approvals WHERE task_id=?').get(taskId);
    assert.ok(approval, '批准卡在场（老板审核面不变）');
    db.close();
  } finally {
    void db;
  }
});

test('B3-6 有牙: 去掉 L1 短路 → critic 会话真开（L2 保留语义的对照面）', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db, 2);
    let engine: Engine | undefined;
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve', notes: 'n' }, isError: false }] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => engine!.dispatch(e) });
    const engine2 = new Engine(db, exec, { autoSchedule: false, now: () => 1 });
    engine = engine2;
    engine2.dispatch({ scope: 'task', id: taskId, event: 'triage', actor: 'boss' }).catch(() => undefined);
    engine2.dispatch({ scope: 'task', id: taskId, event: 'plan_drafted', actor: 'employee:7', payload: { steps: ['s1'] } }).catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const reviewed = listTaskEvents(db, taskId).find((e) => e.kind === 'plan_reviewed');
        if ((reviewed != null && fake.runs.some((r: { sessionKey?: string }) => r.sessionKey?.startsWith('role:critic'))) || tries > 40) {
          assert.ok(fake.runs.some((r: { sessionKey?: string }) => r.sessionKey?.startsWith('role:critic')), 'L2 真开 critic 会话（高风险必审）');
          db.close();
          resolve();
          return;
        }
        tries += 1;
        setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    });
  } finally {
    void db;
  }
});

test('B3-6: 输出治理纪律层——长文直接写文件、submit 只给路径要点', () => {
  assert.match(DELIVERY_DISCIPLINE_LAYER, /2000/, '长文阈值 2000 字写进纪律层');
  assert.match(DELIVERY_DISCIPLINE_LAYER, /write 文件|写文件|直接写/, '要求长文直接写文件');
  assert.match(DELIVERY_DISCIPLINE_LAYER, /路径/, 'submit 只给路径与要点');
});

test('B3-6: verifier 材料补 diff 摘要（有 changeset 时）', () => {
  const db = fresh();
  try {
    insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
    insertEmployee(db, { id: 9, name: '评审', role: 'reviewer', now: 1 });
    const projectId = Number(
      (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1, ownerId: 7 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'W', brief: 'b', now: 1 });
    db.prepare(
      "INSERT INTO changesets(task_id, branch, base_sha, head_sha, files_changed, insertions, deletions, state, summary, created_at) VALUES(?, 'aico/x', 'a', 'b', 2, 10, 3, 'open', '改了配置读取与入口校验', 2)",
    ).run(task.id);
    const ctx = buildReviewContext(db, { role: 'verifier', taskId: task.id, reviewerEmployeeId: 9, workItemId: wi.id });
    assert.match(ctx.userPrompt, /变更|diff|diff 摘要/i, 'verifier 材料含 diff/变更摘要');
    assert.match(ctx.userPrompt, /2\s*个?文件|files_changed|10|3/, '摘要含数字（files/+/−）');
    db.close();
  } finally {
    void db;
  }
});
