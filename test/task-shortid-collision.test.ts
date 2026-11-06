/**
 * D5 复核崩溃修复（2026-10-26）：短号撞号有界重试。
 *
 * 事故链：种子/历史库直接插任务行但不推进 `counters`（短号计数器）→ 对话框建任务分配到
 * 已占用短号 → UNIQUE constraint failed: tasks.short_id 以原始 SQL 错误裸抛到 IPC
 * （2026-10-26 S6 run5 与 D5 实机两现，后者叠加 stderr 断管 EPIPE 直接崩应用）。
 *
 * 判据：
 * ① 计数器落后于既有任务行时，createTask 有界重试到下一个空闲短号（允许空洞——短号永不回收不变式不变）；
 * ② 非 short_id 的冲突仍照抛（不吞别处错误）；
 * ③ 重试后计数器推进到位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, readCounter, runMigrations } from '../src/main/db/index.js';

test('短号撞号：计数器落后于既有行时 createTask 有界重试到空闲短号', () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const AT = Date.now();
    db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(1,'P','D:/r',?)").run(AT);
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(7,'员工七','dev',0,1,?)").run(AT);
    // 模拟种子/历史行：T-1001..T-1003 已存在，但 counters 未推进（首次分配会得到 1001）
    for (const [i, shortId] of ['T-1001', 'T-1002', 'T-1003'].entries()) {
      db.prepare(
        `INSERT INTO tasks(short_id, project_id, title, goal, acceptance, state, priority, risk_level, owner_id, origin, archived, created_at, updated_at)
         VALUES(?,1,?,'g','[]','done',0,1,7,'boss',0,?,?)`,
      ).run(shortId, `种子${i}`, AT, AT);
    }
    const created = createTask(db, new SqliteCounterStore(db), {
      projectId: 1,
      title: '老板新建的任务',
      goal: 'g',
      acceptance: [{ text: '完成' }],
      riskLevel: 1,
      ownerId: 7,
      now: AT,
    });
    assert.equal(created.short_id, 'T-1004', '应跳过被占用的 1001-1003，落到下一个空闲短号');
    assert.equal(readCounter(db, 'task_short_id'), 1004, '计数器推进到 1004');
    assert.equal(created.title, '老板新建的任务');
  } finally {
    db.close();
  }
});

test('短号撞号：非 short_id 冲突不吞（照抛原错误）', () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    // project_id 挂一个不存在的项目（FK 约束或其他错误路径）——确保 createTask 不把无关错误当撞号吞掉
    assert.throws(() =>
      createTask(db, new SqliteCounterStore(db), {
        projectId: 1,
        title: 't',
        goal: 'g',
        acceptance: [],
        riskLevel: 1,
        ownerId: 7,
        now: Date.now(),
      }).id, /constraint|FOREIGN|UNIQUE/i, '无关约束错误应照抛');
  } finally {
    db.close();
  }
});
