/**
 *  联动修复 P1：company.json apply 不得绕过项目模型白名单/引用校验。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { applyCompanyConfig, buildCompanyConfig } from '../src/main/company/config.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(1, 'E', 'engineer', 1)").run();
  db.prepare(
    `INSERT INTO projects(name, root_dir, allowed_providers, default_owner_id, created_at)
     VALUES('P', 'C:/p', '["deepseek"]', 1, 1)`,
  ).run();
  return db;
}

test('模型在项目白名单外 → 整体拒（不落库）', () => {
  const db = setup();
  try {
    const cfg = buildCompanyConfig(db, 1);
    cfg.employees[0]!.model = 'openai/gpt-4o';
    const res = applyCompanyConfig(db, cfg, 2);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /白名单/);
    const row = db.prepare('SELECT model FROM employees WHERE id = 1').get() as { model: string | null } | undefined;
    assert.equal(row?.model ?? null, null);
  } finally {
    db.close();
  }
});

test('白名单内模型放行；悬空技能/MCP 整体拒', () => {
  const db = setup();
  try {
    const cfg = buildCompanyConfig(db, 1);
    cfg.employees[0]!.model = 'deepseek/deepseek-v4-pro';
    assert.equal(applyCompanyConfig(db, cfg, 2).ok, true);
    assert.equal(
      (db.prepare('SELECT model FROM employees WHERE id = 1').get() as { model: string }).model,
      'deepseek/deepseek-v4-pro',
    );

    const bad = buildCompanyConfig(db, 1);
    bad.employees[0]!.skills = ['missing-skill'];
    const res = applyCompanyConfig(db, bad, 3);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /技能不存在/);
  } finally {
    db.close();
  }
});
