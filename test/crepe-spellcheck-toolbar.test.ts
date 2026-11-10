/**
 * 编辑器两处观感修（2026-11-05 T6 点验）：
 *  ① 中文笔记里英文/编号（s13、s14…）被浏览器**拼写检查**画红波浪线，像错字 → 编辑区关掉 spellcheck；
 *  ② 选中文字弹出的**浮动工具栏**图标用上游 `--crepe-color-outline`（浅色 #a8a8a8 落在 #f7f7f7 上
 *    约 2.3:1），看着灰得看不清 → 改用 on-surface-variant（浅 #4d4d4d / 深 #a9a9a9）。
 *
 * 均为源码级断言（Crepe 需真 DOM，Node 里算不了样式/属性效果）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync('src/renderer/components/MilkdownEditor.tsx', 'utf8');
const theme = readFileSync('src/renderer/assets/crepe-theme.css', 'utf8');

test('① 编辑区关闭拼写检查（ProseMirror spellcheck=false）', () => {
  assert.match(
    editor,
    /querySelector\('\.ProseMirror'\)/,
    '必须在 Crepe 创建后取到 ProseMirror 根节点',
  );
  assert.match(editor, /setAttribute\('spellcheck',\s*'false'\)/, '必须显式关 spellcheck（否则红波浪线）');
  assert.match(editor, /setAttribute\('autocorrect',\s*'off'\)/, '顺带关 autocorrect（英文被自动改写同样干扰）');
});

test('② 浮动工具栏图标用 on-surface-variant（不再是 outline 灰）', () => {
  const rule = theme.match(/\.milkdown \.milkdown-toolbar \.toolbar-item svg\s*\{([^}]*)\}/);
  assert.ok(rule, '必须有工具栏图标颜色规则');
  assert.match(rule[1], /color:\s*var\(--crepe-color-on-surface-variant\)/, '图标色应改为 on-surface-variant');
});

test('两主题 on-surface-variant 都有值（深色不回落成浅色值）', () => {
  assert.match(theme, /--crepe-color-on-surface-variant:\s*#4d4d4d/, '浅色缺 #4d4d4d');
  assert.match(theme, /--crepe-color-on-surface-variant:\s*#a9a9a9/, '深色缺 #a9a9a9');
});

test('"有牙"：不改属性 / 仍用 outline → 断言必红（合成）', () => {
  const brokenEditor = 'crepe.setReadonly?.(true);';
  assert.ok(!/setAttribute\('spellcheck'/.test(brokenEditor), '未关 spellcheck 应被抓');
  const brokenTheme = '.milkdown .milkdown-toolbar .toolbar-item svg { color: var(--crepe-color-outline); }';
  assert.ok(!/on-surface-variant/.test(brokenTheme), '仍用 outline 应被抓');
});
