/**
 * 编辑器内文字选区可读性（老板 2026-11-05 真机：笔记页选中 `s1` 标题变「浅灰底 + 白字」，几乎看不见）。
 *
 * 根因：Crepe 的 `reset.css` 只覆盖 `::selection { background: var(--crepe-color-selected) }`（浅灰），
 * **不设字色**；字色落回本应用全局 `::selection { color: var(--on-accent) }`（白，本来配蓝底）
 * ⇒ 浅灰底 + 白字。修法：在 `.milkdown` 内把选区字色改为随主题的 `--crepe-color-on-selected`，
 * 且特异性（0,2,1）必须高于全局（0,0,1），否则会被压回白色。
 *
 * 本测守的是「规则在、颜色对、两主题都有值」——CSS 无法在 Node 里算样式，故源码级断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const theme = readFileSync('src/renderer/assets/crepe-theme.css', 'utf8');
const global = readFileSync('src/renderer/styles.css', 'utf8');

test('编辑器内选区：显式设置字色为 on-selected（不落回全局白字）', () => {
  // 找到 ::selection 规则块并断言同时声明了 background 与 color
  const block = theme.match(/\.milkdown \.ProseMirror \*::selection\s*\{([^}]*)\}/);
  assert.ok(block, '必须存在 `.milkdown .ProseMirror *::selection` 规则（Crepe 只管背景，字色要我们补）');
  const body = block[1];
  assert.match(body, /background:\s*var\(--crepe-color-selected\)/, '背景保持 Crepe 口径（浅灰）');
  assert.match(
    body,
    /color:\s*var\(--crepe-color-on-selected/,
    '字色必须用 on-selected（浅色 #1c1c1c / 深色 #e6e6e6），否则落回全局白字',
  );
});

test('两主题都定义 on-selected（否则深色下又变回不可读）', () => {
  const light = theme.match(/--crepe-color-on-selected:\s*#1c1c1c/);
  const dark = theme.match(/--crepe-color-on-selected:\s*#e6e6e6/);
  assert.ok(light, '浅色主题缺 --crepe-color-on-selected');
  assert.ok(dark, '深色主题缺 --crepe-color-on-selected');
});

test('全局 ::selection 仍是蓝底白字（本修法只收敛编辑器内，不动全局）', () => {
  const block = global.match(/::selection\s*\{([^}]*)\}/);
  assert.ok(block, '全局 ::selection 必须在');
  assert.match(block[1], /background:\s*var\(--accent\)/);
  assert.match(block[1], /color:\s*var\(--on-accent\)/);
});

test('"有牙"：把编辑器选区字色改回白色 / 删掉规则 → 上述断言必红（合成）', () => {
  const broken1 = '.milkdown .ProseMirror *::selection { background: var(--crepe-color-selected); color: #ffffff; }';
  assert.ok(!/color:\s*var\(--crepe-color-on-selected/.test(broken1), '白色字色应被抓');
  const broken2 = '.milkdown .ProseMirror *::selection { background: var(--crepe-color-selected); }';
  assert.ok(!/color:\s*var\(--crepe-color-on-selected/.test(broken2), '缺字色应被抓');
});
