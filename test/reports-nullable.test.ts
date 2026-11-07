/**
 * BRK21 / 迁移 `008_reports_nullable_task` —— `reports.task_id` 放宽可空（全局卡）＋**老库升级零破坏**。
 *
 * 每条可弄红：老库（007 ＋ 子表引用数据）→ 008 重建后 数据逐字段不变 / 外键一致 / NULL 可插 /
 * 索引在 / `user_version` 前进；按任务查卡时全局卡天然不混入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  insertReport,
  listReports,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { loadMigrations } from '../src/main/db/migrations.js';

const AT = 1_800_000_000_000;

/** 造「老库」＝只跑到 007，然后带数据升级（验证 008 重建不丢不坏）。 */
function seedOldDb() {
  const db = openMemoryDatabase();
  const prior = loadMigrations().filter((m) => m.version <= 7);
  runMigrations(db, prior);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  // 老库（007 期）种子用**裸 SQL**：`createTask` 的 INSERT 自 009 起带 `model` 列，
  // 在 007 期表上会 SQLITE_ERROR——本用例要的就是「老 schema ＋ 老数据 → 升级」这一现场。
  const taskId = Number(
    db
      .prepare(
        "INSERT INTO tasks(short_id, project_id, title, goal, acceptance, state, risk_level, owner_id, created_at, updated_at) VALUES('T-1001', ?, '老任务', 'g', '[]', 'executing', 0, 0, 1, 1)",
      )
      .run(projectId).lastInsertRowid,
  );
  const task = { id: taskId };
  const report = insertReport(db, {
    taskId: task.id,
    kind: 'report',
    payload: { tldr: '老卡' },
    state: 'delivered',
    dedupeKey: 'old:1',
    now: AT,
  });
  db.prepare('INSERT INTO notifications(report_id, channel, dedupe_key, sent_at) VALUES(?,?,?,?)').run(
    report.id,
    'desktop',
    `old:${report.id}`,
    AT,
  );
  return { db, task, report };
}

test('迁移 008：老库（007＋数据）升级 → reports 数据逐字段保留、子表引用有效、外键一致、索引在', () => {
  const { db, report } = seedOldDb();
  try {
    const before = db.prepare('SELECT * FROM reports WHERE id=?').get(report.id) as Record<string, unknown>;
    assert.equal(typeof before.task_id, 'number', '升级前 task_id 为普通非空值');
    runMigrations(db); // 应用 008（重建）
    const after = db.prepare('SELECT * FROM reports WHERE id=?').get(report.id) as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      assert.deepEqual(after[key], before[key], `重建不得改字段：${key}`);
    }
    assert.equal(
      (db.prepare('SELECT COUNT(*) c FROM notifications WHERE report_id=?').get(report.id) as { c: number }).c,
      1,
      '子表引用行仍在',
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, '重建后外键零违反');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reports'")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(idx.includes('idx_reports_pending'), '索引已重建');
    assert.equal(db.pragma('user_version', { simple: true }), 23, 'user_version 前进到 23（B2-3 工作项 DAG）');
  } finally {
    db.close();
  }
});

test('迁移 008：task_id 可空 —— 全局卡 NULL 插入/读回；按任务查卡天然隔离', () => {
  const { db, task } = seedOldDb();
  try {
    runMigrations(db);
    const global = insertReport(db, { taskId: null, kind: 'notification', payload: { tldr: '全局' }, now: AT + 1 });
    assert.equal(listReports(db, { taskId: task.id }).length, 1, '按任务查卡：全局卡不混入（task_id = ? 天然排除 NULL）');
    const all = listReports(db);
    assert.equal(all.length, 2);
    assert.equal(all.find((r) => r.id === global.id)?.task_id, null, 'NULL 读回如常');
  } finally {
    db.close();
  }
});
