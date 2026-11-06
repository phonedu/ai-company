/**
 * RW-27（S11 真机登记，老板 2026-10-28 裁 A）· 规划前预算预检。
 *
 * 缺陷：任务预算只在**派发期**生效——500 token 预算的任务规划/评审已烧 10138 token（20×）
 * 才停在「等预算」，超支无提示。
 * 裁 A：规划派发**前**就预检——剩余预算低于最小规划额度（常量）→ 不派会话、出「预算不足」卡；
 * 老板到任务详情加预算后点「已加预算，重试规划」（retry→decision_made→重派）或取消。
 *
 * 口径：
 * ① 无预算（null）→ 不受影响；
 * ② remaining = budget - cost；remaining < MIN_DISPATCH_BUDGET_TOKENS（1000）→ 拦；
 * ③ 拦截时**不**调用执行器（不烧钱），任务转 needs_decision，卡带 retry/cancel 选项。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { SqliteDb } from '../src/main/db/index.js';

function setup(): { db: SqliteDb; taskId: number; rec: ReturnType<typeof makeRecordingExecutor>; engine: Engine } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 't', goal: 'g', now: 1 });
  const rec = makeRecordingExecutor();
  const engine = new Engine(db, rec, { autoSchedule: false, now: () => 1 });
  return { db, taskId: task.id, rec, engine };
}

function planningDispatches(rec: ReturnType<typeof makeRecordingExecutor>): number {
  // recording executor 记录的是 actionKey（形如 dispatch_planning:task:<id>:<rev>）
  return rec.state.calls.filter((key) => key.startsWith('dispatch_planning:')).length;
}

test('RW-27① 无预算任务不受影响：规划照常派发', async () => {
  const { db, taskId, rec, engine } = setup();
  try {
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    assert.equal(planningDispatches(rec), 1, '无预算 → 规划派发一次');
  } finally {
    db.close();
  }
});

test('RW-27② 预算低于最小规划额度 → 不派会话（不烧钱）＋预算不足卡（retry/cancel）', async () => {
  const { db, taskId, rec, engine } = setup();
  try {
    db.prepare('UPDATE tasks SET budget_tokens = 500, cost_tokens = 0 WHERE id = ?').run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    assert.equal(planningDispatches(rec), 0, '预算不足 → 不派规划会话');
    const t = db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as { state: string };
    assert.equal(t.state, 'needs_decision', '转待决策（不静默停）');
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string };
    const card = JSON.parse(row.payload) as { reason?: string; question?: string; options?: Array<{ key: string }> };
    assert.equal(card.reason, 'budget_insufficient');
    assert.match(card.question ?? '', /预算不足/);
    assert.deepEqual((card.options ?? []).map((o) => o.key), ['retry', 'cancel'], '重试＋取消两个出口');
  } finally {
    db.close();
  }
});

test('RW-27③ 剩余额度 ≥ 最小值 → 正常派发（边界不误伤）', async () => {
  const { db, taskId, rec, engine } = setup();
  try {
    db.prepare('UPDATE tasks SET budget_tokens = 6000, cost_tokens = 5000 WHERE id = ?').run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    assert.equal(planningDispatches(rec), 1, '剩 1000 = 阈值 → 放行');
  } finally {
    db.close();
  }
});

test('RW-27④ 加预算后答卡 retry → 重新派发规划', async () => {
  const { db, taskId, rec, engine } = setup();
  try {
    db.prepare('UPDATE tasks SET budget_tokens = 500, cost_tokens = 0 WHERE id = ?').run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    assert.equal(planningDispatches(rec), 0);
    // 老板加预算
    db.prepare('UPDATE tasks SET budget_tokens = 50000 WHERE id = ?').run(taskId);
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_made', actor: 'boss', payload: { chosen: 'retry' } });
    assert.equal(planningDispatches(rec), 1, 'retry → 重派规划（不重规划旧稿）');
  } finally {
    db.close();
  }
});
