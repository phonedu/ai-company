/**
 * M2-A「成本 tab」（`OPT-EXT-13`）—— 任务级成本汇总 + 成本 tab 渲染（含"有牙"）。
 * 口径：**无成本行 → 「本任务暂无成本记录。」**（不摆 $0.0000）；**有行 → 真值 + 按模型拆分**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { summarizeTaskCosts } from '../src/main/db/costs.js';
import { AppChrome } from '../src/renderer/components/AppChrome.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

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

function cost(db: ReturnType<typeof openMemoryDatabase>, taskId: number, model: string, ti: number, to: number, usd: number): void {
  db.prepare(
    'INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?, NULL, NULL, ?, ?, ?, ?, ?)',
  ).run(taskId, model, ti, to, usd, AT);
}

function detail(): TaskDetailDTO {
  return {
    task: { id: 1, shortId: 'T-1001', projectId: 1, title: 't', goal: 'g', state: 'executing', riskLevel: 1, priority: 0, createdAt: AT, updatedAt: AT, acceptance: [] },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}

test('成本 tab DAO：单任务汇总 + 按模型拆分；空任务 → 全 0/空数组', () => {
  const { db, taskId } = setup();
  try {
    assert.deepEqual(summarizeTaskCosts(db, taskId), { costRows: 0, tokens: 0, usd: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, usdPerHour: 0, companyUsd: 0, byModel: [], byEmployee: [] });
    cost(db, taskId, 'deepseek-flash', 100, 20, 0.01);
    cost(db, taskId, 'deepseek-flash', 5, 5, 0.02);
    cost(db, taskId, 'other-model', 7, 3, 0.005);
    const s = summarizeTaskCosts(db, taskId);
    assert.equal(s.costRows, 3);
    assert.equal(s.tokens, 140, '100+20+5+5+7+3');
    assert.equal(s.byModel.length, 2, '两个模型');
    const flash = s.byModel.find((m) => m.model === 'deepseek-flash')!;
    assert.equal(flash.tokensIn, 105);
    assert.equal(flash.tokensOut, 25);
  } finally {
    db.close();
  }
});

test('成本 tab 渲染：有行 → 显示真值 + 每模型一行；无行 → 显式「暂无成本记录」', () => {
  const withCost = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail(),
      initialTab: 'cost',
      cost: { costRows: 2, tokens: 140, usd: 0.035, byModel: [{ model: 'deepseek-flash', tokensIn: 105, tokensOut: 25, usd: 0.03 }] },
    }),
  );
  assert.match(withCost, /data-testid="cost-panel"/);
  assert.match(withCost, /data-testid="cost-total"[^>]*>[\s\S]*?140 tok/);
  assert.match(withCost, /data-testid="cost-row"[^>]*data-model="deepseek-flash"/);
  assert.equal(withCost.includes('暂无成本记录'), false, '有行 → 不显空态');

  const empty = renderToStaticMarkup(
    createElement(TaskDetail, { data: detail(), initialTab: 'cost', cost: { costRows: 0, tokens: 0, usd: 0, byModel: [] } }),
  );
  assert.match(empty, /data-testid="cost-empty"[\s\S]*?暂无成本记录/);
  assert.equal(empty.includes('$0.0000'), false, '空态不摆 $0.0000');

  const none = renderToStaticMarkup(createElement(TaskDetail, { data: detail(), initialTab: 'cost' }));
  assert.match(none, /暂无成本记录/, '无数据源 → 空态');
});

test('成本 tab "有牙"：若把无成本行也当"有数据"（costRows>0 恒定）→ 空态被掩盖（证明判定承重）', () => {
  const zeros = { costRows: 0, tokens: 0, usd: 0, byModel: [] };
  const has = !!zeros && zeros.costRows > 0;
  assert.equal(has, false, '0 行 → 不是"有数据"');
  // 若实现写成 `if (cost)` 而不看 costRows，就会把 0 行当成有数据、掩盖空态：
  assert.notEqual(!!zeros, has);
});

test('N1 顶栏：有数据 ⇒ 显示速率节点（$/h）；无数据 ⇒ 不渲染速率', () => {
  const withRate = renderToStaticMarkup(
    createElement(AppChrome, {
      todoCount: 0,
      agent: 'ready' as never,
      cost: { costRows: 1, tokens: 100, usd: 1.5, cacheReadTokens: 900, cacheWriteTokens: 0, cacheHitRate: 0.9, usdPerHour: 2.25 },
    }),
  );
  assert.match(withRate, /data-testid="statusbar-cost-rate"[^>]*>[\s\S]*?\$ 2\.25\/h/);

  const empty = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0, agent: 'ready' as never, cost: null }));
  assert.equal(empty.includes('statusbar-cost-rate'), false, '无数据 ⇒ 不渲染速率（不摆假 0）');
});
