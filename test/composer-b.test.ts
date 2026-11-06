/**
 * Composer B 方案守卫（2026-10-22 老板选定）：
 * 输入与工具条同在一个浮起胶囊；发送是唯一主操作（圆形箭头）；附件/建任务是次级；
 * 空输入发送禁用；发送中显示进度；960 窄窗隐藏键盘提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/renderer/components/Composer.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('Composer B：一体胶囊骨架 + 次级图标 + 圆形发送', () => {
  assert.match(src, /className="composer__shell"/, '缺一体胶囊容器 .composer__shell');
  assert.match(src, /className="composer__toolbar"/, '缺工具条');
  assert.match(src, /<PaperclipIcon \/>/, '附件应使用自绘 PaperclipIcon');
  assert.match(src, /<PlusIcon \/>/, '建任务应使用 PlusIcon');
  assert.match(src, /<ArrowUpIcon \/>/, '发送应使用圆形上箭头');
  assert.match(src, /<span>建任务<\/span>/, '建任务保留文字，不回到纯图标');
  assert.equal(src.includes('＋建任务'), false, '不得回到「＋建任务」文字胶囊');
});

test('Composer B：空输入禁用 + 发送中态 + 可访问标签', () => {
  assert.match(src, /const canSend = !busy && \(text\.trim\(\)\.length > 0 \|\| attachments\.length > 0\)/);
  assert.match(src, /disabled=\{!canSend\}/);
  assert.match(src, /aria-label=\{busy \? '发送中…' : '发送'\}/);
  assert.match(src, /aria-busy=\{busy\}/);
  assert.match(src, /composer__spinner/);
});

test('Composer B：样式锚点（20 胶囊 / 36 圆形发送 / 960 隐藏键盘提示）', () => {
  assert.match(css, /\.composer__shell\s*\{[^}]*border-radius:\s*var\(--radius-xl\)/s, '一体胶囊应为 20 圆角');
  assert.match(css, /\.composer__shell:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--tint-soft\)/s, '焦点环应打在整壳上');
  assert.match(css, /\.composer__send\s*\{[^}]*width:\s*36px[^}]*height:\s*36px[^}]*border-radius:\s*var\(--radius-pill\)/s, '发送应为 36 圆形');
  assert.match(css, /\.composer__send:disabled\s*\{[^}]*background:\s*var\(--fill\)/s, '空输入发送应有禁用底');
  assert.match(css, /@media \(max-width: 1040px\)\s*\{\s*\.composer__hint\s*\{\s*display:\s*none/s, '窄窗应隐藏键盘提示');
  assert.doesNotMatch(css, /\.composer__input\s*\{[^}]*background:\s*var\(--panel-2\)/s, '输入不应再是独立灰底框');
});
