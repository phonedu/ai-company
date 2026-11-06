/**
 * M2 尾：员工写入口（招募 / 改档）——真库断言：
 *  - 招募写行、回读详情；
 *  - 项目白名单拦点（招募显式 projectId；改档按员工所属项目）；
 *  - 停用守卫（有在跑/排队件 ⇒ busy；幕僚长不可停用；空闲可停用）；
 *  - 非法思考强度/能力档拒且不落库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  handleEmployeeRecruit,
  handleEmployeeUpdate,
  type IpcDeps,
} from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(0, '幕僚长', 'assistant', 1)").run();
  const projectId = (
    db
      .prepare(
        `INSERT INTO projects(name, root_dir, allowed_providers, default_employee_ids, created_at)
         VALUES('P', 'D:/repo', '["local"]', '[1]', 1) RETURNING id`,
      )
      .get() as { id: number }
  ).id;
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(1, '研究员', 'dev', 1)").run();
  return { db, deps: { repo: createSqliteChatRepo(db) }, projectId };
}

test('M2 尾：招募真写行（名字/角色/人设/模型）＋回读详情', () => {
  const { db, deps } = setup();
  const res = handleEmployeeRecruit(deps, {
    name: '林悦',
    role: '数据分析师',
    persona: '先给结论，再给证据。',
    model: 'local/any-model',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.employee.employee.name, '林悦');
  assert.equal(res.employee.employee.role, '数据分析师');
  assert.equal(res.employee.employee.persona, '先给结论，再给证据。');
  assert.equal(res.employee.employee.model, 'local/any-model');
  const row = db.prepare('SELECT name, role, persona, model FROM employees WHERE id = ?').get(res.employee.employee.id) as {
    name: string;
    role: string;
    persona: string;
    model: string;
  };
  assert.deepEqual(row, { name: '林悦', role: '数据分析师', persona: '先给结论，再给证据。', model: 'local/any-model' });
  db.close();
});

test('M2 尾：招募白名单拦点（项目只允许 local；deepseek 模型被拒且不落行）', () => {
  const { db, deps, projectId } = setup();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n;
  const res = handleEmployeeRecruit(deps, {
    name: '越权员工',
    role: 'dev',
    model: 'deepseek/deepseek-flash',
    projectId,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'whitelist');
  assert.match(res.message, /不在项目「P」白名单内/);
  const after = (db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n;
  assert.equal(after, before, '白名单拒绝后不落员工行');
  db.close();
});

test('M2 尾：改档写入口（人设/模型）＋按所属项目白名单拦截', () => {
  const { db, deps } = setup();
  const ok = handleEmployeeUpdate(deps, { employeeId: 1, persona: '新的工作风格', model: 'local/m2' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.employee.employee.persona, '新的工作风格');
  assert.equal(ok.employee.employee.model, 'local/m2');

  const bad = handleEmployeeUpdate(deps, { employeeId: 1, model: 'deepseek/deepseek-v4-pro' });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.code, 'whitelist');
  const row = db.prepare('SELECT model FROM employees WHERE id = 1').get() as { model: string };
  assert.equal(row.model, 'local/m2', '被拒后不落库');
  db.close();
});

test('M2 尾：停用守卫（有在跑件 ⇒ busy；幕僚长不可停用；空闲可停用）', () => {
  const { db, deps, projectId } = setup();
  const taskId = Number(
    (
      db
        .prepare(
          "INSERT INTO tasks(short_id, project_id, title, goal, state, created_at, updated_at) VALUES('T-1', ?, 't', 'g', 'executing', 1, 1) RETURNING id",
        )
        .get(projectId) as { id: number }
    ).id,
  );
  db.prepare(
    "INSERT INTO work_items(task_id, employee_id, title, brief, state, created_at) VALUES(?, 1, 'w', 'b', 'running', 1)",
  ).run(taskId);

  const busy = handleEmployeeUpdate(deps, { employeeId: 1, active: false });
  assert.equal(busy.ok, false);
  if (busy.ok) return;
  assert.equal(busy.code, 'busy');
  assert.match(busy.message, /在跑\/排队/);

  const assistant = handleEmployeeUpdate(deps, { employeeId: 0, active: false });
  assert.equal(assistant.ok, false);
  if (assistant.ok) return;
  assert.equal(assistant.code, 'bad_value');

  db.prepare("UPDATE work_items SET state = 'done' WHERE employee_id = 1").run();
  const idle = handleEmployeeUpdate(deps, { employeeId: 1, active: false });
  assert.equal(idle.ok, true);
  if (!idle.ok) return;
  assert.equal(idle.employee.employee.active, false);
  db.close();
});

test('M2 尾：非法思考强度/能力档拒且不落库（有牙）', () => {
  const { db, deps } = setup();
  const t = handleEmployeeUpdate(deps, { employeeId: 1, thinking: 'extreme' as never });
  assert.equal(t.ok, false);
  if (t.ok) return;
  assert.equal(t.code, 'bad_value');
  const c = handleEmployeeUpdate(deps, { employeeId: 1, capabilityTier: 'god' });
  assert.equal(c.ok, false);
  if (c.ok) return;
  assert.equal(c.code, 'bad_value');
  const row = db.prepare('SELECT thinking, capability_tier FROM employees WHERE id = 1').get() as {
    thinking: string | null;
    capability_tier: string;
  };
  assert.deepEqual(row, { thinking: null, capability_tier: 'standard' });
  db.close();
});

test('UG-11：花名册含已停用（listRosterEmployees / employee:list includeDisabled）——停用后仍可见、可重新启用', () => {
  const { db, deps } = setup();
  // 停用 1 号（空闲可停用）。
  const off = handleEmployeeUpdate(deps, { employeeId: 1, active: false });
  assert.equal(off.ok, true);
  // 大厅口径：只有在职。
  const hall = deps.repo.listEmployees();
  assert.equal(hall.some((e) => e.id === 1), false, '大厅不应显示已停用员工');
  // 花名册口径：含已停用，active 真值。
  const roster = deps.repo.listRosterEmployees();
  const disabled = roster.find((e) => e.id === 1);
  assert.ok(disabled, '花名册必须仍包含已停用员工（否则无法重新启用）');
  assert.equal(disabled?.active, false);
  // 重新启用路径仍在：active:true 写回成功。
  const on = handleEmployeeUpdate(deps, { employeeId: 1, active: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.employee.employee.active, true);
  db.close();
});
