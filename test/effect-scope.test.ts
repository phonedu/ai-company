/**
 * M1-1 · 受管工作单元 + 归属台账 —— 验收单测（`docs/next/research-lessons-productization.md §2.1`；1553）。
 *
 * 四条验收（每条都能被弄红）：
 *  ① 台账登记与回收**各恰好一次**（重放/重复调用不重复回收）；
 *  ② **超时兜底确实触发**（fake clock）；
 *  ③ 回收**只用台账里的 PID**（无关同名进程不受影响）；
 *  ④ `timers` 幂等键/哨兵值口径一致（G-4：同 scope 只一行、dedupe_key 非空）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  listEffectScopes,
  getEffectScope,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { EFFECT_SCOPE_TIMER_KIND } from '../src/main/db/effect_scopes.js';
import { EffectScopeManager, effectScopeKey } from '../src/main/engine/index.js';

function fresh(): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('p', 'D:/tmp/p', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 't', goal: 'g' });
  return { db, taskId: task.id };
}

function fakeKiller(): { kill(pidRoot: number): void; kills: number[] } {
  const kills: number[] = [];
  return { kills, kill: (pidRoot: number) => kills.push(pidRoot) };
}

test('M1-1①: 台账登记恰好一次（同 scopeKey 幂等）', () => {
  const { db, taskId } = fresh();
  try {
    const mgr = new EffectScopeManager(db, { clock: () => 1_000 });
    const a = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] });
    assert.equal(a.created, true);
    assert.equal(a.scopeKey, effectScopeKey({ employeeId: 7, workItemId: 42, attempt: 0 }));
    const b = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] });
    assert.equal(b.created, false, '同 scopeKey 重放不得再建一行');
    assert.equal(listEffectScopes(db).length, 1);
    assert.equal(getEffectScope(db, a.scopeKey)?.state, 'open');
  } finally {
    db.close();
  }
});

test('M1-1①: 回收恰好一次（重复/重放不重复 kill）', () => {
  const { db, taskId } = fresh();
  try {
    const killer = fakeKiller();
    const mgr = new EffectScopeManager(db, { clock: () => 1_000, killer });
    const { scopeKey } = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] });

    const first = mgr.reclaim(scopeKey, 'release');
    assert.deepEqual(first, { reclaimed: true, killedPids: [111] });
    assert.deepEqual(killer.kills, [111]);
    assert.equal(getEffectScope(db, scopeKey)?.state, 'reclaimed');
    assert.equal(getEffectScope(db, scopeKey)?.reclaimReason, 'release');

    const second = mgr.reclaim(scopeKey, 'timeout');
    assert.deepEqual(second, { reclaimed: false, killedPids: [] }, '已回收再调不得再 kill');
    assert.deepEqual(killer.kills, [111], 'killer 只应被调用一次');
    assert.deepEqual(mgr.killedPidsLog, [111]);
  } finally {
    db.close();
  }
});

test('M1-1②: 心跳超时兜底确实触发（fake clock）；续心跳则延后', () => {
  const { db, taskId } = fresh();
  try {
    const killer = fakeKiller();
    let now = 1_000;
    const mgr = new EffectScopeManager(db, { clock: () => now, heartbeatTimeoutMs: 1_000, killer });
    const { scopeKey } = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] });

    now = 1_999;
    assert.equal(mgr.reclaimDue(now), 0, '未到期不得回收');
    assert.equal(getEffectScope(db, scopeKey)?.state, 'open');

    now = 2_000;
    assert.equal(mgr.reclaimDue(now), 1, '到期应兜底回收');
    assert.equal(getEffectScope(db, scopeKey)?.state, 'reclaimed');
    assert.equal(getEffectScope(db, scopeKey)?.reclaimReason, 'timeout');
    assert.deepEqual(killer.kills, [111]);

    // 续心跳：新 scope 到点前心跳 → 延后，不再被旧 due 触发
    const b = mgr.open({ sessionKey: 's2', employeeId: 7, workItemId: 43, attempt: 0, taskId, pidTree: [222] });
    now = 2_500;
    assert.equal(mgr.heartbeat(b.scopeKey), true);
    now = 3_000;
    assert.equal(mgr.reclaimDue(now), 0, '心跳后 due 已顺延到 3500');
    now = 3_500;
    assert.equal(mgr.reclaimDue(now), 1);
  } finally {
    db.close();
  }
});

test('M1-1③: 回收只用台账里的 PID（无关同名进程不受影响）', () => {
  const { db, taskId } = fresh();
  try {
    const killer = fakeKiller();
    const mgr = new EffectScopeManager(db, { clock: () => 1_000, killer });
    const a = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [11111] });
    const b = mgr.open({ sessionKey: 's1', employeeId: 8, workItemId: 43, attempt: 0, taskId, pidTree: [22222] });
    const unrelatedPid = 99_999; // 一台机器上"同名"的无关进程——绝不允许被本台账回收碰到

    mgr.reclaim(a.scopeKey, 'release');
    mgr.reclaim(b.scopeKey, 'release');

    assert.deepEqual(killer.kills.sort((x, y) => x - y), [11111, 22222], '只回收台账里登记的 root PID');
    assert.ok(!killer.kills.includes(unrelatedPid), '无关 PID 永不被传入 killer');
    assert.ok(mgr.killedPidsLog.every((p) => p === 11111 || p === 22222));
  } finally {
    db.close();
  }
});

test('M1-1④: timers 幂等键口径（同 scope 只一行、dedupe_key 非空、task_id 非空）', () => {
  const { db, taskId } = fresh();
  try {
    const mgr = new EffectScopeManager(db, { clock: () => 1_000 });
    const { scopeKey } = mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] });
    mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 42, attempt: 0, taskId, pidTree: [111] }); // 重放
    mgr.heartbeat(scopeKey);

    const rows = db
      .prepare('SELECT task_id, dedupe_key, due_at FROM timers WHERE kind = ? AND dedupe_key = ?')
      .all(EFFECT_SCOPE_TIMER_KIND, scopeKey) as { task_id: number | null; dedupe_key: string | null; due_at: number }[];
    assert.equal(rows.length, 1, '同 scopeKey 的 heartbeat 定时器只一行（幂等 UPSERT）');
    assert.equal(rows[0]?.dedupe_key, scopeKey);
    assert.equal(rows[0]?.task_id, taskId, 'task_id 非空（工作项台账必有归属任务 → 避开 NULL 去重失效的 G-4 口径）');
    assert.equal(rows[0]?.due_at, 1_000 + 60_000, 'due_at = heartbeatAt + 默认超时');
  } finally {
    db.close();
  }
});
