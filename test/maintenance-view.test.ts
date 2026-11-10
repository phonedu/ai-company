/**
 * B-4· 设置·高级「数据保留」纯视图：计数/按钮/二次确认 + 接线守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MaintenanceView, type MaintenanceViewProps } from '../src/renderer/components/MaintenanceView.js';

const base: MaintenanceViewProps = {
  loading: false,
  error: null,
  notice: null,
  counts: null,
  confirming: false,
  onPreview: () => undefined,
  onAskRun: () => undefined,
  onRun: () => undefined,
  onCancelRun: () => undefined,
};

test('B-4 视图：无计数时显式未预览；有计数显示四张表真实读数', () => {
  const empty = renderToStaticMarkup(createElement(MaintenanceView, base));
  assert.match(empty, /data-testid="settings-maintenance"/);
  assert.match(empty, /尚未预览/);
  assert.match(empty, /data-testid="maintenance-preview"/);
  assert.match(empty, /data-testid="maintenance-run"/);

  const counts = { remoteEvents: 1, outbox: 2, checkpoints: 3, timers: 4 };
  const html = renderToStaticMarkup(createElement(MaintenanceView, { ...base, counts, notice: '预览：…' }));
  assert.match(html, /过期远端事件：1/);
  assert.match(html, /已发\/取消\/过期 outbox：2/);
  assert.match(html, /已恢复\/失效检查点：3/);
  assert.match(html, /已触发定时器：4/);
  assert.match(html, /data-testid="maintenance-notice"/);
});

test('B-4 视图：运行清理需二次确认；错误可见；接线守卫', () => {
  const confirming = renderToStaticMarkup(createElement(MaintenanceView, { ...base, confirming: true, error: '示例错误' }));
  assert.match(confirming, /data-testid="maintenance-run-yes"/);
  assert.match(confirming, /data-testid="maintenance-run-no"/);
  assert.match(confirming, /data-testid="maintenance-error"/);
  assert.doesNotMatch(confirming, /data-testid="maintenance-run"/);

  const pane = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
  const view = readFileSync('src/renderer/components/SettingsView.tsx', 'utf8');
  const overview = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.match(pane, /props\.maintenance/);
  assert.match(view, /<MaintenancePanel\s*\/>/);
  assert.match(overview, /data-testid="project-export"/);
  assert.match(overview, /exportProject/);
});
