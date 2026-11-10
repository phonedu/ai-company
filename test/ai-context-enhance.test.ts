/**
 *  / 11 / 12：技能注入、同项目轻量检索、few-shot 模板——真库断言：
 *  - 注册技能（文件必须存在）→ 员工勾选 → 会话 system 段出现 `[技能索引]`（全文按需 load_skill）；
 *  - 同项目历史（记忆/事件/产物）命中 → `[历史检索]`；无命中不注入空段；
 *  - few-shot 缺省开、显式 `prompt.fewShot=false` 关；
 *  - 开关写入设置表，上下文 meta 如实标 true/false。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMemory,
  insertArtifact,
  insertEmployee,
  openMemoryDatabase,
  runMigrations,
  upsertSkill,
  writeSetting,
  type SqliteDb,
} from '../src/main/db/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { handleSkillsSet, type IpcDeps } from '../src/main/ipc/ipc.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; dir: string; skillPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-ai9-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(1, '甲项目', 'D:/repo', 1)").run();
  db.prepare(
    "INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, created_at, updated_at) VALUES(1, 'T-1001', 1, '修渲染', '让 tab 正确显示（修渲染）', '[]', 'executing', 1, 1)",
  ).run();
  insertEmployee(db, { id: 7, name: '林悦', role: 'engineer', now: 1 });
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, '# 前端修复技能\n先复现，再最小改动，最后跑测试。\n', 'utf8');
  return { db, dir, skillPath };
}

test('OPT-AI-9：注册技能（文件必须存在）→ 员工勾选 → 会话出现 [技能索引]（全文按需）', () => {
  const { db, dir, skillPath } = setup();
  const deps = { repo: createSqliteChatRepo(db) } as IpcDeps;
  const missing = handleSkillsSet(deps, { name: 'ghost', path: join(dir, 'nope.md') });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, 'missing_file');

  const registered = handleSkillsSet(deps, { name: 'frontend-fix', path: skillPath, description: '前端修复' });
  assert.equal(registered.ok, true);

  db.prepare("UPDATE employees SET skills = '[\"frontend-fix\"]' WHERE id = 7").run();
  const ctx = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.ok(ctx.systemPrompt.includes('[技能索引]'), 'GAP7：只注入索引');
  assert.ok(ctx.systemPrompt.includes('frontend-fix'), '索引含技能名');
  assert.equal(ctx.systemPrompt.includes('先复现，再最小改动'), false, '全文不注入（load_skill 按需读）');
  assert.equal(ctx.meta.layers.skills, true);
  assert.deepEqual((ctx.meta.skillRefs ?? []).map((s) => s.name), ['frontend-fix']);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OPT-AI-11：同项目记忆/产物命中 → [历史检索]；关开关后不注入', () => {
  const { db, dir } = setup();
  appendMemory(db, {
    employeeId: 7,
    projectId: 1,
    block: '[任务 T-0900] 修渲染时发现 tab 需要先复现',
    marker: '[任务 T-0900]',
    now: 2,
  });
  insertArtifact(db, { taskId: 1, path: 'docs/修渲染笔记.md', kind: 'file', note: '修渲染', sha256: null, now: 3 });

  const on = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.ok(on.systemPrompt.includes('[历史检索]（同项目相关片段'), '开启时注入检索段');
  assert.ok(on.systemPrompt.includes('修渲染时发现 tab'), '记忆命中');
  assert.equal(on.meta.layers.retrieval, true);

  writeSetting(db, 'memory.retrieval', false);
  const off = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.equal(off.systemPrompt.includes('[历史检索]'), false, '显式关闭 → 不注入');
  assert.equal(off.meta.layers.retrieval, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OPT-AI-12：few-shot 缺省开；显式 false 关（meta 如实）', () => {
  const { db, dir } = setup();
  const on = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.ok(on.systemPrompt.includes('[示例模板 · employee]'));
  assert.equal(on.meta.layers.fewShot, true);

  writeSetting(db, 'prompt.fewShot', false);
  const off = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.equal(off.systemPrompt.includes('[示例模板 · employee]'), false);
  assert.equal(off.meta.layers.fewShot, false);

  writeSetting(db, 'prompt.fewShot', true);
  const back = buildEmployeeContext(db, { employeeId: 7, taskId: 1 });
  assert.ok(back.systemPrompt.includes('[示例模板 · employee]'), '开关可回开');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
