/**
 * CTX-1 P0 · 上下文遥测落库（CTX1-2）与层预算（CTX1-4）——真库断言。
 *
 * - `context_metrics` DAO：写/回填/按任务读；未知保持 NULL（不写假 0）。
 * - `buildEmployeeContext`：真实拼装带 `meta.telemetry`；超预算层显式截断（标记可读）。
 * - 执行器：会话前写一行、会话后回填 cache/压缩读数；sessionKey 与运行时一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertContextMetric,
  insertWorkItem,
  listContextMetricsByTask,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  updateContextMetricAfterRun,
  type SqliteDb,
} from '../src/main/db/index.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { LAYER_TOKEN_CAPS } from '../src/main/agent/context-telemetry.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, employeeSessionKey, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';

const AT = 1_800_000_000_000;

function setupDb(rootDir: string): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: AT });
  const projectId = Number(
    db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?)').run('P', rootDir, AT).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: AT });
  return { db, taskId: task.id, wiId: wi.id };
}

test('CTX1-2: context_metrics DAO 写/回填/读；未知字段是 NULL 不是 0', () => {
  const { db, taskId } = setupDb('D:/repo');
  try {
    const id = insertContextMetric(db, {
      taskId,
      workItemId: null,
      employeeId: 7,
      projectId: null,
      sessionKey: 'employee:7:task:1:wi:-',
      ts: AT,
      totalTokens: 120,
      systemTokens: 100,
      userTokens: 20,
      contextWindow: null,
      utilization: null,
      truncated: true,
      layers: [{ name: 'platform', chars: 400, estTokens: 100, truncated: false, tokensBeforeCap: 100 }],
      compactionCount: null,
      tokensBeforeCompaction: null,
    });
    let [row] = listContextMetricsByTask(db, taskId);
    assert.ok(row);
    assert.equal(row!.id, id);
    assert.equal(row!.contextWindow, null, '窗口未知 → null（不写假 0）');
    assert.equal(row!.utilization, null);
    assert.equal(row!.compactionCount, null);
    assert.equal(row!.cacheReadTokens, null);
    assert.equal(row!.model, null, '未提供模型 → NULL（不写假值）');
    assert.equal(row!.systemPromptHash, null, '未提供指纹 → NULL');
    assert.equal(row!.truncated, true);
    assert.equal(row!.layers.length, 1);
    assert.equal(row!.layers[0]!.estTokens, 100);

    updateContextMetricAfterRun(db, id, { cacheReadTokens: 30, cacheWriteTokens: 12, compactionCount: 1, tokensBeforeCompaction: 900 });
    [row] = listContextMetricsByTask(db, taskId);
    assert.equal(row!.cacheReadTokens, 30);
    assert.equal(row!.cacheWriteTokens, 12);
    assert.equal(row!.compactionCount, 1);
    assert.equal(row!.tokensBeforeCompaction, 900);

    // 新行在前（同 ts 用 id 兜底）
    insertContextMetric(db, {
      taskId,
      sessionKey: 's2',
      ts: AT + 1,
      totalTokens: 5,
      systemTokens: 5,
      userTokens: 0,
      contextWindow: 1000,
      utilization: 0.005,
      truncated: false,
      layers: [],
      compactionCount: 0,
      tokensBeforeCompaction: null,
    });
    const rows = listContextMetricsByTask(db, taskId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.totalTokens, 5, '新的在前');
    assert.equal(rows[0]!.utilization, 0.005);
  } finally {
    db.close();
  }
});

test('CTX1-2/4: 真实拼装带 telemetry；项目上下文/老板原话超预算 → 头尾截断＋显式标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-ctx-'));
  try {
    mkdirSync(join(dir, '.aico'), { recursive: true });
    const longAgents = ['# 约定'].concat(Array.from({ length: 900 }, (_, i) => `- 规则 ${i}：不要静默丢内容，报告要可核查。`)).join('\n');
    writeFileSync(join(dir, 'AGENTS.md'), longAgents, 'utf8');
    const { db, taskId } = setupDb(dir);
    try {
      const bossText = '请按约定执行。'.repeat(900);
      const ctx = buildEmployeeContext(db, { employeeId: 7, taskId, bossText });
      const telemetry = ctx.meta.telemetry;
      assert.ok(telemetry, '真实拼装必须带 telemetry');
      assert.ok(telemetry!.totalTokens > 0);
      assert.ok(telemetry!.systemTokens > 0 && telemetry!.userTokens > 0);
      assert.equal(telemetry!.utilization, null, 'buildContext 时窗口未知 → null');

      const names = telemetry!.layers.map((l) => l.name);
      for (const required of ['platform', 'role', 'persona', 'baseline', 'bossText', 'projectContext']) {
        assert.ok(names.includes(required), `层 ${required} 必须在遥测里`);
      }
      const projectLayer = telemetry!.layers.find((l) => l.name === 'projectContext')!;
      const bossLayer = telemetry!.layers.find((l) => l.name === 'bossText')!;
      assert.equal(projectLayer.truncated, true, '超 2000 token 的 AGENTS.md 必须截断');
      assert.ok(projectLayer.tokensBeforeCap > LAYER_TOKEN_CAPS.projectContext!);
      assert.ok(ctx.userPrompt.includes('【projectContext 已截断'), '截断必须有显式标记（不静默丢）');
      assert.equal(bossLayer.truncated, true, '超 4000 token 的老板原话必须截断');
      assert.ok(ctx.userPrompt.includes('【bossText 已截断'), '老板原话截断也要标记（不摘要）');
      assert.equal(telemetry!.truncated, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CTX1-2: 执行器会话前落一行遥测、会话后回填 cache 与压缩读数', async () => {
  const { db, taskId, wiId } = setupDb('D:/repo');
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: 'done',
        toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
        usage: { model: 'deepseek/deepseek-flash', inputTokens: 100, outputTokens: 20, cacheReadTokens: 64, cacheWriteTokens: 8, costUsd: 0.001 },
      },
    ]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: () => undefined,
      buildContext: (d, input) => buildEmployeeContext(d, input),
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, JSON.stringify({ attempt: 0 })));

    const rows = listContextMetricsByTask(db, taskId);
    assert.equal(rows.length, 1, '一次会话一行');
    const row = rows[0]!;
    assert.equal(row.sessionKey, employeeSessionKey({ employeeId: 7, taskId, workItemId: wiId }));
    assert.equal(row.employeeId, 7);
    assert.equal(row.workItemId, wiId);
    assert.equal(row.contextWindow, null, '目录未加载 → 窗口未知(NULL)');
    assert.equal(row.utilization, null);
    assert.equal(row.totalTokens, row.systemTokens + row.userTokens);
    assert.ok(row.layers.length > 0, '分层读数必须落库');
    assert.equal(row.cacheReadTokens, 64, '会话后回填 cache 读');
    assert.equal(row.cacheWriteTokens, 8, '会话后回填 cache 写');
    assert.equal(typeof row.model, 'string', 'CTX1-9：本轮模型必须落库');
    assert.match(row.systemPromptHash ?? '', /^[0-9a-f]{64}$/, 'CTX1-9：system prompt 指纹（sha256）');
    assert.equal(row.compactionCount, 0, '本会话未压缩 → 0（有观测）');
    // 遥测不是审计事件：不重复写 task_events
    const kinds = listTaskEvents(db, taskId).map((e) => e.kind);
    assert.ok(!kinds.includes('context_metrics'), '遥测不得混进 task_events');
  } finally {
    db.close();
  }
});
