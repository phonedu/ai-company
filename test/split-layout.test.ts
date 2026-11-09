/**
 * 2026-11-04 SplitLayout 统一分栏批（老板拍板）：主从两栏一处实现。
 * 判据：断点真源单处定义（壳层复用）；窄窗堆叠＝折叠头＋记忆（缺省收起）；
 * 宽窗维持各页固定宽；34vh 拦腰截断由「显式展开＋内部滚动」取代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NARROW_QUERY, SplitLayout, readStackedCollapsed, writeStackedCollapsed } from '../src/renderer/components/SplitLayout.js';

const component = readFileSync('src/renderer/components/SplitLayout.tsx', 'utf8');
const appShell = readFileSync('src/renderer/AppShell.tsx', 'utf8');

function stubStorage(): { state: { get: string | null }; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const state = { get: null as string | null };
  return {
    state,
    getItem: (k) => (k.startsWith('aico:split:') && k.endsWith(':collapsed') ? state.get : null),
    setItem: (k, v) => {
      state.get = v;
    },
  };
}

test('SplitLayout 断点真源：NARROW_QUERY 单处定义，壳层复用不再自写', () => {
  assert.equal(NARROW_QUERY, '(max-width: 1040px)');
  assert.match(appShell, /import \{ isNarrowViewport, NARROW_QUERY \} from '\.\/components\/SplitLayout';/, '壳层 import 共享常量');
  assert.doesNotMatch(appShell, /const NARROW_RAIL_QUERY/, '壳层本地断点定义已删（防漂移）');
  // 断点数值只允许出现在 SplitLayout 一处（src/renderer 内；styles.css 的 S11 media query 在接入批删除）
  const pane = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
  const hall = readFileSync('src/renderer/components/CompanyHallView.tsx', 'utf8');
  for (const [name, src] of [['SettingsPane', pane], ['CompanyHallView', hall]] as const) {
    assert.ok(!src.includes('(max-width: 1040px)'), `${name} 不得自带断点`);
  }
});

test('SplitLayout 折叠记忆：缺省收起；写入后读回；存储异常回落缺省', () => {
  assert.equal(readStackedCollapsed('test', null), true, '无 storage → 缺省收起');
  const stub = stubStorage();
  assert.equal(readStackedCollapsed('test', stub), true, '未写过 → 缺省收起');
  writeStackedCollapsed('test', false, stub);
  assert.equal(readStackedCollapsed('test', stub), false, '展开态可记忆');
  writeStackedCollapsed('test', true, stub);
  assert.equal(readStackedCollapsed('test', stub), true, '收起态可记忆');
  const bad = { getItem: () => { throw new Error('boom'); }, setItem: () => { throw new Error('boom'); } };
  assert.equal(readStackedCollapsed('test', bad), true, '存储抛错 → 缺省收起（不崩）');
  writeStackedCollapsed('test', false, bad as unknown as Storage); // 不抛
});

test('SplitLayout 宽窗：左右并排，左列用传入宽度，无折叠头', () => {
  const html = renderToStaticMarkup(createElement(SplitLayout, {
    side: createElement('div', null, 'SIDE'),
    main: createElement('div', null, 'MAIN'),
    sideWidth: 300,
    label: '列表',
    storageKey: 'test',
    stackedOverride: false,
    storage: null,
  }));
  assert.match(html, /class="split"/);
  assert.ok(!html.includes('split--stacked'), '宽窗不堆叠');
  assert.ok(html.includes('flex:0 0 300px'), `左列宽 300（实际 ${html.match(/flex:[^"]*/)?.[0]}）`);
  assert.ok(!html.includes('split__toggle'), '宽窗无折叠头');
  assert.ok(html.includes('SIDE') && html.includes('MAIN'));
});

test('SplitLayout 窄窗收起态：悬浮开关＋主内容整宽（2026-11-04 老板意见：不压内容）', () => {
  const html = renderToStaticMarkup(createElement(SplitLayout, {
    side: createElement('div', null, 'SIDE'),
    main: createElement('div', null, 'MAIN'),
    sideWidth: 300,
    label: '名单',
    storageKey: 'hall',
    count: 3,
    stackedOverride: true,
    storage: null,
  }));
  assert.match(html, /data-stacked="true"/);
  assert.match(html, /data-testid="split-hall-toggle"/, '悬浮开关在场');
  assert.match(html, /aria-expanded="false"/, '缺省收起');
  assert.match(html, /aria-controls="split-hall-drawer"/, '开关指向抽屉');
  assert.match(html, /☰ 名单（3）/, '收起态＝图标＋名单＋计数');
  assert.ok(!html.includes('split__drawer'), '收起时不渲染抽屉');
  assert.ok(!html.includes('>SIDE<'), '收起时不渲染列表内容');
  assert.ok(html.includes('>MAIN<'), '主内容整宽常驻');
});

test('SplitLayout 窄窗展开态：抽屉浮层（scrim＋drawer，aria true，自动收起接线在场）', () => {
  const stub = stubStorage();
  writeStackedCollapsed('x', false, stub);
  const html = renderToStaticMarkup(createElement(SplitLayout, {
    side: createElement('div', null, 'SIDE'),
    main: createElement('div', null, 'MAIN'),
    sideWidth: 300,
    label: '名单',
    storageKey: 'x',
    stackedOverride: true,
    storage: stub as unknown as Storage,
  }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /✕ 名单/, '展开态开关变关闭态');
  assert.match(html, /split__scrim/, '浮层遮罩在场（点遮罩收起）');
  assert.match(html, /data-testid="split-x-drawer"/);
  assert.match(html, /split__drawer/, '抽屉面板在场');
  assert.ok(html.includes('>SIDE<'), '列表渲染在抽屉内');
  // 自动收起接线：源码里点抽屉内非表单控件即收起；表单控件豁免（保护批量勾选）
  const src = component;
  assert.match(src, /onSideClickCapture/, '抽屉点击捕获收起');
  assert.match(src, /closest\('input, select, textarea, label, \[data-split-keep\]'\)/, '表单控件不触发收起');
});

// 2026-11-04 批次 4（笔记页）：hideMain（主内容暂无）优先于堆叠——solo DOM 与视口无关，
// 窄窗未选中态与宽窗同构（真机已验宽窗；此处锁死组件级行为）。
test('SplitLayout hideMain：优先于堆叠，任何视口都渲染 solo（无折叠头、side 独占）', () => {
  for (const stacked of [false, true]) {
    const html = renderToStaticMarkup(createElement(SplitLayout, {
      side: createElement('div', null, 'LIST'),
      main: createElement('div', null, 'MAIN'),
      sideWidth: 340,
      label: '列表',
      storageKey: 'notes',
      hideMain: true,
      stackedOverride: stacked,
      storage: null,
    }));
    assert.match(html, /class="split split--solo"/, `stacked=${stacked} 时也必须 solo`);
    assert.ok(!html.includes('split__toggle'), `stacked=${stacked} 时无折叠头`);
    assert.ok(html.includes('>LIST<'), '列表内容在场（独占整宽）');
    assert.ok(!html.includes('>MAIN<'), '主内容不渲染');
  }
});

test('SplitLayout 批次 4：笔记页已接入（hideMain 随选中态）', () => {
  const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  assert.match(page, /storageKey: 'notes'/);
  assert.match(page, /hideMain: selected == null/, '未选中=列表独占；选中=常规分栏/堆叠');
});

// T1 交互专项（S13-C 口径）：抽屉＝弹层，Esc 必须能关（与建任务/新建笔记弹层同语言）。
test('SplitLayout 抽屉：展开态挂 Esc 关闭；收起/宽窗不挂', () => {
  assert.match(component, /if \(!stacked \|\| collapsed\) return;/, 'Esc 监听只在「窄窗且展开」挂');
  assert.match(component, /event\.key === 'Escape'/, 'Esc 关抽屉');
});

// 2026-11-09 老板真机：「竖线没贯穿，下面的都快和上面的合并了」——SplitLayout 接管分栏后，
// 各页 __list 从 `.projects-page/.hall-page`（flex 行）的子项挪进普通块容器 `.split__side`，
// 失去 stretch ⇒ 高度退化为内容高（CDP 实测：侧栏 826px，里层列表 367px），
// 白底与右分隔线半途断掉、下方 --bg 灰与上方白块直接相接。
// 守卫：side 容器纵向 flex＋里层列表 flex:1（宽窗/窄窗同一口径，列表内部滚动）。
test('SplitLayout 侧栏撑满：side 纵向 flex，各页列表 flex:1（2026-11-09 老板真机修）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(
    css,
    /\.split__side,\s*\n\.split--solo \.split__main \{\s*\n\s*display: flex;\s*\n\s*flex-direction: column;/,
    'side 容器必须纵向 flex（否则里层列表无 stretch 可继承）',
  );
  for (const sel of ['.projects-page__list', '.hall-page__list', '.settings-view__nav', "[data-testid='knowledge-list']"]) {
    assert.ok(css.includes(`.split__side > ${sel}`), `${sel} 在 .split__side 下必须 flex:1 撑满`);
  }
  assert.match(css, /\.split__side > \.projects-page__list[\s\S]{0,400}?flex: 1 1 auto;/, '里层列表 flex:1 撑满');
});
