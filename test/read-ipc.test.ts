/**
 * REM-1c · `inbox:read-state` / `inbox:read-mark` handler 契约。
 *
 * 只验证 IPC 入参/principal 边界与 DAO 接线；UI 真机见 `scripts/verification/read-cursor-cdp.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/index.js';
import { insertReport } from '../src/main/db/reports.js';
import { ReadCursorError } from '../src/main/db/read_cursors.js';
import { handleReadMark, handleReadState } from '../src/main/ipc/read.js';

const AT = 1_700_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertReport(db, {
    taskId: null,
    kind: 'ask',
    payload: { title: '待批准' },
    state: 'pending',
    now: AT,
  });
  return { deps: { db }, db };
}

test('read IPC：state 读 count，mark 推进并返回 changed/state', () => {
  const { deps, db } = setup();
  try {
    const before = handleReadState(deps, { surface: 'channel:cards' });
    assert.equal(before.unread, 1);
    assert.equal(before.lastItemId, 0);

    const marked = handleReadMark(deps, { surface: 'channel:cards', throughId: before.asOfId }, AT + 1);
    assert.equal(marked.changed, true);
    assert.equal(marked.state.unread, 0);
    assert.equal(marked.state.lastItemId, before.asOfId);

    const again = handleReadMark(deps, { surface: 'channel:cards', throughId: before.asOfId }, AT + 2);
    assert.equal(again.changed, false, '重复标记应幂等');
  } finally {
    db.close();
  }
});

test('read IPC：未知 surface / 缺 throughId / 越界 → 显式拒', () => {
  const { deps, db } = setup();
  try {
    assert.throws(
      () => handleReadState(deps, { surface: 'im:wechat:x' }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'unknown_surface',
    );
    assert.throws(
      () => handleReadMark(deps, { surface: 'channel:cards' }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'bad_request',
    );
    assert.throws(
      () => handleReadMark(deps, { surface: 'channel:cards', throughId: 9999 }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'bad_request',
    );
  } finally {
    db.close();
  }
});
