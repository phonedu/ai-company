/**
 * 挂载 3 首批（引擎/数据面）：`GAP5`（AGENTS.md 摄入）· `BRK13`（预算链核心）· `GAP10`（按员工归因）。每条可弄红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { summarizeCosts } from '../src/main/db/costs.js';
import { readProjectContext } from '../src/main/agent/context.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { Engine } from '../src/main/engine/index.js';
import { handleChatSend, handleTaskCreate, parseBudgetCommand } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;
const noopExecutor = { execute: async (): Promise<void> => undefined };

test('GAP5：项目根 AGENTS.md 进项目层（回落 CLAUDE.md）；.aico/CONTEXT.md 并行；全无 → 空串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-ctx-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'aico-ctx2-'));
  try {
    assert.equal(readProjectContext(dir), '', '全无 → 空串（不占位、不臆造）');
    writeFileSync(join(dir, 'AGENTS.md'), '# 项目约定：一切改动走 PR\n', 'utf8');
    const withAgents = readProjectContext(dir);
    assert.ok(withAgents.includes('【项目约定 · AGENTS.md】') && withAgents.includes('一切改动走 PR'), 'AGENTS.md 进项目层');
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE 约定', 'utf8');
    assert.ok(!readProjectContext(dir).includes('CLAUDE 约定'), 'AGENTS.md 优先（不叠加 CLAUDE）');
    mkdirSync(join(dir, '.aico'));
    writeFileSync(join(dir, '.aico', 'CONTEXT.md'), '项目上下文文本', 'utf8');
    const both = readProjectContext(dir);
    assert.ok(both.includes('AGENTS.md') && both.includes('.aico/CONTEXT.md') && both.includes('项目上下文文本'), '约定层与上下文层并存');
    writeFileSync(join(dir2, 'CLAUDE.md'), '仅 CLAUDE', 'utf8');
    assert.ok(readProjectContext(dir2).includes('【项目约定 · CLAUDE.md】'), '无 AGENTS 时回落 CLAUDE.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('BRK13：建任务带预算 → 落库；`加预算 T1042 N` → 写列＋超预算暂停同时继续；非法值不改（回执如实）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => AT });
  const deps = { repo, engine };
  const created = await handleTaskCreate(deps, { goal: '带预算的任务', budgetTokens: 123456 });
  assert.equal(created.budgetTokens, 123456, '建任务即带预算（此前全仓无写入口——BRK13）');
  assert.equal(created.budgetLeftTokens, 123456, '余额＝预算−已耗');
  const bare = await handleTaskCreate(deps, { goal: '无预算' });
  assert.equal(bare.budgetTokens, null, '未设预算 ⇒ null（不臆造 0）');

  // 超预算暂停态（surgery：paused 且已耗超预算）→ 加预算命令 → 写列 ＋ resume（真引擎）
  db.prepare("UPDATE tasks SET state='paused', pause_reason='task_budget', cost_tokens=200000 WHERE id=?").run(created.id);
  const r = await handleChatSend(deps, { text: '加预算 T-1001 500000' }, AT + 1);
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT budget_tokens, state FROM tasks WHERE id=?').get(created.id) as {
    budget_tokens: number;
    state: string;
  };
  assert.equal(row.budget_tokens, 500000, '预算真写入');
  assert.equal(row.state, 'ready', '因超预算暂停的任务同时继续（05 §3.1.4 恢复动作）');
  assert.ok(
    repo.listMessages({ taskId: created.id }).some((m) => m.direction === 'out' && m.content.includes('并继续执行')),
    '回执如实',
  );

  await handleChatSend(deps, { text: '加预算 T-1001 0' }, AT + 2);
  assert.equal(
    (db.prepare('SELECT budget_tokens FROM tasks WHERE id=?').get(created.id) as { budget_tokens: number }).budget_tokens,
    500000,
    '非法值不改（回执另行如实）',
  );
  assert.deepEqual(parseBudgetCommand('加预算 T1042 8000'), { shortId: 'T-1042', tokens: 8000 }, '简写归一');
  assert.equal(parseBudgetCommand('加预算 T-1001 abc'), null, '非数字不吞');
  db.close();
});

test('GAP10：成本按员工归因（含 null=公司级；名字 join；归因之和＝总额）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(7,'E7','dev',1)").run();
    const ins = db.prepare(
      'INSERT INTO costs(task_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?,?,?,?,?,?,?)',
    );
    ins.run(null, 7, 'm', 100, 50, 0.5, AT);
    ins.run(null, 7, 'm', 100, 50, 0.25, AT + 1);
    ins.run(null, null, 'm', 10, 5, 0.1, AT + 2);
    const s = summarizeCosts(db);
    assert.ok(Math.abs(s.usd - 0.85) < 1e-9);
    const emp = s.byEmployee.find((e) => e.employeeId === 7);
    assert.ok(
      emp && Math.abs(emp.usd - 0.75) < 1e-9 && emp.name === 'E7' && emp.tokensIn === 200 && emp.tokensOut === 100,
      JSON.stringify(s.byEmployee),
    );
    const company = s.byEmployee.find((e) => e.employeeId === null);
    assert.ok(company && company.name === null && Math.abs(company.usd - 0.1) < 1e-9, '公司级（无归属）如实成组');
    assert.ok(
      Math.abs(s.byEmployee.reduce((a, e) => a + e.usd, 0) - s.usd) < 1e-9,
      '归因之和＝总额（不漏行）',
    );
  } finally {
    db.close();
  }
});
