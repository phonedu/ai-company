/**
 * S10 真机带回两缺陷（老板 2026-10-28）：
 * RW-24 频道不回底：新内容到达后，长 Markdown 回复/卡片排版晚于 React 提交完成——
 *   只滚一次会停在「旧底部」。修法：MutationObserver 监听流内容增长，atBottom 时 rAF 钉底。
 * RW-25 手机批复只认 1/2 与精确词：老板自然回「T-1020批准了」不被识别（幕僚长如实说未批准）。
 *   修法：解析前剥离任务号前缀与语气助词，再做精确词匹配（「不批准」仍不猜）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseApprovalChoice } from '../src/main/im/approval.js';

const opts = [
  { key: 'approve', label: '批准（推荐）' },
  { key: 'revise', label: '打回，改计划' },
];

test('RW-25① 自然写法「T-1020批准了」→ approve（剥任务号前缀＋语气助词）', () => {
  assert.equal(parseApprovalChoice('T-1020批准了', opts), 'approve');
  assert.equal(parseApprovalChoice('T1020 批准', opts), 'approve');
  assert.equal(parseApprovalChoice('#T1020 批准吧', opts), 'approve');
  assert.equal(parseApprovalChoice('批准了', opts), 'approve');
});

test('RW-25② 打回自然写法 → revise', () => {
  assert.equal(parseApprovalChoice('T-1020打回了', opts), 'revise');
  assert.equal(parseApprovalChoice('驳回', opts), 'revise');
});

test('RW-25③ 不猜：否定句/含额外内容 → null（走普通消息，不误批）', () => {
  assert.equal(parseApprovalChoice('不批准', opts), null);
  assert.equal(parseApprovalChoice('先不批准，等我看下计划', opts), null);
  assert.equal(parseApprovalChoice('T-1020 我再想想', opts), null);
});

test('RW-25④ 序号与精确词原口径不变', () => {
  assert.equal(parseApprovalChoice('1', opts), 'approve');
  assert.equal(parseApprovalChoice('2', opts), 'revise');
  assert.equal(parseApprovalChoice('批准（推荐）', opts), 'approve');
  assert.equal(parseApprovalChoice('approve', opts), 'approve');
});

test('RW-24 源码守卫：频道内容增长时钉底（MutationObserver＋rAF，且尊重上翻不抢滚）', () => {
  const src = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
  assert.match(src, /MutationObserver/, '必须监听内容增长（长回复排版晚于提交）');
  assert.match(src, /atBottomRef\.current/, '钉底必须尊重 atBottom（上翻读历史不抢滚）');
  assert.match(src, /requestAnimationFrame/, '钉底放到下一帧（排版完成后）');
});
