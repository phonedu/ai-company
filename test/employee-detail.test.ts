/**
 * D-5 补位 ① · 员工工位页数据面（`employee:get`）——DTO 形状 + 「不臆造」+ 边界（含"有牙"）。
 *
 * 口径：只读；成本无行 → `usd:null`；技能/MCP 名字解析不到 → `name:null`；未知 id / 非法入参 → `null`（不抛）。
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
import { insertEmployee } from '../src/main/db/employees.js';
import { buildEmployeeDetail } from '../src/main/ipc/employee.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleEmployeeGet, type IpcDeps } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;
const ROOT = 'D:/work/billing';

function setupDb(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 0, name: '幕僚长', role: '编排', isAssistant: true, now: AT - 100 });
  insertEmployee(db, { id: 5, name: '小雅', role: '内容运营', now: AT });
  db.prepare(
    'UPDATE employees SET persona = ?, model = ?, thinking = ?, skills = ?, mcps = ?, capability_tier = ? WHERE id = 5',
  ).run('你是内容运营，写东西先给结论。', null, 'medium', JSON.stringify(['1', '9']), JSON.stringify([7]), 'trusted');
  // 技能库只登记了 id=1（其余按「未登记」如实呈现）
  db.prepare("INSERT INTO skills (id, name, source, path, created_at) VALUES (1, 'writer', 'builtin', 'x/SKILL.md', 1)").run();
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (11, ?, ?, ?)').run('记账系统', ROOT, AT);
  return db;
}

/** 一条在跑任务（executing）＋ 一条已完成任务（owner 都是 5）。 */
function seedTasks(db: SqliteDb): { openTaskId: number; doneTaskId: number } {
  const counter = new SqliteCounterStore(db);
  const openTask = createTask(db, counter, { projectId: 11, title: '写周报', goal: 'g', ownerId: 5, state: 'executing' });
  const doneTask = createTask(db, counter, { projectId: 11, title: '旧活', goal: 'g', ownerId: 5, state: 'done' });
  insertWorkItem(db, { taskId: openTask.id, employeeId: 5, title: '起草', brief: 'b', now: AT + 10 });
  insertWorkItem(db, { taskId: doneTask.id, employeeId: 5, title: '收尾', brief: 'b', now: AT + 20 });
  db.prepare("UPDATE work_items SET state = 'done' WHERE task_id = ?").run(doneTask.id);
  db.prepare('UPDATE tasks SET closed_at = ? WHERE id = ?').run(AT + 30, doneTask.id);
  return { openTaskId: openTask.id, doneTaskId: doneTask.id };
}

test('D-5 employee:get：字段与真数据（人设/模型 null=跟随全局/技能名字解析/能力档）', () => {
  const db = setupDb();
  const detail = buildEmployeeDetail(db, 5);
  assert.ok(detail);
  assert.equal(detail.employee.name, '小雅');
  assert.equal(detail.employee.role, '内容运营');
  assert.equal(detail.employee.persona, '你是内容运营，写东西先给结论。');
  assert.equal(detail.employee.model, null, 'model=NULL 原样返回（UI 显「跟随全局默认」，不臆造模型名）');
  assert.equal(detail.employee.thinking, 'medium');
  assert.equal(detail.employee.capabilityTier, 'trusted');
  assert.equal(detail.employee.isAssistant, false);
  assert.equal(detail.employee.active, true);
  assert.deepEqual(detail.employee.skills, [
    { id: '1', name: 'writer' },
    { id: '9', name: null },
  ], '登记过的解析出名字；未登记的 name=null（不编名字）');
  assert.deepEqual(detail.employee.mcps, [{ id: '7', name: null }], 'mcp_servers 无行 → name=null');
  db.close();
});

test('D-5 employee:get：记忆（项目名 join；project_id=0 通用分区 projectName=null）+ 在跑只算未终结 + 最近任务', () => {
  const db = setupDb();
  const { openTaskId, doneTaskId } = seedTasks(db);
  db.prepare('INSERT INTO employee_memory (employee_id, project_id, memory, updated_at) VALUES (?,?,?,?)').run(
    5,
    11,
    '[任务 T-1001] 写周报',
    AT + 100,
  );
  db.prepare('INSERT INTO employee_memory (employee_id, project_id, memory, updated_at) VALUES (?,?,?,?)').run(
    5,
    0,
    '[通用] 偏好：先结论',
    AT + 50,
  );
  const detail = buildEmployeeDetail(db, 5);
  assert.ok(detail);
  assert.equal(detail.memory.length, 2, '两块记忆都在（不隐藏）');
  const byProject = Object.fromEntries(detail.memory.map((m) => [m.projectId, m]));
  assert.equal(byProject[11].projectName, '记账系统', '项目分区 join 出项目名');
  assert.equal(byProject[0].projectName, null, '通用分区（project_id=0）无 projects 行 → null（UI 显「通用记忆」）');
  assert.deepEqual(detail.currentWork.map((w) => w.taskId), [openTaskId], '在跑＝未终结工作项（done 的不算）');
  assert.equal(detail.currentWork[0].state, 'queued');
  assert.equal(detail.currentWork[0].taskTitle, '写周报');
  assert.ok(detail.currentWork[0].taskShortId, '短号在场（可点进任务详情）');
  assert.deepEqual(
    detail.recentTasks.map((t) => t.id).sort((a, b) => a - b),
    [openTaskId, doneTaskId].sort((a, b) => a - b),
    '最近任务＝owner 名下任务（含已完成，按 updated_at 倒序）',
  );
  db.close();
});

test('D-5 employee:get：成本「不臆造」—— 无行 usd=null；有行累加；别的员工的成本不得混入（有牙）', () => {
  const db = setupDb();
  const { openTaskId } = seedTasks(db);
  assert.equal(buildEmployeeDetail(db, 5)?.cost.usd, null, "无成本行 → null（UI 显 —，不写假 0）");
  insertEmployee(db, { id: 6, name: '阿测', role: '测试', now: AT });
  db.prepare('INSERT INTO costs (task_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES (?,?,?,?,?,?,?)').run(
    openTaskId,
    6,
    'm',
    10,
    5,
    0.5,
    AT,
  );
  assert.equal(buildEmployeeDetail(db, 5)?.cost.usd, null, "有牙：别的员工的成本行不得计到本人头上");
  db.prepare('INSERT INTO costs (task_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES (?,?,?,?,?,?,?)').run(
    openTaskId,
    5,
    'm',
    100,
    50,
    0.25,
    AT + 1,
  );
  const cost = buildEmployeeDetail(db, 5)?.cost;
  assert.ok(cost, '员工详情在场');
  assert.equal(cost.usd, 0.25);
  assert.deepEqual({ rows: cost.rows, tokensIn: cost.tokensIn, tokensOut: cost.tokensOut }, { rows: 1, tokensIn: 100, tokensOut: 50 });
  db.close();
});

test('D-5 employee:get：边界 —— 未知 id → null；已停用员工可读（active:false 如实）；非法入参 → null（不抛）', () => {
  const db = setupDb();
  assert.equal(buildEmployeeDetail(db, 999), null, '未知 id → null（UI 显「员工不存在」，不白屏）');
  db.prepare('UPDATE employees SET active = 0 WHERE id = 5').run();
  const inactive = buildEmployeeDetail(db, 5);
  assert.ok(inactive);
  assert.equal(inactive.employee.active, false, '停用员工仍可读详情（如实标 active:false）');

  const repo = createSqliteChatRepo(db);
  const deps = { repo } as unknown as IpcDeps;
  assert.equal(handleEmployeeGet(deps, { employeeId: 5 })?.employee.name, '小雅', '正常入参 → 详情');
  assert.equal(handleEmployeeGet(deps, { employeeId: '5' }), null, '字符串入参 → null（不当 number 用）');
  assert.equal(handleEmployeeGet(deps, {}), null);
  assert.equal(handleEmployeeGet(deps, null), null);
  db.close();
});
