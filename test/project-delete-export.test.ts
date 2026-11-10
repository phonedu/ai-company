/**
 * B-3· 项目档案导出 + 删除前清理（无孤儿行；只删归档且无任务）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  openMemoryDatabase,
  runMigrations,
  setPermissionPolicy,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SqliteMemoryStore } from '../src/main/memory/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleExportProject } from '../src/main/ipc/project-export.js';

const AT = 1_800_000_000_000;

function count(db: SqliteDb, sql: string, ...args: unknown[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo> } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, repo };
}

test('B-3 导出：项目档案单文件 JSON（项目＋任务详情），落注入的导出目录', () => {
  const { db, repo } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'aico-project-export-'));
  try {
    const project = repo.createProject({ name: '导出项目', rootDir: 'D:/export', accessMode: 'inplace', now: 1 });
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId: project.id,
      title: 'T',
      goal: 'g',
      riskLevel: 0,
      now: 2,
    });
    const res = handleExportProject({ repo, db, exportDir: () => dir }, { projectId: project.id }, AT);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const raw = readFileSync(res.path, 'utf8');
    const bundle = JSON.parse(raw) as {
      schema: string;
      project: { id: number; name: string };
      tasks: Array<{ task: { id: number } }>;
      memory: unknown[];
    };
    assert.equal(bundle.schema, 'aico.project-export/v1');
    assert.equal(bundle.project.id, project.id);
    assert.equal(bundle.project.name, '导出项目');
    assert.equal(bundle.tasks.length, 1);
    assert.equal(bundle.tasks[0]!.task.id, task.id);
    assert.ok(Array.isArray(bundle.memory));
    assert.ok(res.bytes > 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B-3 删除：归档且无任务才可删；项目级附属行清零；默认项目指针清掉；别的项目不动', () => {
  const { db, repo } = setup();
  try {
    const dead = repo.createProject({ name: '待删', rootDir: 'D:/dead', accessMode: 'inplace', now: 1 });
    const alive = repo.createProject({ name: '保留', rootDir: 'D:/alive', accessMode: 'inplace', now: 1 });
    repo.setSetting({ key: 'projects.default_id', value: dead.id });
    db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(7,'E7','dev',1)").run();
    setPermissionPolicy(db, { scopeType: 'project', scopeId: dead.id, tier: 'standard', policy: { pathAllow: ['D:/dead'] }, now: 2 });
    new SqliteMemoryStore(db).remember({
      scope: { type: 'project', projectId: dead.id },
      kind: 'fact',
      value: '项目事实',
      source: { type: 'boss' },
      now: 3,
    });
    db.prepare('INSERT INTO employee_memory(employee_id,project_id,memory,updated_at) VALUES(7,?,?,?)').run(dead.id, 'm', 4);
    db.prepare('INSERT INTO seams(project_id,boundary,status,created_at) VALUES(?,?,?,?)').run(dead.id, 'B-1', 'open', 5);
    // 保留项目也要有同类行（证明只清目标项目）。
    setPermissionPolicy(db, { scopeType: 'project', scopeId: alive.id, tier: 'standard', policy: {}, now: 6 });
    const aliveTask = createTask(db, new SqliteCounterStore(db), {
      projectId: alive.id,
      title: '保留任务',
      goal: 'g',
      riskLevel: 0,
      now: 7,
    });

    // 未归档 → 拒；有任务 → 拒（用另一个项目验证非空）。
    const notArchived = repo.deleteProjectIfEmpty(dead.id);
    assert.equal(notArchived.ok, false);
    if (!notArchived.ok) assert.equal(notArchived.code, 'not_archived');
    repo.archiveProject(dead.id, 8);
    // 归档但空 → 可删。
    const deleted = repo.deleteProjectIfEmpty(dead.id);
    assert.deepEqual(deleted, { ok: true });
    assert.equal(repo.getProject(dead.id), null);
    assert.equal(count(db, 'SELECT COUNT(*) n FROM permission_policies WHERE scope_type=? AND scope_id=?', 'project', dead.id), 0);
    assert.equal(count(db, 'SELECT COUNT(*) n FROM memory_items WHERE scope_type=? AND scope_id=?', 'project', dead.id), 0);
    assert.equal(count(db, 'SELECT COUNT(*) n FROM employee_memory WHERE project_id=?', dead.id), 0);
    assert.equal(count(db, 'SELECT COUNT(*) n FROM seams WHERE project_id=?', dead.id), 0);
    assert.equal(count(db, "SELECT COUNT(*) n FROM settings WHERE key='projects.default_id'"), 0, '默认指针清掉');
    // 别的项目不动。
    assert.notEqual(repo.getProject(alive.id), null);
    assert.notEqual(repo.getTask(aliveTask.id), null);
    assert.equal(count(db, 'SELECT COUNT(*) n FROM permission_policies WHERE scope_type=? AND scope_id=?', 'project', alive.id), 1);

    // 有任务的项目即使归档也拒（不做级联）。
    repo.archiveProject(alive.id, 9);
    const nonEmpty = repo.deleteProjectIfEmpty(alive.id);
    assert.equal(nonEmpty.ok, false);
    if (!nonEmpty.ok) assert.equal(nonEmpty.code, 'not_empty');
    assert.notEqual(repo.getTask(aliveTask.id), null, '非空项目不得删任务');
  } finally {
    db.close();
  }
});
