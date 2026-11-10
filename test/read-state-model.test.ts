/**
 *  联动修复 P0-2：未读读数按 surface 分面。
 * messages 的返回绝不能写进 cards 的 badge；unknown 必须携带 reason 且 unread=null。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReadState } from '../src/renderer/components/readStateModel.js';

test('surface 不一致 ⇒ 整条丢弃（messages 不得覆盖 cards）', () => {
  const state = {
    surface: 'channel:messages',
    lastItemId: 42,
    unread: 0,
    unreadState: 'exact',
    reason: undefined,
  };
  assert.equal(parseReadState(state, 'channel:cards'), null);
  const own = parseReadState(state, 'channel:messages');
  assert.ok(own);
  assert.equal(own.surface, 'channel:messages');
  assert.equal(own.lastItemId, 42);
  assert.equal(own.unread, 0);
});

test('unknown 读数保留 reason 且 unread=null；非法 lastItemId 丢弃', () => {
  const unknown = parseReadState(
    { surface: 'channel:cards', lastItemId: 7, unread: null, unreadState: 'unknown', reason: 'db down' },
    'channel:cards',
  );
  assert.ok(unknown);
  assert.equal(unknown.unread, null);
  assert.equal(unknown.unreadState, 'unknown');
  assert.equal(unknown.reason, 'db down');

  assert.equal(parseReadState({ surface: 'channel:cards', lastItemId: -1 }, 'channel:cards'), null);
  assert.equal(parseReadState({ surface: 'channel:cards', lastItemId: 1.5 }, 'channel:cards'), null);
  assert.equal(parseReadState(null, 'channel:cards'), null);
});
