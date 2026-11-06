/**
 * OPT-AI-8 成本闭环 —— 底座已算好的 `cost` 与 `cacheRead/cacheWrite` **真落库**（此前只丢 tokens）。
 *
 * 判据（本文件头注即真源）：
 *  - 员工会话跑完 → `costs` 行：`usd` / `cache_read_tokens` / `cache_write_tokens` / `project_id` / `model` **与假运行器的输入逐一相等**（不硬编码）；
 *  - `tasks.cost_tokens` 口径**不变**（= tokens_in + tokens_out；缓存**不计入预算**、只入账）；
 *  - `task_events` 有 `cost_recorded`（payload 带缓存字段，可审计）；
 *  - **不臆造**：运行器不给 `usage` → 不写行；全零用量 → 不写行；
 *  - **评审会话（critic）同样入账**（它也是会话、也烧钱）；
 *  - **有牙**：`project_id` 必须来自真项目（接线漏了会变 null → 必红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, recordCost, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; projectId: number; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(9,'验证者','reviewer','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  db.prepare('UPDATE work_items SET verifier_employee_id = 9 WHERE id = ?').run(wi.id);
  return { db, projectId, taskId: task.id, wiId: wi.id };
}

const costRows = (db: SqliteDb, taskId: number) =>
  db
    .prepare('SELECT model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, usd, project_id FROM costs WHERE task_id = ? ORDER BY id')
    .all(taskId) as Array<Record<string, number | string | null>>;

test('AI-8: 员工会话的 cost/cache 真落库；预算口径不变；事件可审计', async () => {
  const { db, projectId, taskId, wiId } = setup();
  try {
    const usage = { model: 'fake/m', inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 30, costUsd: 0.0123 };
    const fake = makeFakeAgentRuntime([
      { text: 'done', usage, toolCalls: [{ id: 's1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));

    const rows = costRows(db, taskId);
    assert.equal(rows.length, 1, `应有恰 1 条成本行，实际 ${rows.length}`);
    const r = rows[0]!;
    assert.equal(r.usd, 0.0123, 'usd 必须与运行器给的一字不差（不硬编码、不取整）');
    assert.equal(r.cache_read_tokens, 900);
    assert.equal(r.cache_write_tokens, 30);
    assert.equal(r.tokens_in, 100);
    assert.equal(r.tokens_out, 50);
    assert.equal(r.model, 'fake/m');
    assert.equal(r.project_id, projectId, 'project_id 必须来自真项目（接线漏了会 null → 有牙）');

    const cost = db.prepare('SELECT cost_tokens FROM tasks WHERE id = ?').get(taskId) as { cost_tokens: number };
    assert.equal(cost.cost_tokens, 150, '预算口径不变：只计 tokens_in + tokens_out（缓存不计入）');

    const ev = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'cost_recorded'").all(taskId) as Array<{ payload: string }>;
    assert.equal(ev.length, 1);
    const payload = JSON.parse(ev[0]!.payload) as Record<string, unknown>;
    assert.equal(payload.cacheReadTokens, 900, 'cost_recorded payload 必须带缓存字段（可审计）');
  } finally {
    db.close();
  }
});

test('AI-8 "不臆造": 无 usage / 全零用量 → 不写成本行', async () => {
  {
    const { db, taskId, wiId } = setup();
    try {
      const fake = makeFakeAgentRuntime([{ text: 'done', toolCalls: [] }]); // 不给 usage
      const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
      await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));
      assert.equal(costRows(db, taskId).length, 0, '无 usage ⇒ 不写行');
    } finally {
      db.close();
    }
  }
  {
    const { db, taskId, wiId } = setup();
    try {
      const fake = makeFakeAgentRuntime([{ text: 'done', usage: { model: 'fake/m', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, toolCalls: [] }]);
      const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
      await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));
      assert.equal(costRows(db, taskId).length, 0, '全零用量 ⇒ 无事实可记，不写行');
    } finally {
      db.close();
    }
  }
});

test('AI-8: 评审会话（critic）同样入账（它也烧钱）', async () => {
  const { db, projectId, taskId } = setup();
  try {
    const usage = { model: 'fake/critic', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0007 };
    const fake = makeFakeAgentRuntime([{ text: '', usage, toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve', notes: 'n' }, isError: false }] }]);
    const events: EngineEvent[] = [];
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute(toPersistedAction(`dispatch_critic:task:${taskId}:0`, 'dispatch_critic', taskId, '{}'));

    const rows = costRows(db, taskId);
    assert.equal(rows.length, 1, '评审会话也应写 1 条成本行');
    assert.equal(rows[0]!.usd, 0.0007);
    assert.equal(rows[0]!.project_id, projectId);
    const emp = db.prepare('SELECT employee_id FROM costs WHERE task_id = ?').get(taskId) as { employee_id: number };
    assert.equal(emp.employee_id, 9, 'critic 必须独立于规划者(0)/实现者(7)——成本可归因到独立评审者');
  } finally {
    db.close();
  }
});

test('成本事件可带来源标记（assistant_selection）——不改预算口径，只供审计区分', () => {
  const { db, taskId } = setup();
  try {
    recordCost(db, {
      taskId,
      employeeId: 0,
      model: 'deepseek/deepseek-flash',
      tokensIn: 10,
      tokensOut: 2,
      usd: 0.00001,
      source: 'assistant_selection',
      now: 2,
    });
    const ev = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'cost_recorded'").all(taskId) as Array<{ payload: string }>;
    assert.equal(JSON.parse(ev[0]!.payload).source, 'assistant_selection');
    const task = db.prepare('SELECT cost_tokens FROM tasks WHERE id = ?').get(taskId) as { cost_tokens: number };
    assert.equal(task.cost_tokens, 12, '预算口径仍是输入+输出（标记不改变记账）');
  } finally {
    db.close();
  }
});
