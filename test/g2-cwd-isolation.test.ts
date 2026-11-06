/**
 * G2（M2）· 任务级 cwd 隔离：会话按 `(sessionKey, cwd)` 分区。
 * 本文件只测**纯键逻辑**与**运行期传参**（真实 Pi 会话两 cwd 隔离归真机验证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmployeeExecutor, EmployeeSessionRuntime, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { sessionCacheKey } from '../src/main/agent/pi-runtime.js';
import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';

test('G2: 会话缓存键含 cwd —— 同 sessionKey 不同 cwd 分区（不串上下文）', () => {
  const a = sessionCacheKey('employee:7:task:1:wi:1', 'D:/proj');
  const b = sessionCacheKey('employee:7:task:1:wi:1', 'D:/proj/.aico-worktrees/t1');
  assert.notEqual(a, b, '不同 cwd 必须得到不同缓存键');
  assert.equal(a, 'employee:7:task:1:wi:1@D:/proj');
});

test('G2 接线: 派发 payload 的 cwd（任务工作区）→ 会话 cwd 用它；无 payload cwd → 回退项目根（inplace 不变）', async () => {
  const db: SqliteDb = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/workspace',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });

    // ① payload 带工作区 cwd（staging/worktree） → 用它
    const fake1 = makeFakeAgentRuntime([{ text: 'x', toolCalls: [] }]);
    const exec1 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake1), dispatch: () => undefined });
    await exec1.execute(
      toPersistedAction(`dispatch:work_item:${wi.id}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0, cwd: 'D:/workspace/.aico-worktrees/t1' })),
    );
    assert.equal(fake1.runs[0]!.cwd, 'D:/workspace/.aico-worktrees/t1', 'staging/worktree：会话 cwd = 工作区路径');

    // ② 无 payload cwd（inplace） → 回退项目根（默认路径不被改坏）
    const fake2 = makeFakeAgentRuntime([{ text: 'x', toolCalls: [] }]);
    const exec2 = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake2), dispatch: () => undefined });
    await exec2.execute(toPersistedAction(`dispatch:work_item:${wi.id}:1`, 'dispatch', task.id, '{"attempt":1}'));
    assert.equal(fake2.runs[0]!.cwd, 'D:/workspace', 'inplace：仍是项目根');
  } finally {
    db.close();
  }
});

test('G2 "有牙": payload 无 cwd 时绝不会用工作区路径（对照证明接线承重）', async () => {
  const db: SqliteDb = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/root',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
    const fake = makeFakeAgentRuntime([{ text: 'x', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wi.id}:0`, 'dispatch', task.id, '{}'));
    assert.equal(fake.runs[0]!.cwd, 'D:/root');
    assert.notEqual(fake.runs[0]!.cwd, 'D:/workspace/.aico-worktrees/t1', '无 payload cwd ⇒ 不得凭空用工作区路径');
  } finally {
    db.close();
  }
});

test('G2: 执行器把上下文里的 cwd 传给会话（运行期 cwd = ctx.meta.cwd，不是构造期 cwd）', async () => {
  const db: SqliteDb = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/workspace',1)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });

    const fake = makeFakeAgentRuntime([{ text: 'x', toolCalls: [] }]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: () => undefined,
      // 注入评审/员工上下文：cwd = 任务工作区（模拟 worktree/staging）
      buildContext: (_db, input) => ({
        systemPrompt: 's',
        userPrompt: 'u',
        meta: { layers: { platform: true, role: true, persona: false, memory: false, memoryBrief: false, skills: false, retrieval: false, fewShot: false, baseline: false, project: true, task: true }, projectRoot: 'D:/workspace', cwd: 'D:/workspace/.aico-worktrees/t1' },
        ...input,
      }),
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wi.id}:0`, 'dispatch', task.id, '{"attempt":0}'));
    assert.equal(fake.runs[0]!.cwd, 'D:/workspace/.aico-worktrees/t1', '会话 cwd 必须来自运行期上下文（任务工作区）');
  } finally {
    db.close();
  }
});
