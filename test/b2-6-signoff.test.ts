/**
 * B2-6（57 P0-8；D-30③）：done 前老板签收关卡——风险档分级。
 *
 * 口径：**L0 机器门直通不变**（verifier pass → 自动 done）；**L1+ verifier pass → 不自动
 * done**，迁 `needs_decision`（resume_state=verifying）出**签收卡**（复用决策卡形态：
 * options=签收＋逐件返工；材料=验收结论）；签收 → done（`boss_signoff` 审计事件）；
 * 拒绝（rework:<wiId>）→ 只该件返工（spawnReworkItem retry_of 血缘），任务回 executing。
 * 不新增状态机状态（复用 needs_decision 回边）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask,
  insertEmployee,
  insertWorkItem,
  listWorkItemsByTask,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { Engine } from '../src/main/engine/index.js';
import { approvalAnswerEvent } from '../src/core/approval-events.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seed(db: SqliteDb, risk: 0 | 1): { taskId: number; wiId: number } {
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
  insertEmployee(db, { id: 9, name: '验证者', role: 'reviewer', now: 1 });
  const projectId = Number(
    (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    acceptance: [{ text: '产物存在', check: 'node -e "process.exit(0)"' }],
    riskLevel: risk,
    ownerId: 7,
  });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'W', brief: 'b', now: 1 });
  db.prepare("UPDATE work_items SET state='submitted' WHERE id=?").run(wi.id);
  db.prepare("UPDATE tasks SET state='verifying' WHERE id=?").run(task.id);
  return { taskId: task.id, wiId: wi.id };
}

test('B2-6: L1+ verifier pass → 不自动 done，迁 needs_decision 出签收卡（options=签收＋逐件返工）', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db, 1);
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 1 });
    engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'verification_completed',
      actor: 'employee:9',
      payload: { verdict: 'pass', notes: '逐条通过', workItemId: null, reportId: null },
    }).catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const task = db.prepare('SELECT state, resume_state FROM tasks WHERE id=?').get(taskId) as { state: string; resume_state: string | null };
        if (task.state === 'needs_decision' || tries > 40) {
          assert.equal(task.state, 'needs_decision', `L1+ pass 不自动 done（实际 ${task.state}）`);
          assert.equal(task.resume_state, 'verifying', '签收拒绝需回 verifying 语义');
          const kinds = db.prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id").all(taskId).map((e) => String((e as { kind: string }).kind));
          assert.ok(kinds.includes('signoff_required'), 'signoff_required 事件在案');
          const approval = db.prepare("SELECT question, options FROM approvals WHERE task_id=? ORDER BY id DESC LIMIT 1").get(taskId) as { question: string; options: string } | undefined;
          assert.ok(approval, '签收卡 approvals 行在案（待我处理可见）');
          const opts = JSON.parse(approval!.options) as Array<{ key: string; label: string }>;
          assert.ok(opts.some((o) => o.key === 'sign'), '有签收选项');
          assert.ok(opts.some((o) => o.key.startsWith('rework:')), '有逐件返工选项');
          const card = db.prepare("SELECT payload FROM reports WHERE task_id=? ORDER BY id DESC LIMIT 1").get(taskId) as { payload: string } | undefined;
          assert.ok(card, '签收卡真卡在案（频道/待我处理可见）');
          resolve();
          return;
        }
        tries += 1;
        setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    }).finally(() => db.close());
  } finally {
    void db;
  }
});

test('B2-6: 签收 → done（boss_signoff 审计事件；task_completed）', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db, 1);
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 1 });
    void engine
      .dispatch({ scope: 'task', id: taskId, event: 'verification_completed', actor: 'employee:9', payload: { verdict: 'pass' } })
      .catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
        if (task.state === 'needs_decision' || tries > 40) {
          void engine.dispatch({ scope: 'task', id: taskId, event: 'signoff', actor: 'boss', payload: { via: 'signoff_card' } }).catch(() => undefined);
          setTimeout(() => {
            const done = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
            assert.equal(done.state, 'done', '签收后任务 done');
            const kinds = db.prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id").all(taskId).map((e) => String((e as { kind: string }).kind));
            assert.ok(kinds.includes('boss_signoff'), 'boss_signoff 审计事件在案');
            assert.ok(kinds.includes('task_completed'));
            db.close();
            resolve();
          }, 60);
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

test('B2-6: 拒绝（rework:<wi>）→ 只该件返工（retry_of 血缘），任务回 executing', () => {
  const db = fresh();
  try {
    const { taskId, wiId } = seed(db, 1);
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 1 });
    void engine
      .dispatch({ scope: 'task', id: taskId, event: 'verification_completed', actor: 'employee:9', payload: { verdict: 'pass' } })
      .catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
        if (task.state === 'needs_decision' || tries > 40) {
          void engine
            .dispatch({ scope: 'task', id: taskId, event: 'signoff_reject', actor: 'boss', payload: { workItemId: wiId, via: 'signoff_card' } })
            .catch(() => undefined);
          setTimeout(() => {
            const t = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
            assert.equal(t.state, 'executing', '拒绝后任务回 executing（返工件重跑）');
            const items = listWorkItemsByTask(db, taskId);
            const rework = items.find((i) => i.retry_of === wiId);
            assert.ok(rework, '只该件派了返工件（retry_of 血缘指向被拒件）');
            assert.match(rework!.title, /返工/);
            const kinds = db.prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id").all(taskId).map((e) => String((e as { kind: string }).kind));
            assert.ok(kinds.includes('signoff_rejected'), 'signoff_rejected 事件在案（无静默路径）');
            db.close();
            resolve();
          }, 60);
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

test('B2-6 回归: L0 verifier pass → 直通 done（不出签收卡）', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db, 0);
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 1 });
    engine
      .dispatch({ scope: 'task', id: taskId, event: 'verification_completed', actor: 'employee:9', payload: { verdict: 'pass' } })
      .catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
        if (task.state === 'done' || tries > 40) {
          assert.equal(task.state, 'done', 'L0 机器门直通不变（D-30③）');
          const kinds = db.prepare("SELECT kind FROM task_events WHERE task_id=?").all(taskId).map((e) => String((e as { kind: string }).kind));
          assert.ok(!kinds.includes('signoff_required'), 'L0 不出签收卡');
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

test('B2-6: approvalAnswerEvent——sign/rework:N 映射机器真边；坏 rework 不猜', () => {
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'sign'), { event: 'signoff' });
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'rework:3'), { event: 'signoff_reject', payload: { workItemId: 3 } });
  assert.equal(approvalAnswerEvent('needs_decision', 'rework:x'), null, '非整数 wiId 不猜');
  assert.equal(approvalAnswerEvent('needs_decision', 'rework:0'), null, 'wiId>0 校验');
  // 既有映射不回归
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'cancel'), { event: 'cancel' });
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'proceed'), { event: 'decision_proceed_latest' });
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'revise'), { event: 'decision_made', payload: { chosen: 'revise' } });
});
