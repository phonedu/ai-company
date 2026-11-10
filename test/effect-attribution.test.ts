/**
 * OPT- · 长任务归因（effect scope 清单耗时读数）。每条断言可被弄红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import {
  EffectScopeManager,
  attributeDurations,
  effectScopeAttribution,
  scopeDuration,
  type ScopeDuration,
} from '../src/main/engine/index.js';
import type { EffectScope } from '../src/main/db/index.js';

const fake = (over: Partial<EffectScope>): EffectScope => ({
  timerId: 1,
  scopeKey: 'k',
  sessionKey: 's',
  employeeId: 1,
  workItemId: 1,
  taskId: 1,
  pidTree: [],
  tempDir: null,
  port: null,
  dbPath: null,
  userDataDir: null,
  state: 'open',
  startedAt: 1000,
  heartbeatAt: 1000,
  dueAt: 2000,
  reclaimReason: null,
  reclaimedAt: null,
  ...over,
});

test('OPT-M9-3: 已回收 → 耗时固定（= reclaimedAt - startedAt），不随 now 漂', () => {
  const s = fake({ state: 'reclaimed', reclaimedAt: 5000 });
  assert.equal(scopeDuration(s, 9_999_999).durationMs, 4000);
  assert.equal(scopeDuration(s, 9_999_999).open, false);
});

test('OPT-M9-3: 未回收 → 耗时随 now 增长（open）；clamp ≥0', () => {
  const s = fake({ state: 'open', startedAt: 1000 });
  assert.equal(scopeDuration(s, 3000).durationMs, 2000);
  assert.equal(scopeDuration(s, 3000).open, true);
  assert.equal(scopeDuration(fake({ startedAt: 5000 }), 1000).durationMs, 0, 'now<started 时 clamp 到 0');
});

test('OPT-M9-3: 归因按耗时降序 + 带 workItemId/employeeId/pidCount', () => {
  const rows = attributeDurations(
    [
      fake({ scopeKey: 'b', workItemId: 2, startedAt: 0, state: 'reclaimed', reclaimedAt: 1000, pidTree: [11] }),
      fake({ scopeKey: 'a', workItemId: 1, startedAt: 0, state: 'reclaimed', reclaimedAt: 9000, pidTree: [21, 22, 23] }),
    ],
    10_000,
  );
  assert.deepEqual(rows.map((r) => r.scopeKey), ['a', 'b']);
  assert.equal(rows[0]!.workItemId, 1);
  assert.equal(rows[0]!.pidCount, 3);
  assert.equal(rows[0]!.employeeId, 1);
});

test('OPT-M9-3: 从台账读归因（open + reclaimed 混合，长任务可定位到工作项）', () => {
  const db: SqliteDb = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(7,'E7','dev',1)").run();
    const taskId = Number(
      db.prepare("INSERT INTO tasks(project_id,title,goal,state,risk_level,created_at,updated_at) VALUES(?,'T','g','executing',0,1,1)").run(projectId).lastInsertRowid,
    );
    let t = 1000;
    const mgr = new EffectScopeManager(db, { clock: () => t, killer: { kill: () => undefined } });
    mgr.open({ sessionKey: 's1', employeeId: 7, workItemId: 1, attempt: 0, taskId, pidTree: [101] });
    t = 4000;
    mgr.reclaim('employee:7:wi:1:attempt:0', 'graceful'); // 耗时 3000
    t = 5000;
    mgr.open({ sessionKey: 's2', employeeId: 7, workItemId: 2, attempt: 0, taskId, pidTree: [201, 202] });
    t = 9000; // wi2 未回收：耗时 4000

    const rows: ScopeDuration[] = effectScopeAttribution(db, { now: 9000 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.workItemId), [2, 1], '耗时降序');
    assert.equal(rows[0]!.durationMs, 4000);
    assert.equal(rows[0]!.open, true);
    assert.equal(rows[1]!.durationMs, 3000);
    assert.equal(rows[1]!.open, false);
    assert.equal(rows[1]!.pidCount, 1);
    assert.equal(mgr.attribution(9000)[0]!.workItemId, 2, '引擎方法等价');
  } finally {
    db.close();
  }
});

test('OPT-M9-3 "有牙": 若耗时写成 now-startedAt 恒等式（忽略 reclaimedAt）→ 已回收项必错', () => {
  const s = fake({ state: 'reclaimed', reclaimedAt: 5000, startedAt: 1000 });
  const correct = scopeDuration(s, 9_999_999).durationMs;
  const wrong = 9_999_999 - s.startedAt; // 忽略 reclaimedAt 的错误算法
  assert.notEqual(correct, wrong, '正确实现必须用 reclaimedAt 截断');
  assert.equal(correct, 4000);
});
