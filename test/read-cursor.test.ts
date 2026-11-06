/**
 * REM-1a/1c · 服务端未读游标（老板频道卡片 / 消息）。
 *
 * 口径真源：`docs/work/spec-remote-preconditions.md` §4。
 *  - 游标是 `(principal, surface)` 高水位；只前进、幂等；
 *  - 卡片未读只数 `ask/report/alert` 的 `pending/delivered`；
 *  - 消息未读只数 `out`；`in` 只推进 transcript 位置；
 *  - 读不改变 `reports.state`/`approvals`/任务状态；
 *  - 迁移只种消息游标（历史消息视为已读基线），卡片不种。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { loadMigrations, runMigrations } from '../src/main/db/index.js';
import { insertReport } from '../src/main/db/reports.js';
import { insertHumanMessage } from '../src/main/db/human_messages.js';
import {
  READ_SURFACE_CARDS,
  READ_SURFACE_MESSAGES,
  ReadCursorError,
  markRead,
  readState,
  unreadCardsCount,
} from '../src/main/db/read_cursors.js';

const AT = 1_700_000_000_000;

function fresh() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function card(
  db: ReturnType<typeof fresh>,
  kind: 'ask' | 'report' | 'alert' | 'notification',
  state = 'pending',
): number {
  return insertReport(db, {
    taskId: null,
    kind,
    payload: { title: `${kind}-${state}`, summary: 'x' },
    state,
    now: AT,
  }).id;
}

test('read: 卡片未读只数 ask/report/alert 的 pending/delivered；FYI/已处理不计', () => {
  const db = fresh();
  try {
    const ask = card(db, 'ask');
    const report = card(db, 'report');
    const delivered = card(db, 'alert', 'delivered');
    card(db, 'notification');
    card(db, 'report', 'resolved');
    const state = readState(db, 'boss', READ_SURFACE_CARDS);
    assert.equal(state.unread, 3, 'ask/report/alert delivered 应计 3');
    assert.equal(state.lastItemId, 0, '没有游标行时从 0 开始');
    assert.equal(state.unreadState, 'exact');
    assert.ok(state.asOfId >= Math.max(ask, report, delivered), 'asOfId 应是当前源表最大 id');
  } finally {
    db.close();
  }
});

test('read: 游标只前进、幂等；读不改变卡片状态/审批', () => {
  const db = fresh();
  try {
    const first = card(db, 'ask');
    const second = card(db, 'report');
    const before = db
      .prepare('SELECT id, state FROM reports ORDER BY id')
      .all() as Array<{ id: number; state: string }>;
    const one = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_CARDS,
      throughId: first,
      now: AT,
      source: 'desktop',
    });
    assert.equal(one.changed, true);
    assert.equal(one.state.unread, 1);
    assert.equal(one.state.lastItemId, first);

    const same = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_CARDS,
      throughId: first,
      now: AT + 1,
      source: 'desktop',
    });
    assert.equal(same.changed, false);
    assert.equal(same.state.lastItemId, first);

    const lower = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_CARDS,
      throughId: 0,
      now: AT + 2,
      source: 'desktop',
    });
    assert.equal(lower.changed, false);
    assert.equal(lower.state.lastItemId, first);

    const after = db
      .prepare('SELECT id, state FROM reports ORDER BY id')
      .all() as Array<{ id: number; state: string }>;
    assert.deepEqual(after, before, '读游标不得改变 reports.state');

    const all = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_CARDS,
      throughId: second,
      now: AT + 3,
      source: 'desktop',
    });
    assert.equal(all.changed, true);
    assert.equal(all.state.unread, 0);
    assert.equal(all.state.lastItemId, second);
  } finally {
    db.close();
  }
});

test('read: 未知 surface / 越界 throughId / 非 boss principal 显式拒', () => {
  const db = fresh();
  try {
    card(db, 'ask');
    assert.throws(
      () => markRead(db, { principal: 'boss', surface: 'nope', throughId: 1, now: AT }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'unknown_surface',
    );
    assert.throws(
      () => markRead(db, { principal: 'boss', surface: READ_SURFACE_CARDS, throughId: 999, now: AT }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'bad_request',
    );
    assert.throws(
      () => markRead(db, { principal: 'boss', surface: READ_SURFACE_CARDS, throughId: -1, now: AT }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'bad_request',
    );
    assert.throws(
      () => readState(db, 'employee:1', READ_SURFACE_CARDS),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'unsupported_principal',
    );
  } finally {
    db.close();
  }
});

test('read: throughId 必须在源中存在（缺口 id 拒绝）；unreadCardsCount 与 readState 同口径', () => {
  const db = fresh();
  try {
    card(db, 'ask');
    const gap = card(db, 'report');
    db.prepare('DELETE FROM reports WHERE id = ?').run(gap);
    assert.throws(
      () => markRead(db, { principal: 'boss', surface: READ_SURFACE_CARDS, throughId: gap, now: AT }),
      (error: unknown) => error instanceof ReadCursorError && error.code === 'bad_request',
    );
    assert.equal(unreadCardsCount(db), readState(db, 'boss', READ_SURFACE_CARDS).unread, '托盘/日报与 badge 同口径');
  } finally {
    db.close();
  }
});

test('read: 消息只数 out；in 只推进 transcript 位置', () => {
  const db = fresh();
  try {
    const out1 = insertHumanMessage(db, { direction: 'out', content: 'a', now: AT }).id;
    const in1 = insertHumanMessage(db, { direction: 'in', content: 'b', now: AT + 1 }).id;
    const out2 = insertHumanMessage(db, { direction: 'out', content: 'c', now: AT + 2 }).id;
    let state = readState(db, 'boss', READ_SURFACE_MESSAGES);
    assert.equal(state.unread, 2, '只有两条 out');
    assert.ok(state.asOfId >= out2);

    const one = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_MESSAGES,
      throughId: out1,
      now: AT + 3,
    });
    assert.equal(one.state.unread, 1, 'out2 仍未读');

    const throughIn = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_MESSAGES,
      throughId: in1,
      now: AT + 4,
    });
    assert.equal(throughIn.state.lastItemId, in1);
    assert.equal(throughIn.state.unread, 1, 'in1 不产生未读，但游标可推进');

    const all = markRead(db, {
      principal: 'boss',
      surface: READ_SURFACE_MESSAGES,
      throughId: out2,
      now: AT + 5,
    });
    assert.equal(all.state.unread, 0);
  } finally {
    db.close();
  }
});

test('read: 迁移种消息游标（历史消息不炸未读），卡片不种', () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db, loadMigrations().filter((m) => m.version <= 13));
    const oldOut = insertHumanMessage(db, { direction: 'out', content: 'old', now: AT }).id;
    const oldCard = card(db, 'ask');
    runMigrations(db);

    const messages = readState(db, 'boss', READ_SURFACE_MESSAGES);
    assert.equal(messages.lastItemId, oldOut, '迁移应把历史消息视为已读基线');
    assert.equal(messages.unread, 0);

    const cards = readState(db, 'boss', READ_SURFACE_CARDS);
    assert.equal(cards.lastItemId, 0, '卡片不种游标：存量 pending 卡仍应提醒一次');
    assert.equal(cards.unread, 1);
    assert.ok(oldCard > 0);

    insertHumanMessage(db, { direction: 'out', content: 'new', now: AT + 1 });
    assert.equal(readState(db, 'boss', READ_SURFACE_MESSAGES).unread, 1, '迁移后的新消息应计未读');
  } finally {
    db.close();
  }
});
