/**
 *  · （老板真机 2026-10-28）：夜间模式「主题」下拉弹出列表白字压灰底。
 * 判据：① option 显式底色/字色（跟随主题令牌）；② 根节点声明 color-scheme（原生控件跟随主题）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');

test('RW-33① option 显式配色（底色 panel、字色 text）', () => {
  assert.match(css, /select option\s*\{[^}]*background-color:\s*var\(--panel\)[^}]*color:\s*var\(--text\)/s);
});

test('RW-33② 根节点声明 color-scheme（原生控件与弹层跟随主题）', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/s);
});
