/**
 * D-17 记忆注入门：员工/幕僚长/critic/verifier 的可见面不同；项目隔离。
 * 全部内存库；不碰真实数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { buildEmployeeContext, buildReviewContext } from '../src/main/agent/context.js';
import { MEMORY_DATA_BOUNDARY, SqliteMemoryStore } from '../src/main/memory/index.js';

function setup(): { db: SqliteDb; projectA: number; projectB: number; taskA: number; taskB: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(1,'执行者','dev',1)").run();
  const projectA = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('A','D:/a',1)").run().lastInsertRowid);
  const projectB = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('B','D:/b',1)").run().lastInsertRowid);
  const store = new SqliteCounterStore(db);
  const taskA = createTask(db, store, { projectId: projectA, title: '甲任务', goal: '做甲' }).id;
  const taskB = createTask(db, store, { projectId: projectB, title: '乙任务', goal: '做乙' }).id;
  return { db, projectA, projectB, taskA, taskB };
}

test('memory-context: 员工拿到全局+项目事实；项目 B 不串项目 A', () => {
  const { db, projectA, taskA, taskB } = setup();
  try {
    const mem = new SqliteMemoryStore(db);
    mem.remember({
      scope: { type: 'project', projectId: projectA },
      kind: 'decision',
      key: 'billing.unit',
      value: '对账单以万元为单位',
      source: { type: 'boss', ref: 'T-1001' },
      now: 1,
    });
    mem.remember({
      scope: { type: 'global' },
      kind: 'preference',
      key: 'tone',
      value: '输出用简洁中文',
      source: { type: 'boss', ref: 'boss:1' },
      now: 2,
    });

    const a = buildEmployeeContext(db, { employeeId: 1, taskId: taskA });
    assert.ok(a.systemPrompt.includes(MEMORY_DATA_BOUNDARY), '记忆块必须带数据边界');
    assert.ok(a.systemPrompt.includes('[记忆·project]'), '员工应看到项目事实段');
    assert.ok(a.systemPrompt.includes('对账单以万元为单位'));
    assert.ok(a.systemPrompt.includes('[记忆·global]'), '员工应看到全局事实段');
    assert.ok(a.systemPrompt.includes('输出用简洁中文'));
    assert.equal(a.meta.layers.facts, true);

    const b = buildEmployeeContext(db, { employeeId: 1, taskId: taskB });
    assert.ok(!b.systemPrompt.includes('对账单以万元为单位'), '项目 B 不得看到 A 的项目事实');
    assert.ok(b.systemPrompt.includes('输出用简洁中文'), '全局事实跨项目可见');
  } finally {
    db.close();
  }
});

test('memory-context: critic 看事实；verifier 默认 0 记忆；两者都不读员工 L1', () => {
  const { db, projectA, taskA } = setup();
  try {
    const mem = new SqliteMemoryStore(db);
    mem.remember({
      scope: { type: 'project', projectId: projectA },
      kind: 'constraint',
      key: 'client.name',
      value: '客户叫记账系统',
      source: { type: 'boss', ref: 'T-1001' },
      now: 1,
    });
    // 造一条员工 L1 摘要，证明评审会话不会读到它
    db.prepare("INSERT INTO employee_memory(employee_id, project_id, memory, updated_at) VALUES(1, ?, '[任务 T-1001] 员工私货', 1)").run(projectA);

    const critic = buildReviewContext(db, { role: 'critic', taskId: taskA, reviewerEmployeeId: 1 });
    assert.ok(critic.systemPrompt.includes(MEMORY_DATA_BOUNDARY), 'critic 记忆块必须带数据边界');
    assert.ok(critic.systemPrompt.includes('[记忆·project]'), 'critic 应看到项目事实');
    assert.ok(critic.systemPrompt.includes('客户叫记账系统'));
    assert.ok(!critic.systemPrompt.includes('员工私货'), 'critic 不读员工 L1');
    assert.ok(!critic.systemPrompt.includes('[员工记忆]'), 'critic 不注入员工记忆段');

    const verifier = buildReviewContext(db, { role: 'verifier', taskId: taskA, reviewerEmployeeId: 1 });
    assert.ok(!verifier.systemPrompt.includes('[记忆·'), 'verifier 默认 0 记忆');
    assert.ok(!verifier.systemPrompt.includes('客户叫记账系统'));
    assert.ok(!verifier.systemPrompt.includes('员工私货'));
    assert.ok(!verifier.systemPrompt.includes('[员工记忆]'));
  } finally {
    db.close();
  }
});
