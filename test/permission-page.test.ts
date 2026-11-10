/**
 *  · 权限页只读审计 + 撤销。
 *
 * 判据：
 *  - `permission_policies` 三级 scope 都列出；项目 scope 带项目名；
 *  - 只列 `[权限] ` 前缀的 approvals（业务决策不混入）；
 *  - 撤销只删该 scope 行；不存在 → 显式 not_found（不静默成功）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { listPermissionOverview, revokePermissionPolicy } from '../src/main/ipc/permission.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('记账系统', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO permission_policies(scope_type, scope_id, tier, policy, updated_at) VALUES('global', 0, 'standard', ?, 10)",
  ).run(JSON.stringify({ grants: [{ rule: 'a' }, { rule: 'b' }] }));
  db.prepare(
    "INSERT INTO permission_policies(scope_type, scope_id, tier, policy, updated_at) VALUES('project', ?, 'strict', ?, 11)",
  ).run(projectId, JSON.stringify({}));
  db.prepare(
    `INSERT INTO approvals(task_id, report_id, question, options, default_action, timeout_at, chosen, decided_by, decided_at)
     VALUES(NULL, NULL, '[权限] 写文件', '[]', NULL, NULL, '1', 'boss', 12)`,
  ).run();
  db.prepare(
    `INSERT INTO approvals(task_id, report_id, question, options, default_action, timeout_at, chosen, decided_by, decided_at)
     VALUES(NULL, NULL, '业务决策', '[]', NULL, NULL, '1', 'boss', 13)`,
  ).run();
  return { db, projectId };
}

test('UG-09：权限总览列三级策略（项目名）＋只列 [权限] 审批', () => {
  const { db, projectId } = setup();
  const overview = listPermissionOverview(db);
  assert.equal(overview.policies.length, 2);
  const global = overview.policies.find((p) => p.scopeType === 'global');
  assert.equal(global?.grants, 2, 'grants 计数来自 policy JSON');
  const project = overview.policies.find((p) => p.scopeType === 'project');
  assert.equal(project?.scopeId, projectId);
  assert.equal(project?.scopeName, '记账系统');
  assert.equal(overview.approvals.length, 1, '业务决策审批不混入权限页');
  assert.match(overview.approvals[0]!.question, /^\[权限\]/);
  db.close();
});

test('UG-09：撤销只删指定 scope；不存在显式 not_found', () => {
  const { db, projectId } = setup();
  const ok = revokePermissionPolicy(db, { scopeType: 'project', scopeId: projectId });
  assert.deepEqual(ok, { ok: true, removed: 1 });
  assert.equal(listPermissionOverview(db).policies.some((p) => p.scopeType === 'project'), false);
  const again = revokePermissionPolicy(db, { scopeType: 'project', scopeId: projectId });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, 'not_found');
  const bad = revokePermissionPolicy(db, { scopeType: 'god', scopeId: 1 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'bad_request');
  db.close();
});
