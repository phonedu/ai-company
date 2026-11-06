/**
 * B2 右栏上下文化（2026-10-17）——判据：
 *   ① 全局：槽位/成本真读数 + 「谁在忙」（有大厅数据才列；无数据显式空态）；不再有"待做"开发备注；
 *   ② 任务：产物 / 证据 / 成本三块；空数据显式空态；加载/错误不伪装；
 *   ③ 壳层：`AppChrome` 接受 `rightRail` 注入；`AppShell` 传入 `RightRail`；源码不得再出现旧备注。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { OverviewRail, TaskRail } from '../src/renderer/components/RightRailView.js';
import type { TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';
import type { CostSummaryDTO, EmployeeDTO } from '../src/renderer/types.js';

function renderOverview(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(OverviewRail, overrides as never));
}

function renderTask(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(TaskRail, overrides as never));
}

const EMPLOYEES: EmployeeDTO[] = [
  { id: 1, name: '林悦', role: '产品负责人', activity: { status: 'running', currentAction: '写对账脚本', taskShortId: 'T-1042', todayOutput: 2, todayMinutes: 40 } },
  { id: 2, name: '陈默', role: '技术负责人', activity: { status: 'idle', currentAction: null, taskShortId: null, todayOutput: 0, todayMinutes: 0 } },
];

const COST = { costRows: 2, usd: 0.42, tokens: 1200 } as unknown as CostSummaryDTO;

function fixture(): TaskDetailDTO {
  return {
    task: { id: 1, shortId: 'T-1042', projectId: 1, title: '竞品对账', goal: 'g', state: 'executing', riskLevel: 1, priority: 0, createdAt: 0, updatedAt: 0, acceptance: [] },
    progress: { done: 1, total: 2 },
    planSteps: [
      { idx: 1, text: '调研', state: 'done', evidenceRef: 'pytest -q' },
      { idx: 2, text: '实现', state: 'running', evidenceRef: null },
    ],
    timeline: [],
    behaviorLog: [],
    artifacts: [{ id: 5, kind: 'file', name: 'reconcile.md', path: 'reports/reconcile.md' }],
  } as unknown as TaskDetailDTO;
}

test('B2 全局右栏：槽位/成本真读数 + 谁在忙；无开发备注', () => {
  const html = renderOverview({ slots: { running: 2, total: 3 }, cost: COST, employees: EMPLOYEES });
  assert.match(html, /data-testid="right-rail-overview"/);
  assert.match(html, /资源占用 2\/3 槽/);
  assert.match(html, /成本 \$0\.4200/);
  assert.match(html, /data-testid="right-rail-active"/);
  assert.match(html, /林悦/);
  assert.equal(html.includes('陈默'), false, '空闲员工不进「谁在忙」');
  assert.equal(html.includes('待做'), false, '开发备注不得上屏');
});

test('B2 全局右栏：大厅未加载/无人忙 ⇒ 显式空态，不摆假动作', () => {
  const noHall = renderOverview({ slots: null, cost: null });
  assert.match(noHall, /调度详情在公司大厅/);
  assert.match(noHall, /资源占用 —/);
  assert.match(noHall, /成本 —/);

  const idle = renderOverview({
    slots: { running: 0, total: 3 },
    cost: null,
    employees: [
      { id: 3, name: '苏然', role: '运营负责人', activity: { status: 'idle', currentAction: null, taskShortId: null, todayOutput: 0, todayMinutes: 0 } },
    ],
  });
  assert.match(idle, /现在没有员工在跑/);
});

test('B2 任务右栏：产物/证据/成本三块；空数据显式空态', () => {
  const html = renderTask({ detail: fixture(), cost: COST });
  assert.match(html, /data-testid="right-rail-task"/);
  assert.match(html, /T-1042 · 竞品对账/);
  assert.match(html, /data-testid="right-rail-task-artifacts"[\s\S]*reconcile\.md/);
  assert.match(html, /data-testid="right-rail-task-evidence"[\s\S]*pytest -q/);
  assert.match(html, /data-testid="right-rail-task-cost"[^>]*>成本 \$0\.4200/);

  // UG-05：有 handler 时产物名变成可点入口（复用任务详情的统一抽屉）。
  const clickable = renderTask({
    detail: fixture(),
    cost: COST,
    onPreviewArtifact: () => undefined,
  });
  assert.match(clickable, /data-testid="right-rail-task-artifact"[^>]*data-artifact-id="5"/);
  assert.match(clickable, /预览产物/);

  const empty = renderTask({ detail: { ...fixture(), artifacts: [], planSteps: [] } as unknown as TaskDetailDTO });
  assert.match(empty, /暂无产物/);
  assert.match(empty, /暂无证据/);
  assert.match(empty, /成本 —/);
});

test('CTX1-2 任务右栏：上下文遥测真值上屏；未知显 —；无遥测显式空态', () => {
  const none = renderTask({ detail: fixture(), cost: COST });
  assert.match(none, /data-testid="right-rail-task-context-empty"[\s\S]*?还没有上下文遥测/, '无遥测 → 显式空态');
  assert.doesNotMatch(none, /right-rail-task-context"[^>]*>[\s\S]*?0 tok/, '不得摆假 0');

  const detail = {
    ...fixture(),
    contextMetrics: [
      {
        id: 1,
        sessionKey: 'employee:1:task:1:wi:-',
        ts: 0,
        totalTokens: 12000,
        systemTokens: 8000,
        userTokens: 4000,
        contextWindow: null,
        utilization: null,
        truncated: true,
        layers: [{ name: 'bossText', chars: 9000, estTokens: 4000, truncated: true, tokensBeforeCap: 9000 }],
        compactionCount: 2,
        tokensBeforeCompaction: 150000,
        cacheReadTokens: 6400,
        cacheWriteTokens: 800,
      },
    ],
  } as unknown as TaskDetailDTO;
  const html = renderTask({ detail, cost: COST });
  assert.match(html, /data-testid="right-rail-task-context"[^>]*>[\s\S]*?12000 tok[\s\S]*?窗口 —[\s\S]*?占用 —/);
  assert.match(html, /data-testid="right-rail-task-context-meta"[^>]*>[\s\S]*?压缩 2 次[\s\S]*?读 6400 \/ 写 800/);
  assert.match(html, /data-testid="right-rail-task-context-layer"[^>]*data-layer="bossText"[\s\S]*?截断（9000→4000）/);
});

test('B2 任务右栏：加载/错误/未选任务不伪装', () => {
  assert.match(renderTask({ detail: null, loading: true }), /加载中…/);
  assert.match(renderTask({ detail: null, error: '任务读取失败' }), /任务读取失败/);
  assert.match(renderTask({ detail: null }), /未选择任务/);
});

test('B2 壳层：AppShell 注入 RightRail；旧备注与 testid 不得回潮', () => {
  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  const chrome = readFileSync('src/renderer/components/AppChrome.tsx', 'utf8');
  const view = readFileSync('src/renderer/components/RightRailView.tsx', 'utf8');
  assert.match(shell, /rightRail=\{<RightRail\s*\/>\}/, 'AppShell 未注入 RightRail');
  assert.match(shell, /loadHall\(\)/, 'AppShell 未加载大厅聚合');
  assert.match(chrome, /rightRail \?\? <OverviewRail/, 'AppChrome 缺 rightRail 注入回落');
  assert.equal(chrome.includes('right-rail-unimplemented'), false, 'AppChrome 旧备注 testid 回潮');
  assert.equal(view.includes('待做'), false, 'RightRailView 不得写开发备注');
});
