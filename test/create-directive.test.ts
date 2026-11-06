/**
 * T8b/RW-48（2026-11-05）：显式建任务前缀直通——语义分类器缺位期间的确定性兜底。
 * 判据：只认开头（含可选 #别名）的「建任务/派任务」；无目标不建；正文提及不算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreateTaskDirective } from '../src/core/resolver.js';

test('RW-48 解析：建任务：/派任务： 前缀取目标；#别名 captured', () => {
  assert.deepEqual(parseCreateTaskDirective('建任务：写一份报告'), { goal: '写一份报告', alias: null });
  assert.deepEqual(parseCreateTaskDirective('派任务，写周报'), { goal: '写周报', alias: null });
  const aliased = parseCreateTaskDirective('#demo 派任务：审查 docs 组织');
  assert.equal(aliased?.alias, 'demo');
  assert.equal(aliased?.goal, '审查 docs 组织');
});

test('RW-48 解析：无目标/非开头 不触发（不误伤普通聊天）', () => {
  assert.equal(parseCreateTaskDirective('建任务'), null, '光喊建任务没有目标 → 不建');
  assert.equal(parseCreateTaskDirective('我们聊聊要不要建任务流程'), null, '正文提及不触发');
  assert.equal(parseCreateTaskDirective(''), null);
});
