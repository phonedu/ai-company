/**
 *  ·：公司配置版本化（export → preview diff → apply → rollback）＋非法配置拒。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertEmployee,
  insertWorkItem,
  openMemoryDatabase,
  readSetting,
  runMigrations,
  upsertMcpServer,
  writeSetting,
  type SqliteDb,
} from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleCompanyConfig, type CompanyConfigResult } from '../src/main/ipc/company.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import {
  COMPANY_CONFIG_RELATIVE,
  buildCompanyConfig,
  validateCompanyConfig,
} from '../src/main/company/config.js';

function setup(): { db: SqliteDb; deps: IpcDeps; projectId: number; root: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-company-'));
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 0, name: '幕僚长', role: 'assistant', isAssistant: true, now: 1 });
  insertEmployee(db, { id: 1, name: '小林', role: 'engineer', thinking: 'medium', mcps: ['fs'], now: 1 });
  upsertMcpServer(db, {
    name: 'fs',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', ''],
    env: { TOKEN: 'company-secret' },
    now: 1,
  });
  writeSetting(db, 'models.default', 'deepseek/deepseek-v4-pro');
  writeSetting(db, 'notify.digestAtMinutes', 540);
  const projectId = Number(
    db
      .prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, 1)')
      .run('P', root).lastInsertRowid,
  );
  const repo = createSqliteChatRepo(db);
  return { db, deps: { repo, db, now: () => 100 }, projectId, root, dir };
}

function ok<T extends CompanyConfigResult>(res: T): Extract<T, { ok: true }> {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res as Extract<T, { ok: true }>;
}

function configFile(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, COMPANY_CONFIG_RELATIVE), 'utf8')) as Record<string, unknown>;
}

test('GAP9：导出不含凭据/通知偏好；preview diff；apply 落库；rollback 恢复并撤销新增', () => {
  const { db, deps, projectId, root, dir } = setup();
  try {
    const exported = ok(handleCompanyConfig(deps, { projectId, action: 'export' }, 100));
    assert.equal(exported.path, COMPANY_CONFIG_RELATIVE);
    assert.equal(exported.employees, 2);
    const text = readFileSync(join(root, COMPANY_CONFIG_RELATIVE), 'utf8');
    assert.equal(text.includes('company-secret'), false, 'MCP env 值不得进配置');
    const cfg = configFile(root);
    assert.equal((cfg.settings as Record<string, unknown>)['models.default'], 'deepseek/deepseek-v4-pro');
    assert.equal('notify.digestAtMinutes' in (cfg.settings as object), false, '通知偏好不随仓库走');
    assert.equal(JSON.stringify(cfg.employees).includes('"fs"'), true);

    // 修改文件：新增员工 + 改角色 + 改/加设置
    const raw = configFile(root) as {
      employees: Array<Record<string, unknown>>;
      settings: Record<string, unknown>;
    };
    raw.employees.push({
      name: '阿新',
      role: 'writer',
      persona: '新同事',
      model: null,
      thinking: 'low',
      skills: [],
      mcps: [],
      capabilityTier: 'standard',
      active: true,
      isAssistant: false,
    });
    raw.employees[1]!.role = 'senior-engineer';
    raw.settings['models.default'] = 'deepseek/deepseek-flash';
    raw.settings['scheduler.maxActiveTasks'] = 5;
    writeFileSync(join(root, COMPANY_CONFIG_RELATIVE), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const preview = ok(handleCompanyConfig(deps, { projectId, action: 'preview' }, 101));
    assert.deepEqual(preview.diff!.added, ['阿新']);
    assert.ok(preview.diff!.updated.some((u) => u.name === '小林' && 'role' in u.changes));
    assert.ok(preview.diff!.settings.updated.includes('models.default'));
    assert.ok(preview.diff!.settings.added.includes('scheduler.maxActiveTasks'));
    assert.match(preview.token!, /^[0-9a-f]{64}$/);

    // token 过期：预览后改文件 → apply 拒
    const raw2 = configFile(root) as { employees: Array<Record<string, unknown>> };
    raw2.employees[1]!.persona = 'preview 后被改';
    writeFileSync(join(root, COMPANY_CONFIG_RELATIVE), `${JSON.stringify(raw2, null, 2)}\n`, 'utf8');
    const stale = handleCompanyConfig(deps, { projectId, action: 'apply', token: preview.token }, 102);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.code, 'stale_config');

    const preview2 = ok(handleCompanyConfig(deps, { projectId, action: 'preview' }, 103));
    const applied = ok(handleCompanyConfig(deps, { projectId, action: 'apply', token: preview2.token }, 104));
    assert.deepEqual(applied.applied!.added, ['阿新']);
    assert.deepEqual(applied.applied!.updated, ['小林']);
    assert.equal((db.prepare("SELECT role FROM employees WHERE name='小林'").get() as { role: string }).role, 'senior-engineer');
    assert.equal((db.prepare("SELECT persona FROM employees WHERE name='小林'").get() as { persona: string }).persona, 'preview 后被改');
    assert.ok(db.prepare("SELECT id FROM employees WHERE name='阿新'").get());
    assert.equal(readSetting(db, 'models.default'), 'deepseek/deepseek-flash');
    assert.equal(readSetting(db, 'scheduler.maxActiveTasks'), 5);
    assert.ok(existsSync(join(root, '.aico/company.backup.json')));

    const rolled = ok(handleCompanyConfig(deps, { projectId, action: 'rollback' }, 105));
    assert.equal(rolled.action, 'rollback');
    assert.equal((db.prepare("SELECT role FROM employees WHERE name='小林'").get() as { role: string }).role, 'engineer');
    assert.equal((db.prepare("SELECT id FROM employees WHERE name='阿新'").get() as { id: number } | undefined), undefined);
    assert.equal(readSetting(db, 'models.default'), 'deepseek/deepseek-v4-pro');
    assert.equal(readSetting(db, 'scheduler.maxActiveTasks'), undefined, '回滚撤销本次新增的设置');
    const fileAfter = configFile(root) as { employees: Array<{ name: string }> };
    assert.deepEqual(fileAfter.employees.map((e) => e.name).sort(), ['小林', '幕僚长']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAP9 非法配置整体拒：schema/枚举/白名单/忙碌员工停用；不半应用', () => {
  const { db, deps, projectId, root, dir } = setup();
  try {
    ok(handleCompanyConfig(deps, { projectId, action: 'export' }, 100));
    const bad = configFile(root) as { schema: string; employees: Array<Record<string, unknown>>; settings: Record<string, unknown> };
    bad.schema = 'wrong/1';
    writeFileSync(join(root, COMPANY_CONFIG_RELATIVE), JSON.stringify(bad), 'utf8');
    const badSchema = handleCompanyConfig(deps, { projectId, action: 'preview' }, 101);
    assert.equal(badSchema.ok, false);
    assert.equal(!badSchema.ok && badSchema.code, 'invalid_config');

    bad.schema = 'aico-company/1';
    bad.employees[1]!.capabilityTier = 'root';
    bad.settings['notify.digestAtMinutes'] = 600;
    writeFileSync(join(root, COMPANY_CONFIG_RELATIVE), JSON.stringify(bad), 'utf8');
    const badValues = handleCompanyConfig(deps, { projectId, action: 'preview' }, 102);
    assert.equal(badValues.ok, false);
    assert.equal(!badValues.ok && badValues.code, 'invalid_config');
    assert.ok((badValues.errors ?? []).some((e) => e.includes('capabilityTier')));
    assert.ok((badValues.errors ?? []).some((e) => e.includes('notify.digestAtMinutes')));

    // 忙碌员工不得在配置里停用
    bad.employees[1]!.capabilityTier = 'standard';
    delete bad.settings['notify.digestAtMinutes'];
    bad.employees[1]!.active = false;
    writeFileSync(join(root, COMPANY_CONFIG_RELATIVE), JSON.stringify(bad), 'utf8');
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
    insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    const preview = ok(handleCompanyConfig(deps, { projectId, action: 'preview' }, 103));
    const busy = handleCompanyConfig(deps, { projectId, action: 'apply', token: preview.token! }, 104);
    assert.equal(busy.ok, false);
    assert.equal(!busy.ok && busy.code, 'invalid_config');
    assert.match(!busy.ok ? busy.message : '', /仍有在跑|排队/);
    assert.equal((db.prepare("SELECT active FROM employees WHERE name='小林'").get() as { active: number }).active, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateCompanyConfig：重名/无员工/非对象显式拒；build 不含 MCP env', () => {
  const { db, dir } = setup();
  try {
    const cfg = buildCompanyConfig(db, 1);
    assert.equal(JSON.stringify(cfg).includes('company-secret'), false);
    const bad = { ...cfg, employees: [cfg.employees[0], cfg.employees[0]] };
    const res = validateCompanyConfig(bad);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.errors.some((e) => e.includes('重名')));
    assert.equal(validateCompanyConfig([]).ok, false);
    assert.equal(validateCompanyConfig({ ...cfg, employees: [] }).ok, false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
