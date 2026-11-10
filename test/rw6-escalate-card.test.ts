/**
 * （真机带回，2026-10-27）· `critic_revise_limit` 升级卡必须带 critic 意见。
 *
 * 真机事实：评审连续打回达上限升级老板时，卡面只有「需要你决策（T-1001）」＋ reason 代号——
 * critic 的打回理由（notes）没上卡，老板拿到卡无法决策（真机靠查库才知道反对点）。
 * 修复口径：决策卡 question 说清发生了什么；critic 意见截断后进 payload.body
 * （Card.tsx / InboxView 已渲染 body——E-16 批接的渲染面，正好复用）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { SqliteDb } from '../src/main/db/index.js';

const LONG_NOTES =
  '整体路线可执行，但步骤4「cat -A 断言输出恰为 M5 底座 OK$」不可执行：GNU cat -A 会把 UTF-8 高位字节渲染成 M- 转义，' +
  '执行者拿正确文件也会判失败。改法：用 [ "$(cat hello.txt)" = "M5 底座 OK" ] 做内容等值断言，od -c 做字节级核对。'.repeat(3);

function setup(): { db: SqliteDb; taskId: number; engine: Engine } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: '底座', goal: 'g', now: 1 });
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1 });
  return { db, taskId: task.id, engine };
}

test('RW-6: critic_revise_limit 升级卡带「连续打回」question＋critic 意见摘要 body（截断）', async () => {
  const { db, taskId, engine } = setup();
  try {
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'employee:2',
      payload: { role: 'critic', reason: 'critic_revise_limit', round: 3, notes: LONG_NOTES },
    });
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string };
    const card = JSON.parse(row.payload) as {
      title?: string;
      question?: string;
      body?: string;
      reason?: string;
    };
    assert.equal(card.reason, 'critic_revise_limit');
    assert.match(card.question ?? '', /连续打回/, 'question 必须说清「评审连续打回」');
    assert.match(card.question ?? '', /裁定/, 'question 必须请老板裁定');
    assert.ok(card.body != null && card.body.length > 0, '卡必须带 critic 意见 body');
    assert.ok(card.body!.includes('cat -A'), 'body 应含 critic 意见关键内容');
    assert.ok(card.body!.length <= 400, `body 应截断（实际 ${card.body!.length} 字符）`);
    assert.ok(card.title != null && card.title.includes('T-'), '标题带任务短号');
  } finally {
    db.close();
  }
});

test('RW-6: 其他升级原因不附 body（critic_unavailable 等原口径不变）', async () => {
  const { db, taskId, engine } = setup();
  try {
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: { role: 'critic', reason: 'critic_unavailable', notes: '不该上卡' },
    });
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string };
    const card = JSON.parse(row.payload) as { question?: string; body?: string };
    assert.match(card.question ?? '', /没有独立评审员工/, 'critic_unavailable 的指引文案不变');
    assert.equal(card.body, undefined, '非 revise_limit 升级不附 body（notes 不透传）');
  } finally {
    db.close();
  }
});

test('RW-10: done 完成卡存在 open changeset 时提示「产物在暂存工作区、需合并落项目根」', async () => {
  const { db, taskId, engine } = setup();
  try {
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage' });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'plan_drafted' });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'plan_reviewed' });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'plan_approved' });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'start_task' });
    // 种一个 open 变更集（真机＝执行器登记；单测直接插）——免验聚合前在场
    db.prepare(
      "INSERT INTO changesets(task_id, branch, base_sha, head_sha, files_changed, insertions, deletions, state, created_at) VALUES(?, 'aico/x', 'a', 'b', 1, 5, 0, 'open', 2)",
    ).run(taskId);
    // 免验聚合：verificationNeeded=false ⇒ 引擎如实自动 pass ⇒ done ＋ 完成卡（此时 open changeset 在场）
    await engine.dispatch({ scope: 'task', id: taskId, event: 'all_work_items_done', payload: { verificationNeeded: false } });
    // /：L1+（含免验）pass 现迁 needs_decision（签收卡）——补签收步，done 后才有完成卡
    if ((db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state === 'needs_decision') {
      await engine.dispatch({ scope: 'task', id: taskId, event: 'signoff', actor: 'boss', payload: { via: 'b26-regression' } });
    }
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'report' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string };
    const card = JSON.parse(row.payload) as { title?: string; body?: string };
    assert.match(card.title ?? '', /完成/, '完成卡');
    assert.match(card.body ?? '', /暂存工作区/, 'body 必须提示产物在暂存区');
    assert.match(card.body ?? '', /合并/, 'body 必须给出动作（合并）');
  } finally {
    db.close();
  }
});
