/**
 *  ``「用量可视」—— 成本聚合（`summarizeCosts`，含"有牙"）。
 * 口径：**有成本行则非 0；无行 → costRows=0（由上层显 `—`，不写假 0）**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { summarizeCosts } from '../src/main/db/costs.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppChrome } from '../src/renderer/components/AppChrome.js';

const AT = 1_700_000_000_000;

function setup(): { db: ReturnType<typeof openMemoryDatabase>; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const counters = new SqliteCounterStore(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/r', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, counters, { projectId, title: 'T', goal: 'g', riskLevel: 0 });
  return { db, taskId: task.id };
}

function cost(db: ReturnType<typeof openMemoryDatabase>, taskId: number, tokensIn: number, tokensOut: number, usd: number, at: number): void {
  db.prepare(
    'INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?, NULL, NULL, ?, ?, ?, ?, ?)',
  ).run(taskId, 'deepseek-flash', tokensIn, tokensOut, usd, at);
}

test('OPT-EXT-13 聚合：无成本行 → costRows:0（上层显 `—`，不写假 0）', () => {
  const { db } = setup();
  try {
    assert.deepEqual(summarizeCosts(db), { costRows: 0, tokens: 0, usd: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, usdPerHour: 0, companyUsd: 0, byEmployee: [] });
  } finally {
    db.close();
  }
});

test('OPT-EXT-13 聚合：有行 → tokens/usd 求和、costRows 计数（非死读数）', () => {
  const { db, taskId } = setup();
  try {
    cost(db, taskId, 100, 20, 0.01, AT);
    cost(db, taskId, 5, 5, 0.02, AT + 1);
    const s = summarizeCosts(db);
    assert.equal(s.costRows, 2);
    assert.equal(s.tokens, 130, '100+20+5+5');
    assert.ok(Math.abs(s.usd - 0.03) < 1e-9, '0.01+0.02');
  } finally {
    db.close();
  }
});

test('OPT-EXT-13 `since` 过滤：只算窗口内的行（今日成本用）', () => {
  const { db, taskId } = setup();
  try {
    cost(db, taskId, 100, 0, 0.01, AT - 30 * 24 * 3600 * 1000); // 30 天前
    cost(db, taskId, 10, 0, 0.02, AT); // 今天
    const today = summarizeCosts(db, { since: AT - 24 * 3600 * 1000 });
    assert.equal(today.costRows, 1);
    assert.equal(today.tokens, 10);
    assert.equal(summarizeCosts(db).costRows, 2, '不带 since = 全部');
  } finally {
    db.close();
  }
});

test('OPT-EXT-13 "有牙"：`since` 若被忽略（不过滤）→ 今日成本必然多算（证明过滤承重）', () => {
  const { db, taskId } = setup();
  try {
    cost(db, taskId, 100, 0, 0.01, AT - 30 * 24 * 3600 * 1000);
    cost(db, taskId, 10, 0, 0.02, AT);
    const windowed = summarizeCosts(db, { since: AT - 24 * 3600 * 1000 }).tokens;
    const unfiltered = summarizeCosts(db).tokens;
    assert.equal(windowed, 10);
    assert.equal(unfiltered, 110, '不过滤 → 110（证明过滤真承重）');
    assert.notEqual(windowed, unfiltered);
  } finally {
    db.close();
  }
});

test('OPT-EXT-13 底栏状态条：有数据 → 真值；无数据/0 行 → `—`（不写假 0）', () => {
  const withCost = renderToStaticMarkup(
    createElement(AppChrome, { todoCount: 0, cost: { costRows: 2, tokens: 130, usd: 0.03 } }),
  );
  assert.match(withCost, /data-testid="statusbar-cost"[^>]*data-has-cost="true"/);
  assert.match(withCost, /\$0\.0300/, '有数据显真值');
  assert.equal(withCost.includes('今日成本 —'), false, '有数据不显 —');
  assert.equal(/今日成本\s*\$?0(?![.\d])/.test(withCost), false, '不得出现"看起来像 0"的死读数');

  const zeroRows = renderToStaticMarkup(
    createElement(AppChrome, { todoCount: 0, cost: { costRows: 0, tokens: 0, usd: 0 } }),
  );
  assert.match(zeroRows, /今日成本 —/, '0 行 → —（不写假 0）');
  // 3290：源已接但暂无数据 → 只说"暂无数据"；不与"源未接入"混用。
  assert.match(zeroRows, /data-testid="statusbar-cost"[^>]*title="暂无今日成本数据"/);

  const noSource = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0 }));
  assert.match(noSource, /今日成本 —/, '无数据源 → —');
  assert.match(noSource, /data-testid="statusbar-cost"[^>]*title="暂无今日成本数据"/, '成本源已接：空态标题不说"源未接入"');
  assert.match(noSource, /data-testid="statusbar-slots"[^>]*title="数据源未接入（M1）"/, '槽位真未接：才说"源未接入"');
});

test('N1 速率：usdPerHour 只算最近 1 小时（窗外的钱不算进速率）', () => {
  const { db, taskId } = setup();
  try {
    cost(db, taskId, 10, 5, 1, AT - 10 * 60 * 1000);      // 10 分钟前：$1
    cost(db, taskId, 10, 5, 9, AT - 2 * 60 * 60 * 1000);  // 2 小时前：$9
    const s = summarizeCosts(db, { now: AT });
    assert.equal(s.usd, 10, '总额含两行');
    assert.equal(s.usdPerHour, 1, '速率窗只含最近 1 小时——**看速率才是防"如流水"的正解**');
  } finally {
    db.close();
  }
});

test('N1 命中率：cacheRead/(input+cacheRead+cacheWrite)；分母 0 ⇒ null（不写假 0）', () => {
  const { db, taskId } = setup();
  try {
    db.prepare(
      'INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, usd, created_at) VALUES(?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)',
    ).run(taskId, 'm', 100, 50, 900, 0, 0.01, AT);
    const s = summarizeCosts(db, { now: AT });
    assert.equal(s.cacheReadTokens, 900);
    assert.equal(s.cacheHitRate, 0.9, '分母 = input+cacheRead+cacheWrite = 1000 ⇒ 0.9');
    // 有牙：naive 分母（input+output = 150）会给出 6.0 —— 断言真值即证明**分母选择承重**
    assert.notEqual(s.cacheHitRate, 900 / 150);
  } finally {
    db.close();
  }
});

test('N1 命中率：只有输出 token（无任何输入）⇒ null，渲染层显 —', () => {
  const { db, taskId } = setup();
  try {
    cost(db, taskId, 0, 20, 0.001, AT);
    const s = summarizeCosts(db, { now: AT });
    assert.equal(s.cacheHitRate, null, '分母 0 ⇒ null（不写假 0）');
    assert.equal(s.cacheReadTokens, 0);
  } finally {
    db.close();
  }
});

test('M2 可续④ 右栏读数：资源占用/成本与顶栏同源真读数；无读数显 —（不写假 0）', () => {
  let html = renderToStaticMarkup(
    createElement(AppChrome, { todoCount: 0, cost: { costRows: 2, tokens: 130, usd: 0.03 }, slots: { running: 1, total: 3 } }),
  );
  assert.match(html, /data-testid="right-rail-slots"[^>]*data-has-slots="true"/);
  assert.ok(html.includes('资源占用 1/3 槽'), '槽位真读数上屏');
  assert.ok(html.includes('成本 $0.0300'), '成本真读数上屏（与顶栏同源）');

  html = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0, cost: null }));
  assert.match(html, /data-testid="right-rail-slots"[^>]*data-has-slots="false"/);
  assert.ok(html.includes('资源占用 —'), '无读数 ⇒ —（不写假 0）');
  assert.ok(html.includes('成本 —'), '无成本数据 ⇒ —（不写假 0）');
});
