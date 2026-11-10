/**
 * 主题两态开关（2026-10-28：两个状态别用下拉，左右滑动＋日/夜图标）。
 * 判据：纯函数语义（system 按实际生效态、点击取反并固定）＋源码守卫（无 select 下拉、有 switch）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isFollowingSystem, themeSwitchChecked, themeSwitchTarget } from '../src/renderer/components/themeSwitch.js';

test('主题开关① system 按实际生效深浅显示，点击后固定为相反态', () => {
  assert.equal(themeSwitchChecked('system', true), true);
  assert.equal(themeSwitchChecked('system', false), false);
  assert.equal(themeSwitchTarget('system', true), 'light');
  assert.equal(themeSwitchTarget('system', false), 'dark');
  assert.equal(isFollowingSystem('system'), true);
});

test('主题开关② 显式 light/dark 时点击取反；不再跟随系统', () => {
  assert.equal(themeSwitchChecked('dark', false), true);
  assert.equal(themeSwitchTarget('dark', true), 'light');
  assert.equal(themeSwitchTarget('light', true), 'dark');
  assert.equal(isFollowingSystem('light'), false);
});

test('主题开关③ 源码守卫：主题不再用原生 select；开关带 role/aria 与跟随系统提示', () => {
  const src = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
  assert.doesNotMatch(src, /settings-theme-select/, '原生下拉已退役');
  assert.match(src, /settings-theme-switch/, '开关 testid');
  assert.match(src, /role="switch"/, '无障碍角色');
  assert.match(src, /settings-theme-following/, '跟随系统小字');
});

test('主题开关④ 滑块恒为高对比白（不得回退到 --panel，否则夜间右端不可见）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const block = css.slice(css.indexOf('.theme-switch__thumb'), css.indexOf('.theme-switch[data-dark'));
  assert.match(block, /background:\s*#ffffff/, '滑块必须是白色');
  assert.doesNotMatch(block, /background:\s*var\(--panel\)/, '不得再使用 --panel 作滑块底色');
});
