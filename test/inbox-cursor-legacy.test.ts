/**
 *  P0-2：旧 `aico.inbox.seenAt` 一次性迁移的纯归约。
 * 只把 createdAt ≤ seenAt 的最大 card id 作为服务端游标；没有/非法 seenAt → 0。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { seenThroughId } from '../src/renderer/components/inboxCursor.js';

const cards = [
  { id: 1, createdAt: 1000 },
  { id: 2, createdAt: 2000 },
  { id: 3, createdAt: 3000 },
  { id: 5, createdAt: 5000 },
];

test('旧 seenAt → 最大已见 card id（只取 <= seenAt）', () => {
  assert.equal(seenThroughId(cards, 2500), 2);
  assert.equal(seenThroughId(cards, 3000), 3);
  assert.equal(seenThroughId(cards, 4000), 3, '空洞 4 不存在时取已有最大 3');
  assert.equal(seenThroughId(cards, 9999), 5);
});

test('无/非法 seenAt → 0（不臆造迁移）', () => {
  assert.equal(seenThroughId(cards, 0), 0);
  assert.equal(seenThroughId(cards, -1), 0);
  assert.equal(seenThroughId(cards, Number.NaN), 0);
  assert.equal(seenThroughId([], 2000), 0);
});
