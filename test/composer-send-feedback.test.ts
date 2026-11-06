/**
 * 发送即时反馈（2026-10-17 真机反馈）——老板「点发送一点反应都没有」。
 * 判据：点击后立刻清空输入并显示「发送中…」，失败恢复原话；不能再等 IPC 回来才变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/renderer/components/Composer.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('Composer：点击即清空 + 发送中态，失败恢复原话', () => {
  const clearAt = src.indexOf("setText('');");
  const sendAt = src.indexOf('await sendMessage(');
  assert.ok(clearAt > -1, '缺点击即清空');
  assert.ok(sendAt > clearAt, '必须先给反馈再等 IPC');
  assert.match(src, /发送中…/);
  assert.match(src, /aria-busy=\{busy\}/);
  assert.match(src, /setText\(\(current\) => \(current\.trim\(\)\.length === 0 \? value : current\)\)/, '失败应恢复原话');
});

test('Composer：发送中按钮保持可读（不从 0.5 透明再压暗）', () => {
  assert.match(css, /\.composer__send\[data-busy='true'\]\s*\{[^}]*opacity:\s*0\.8/s);
});
