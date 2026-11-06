/**
 * GAP8（M3-P-1）UI 面：
 *  - 计划编辑纯函数（增删/排序）不越界、不静默丢只剩一步；
 *  - 待批准任务：操作条「改计划再批准」可点 → 打开编辑器；计划面板「编辑计划」可见；
 *  - 批准卡展示计划全文，列表展示计划摘要（编辑后随 payload 刷新）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { appendPlanStep, movePlanStep, removePlanStep, updatePlanStep } from '../src/renderer/components/planEditor.js';
import { planSummary } from '../src/renderer/components/inboxModel.js';
import { CardPlan } from '../src/renderer/components/CardPlan.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

test('GAP8 编辑器纯函数：上移/下移/追加/删除/改文本（边界不越界）', () => {
  const base = ['A', 'B', 'C'];
  assert.deepEqual(movePlanStep(base, 2, -1), ['A', 'C', 'B']);
  assert.deepEqual(movePlanStep(base, 0, -1), base, '首行上移无效');
  assert.deepEqual(movePlanStep(base, 2, 1), base, '末行下移无效');
  assert.deepEqual(appendPlanStep(base), ['A', 'B', 'C', '']);
  assert.deepEqual(removePlanStep(base, 1), ['A', 'C']);
  assert.deepEqual(removePlanStep(['A'], 0), ['A'], '只剩一步时不允许删空');
  assert.deepEqual(updatePlanStep(base, 1, 'B2'), ['A', 'B2', 'C']);
  assert.deepEqual(updatePlanStep(base, 9, 'X'), base, '越界不改');
  assert.deepEqual(appendPlanStep(Array.from({ length: 12 }, (_, i) => `s${i}`)).length, 12, '上限 12 不再追加');
});

test('GAP8 待批准任务：操作条可点且标记「打开编辑器」；计划面板有编辑入口', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: fixture('awaiting_approval'),
      initialTab: 'plan',
      onSavePlan: async () => null,
    }),
  );
  assert.match(html, /data-testid="task-action-revise-approve"[^>]*data-implemented="true"/);
  assert.match(html, /data-testid="task-action-revise-approve"[^>]*data-opens-editor="true"/);
  assert.doesNotMatch(html, /data-testid="task-action-revise-approve"[^>]*\sdisabled=/);
  assert.match(html, /data-testid="plan-edit"/, '计划面板提供编辑计划入口');
  assert.match(html, /data-testid="plan-step"/);
});

test('GAP8 非待批准态：没有编辑入口（不假装能改）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: fixture('executing'),
      initialTab: 'plan',
      onSavePlan: async () => null,
    }),
  );
  assert.equal(html.includes('data-testid="plan-edit"'), false);
  assert.equal(html.includes('data-testid="task-action-revise-approve"'), false);
});

test('GAP8 批准卡展示计划全文（data-count=实际步数）；Card 已接线 CardPlan', () => {
  const html = renderToStaticMarkup(
    createElement(CardPlan, { steps: ['读需求（改）', '写实现', '跑验收', '补回归'] }),
  );
  assert.match(html, /data-testid="card-plan"[^>]*data-count="4"/);
  assert.ok(html.includes('读需求（改）'));
  assert.ok(html.includes('补回归'));
  const cardSource = readFileSync('src/renderer/components/Card.tsx', 'utf8');
  assert.match(cardSource, /<CardPlan steps=\{card\.payload\.planSteps\}/, 'Card 必须渲染 CardPlan（不是死代码）');

  assert.equal(planSummary(['A', 'B']), '1. A · 2. B');
  assert.equal(planSummary(['A', 'B', 'C', 'D']), '1. A · 2. B · 3. C · 另 1 步');
  assert.equal(planSummary([]), null);
  assert.equal(planSummary(undefined), null);
});

function fixture(state: string): TaskDetailDTO {
  const at = 1_700_000_000_000;
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: '计划编辑',
      goal: 'g',
      state,
      riskLevel: 1,
      priority: 0,
      createdAt: at,
      updatedAt: at,
      acceptance: [],
    },
    progress: { done: 0, total: 2 },
    planSteps: [
      { idx: 1, text: '第一步', state: 'pending' },
      { idx: 2, text: '第二步', state: 'pending' },
    ],
    timeline: [],
    behaviorLog: [],
    counts: { planSteps: 2, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}
