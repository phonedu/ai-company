/**
 *  联动修复 P0-2：列表取**最新** N 条（仍按时间升序返回）。
 * 旧口径取最旧 N 条 ⇒ 新消息/新卡永远不出现，未读游标也永远清不掉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { insertReport, listReports } from '../src/main/db/reports.js';
import { insertHumanMessage, listHumanMessages } from '../src/main/db/human_messages.js';

test('listReports({latest:true,limit}) 取最新 N 条并按时间升序返回', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const ids = [1, 2, 3, 4].map((n) =>
      insertReport(db, { taskId: null, kind: 'ask', payload: { title: `c${n}` }, now: 1000 + n }).id,
    );
    const rows = listReports(db, { latest: true, limit: 2 });
    assert.deepEqual(rows.map((r) => r.id), [ids[2], ids[3]], '最新两条，且升序');
    const oldest = listReports(db, { limit: 2 });
    assert.deepEqual(oldest.map((r) => r.id), [ids[0], ids[1]], '缺省仍是历史口径（最旧 N 条）');
  } finally {
    db.close();
  }
});

test('listHumanMessages({latest:true,limit}) 取最新 N 条并按时间升序返回', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const ids = [1, 2, 3].map((n) => insertHumanMessage(db, { direction: 'out', content: `m${n}`, now: 2000 + n }).id);
    const rows = listHumanMessages(db, { latest: true, limit: 2 });
    assert.deepEqual(rows.map((r) => r.id), [ids[1], ids[2]], '最新两条，且升序');
  } finally {
    db.close();
  }
});
