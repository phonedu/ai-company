/**
 * 块菜单指针语义（老板 2026-11-05 T6 点验：「这个位置鼠标指针显示把手」——拖把手显示「手」指针，
 * 看着像可点击，实际是拖拽）。
 *
 * 上游 Crepe 只给整条 `.milkdown-block-handle` 设 `cursor: pointer`；把手与「＋」同 class
 * (`operation-item`)，无法按 class 区分 → 用 `:last-child` 指到拖把手，设为 grab / 按住 grabbing。
 *
 * CSS 无法在 Node 里算样式，故源码级断言（与 crepe-selection-contrast 同口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const theme = readFileSync('src/renderer/assets/crepe-theme.css', 'utf8');

test('拖把手：悬停 grab、按住 grabbing（不再是「手」指针）', () => {
  const grab = theme.match(/\.milkdown \.milkdown-block-handle \.operation-item:last-child\s*\{([^}]*)\}/);
  assert.ok(grab, '必须有拖把手的 cursor 规则（:last-child 指第二个 operation-item）');
  assert.match(grab[1], /cursor:\s*grab/, '悬停态应为 grab');
  const grabbing = theme.match(/\.operation-item:last-child:active\s*\{([^}]*)\}/);
  assert.ok(grabbing, '必须有按住态规则');
  assert.match(grabbing[1], /cursor:\s*grabbing/, '按住态应为 grabbing');
});

test('"有牙"：改成 pointer / 删规则 → 断言必红（合成）', () => {
  const broken = '.milkdown .milkdown-block-handle .operation-item:last-child { cursor: pointer; }';
  assert.ok(!/cursor:\s*grab/.test(broken), 'pointer 应被抓');
  assert.ok(!/\.operation-item:last-child:active\s*\{/.test(broken), '缺按住态应被抓');
});
