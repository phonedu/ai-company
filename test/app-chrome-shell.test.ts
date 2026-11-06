/**
 * 壳层重排守卫（2026-10-16 替换批·第一批；设计件 §4.1「壳层重排批」/§9 壳层表）。
 *
 * 口径：
 *   ① **顶栏**＝〔左：折叠钮＋品牌〕〔中：搜索盒（disabled 诚实）〕〔右：右栏折叠钮＋**自绘三键**〕；
 *      拖拽＝`.topbar -webkit-app-region: drag`（`frame:false` 后系统标题栏不存在）；
 *   ② **底栏状态条 26px**：今日成本/槽位/待办**迁离顶栏**（`topbar-cost` 等 testid 退役→`statusbar-*`）；
 *   ③ **折叠**：左 208⇄56（图标态）/ 右 288⇄0；状态入本地记忆（壳持有）；折叠态只留图标；
 *   ④ **三键 IPC**：`frame:false`（主进程）＋ `ui:win-minimize/-toggle-maximize/-close`（主注册／
 *      preload 暴露／env.d.ts 声明——三侧一致由 `ipc-contract` AU1 ＋ G-10-11 把着）。
 *
 * 断言分三层：**渲染层**（AppChrome 纯组件静态渲染）＋**样式层**（styles.css 规则）＋
 * **源码层**（AppShell 记忆键 / 主进程窗口选项与 handler；真机观感由 CDP 真机验）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { AppChrome } from '../src/renderer/components/AppChrome.js';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
const main = readFileSync('src/main/index.ts', 'utf8');

function countTestId(html: string, id: string): number {
  const needle = `data-testid="${id}"`;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at === -1) break;
    n += 1;
    from = at + needle.length;
  }
  return n;
}

const full = renderToStaticMarkup(
  createElement(AppChrome, { todoCount: 3, cost: { costRows: 2, tokens: 130, usd: 0.03 }, slots: { running: 2, total: 3 } }),
);

test('壳层·顶栏：左折叠钮＋品牌 / 搜索盒 / 右折叠钮＋自绘三键 各就其位', () => {
  for (const id of ['rail-toggle-left', 'topbar-search', 'rail-toggle-right', 'win-minimize', 'win-maximize', 'win-close']) {
    assert.equal(countTestId(full, id), 1, `缺 ${id}`);
  }
  assert.match(full, /class="topbar__left"/);
  assert.match(full, /class="topbar__center"/);
  assert.match(full, /class="topbar__right"/);
  // 搜索盒：2026-10-18 起**可点** → 命令面板（Ctrl K）；形态保持（文案＋键帽提示）。
  assert.match(full, /data-testid="topbar-search"[^>]*title="打开命令面板（Ctrl K）"/);
  assert.ok(!/data-testid="topbar-search"[^>]*disabled/.test(full), '命令面板已落地 ⇒ 不再 disabled');
  assert.match(full, /Ctrl K/);
});

test('壳层·底栏状态条：读数迁离顶栏（topbar-cost 退役；statusbar-* 承担）', () => {
  for (const id of ['statusbar-cost', 'statusbar-slots', 'statusbar-todo']) {
    assert.equal(countTestId(full, id), 1, `缺 ${id}`);
  }
  // 退役：旧顶栏 chips 不再存在（防两处读数漂移）。
  assert.equal(full.includes('data-testid="topbar-cost"'), false, 'topbar-cost 应已迁底栏');
  assert.equal(full.includes('data-testid="topbar-slots"'), false);
  assert.equal(full.includes('data-testid="topbar-todo"'), false);
  // 真读数上屏（防假 0 回归：本件只做搬运，不碰口径——口径断言在 ui-truthful-readings）。
  assert.match(full, /data-testid="statusbar-slots"[^>]*>槽位 2\/3/);
  assert.match(full, /data-testid="statusbar-todo"[^>]*>待办 3/);
});

test('壳层·待办未加载：todoCount=null → 显 —（不写假 0）', () => {
  const html = renderToStaticMarkup(createElement(AppChrome, { todoCount: null }));
  assert.match(html, /data-testid="statusbar-todo"[^>]*>待办 —/);
});

test('壳层·折叠态：按钮 aria-pressed 随折叠态；两钮缺省（服务端渲染）不折叠', () => {
  const open = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0 }));
  assert.match(open, /data-testid="rail-toggle-left"[^>]*aria-pressed="false"/);
  assert.match(open, /data-testid="rail-toggle-right"[^>]*aria-pressed="false"/);
  const closed = renderToStaticMarkup(createElement(AppChrome, { todoCount: 0, leftCollapsed: true, rightCollapsed: true }));
  assert.match(closed, /data-testid="rail-toggle-left"[^>]*aria-pressed="true"/);
  assert.match(closed, /data-testid="rail-toggle-right"[^>]*aria-pressed="true"/);
});

test('样式·壳层：栅格含状态条行；顶栏拖拽区；折叠态规则成组', () => {
  assert.match(css, /--statusbar-h:\s*26px/);
  assert.match(css, /"statusbar statusbar statusbar"/);
  assert.match(css, /\.topbar\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /data-left-collapsed='true'\]\s*\{\s*--left-rail-w:\s*56px/);
  assert.match(css, /data-right-collapsed='true'\]\s*\{\s*--right-rail-w:\s*0px/);
  // 折叠态：只隐藏标签（图标栏只承载导航；任务列表/建任务区已退役，不再有对应规则）。
  assert.match(css, /data-left-collapsed='true'\]\s*\.left-rail__label\s*\{[^}]*display:\s*none/s);
  assert.equal(css.includes("data-left-collapsed='true'] .left-rail__create"), false, '旧建任务区折叠规则应退役');
  // 2026-10-17 真机反馈：未读数＝角标（圆角胶囊）；折叠态绝对定位，不参与图标行 flex（不挤图标）。
  assert.match(css, /\.left-rail__badge\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/s);
  assert.match(css, /data-left-collapsed='true'\]\s*\.left-rail__badge\s*\{[^}]*position:\s*absolute/s);
});

test('源码·壳与主进程：折叠记忆键；frame:false；三键 handler 已注册（AU1/G-10-11 另把双侧一致）', () => {
  assert.ok(shell.includes("aico.rail.collapsed"), '缺折叠记忆键（localStorage）');
  assert.match(shell, /data-left-collapsed=/);
  assert.match(shell, /data-right-collapsed=/);
  assert.match(shell, /api\?\.win/, '壳未接 window.api.win');
  assert.ok(/frame:\s*false/.test(main), '主进程窗口未开 frame:false');
  for (const ch of ['ui:win-minimize', 'ui:win-toggle-maximize', 'ui:win-close']) {
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), `主进程未注册 ${ch}`);
  }
});

test('窄窗：≤1040 右栏自动收起；顶栏开关临时展开不覆盖宽窗偏好', () => {
  // 2026-11-04 断点真源迁 SplitLayout（壳层复用 import，不再本地定义）。
  assert.match(shell, /const rightCollapsed = narrow \? !rightNarrowOpen : railCollapsed\.right/);
  assert.match(shell, /data-right-collapsed=\{rightCollapsed \? 'true' : 'false'\}/);
  assert.match(shell, /rightCollapsed=\{rightCollapsed\}/);
  assert.match(shell, /if \(narrow\) setRightNarrowOpen\(\(open\) => !open\)/);
  // 窄窗手动展开不得写进宽窗偏好：持久化仍只写 railCollapsed。
  assert.match(shell, /localStorage\.setItem\(RAIL_KEY, JSON\.stringify\(railCollapsed\)\)/);
  assert.match(css, /1040 以下\*\*右栏自动收起\*\*/);
  // 窄窗左栏收至 180（设计 960：左 180 / 内容 688 / 无右栏）；手动展开右栏仍保留 240。
  assert.match(css, /@media \(max-width: 1040px\)\s*\{\s*\.app-shell\s*\{\s*--left-rail-w:\s*180px;\s*--right-rail-w:\s*240px/);
});

test('UI 简化：无本地偏好时右栏默认收起（宽窗），左栏仍展开', () => {
  assert.match(shell, /if \(!raw\) return \{ left: false, right: true \}/, '无本地偏好时右栏应默认收起');
  assert.match(shell, /catch \{\s*return \{ left: false, right: true \}/s, '读取失败时也按右栏收起，不假装展开');
});
