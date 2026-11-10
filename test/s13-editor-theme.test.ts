/**
 *  · （老板真机：点块图标后文字变白、大面积文字重合）回归守卫。
 *
 * 根因：Crepe 结构 CSS（theme/common/*）只用 var(--crepe-color-*)；变量真源在
 * theme/frame（浅）/ frame-dark（深）——此前只引 common → 变量缺失 → 菜单/工具栏
 * 背景与文字色失效（浅色下白字、阴影缺失叠在一起）。
 * 判据：主题变量文件在、深浅两套都在、被懒加载门面引入、字号对齐 15px。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const theme = readFileSync('src/renderer/assets/crepe-theme.css', 'utf8');
const lazy = readFileSync('src/renderer/components/crepe-lazy.ts', 'utf8');

test('RW-29① 深浅两套 crepe 变量都在（surface/on-surface/hover/selected/shadow）', () => {
  for (const key of [
    '--crepe-color-surface:',
    '--crepe-color-on-surface:',
    '--crepe-color-hover:',
    '--crepe-color-selected:',
    '--crepe-shadow-1:',
  ]) {
    assert.match(theme, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `缺 ${key}`);
  }
  assert.match(theme, /@media \(prefers-color-scheme: dark\)/, '深色变量必须在 dark 媒体查询下');
  // 深色块内 on-surface 与浅色不同（防复制粘贴漏改）
  const dark = theme.slice(theme.indexOf('@media (prefers-color-scheme: dark)'));
  assert.match(dark, /--crepe-color-on-surface:\s*#d1d1d1/, '深色 on-surface 值应为 #d1d1d1');
});

test('RW-29② 变量文件进懒加载门面（与 Crepe 同块加载）', () => {
  assert.match(lazy, /import '\.\.\/assets\/crepe-theme\.css'/, 'crepe-lazy 必须引入主题变量');
});

test('RW-29③ 字号对齐应用正文 15px（--crepe-base-font-size）', () => {
  assert.match(theme, /--crepe-base-font-size:\s*15px/);
});
