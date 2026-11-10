/**
 *  修项守卫（2026-10-28）： 浅色 panel-2≠bg、 深色 panel 提亮、 文字用 warn-text、
 *  文件图标浅色加深（token 化）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));

test('F1 浅色 panel-2 不得等于 bg', () => {
  // CodeQL（2026-11-10）：模板字符串里的 `\s` 会退化成字面 `s`——这里用 String.raw 保真。
  const v = (k: string, block: string): string | undefined =>
    block.match(new RegExp(String.raw`--${k}:\s*([^;]+);`))?.[1].trim().toLowerCase();
  assert.ok(v('panel-2', light) !== v('bg', light), 'panel-2 需与 bg 不同');
});

test('F2 深色 panel 与 bg 不同（层级）', () => {
  const v = (k: string, block: string): string | undefined =>
    block.match(new RegExp(String.raw`--${k}:\s*([^;]+);`))?.[1].trim().toLowerCase();
  assert.ok(v('panel', dark) !== v('bg', dark));
});

test('F4 文字不再用低对比 --warn（改用 --warn-text）', () => {
  assert.match(light, /--warn-text:\s*#9a5200/);
  assert.match(dark, /--warn-text:\s*#ffb340/);
  assert.doesNotMatch(css, /(?<!border-)color:\s*var\(--warn\);/);
});

test('F6 文件图标 token 化（浅深两套）', () => {
  for (const k of ['file-icon-note', 'file-icon-doc', 'file-icon-artifact']) {
    assert.match(light, new RegExp(`--${k}:`));
    assert.match(dark, new RegExp(`--${k}:`));
  }
  assert.match(page, /var\(--file-icon-artifact\)/);
});
