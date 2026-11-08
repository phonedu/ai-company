/**
 * RW-12（M5 真机带回，2026-10-27）· critic/verifier 选人必须**优先专职评审角色**。
 *
 * 真机事实：公司里专职评审员工苏芮(#2, role=review)在册，但历次 plan_reviewed 的 critic 都是
 * 林川(#1, role=dev)——选人 `ORDER BY id` 纯按 id 顺序，role 被无视；专职评审员工被闲置，
 * 「评审≠执行」名存实亡（dev 当 critic 评 dev 的活，只是恰好不是同一人）。
 * 修复口径：两处选人 SQL 加 role 优先级——role 含 review/评审/critic 的排前面，同级按 id；
 * 幕僚长/实现者/规划者排除等既有边界不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';

test('RW-12①: critic 选人优先 role=review（不再按 id 顺序拿 dev 同事）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'实现者','dev','standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(8,'dev同事','dev','standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(9,'专职评审','review','standard',1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 2 }); // B3-6：critic 选人依赖 critic 真开（L2）
    insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });

    const events: EngineEvent[] = [];
    const fake = makeFakeAgentRuntime([
      { text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: (e) => void events.push(e) });
    await exec.execute({ actionKey: 'dispatch_critic:task:' + task.id + ':0', kind: 'dispatch_critic', taskId: task.id, payload: {} });
    assert.equal(
      events[0]!.actor,
      'employee:9',
      `critic 应优先专职评审 #9（实际 ${String(events[0]!.actor)}）——按 id 顺序拿 dev 同事＝RW-12`,
    );
  } finally {
    db.close();
  }
});

test('RW-12②: verifier 选人同样优先 role=review', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(0,'幕僚长','assistant',1,'standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(1,'实现者','dev',0,'standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(2,'dev同事','dev',0,'standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(3,'专职评审','review',0,'standard',1)").run();
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 2 }).id;
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    const r = engine.requestReview(wi.id);
    assert.equal(
      r.verifierEmployeeId,
      3,
      `verifier 应优先专职评审 #3（实际 ${String(r.verifierEmployeeId)}）——按 id 顺序拿 dev 同事＝RW-12 同族`,
    );
  } finally {
    db.close();
  }
});

test('RW-12③: 无专职评审时回退普通员工（既有行为不回退）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(0,'幕僚长','assistant',1,'standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(1,'实现者','dev',0,'standard',1)").run();
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,capability_tier,created_at) VALUES(2,'dev同事','dev',0,'standard',1)").run();
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 1_000 });
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 2 }).id;
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    const r = engine.requestReview(wi.id);
    assert.equal(r.verifierEmployeeId, 2, '无专职评审 ⇒ 回退按 id（独立 dev 同事）');
  } finally {
    db.close();
  }
});
