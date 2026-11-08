import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendMemory,
  insertWorkItem,
  openMemoryDatabase,
  readMemory,
  recordTaskMemory,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskCreate, handleTaskTransition, type IpcDeps } from '../src/main/ipc/ipc.js';

// ── G11 · 员工长期记忆（`employee_memory`）：DAO 幂等/上限 + 任务收尾投影（引擎同事务） ──

const AT = 1_800_000_000_000;

function setupDb(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 5, name: '小雅', role: '内容运营', now: AT });
  insertEmployee(db, { id: 2, name: '陈默', role: '技术负责人', now: AT });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\\work\\proj', AT);
  return db;
}

test('G11 memory DAO: 空 → ""；append 后可读；同 marker 幂等跳过', () => {
  const db = setupDb();
  assert.equal(readMemory(db, { employeeId: 5, projectId: 11 }), '', '无行 → 空串（不臆造）');

  const wrote = appendMemory(db, {
    employeeId: 5,
    projectId: 11,
    block: '[任务 T-1001] 写周报（2026-10-14 完成）\n验收：含来源',
    marker: '[任务 T-1001]',
    now: AT,
  });
  assert.equal(wrote, true);
  assert.ok(readMemory(db, { employeeId: 5, projectId: 11 }).includes('[任务 T-1001] 写周报'));

  const again = appendMemory(db, {
    employeeId: 5,
    projectId: 11,
    block: '[任务 T-1001] 写周报（2026-10-14 完成）\n验收：含来源',
    marker: '[任务 T-1001]',
    now: AT + 1,
  });
  assert.equal(again, false, '同 marker 重复写必须跳过（幂等）');
  assert.equal(readMemory(db, { employeeId: 5, projectId: 11 }).split('[任务 T-1001]').length - 1, 1, '不得出现第二份');
  db.close();
});

test('G11 memory DAO: 超上限只保留最近 20 块（丢最旧、保最新）', () => {
  const db = setupDb();
  for (let i = 1; i <= 25; i += 1) {
    appendMemory(db, {
      employeeId: 2,
      projectId: 11,
      block: `[任务 T-${1000 + i}] 第 ${i} 件（2026-10-14 完成）`,
      marker: `[任务 T-${1000 + i}]`,
      now: AT + i,
    });
  }
  const memory = readMemory(db, { employeeId: 2, projectId: 11 });
  const count = memory.split('\n\n').filter((b) => b.trim().length > 0).length;
  assert.equal(count, 20, '最多 20 块');
  assert.ok(!memory.includes('[任务 T-1001]'), '最旧的应被丢弃');
  assert.ok(!memory.includes('[任务 T-1005]'), '第 5 个以后仍在 20 块窗口外的也应被丢弃');
  assert.ok(memory.includes('[任务 T-1025]'), '最新一块必须在');
  db.close();
});

test('G11 recordTaskMemory: 无参与者 → 不写任何人；有参与者 → 只写参与者', async () => {
  const db = setupDb();
  const created = await handleTaskCreate({ repo: createSqliteChatRepo(db) }, {
    goal: '无人的任务',
    acceptance: [{ text: 'a' }],
    projectId: 11,
  });
  const none = recordTaskMemory(db, created.id, AT);
  assert.deepEqual(none?.employees, [], '无工作项 → 无参与者');
  assert.deepEqual(none?.writtenTo, []);
  assert.equal(readMemory(db, { employeeId: 5, projectId: 11 }), '', '不得给任何人臆造记忆');

  insertWorkItem(db, { taskId: created.id, employeeId: 5, title: '初稿', brief: 'b', now: AT });
  const one = recordTaskMemory(db, created.id, AT + 1);
  assert.deepEqual(one?.employees, [5]);
  assert.deepEqual(one?.writtenTo, [5]);
  assert.ok(readMemory(db, { employeeId: 5, projectId: 11 }).includes(`[任务 ${created.shortId}]`));
  db.close();
});

test('G11 端到端: 任务走完（done）→ 参与者员工的项目记忆出现任务块（含验收/成本），重复收尾不重复写', async () => {
  const db = setupDb();
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  const deps: IpcDeps = { repo, engine };

  const created = await handleTaskCreate(deps, { goal: '把周报写出来', acceptance: [{ text: '含来源链接' }], projectId: 11 });
  assert.equal(created.shortId, 'T-1001');
  insertWorkItem(db, { taskId: created.id, employeeId: 5, title: '写初稿', brief: 'b', now: AT });
  // 记账一行（验「成本行有真数据才写」；usd>0）
  db.prepare(
    `INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, created_at)
     VALUES(?, NULL, 5, 'deepseek/deepseek-flash', 800, 400, 0.0021, ?)`,
  ).run(created.id, AT);

  // D1：`handleTaskCreate` 已自动分诊（triage）→ 本列表从 `plan_drafted` 起（不再手工发 triage）
  for (const [event, payload] of [
    ['plan_drafted', undefined],
    ['plan_reviewed', undefined],
    ['plan_approved', undefined],
    ['start_task', undefined],
    ['all_work_items_done', undefined],
    ['verification_completed', { verdict: 'pass' }],
  ] as Array<[string, Record<string, unknown> | undefined]>) {
    const result = await handleTaskTransition(deps, { taskId: created.id, event, payload });
    assert.equal(result.ok, true, `task:transition ${event} 应成功`);
  }
  // B2-6/D-30③：L1+ pass 现迁 needs_decision（签收卡）——补老板签收步
  if ((repo.getTask(created.id) as { state: string } | undefined)?.state === 'needs_decision') {
    await engine.dispatch({ scope: 'task', id: created.id, event: 'signoff', actor: 'boss', payload: { via: 'b26-regression' } });
  }
  assert.equal(repo.getTask(created.id)?.state, 'done');

  const memory = readMemory(db, { employeeId: 5, projectId: 11 });
  assert.ok(memory.includes('[任务 T-1001]'), '任务块必须落库（引擎同事务写入）');
  assert.ok(memory.includes('验收：含来源链接'), '验收必须进块');
  assert.ok(memory.includes('成本：$0.0021 · 1200 tokens'), `成本行应含真读数，实际：${memory}`);

  // 幂等：同任务重复收尾（重开/重放语义）不再写第二份
  const replay = recordTaskMemory(db, created.id, AT + 10);
  assert.deepEqual(replay?.writtenTo, [], '重复收尾 → 无新写入');
  assert.equal(memory.split('[任务 T-1001]').length - 1, 1, '不得出现第二份');
  db.close();
});
