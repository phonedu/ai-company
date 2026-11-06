/**
 * 深色主背景（老板 2026-10-28 真机）：中间内容区纯黑 #000 过生硬。
 * 判据：深色 --bg 不得为纯黑（#000），且与面板色（--panel）不同（保留分层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));

test('深色 --bg 不得为纯黑', () => {
  const m = dark.match(/--bg:\s*([^;]+);/);
  assert.ok(m, '缺少深色 --bg');
  assert.notEqual(m[1].trim().toLowerCase(), '#000000', '纯黑已弃用（老板真机）');
  assert.match(m[1].trim().toLowerCase(), /^#[0-9a-f]{6}$/, '需为六位十六进制');
});

test('深色 --bg 与 --panel 不同（保留分层）', () => {
  const bg = dark.match(/--bg:\s*([^;]+);/)?.[1].trim().toLowerCase();
  const panel = dark.match(/--panel:\s*([^;]+);/)?.[1].trim().toLowerCase();
  assert.ok(bg && panel && bg !== panel);
});
