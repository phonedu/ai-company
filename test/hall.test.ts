import test from 'node:test';
import assert from 'node:assert/strict';

import { insertWorkItem, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { buildHallState, UNGROUPED_ID } from '../src/main/ipc/hall.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';

// ─────────── M1 公司大厅 B0/B1：员工列表 + 轻量部门分组 + 真实协作流聚合 ───────────

function emp(db: SqliteDb, name: string, role = 'standard'): number {
  return Number(db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?, ?, 1)").run(name, role).lastInsertRowid);
}

test('B0: 员工列表只含在职；部门分组含「未分组」兜底', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const a = emp(db, '甲');
  const b = emp(db, '乙');
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(b); // 乙离职 → 不在列表

  const hall = buildHallState(db, { [a]: 'product' });
  assert.deepEqual(hall.employees.map((e) => e.name), ['甲']);
  assert.equal(hall.employees[0].departmentId, 'product');
  assert.equal(hall.employees[0].isAssistant, false);
  // 部门（三部门固定）+ 未分组仅在有成员时出现
  assert.deepEqual(hall.departments.map((d) => d.id), ['product', 'engineering', 'operations']);
  assert.deepEqual(hall.departments.find((d) => d.id === 'product')!.memberIds, [a]);
  assert.ok(!hall.departments.some((d) => d.id === UNGROUPED_ID), '无未分组员工时不应出现未分组部门');
  assert.deepEqual(hall.collab, [], '无跨部门往来 → 无协作边');
  assert.equal(hall.windowDays, 7);
  db.close();
});

test('B1: 未分组兜底出现；协作流＝按任务 work_items 相邻跨部门计数（同部门不算、无往来无边）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const p = emp(db, '产品甲');
  const e = emp(db, '研发乙');
  emp(db, '散人丙'); // 未分组

  const t = repo.createTask({ title: 't', goal: 'g' });
  insertWorkItem(db, { taskId: t.id, employeeId: p, title: 'w1', brief: 'b', now: 1 });
  insertWorkItem(db, { taskId: t.id, employeeId: e, title: 'w2', brief: 'b', now: 2 });
  insertWorkItem(db, { taskId: t.id, employeeId: e, title: 'w3', brief: 'b', now: 3 }); // 相邻同部门，不计

  const hall = buildHallState(db, { [p]: 'product', [e]: 'engineering' }, { now: 10 });
  assert.deepEqual(hall.departments.find((d) => d.id === UNGROUPED_ID)!.memberIds.length, 1);
  assert.deepEqual(hall.collab, [{ from: 'product', to: 'engineering', count: 1 }]);

  // 契约（HTTP 层）：employee:list / hall:state 走 repo（不再 not_implemented）
  assert.equal(repo.listEmployees().length, 3);
  assert.equal(repo.hallState().windowDays, 7);
  assert.ok(repo.hallState().departments.length >= 3);
  db.close();
});

test('B0: 幕僚长（is_assistant=1）也在墙上；库里没有的员工不臆造', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  // 库里没有员工（更无 0 号）→ 列表为空，**不臆造幕僚长**
  assert.deepEqual(buildHallState(db, {}).employees, []);
  const assist = Number(
    db
      .prepare("INSERT INTO employees(name, role, is_assistant, created_at) VALUES('幕僚长','assistant',1,1)")
      .run().lastInsertRowid,
  );
  const hall = buildHallState(db, { [assist]: 'product' });
  assert.equal(hall.employees.length, 1);
  assert.equal(hall.employees[0].isAssistant, true);
  assert.equal(hall.employees[0].departmentId, 'product');
  assert.ok(hall.departments.find((d) => d.id === 'product')!.memberIds.includes(assist));
  db.close();
});
