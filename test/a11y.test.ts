/**
 *  可访问性守门（2026-10-17）——判据：
 *   ① 图标钮有可读名称（aria-label），不只靠 title/SVG；
 *   ② 大厅员工行状态有文字（色点之外的第二编码，不只靠颜色）；
 *   ③ 四个浮层都接焦点圈（useFocusTrap）且声明 aria-modal；
 *   ④ 全局焦点/按压/禁用规则在 styles.css（已锁，这里做集成引用）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { AppChrome } from '../src/renderer/components/AppChrome.js';

test('B5 壳层图标钮：rail 两钮 / 搜索 / 窗口三键都有 aria-label', () => {
  const html = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0 }));
  for (const [id, label] of [
    ['rail-toggle-left', '收起左栏'],
    ['rail-toggle-right', '收起右栏'],
    ['topbar-search', '打开命令面板'],
    ['win-minimize', '最小化窗口'],
    ['win-maximize', '最大化窗口'],
    ['win-close', '关闭窗口'],
  ] as const) {
    assert.match(html, new RegExp(`data-testid="${id}"[^>]*aria-label="${label}"`), `${id} 缺 aria-label`);
  }
  const max = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0, maximized: true }));
  assert.match(max, /data-testid="win-maximize"[^>]*aria-label="还原窗口"/, '最大化态应提供还原语义');
});

test('B5 大厅状态：色点之外有人话文字（不只靠颜色）', () => {
  const view = readFileSync('src/renderer/components/CompanyHallView.tsx', 'utf8');
  assert.match(
    view,
    /const STATUS_TEXT:[\s\S]*running:\s*'思考中'[\s\S]*waiting:\s*'等你'[\s\S]*stuck:\s*'卡住了'[\s\S]*idle:\s*'空闲'/,
  );
  assert.match(view, /className="hall-row__state"[\s\S]*?STATUS_TEXT\[status\]/);
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(css, /\.hall-row__state\s*\{[^}]*font-size:\s*var\(--text-meta\)/s);
});

test('B5 四个浮层：焦点圈 + aria-modal', () => {
  const files = [
    'src/renderer/components/CommandPalette.tsx',
    'src/renderer/components/TaskCreateDialog.tsx',
    'src/renderer/components/OnboardingWizard.tsx',
    'src/renderer/components/PreviewDrawer.tsx',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /useFocusTrap\(/, `${file} 未接 useFocusTrap`);
    assert.match(source, /aria-modal="true"/, `${file} 缺 aria-modal`);
  }
  // 任务详情产物预览已抽到统一 PreviewDrawer；TaskDetail 必须委托它，不能自带第二套浮层。
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /<PreviewDrawer/, 'TaskDetail 未委托统一预览抽屉');
});
