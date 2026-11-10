/**
 *  空态原语（2026-10-17）——判据：
 *   ① `page` 用 22/500 大标，`inline` 用 15/500；提示 12/dim；
 *   ② 任务详情的 0 步空态有标题+说明，不再是 12px 小字一行；
 *   ③ 待我处理/项目树/归档接入统一空态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { EmptyState } from '../src/renderer/components/EmptyState.js';

test('B3 空态原语：page / inline 两种密度与语义', () => {
  const page = renderToStaticMarkup(
    createElement(EmptyState, { variant: 'page', title: '暂无归档任务', hint: '归档是软操作，任务文件夹不会动。', testid: 'demo-empty' }),
  );
  assert.match(page, /class="empty-state" data-variant="page" data-testid="demo-empty"/);
  assert.match(page, /class="empty-state__title">暂无归档任务/);
  assert.match(page, /class="empty-state__hint">归档是软操作/);

  const inline = renderToStaticMarkup(createElement(EmptyState, { title: '计划还没生成', hint: '进入规划后出现。' }));
  assert.match(inline, /data-variant="inline"/);
  assert.match(inline, /计划还没生成/);
});

test('B3 空态样式：整页 22 / 卡内 15 / 提示 12', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(css, /\.empty-state__title\s*\{[^}]*font-size:\s*var\(--text-section\)/s);
  assert.match(css, /\.empty-state\[data-variant='page'\] \.empty-state__title\s*\{[^}]*font-size:\s*var\(--text-display\)/s);
  assert.match(css, /\.empty-state__hint\s*\{[^}]*font-size:\s*var\(--text-meta\)/s);
});

test('B3 任务详情：0 步不摆进度条，改为有标题的计划空态', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /progress\.total > 0 \?/, '进度条应按 total 条件渲染');
  assert.match(detail, /data-testid="plan-empty"[\s\S]*?计划还没生成/, '计划空态缺标题');
  assert.match(detail, /data-testid="acceptance-empty"[\s\S]*?验收项还没生成/, '验收空态缺标题');
});

test('B3 三个列表页接入统一空态', () => {
  const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  const projects = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
  const lists = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
  assert.match(inbox, /<EmptyState[\s\S]*?testid="inbox-empty"/);
  assert.match(inbox, /data-testid="inbox-empty-channel"/, '空态给「回老板频道」一个动作');
  assert.match(inbox, /没有要你拍板的事。/, '空态标题人话');
  assert.match(projects, /<EmptyState/);
  assert.match(lists, /testid="archive-empty"/);
  assert.match(lists, /testid="ptree-empty"/);
});
