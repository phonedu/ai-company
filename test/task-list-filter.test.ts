/**
 * M2-A「归档口径收口 + 列表长度策略」—— `tasks.listTasks` 过滤器（含"有牙"）。
 * 口径（3066）：默认排除 `archived=1`；`since` **只对终态任务**限"最近 7 天"，**活态不受限**；`limit` 显式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask, listTasks } from '../src/main/db/tasks.js';

const AT = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function setup(): { db: ReturnType<typeof openMemoryDatabase>; mk: (o: { title?: string; state?: string; updatedAt?: number; archived?: number }) => number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const counters = new SqliteCounterStore(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/r', 1)").run().lastInsertRowid,
  );
  const mk = (o: { title?: string; state?: string; updatedAt?: number; archived?: number }): number => {
    const t = createTask(db, counters, { projectId, title: o.title ?? 'T', goal: 'g', riskLevel: 0 });
    db.prepare('UPDATE tasks SET state = ?, updated_at = ?, archived = ? WHERE id = ?').run(
      o.state ?? 'ready',
      o.updatedAt ?? AT,
      o.archived ?? 0,
      t.id,
    );
    return t.id;
  };
  return { db, mk };
}

test('M2-A 归档默认隐藏：listTasks() 不含 archived=1；includeArchived:true 才含', () => {
  const { db, mk } = setup();
  try {
    mk({ title: 'active' });
    mk({ title: 'archived', archived: 1 });
    assert.equal(listTasks(db).length, 1, '默认排除归档');
    assert.equal(listTasks(db, { includeArchived: true }).length, 2, '显式包含才可见');
  } finally {
    db.close();
  }
});

test('M2-A 列表长度 since：终态超窗消失、终态窗内保留、活态再老也保留（UI §515）', () => {
  const { db, mk } = setup();
  try {
    const since = AT - 7 * DAY;
    mk({ title: 'active-old', state: 'executing', updatedAt: AT - 30 * DAY });
    mk({ title: 'done-recent', state: 'done', updatedAt: AT - 1 * DAY });
    mk({ title: 'done-old', state: 'done', updatedAt: AT - 30 * DAY });
    const titles = listTasks(db, { since })
      .map((r) => r.title)
      .sort();
    assert.deepEqual(titles, ['active-old', 'done-recent'], '活态保留、终态超窗剔除');
  } finally {
    db.close();
  }
});

test('M2-A limit：截断', () => {
  const { db, mk } = setup();
  try {
    mk({ title: 'a' });
    mk({ title: 'b' });
    mk({ title: 'c' });
    assert.equal(listTasks(db, { limit: 2 }).length, 2);
  } finally {
    db.close();
  }
});

test('M2-A "有牙"①：默认排除归档一旦去掉 → 计数必然变化（证明默认过滤真承重）', () => {
  const { db, mk } = setup();
  try {
    mk({ title: 'active' });
    mk({ title: 'archived', archived: 1 });
    const guarded = listTasks(db).length;
    const unguarded = listTasks(db, { includeArchived: true }).length;
    assert.equal(guarded, 1);
    assert.equal(unguarded, 2);
    assert.notEqual(guarded, unguarded, '去掉默认过滤必多一条');
  } finally {
    db.close();
  }
});

test('M2-A "有牙"②：since 若错误地作用于活态 → 活态老任务会被误剔（证明"仅终态"是真口径）', () => {
  const { db, mk } = setup();
  try {
    mk({ title: 'active-old', state: 'executing', updatedAt: AT - 30 * DAY });
    const since = AT - 7 * DAY;
    assert.equal(listTasks(db, { since }).length, 1, '活态不受 since 限');
    const broken = (db.prepare('SELECT COUNT(*) n FROM tasks WHERE updated_at >= ?').get(since) as { n: number }).n;
    assert.equal(broken, 0, '若 since 无差别应用 → 活态被误剔（证明我的实现有牙）');
  } finally {
    db.close();
  }
});
