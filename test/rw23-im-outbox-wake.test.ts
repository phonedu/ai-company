/**
 * （真机登记，2026-10-28）· 微信补发不得刷屏。
 *
 * 缺陷：入站 `wake()` 把**所有** blocked 出站卡一次性放回 pending（单轮 tick 上限 20）——
 * 老板首次用手机发消息（打开 48h 回推窗口）时，历史积压卡可能批量推到他手机上
 * （隔离实例实测 21 行 blocked＋41 张 pending 卡）。
 *
 * 修复口径：
 * ① 过期不补：blocked 行 `created_at` 超过 maxAgeMs（缺省 24h）→ `cancelled`（last_error 说明）；
 * ② 单次限量：只唤醒**最新** limit 张（缺省 5），其余留 blocked，下次入站再陆续补；
 * ③ 只动本会话行（`(channel, conversation_ref)` 双键）——旧 owner 的卡不得跨会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { wakeBlockedImOutbox } from '../src/main/db/im_outbox.js';
import type { SqliteDb } from '../src/main/db/index.js';

const HOUR = 3_600_000;

function insertRow(db: SqliteDb, opts: { id?: number; state: string; createdAt: number; conv?: string; reportId: number }): void {
  // im_outbox.report_id 外键 → reports；先种一张最小卡行。
  db.prepare(
    "INSERT OR IGNORE INTO reports(id, task_id, kind, payload, state, dedupe_key, created_at) VALUES(?, NULL, 'ask', '{}', 'pending', ?, ?)",
  ).run(opts.reportId, `rw23-${opts.reportId}`, opts.createdAt);
  db.prepare(
    `INSERT INTO im_outbox(id, channel, conversation_ref, report_id, task_id, state, attempts, last_error, next_attempt_at, platform_msg_id, created_at, sent_at)
     VALUES(?, 'im:wechat', ?, ?, NULL, ?, 1, '窗口关闭', NULL, NULL, ?, NULL)`,
  ).run(opts.id ?? null, opts.conv ?? 'owner-A', opts.reportId, opts.state, opts.createdAt);
}

function stateOf(db: SqliteDb, id: number): { state: string; last_error: string | null } {
  return db.prepare('SELECT state, last_error FROM im_outbox WHERE id = ?').get(id) as { state: string; last_error: string | null };
}

test('RW-23① 过期的 blocked 行 → cancelled（不补发，留痕）；新鲜行才唤醒', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const now = 100 * HOUR;
    insertRow(db, { state: 'blocked', createdAt: now - 30 * HOUR, reportId: 1 }); // 30h 前 → 过期
    insertRow(db, { state: 'blocked', createdAt: now - 1 * HOUR, reportId: 2 }); // 1h 前 → 新鲜
    const r = wakeBlockedImOutbox(db, 'im:wechat', 'owner-A', { now, maxAgeMs: 24 * HOUR, limit: 5 });
    assert.equal(r.expired, 1, '过期 1 行转 cancelled');
    assert.equal(r.woken, 1, '新鲜 1 行唤醒');
    const expired = db.prepare("SELECT state, last_error FROM im_outbox WHERE report_id = 1").get() as { state: string; last_error: string | null };
    assert.equal(expired.state, 'cancelled');
    assert.match(expired.last_error ?? '', /过期|超过/);
    assert.equal(stateOf(db, 2).state, 'pending');
  } finally {
    db.close();
  }
});

test('RW-23② 单次限量：只唤醒最新 limit 张，其余留 blocked（下次入站再补）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const now = 100 * HOUR;
    for (let i = 1; i <= 8; i++) insertRow(db, { state: 'blocked', createdAt: now - i * 60_000, reportId: 100 + i });
    const r = wakeBlockedImOutbox(db, 'im:wechat', 'owner-A', { now, maxAgeMs: 24 * HOUR, limit: 3 });
    assert.equal(r.woken, 3, '只唤醒 3 张');
    const rows = db.prepare('SELECT report_id, state FROM im_outbox ORDER BY report_id').all() as Array<{ report_id: number; state: string }>;
    const pending = rows.filter((x) => x.state === 'pending').map((x) => x.report_id);
    assert.deepEqual(pending.sort(), [101, 102, 103], '唤醒的是最新的 3 张（created_at 最近）');
    assert.equal(rows.filter((x) => x.state === 'blocked').length, 5, '其余 5 张保持 blocked');
  } finally {
    db.close();
  }
});

test('RW-23③ 只动本会话：其他 conversation_ref 的 blocked 行不受影响', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const now = 100 * HOUR;
    insertRow(db, { state: 'blocked', createdAt: now - 1 * HOUR, reportId: 1, conv: 'owner-A' });
    insertRow(db, { state: 'blocked', createdAt: now - 1 * HOUR, reportId: 2, conv: 'owner-B' });
    insertRow(db, { state: 'blocked', createdAt: now - 30 * HOUR, reportId: 3, conv: 'owner-B' });
    wakeBlockedImOutbox(db, 'im:wechat', 'owner-A', { now, maxAgeMs: 24 * HOUR, limit: 5 });
    const b = db.prepare("SELECT state FROM im_outbox WHERE conversation_ref = 'owner-B' ORDER BY report_id").all() as Array<{ state: string }>;
    assert.deepEqual(b.map((x) => x.state), ['blocked', 'blocked'], '旧 owner 的行原样不动（既不发也不清）');
  } finally {
    db.close();
  }
});
