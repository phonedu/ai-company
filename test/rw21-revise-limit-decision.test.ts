/**
 * （真机带回，2026-10-28）· `critic_revise_limit` 升级后老板没有可用的裁定通路。
 *
 * 真机事实（T-1015）：critic 三连打回触发 revise 上限升级 → 升级卡**不带 options**（无按钮可点）；
 * 老板文字回复只进幕僚长对话（它没有任务裁定工具）→ 任务永久 needs_decision。
 * 且升级问句原承诺「按最新版继续」，但任务机 needs_decision 只有 decision_made/cancel 两条真边——
 * 问句承诺了机器做不到的事。
 *
 * 修复口径（含残留收尾）：
 * ① 引擎升级卡自带三选项（proceed/revise/cancel）——**全部对齐机器真边**：
 *    proceed＝decision_proceed_latest（最新稿视同批准，不重规划；仅规划期升级有效）；
 *    revise＝decision_made（回规划带评审意见）；cancel＝cancel（真取消）。
 * ② 无 options 的其他决策卡兜底「取消任务」——needs_decision 永不砖死（不变式）。
 * ③ 审批行同步落同一份 options（approvals.options 不再是 "[]"）。
 * ④ `approvalAnswerEvent`：needs_decision + chosen='cancel'→真 cancel、chosen='proceed'→
 *    decision_proceed_latest、其余→decision_made。
 * ⑤ 卡渲染端以审批行 options 兜底（enrichReport 带 approvalOptions——历史砖卡复活按钮）。
 * ⑥ 员工 `escalate_to_boss` 工具 schema 增结构化 options（宿主清洗后透传）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { approvalAnswerEvent } from '../src/main/ipc/ipc.js';
import { countPlanDrafts } from '../src/main/agent/employee-executor.js';
import { readFileSync } from 'node:fs';
import type { SqliteDb } from '../src/main/db/index.js';

const NOTES = '计划第 1 步自相矛盾（10 步/8 步），第 9/10 步不存在；第 3 步引用不存在的工具。';

function setup(): { db: SqliteDb; taskId: number; engine: Engine } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '写笔记', goal: 'g', now: 1 });
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1 });
  return { db, taskId: task.id, engine };
}

test('RW-21① 升级卡自带三选项（proceed/revise/cancel，全对齐机器真边）＋问句如实', async () => {
  const { db, taskId, engine } = setup();
  try {
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'employee:2',
      payload: { role: 'critic', reason: 'critic_revise_limit', round: 3, notes: NOTES },
    });
    const report = db
      .prepare("SELECT id, payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { id: number; payload: string };
    const card = JSON.parse(report.payload) as {
      options?: Array<{ key: string; label?: string }>;
      question?: string;
    };
    assert.deepEqual(
      (card.options ?? []).map((o) => o.key),
      ['proceed', 'revise', 'cancel'],
      '三选项＝三条机器真边',
    );
    assert.match(card.question ?? '', /按最新版继续/, '问句可承诺 proceed（机器边已补）');
    assert.match(card.question ?? '', /按评审意见/, '问句含 revise');
    assert.match(card.question ?? '', /取消任务/, '问句含 cancel');
    const approval = db
      .prepare('SELECT options FROM approvals WHERE report_id = ? ORDER BY id LIMIT 1')
      .get(report.id) as { options: string };
    assert.deepEqual(
      (JSON.parse(approval.options) as Array<{ key: string }>).map((o) => o.key),
      ['proceed', 'revise', 'cancel'],
      '审批行 options 与卡同源（不再 "[]"）',
    );
  } finally {
    db.close();
  }
});

test('RW-21② needs_decision 作答映射：cancel→真取消／proceed→最新稿批准／其余→decision_made', () => {
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'cancel'), { event: 'cancel' });
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'proceed'), { event: 'decision_proceed_latest' });
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'revise'), {
    event: 'decision_made',
    payload: { chosen: 'revise' },
  });
  assert.deepEqual(approvalAnswerEvent('awaiting_approval', 'approve'), { event: 'plan_approved' });
  assert.equal(approvalAnswerEvent('executing', 'revise'), null);
});

test('RW-21③ 机器边：needs_decision→decision_proceed_latest＝最新稿视同批准（ready＋建工作项）', async () => {
  const { db, taskId, engine } = setup();
  try {
    // 种当前计划步骤（proceed 的对象＝最新稿）
    db.prepare(
      'INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run(taskId, 1, '唯一一步', 'pending', 1, 1);
    // 真实时序：先 triage 进 planning，规划期才可能 critic 打回升级（resume_state=planning）
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'employee:2',
      payload: { role: 'critic', reason: 'critic_revise_limit', round: 3, notes: NOTES },
    });
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as { state: string }).state, 'needs_decision');
    await engine.dispatch({ scope: 'task', id: taskId, event: 'decision_proceed_latest', actor: 'boss', payload: { chosen: 'proceed' } });
    const t = db.prepare('SELECT state, resume_state FROM tasks WHERE id = ?').get(taskId) as { state: string; resume_state: string | null };
    assert.equal(t.state, 'ready', 'proceed＝最新稿视同批准 → ready（不重规划）');
    // 工作项已按当前计划登记（C2：plan_approved 同语义）
    const items = db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE task_id = ?').get(taskId) as { n: number };
    assert.ok(items.n >= 1, 'proceed 应按当前计划建工作项');
  } finally {
    db.close();
  }
});

test('RW-21④ 其他无选项决策卡兜底「取消任务」（needs_decision 永不砖死的不变式）', async () => {
  const { db, taskId, engine } = setup();
  try {
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: { role: 'critic', reason: 'no_verdict', raw: '无结论' },
    });
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string };
    const card = JSON.parse(row.payload) as { options?: Array<{ key: string }> };
    assert.deepEqual((card.options ?? []).map((o) => o.key), ['cancel'], '无选项决策卡兜底取消（可逃生）');
  } finally {
    db.close();
  }
});

test('RW-21⑤ revise 预算改连续计数：老板裁定后从零重计（不再一轮打回就再升级）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 't', goal: 'g', now: 1 });
    const ins = db.prepare("INSERT INTO task_events(task_id, ts, kind, actor, payload) VALUES(?, ?, 'plan_drafted', 'employee:0', '{}')");
    ins.run(task.id, 1);
    ins.run(task.id, 2);
    ins.run(task.id, 3);
    assert.equal(countPlanDrafts(db, task.id), 3, '无裁定＝数全部（3 版全被打回）');
    db.prepare("INSERT INTO task_events(task_id, ts, kind, actor, payload) VALUES(?, 4, 'decision_made', 'boss', '{}')").run(task.id);
    ins.run(task.id, 5);
    assert.equal(countPlanDrafts(db, task.id), 1, '老板裁定后从零重计（只剩裁定后的 1 版）');
  } finally {
    db.close();
  }
});

test('RW-21⑥ 源码守卫：escalate_to_boss 工具有结构化 options、宿主清洗透传', () => {
  const tool = readFileSync('src/main/agent/escalate-to-boss-tool.ts', 'utf8');
  assert.match(tool, /options: Type\.Optional/, '工具 schema 必须带 options');
  const exec = readFileSync('src/main/agent/employee-executor.ts', 'utf8');
  assert.match(exec, /input\.options/, '宿主必须读 escalate 输入的 options');
  assert.match(exec, /options\.length > 0 \? \{ options \}/, 'options 透传进 escalate payload');
});
