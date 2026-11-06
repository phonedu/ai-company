/**
 * M3-N-3 · GAP7/B3/B6 IPC 面：启停/删除守卫、项目默认技能集校验、`用技能` 命令写事件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertEmployee,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  setSkillEnabled,
  upsertSkill,
  type SqliteDb,
} from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectSkillsSet, handleSkillAction, handleSkillCommand, handleSkillsSet, parseSkillCommand, type IpcDeps } from '../src/main/ipc/ipc.js';

function setup(): { db: SqliteDb; deps: IpcDeps; taskId: number; projectId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-skill-ipc-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 1, name: '实施', role: 'engineer', skills: [], now: 1 });
  const projectId = Number(
    db
      .prepare('INSERT INTO projects(name, root_dir, default_skills, created_at) VALUES(?, ?, ?, 1)')
      .run('P', join(dir, 'project'), JSON.stringify([])).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
  const repo = createSqliteChatRepo(db);
  const skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return {
    db,
    deps: { repo, db, skillsDir: () => skillsDir, now: () => 100 },
    taskId: task.id,
    projectId,
    dir,
  };
}

function addSkill(db: SqliteDb, dir: string, name: string): { id: number; path: string } {
  const d = join(dir, 'src', name);
  mkdirSync(d, { recursive: true });
  const path = join(d, 'SKILL.md');
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 用途\n---\n\nBODY_${name}\n`, 'utf8');
  const row = upsertSkill(db, { name, description: `${name} 用途`, source: 'local', path, now: 1 });
  return { id: row.id, path };
}

test('B6 命令：parse 用技能/取消；写 task_skill_forced 并回执（查无/停用显式拒）', () => {
  const { db, deps, taskId, dir } = setup();
  try {
    assert.deepEqual(parseSkillCommand('用技能 fact-check T-1001'), { shortId: 'T-1001', skill: 'fact-check' });
    assert.deepEqual(parseSkillCommand('取消技能 #T1001'), { shortId: 'T-1001', skill: null });
    assert.deepEqual(parseSkillCommand('强制技能 fact-check T1001'), { shortId: 'T-1001', skill: 'fact-check' });
    assert.equal(parseSkillCommand('普通聊天'), null);

    const skill = addSkill(db, dir, 'fact-check');
    const res = handleSkillCommand(deps, { shortId: 'T-1001', skill: 'fact-check' }, '用技能 fact-check T-1001', [], 10);
    assert.ok(res);
    const events = listTaskEvents(db, taskId).filter((e) => e.kind === 'task_skill_forced');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.payload), { skill: 'fact-check' });

    const cleared = handleSkillCommand(deps, { shortId: 'T-1001', skill: null }, '取消技能 T-1001', [], 11);
    assert.ok(cleared);
    const last = listTaskEvents(db, taskId).filter((e) => e.kind === 'task_skill_forced').at(-1);
    assert.deepEqual(JSON.parse(last!.payload), { skill: null });

    const missing = handleSkillCommand(deps, { shortId: 'T-1001', skill: 'nope' }, '用技能 nope T-1001', [], 12);
    assert.ok(missing);
    setSkillEnabled(db, skill.id, false);
    const disabled = handleSkillCommand(deps, { shortId: 'T-1001', skill: 'fact-check' }, '用技能 fact-check T-1001', [], 13);
    assert.ok(disabled);
    // 拒绝不写新事件。
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'task_skill_forced').length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAP7 启停/删除守卫：内置不可删；被引用拒删；本地可停用再删', async () => {
  const { db, deps, projectId, dir } = setup();
  try {
    const local = addSkill(db, dir, 'local-skill');
    const toggled = await handleSkillAction(deps, { action: 'toggle', id: local.id, enabled: false }, 10);
    assert.equal(toggled.ok, true);
    assert.equal((toggled as { skill: { enabled: number } }).skill.enabled, 0);

    db.prepare("UPDATE employees SET skills = ? WHERE id = 1").run(JSON.stringify(['local-skill']));
    const inUse = await handleSkillAction(deps, { action: 'remove', id: local.id }, 11);
    assert.equal(inUse.ok, false);
    assert.equal(!inUse.ok && inUse.code, 'in_use');

    db.prepare("UPDATE employees SET skills = '[]' WHERE id = 1").run();
    const removed = await handleSkillAction(deps, { action: 'remove', id: local.id }, 12);
    assert.equal(removed.ok, true);

    upsertSkill(db, { name: 'builtin-x', description: 'x', source: 'builtin', path: join(dir, 'builtin-x', 'SKILL.md'), now: 1 });
    const builtin = (db.prepare("SELECT id FROM skills WHERE name = 'builtin-x'").get() as { id: number }).id;
    const refused = await handleSkillAction(deps, { action: 'remove', id: builtin }, 13);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, 'builtin');
    mkdirSync(join(dir, 'builtin-x'), { recursive: true });
    writeFileSync(join(dir, 'builtin-x', 'SKILL.md'), '# x\n', 'utf8');
    const overwrite = handleSkillsSet(deps, { name: 'builtin-x', path: join(dir, 'builtin-x', 'SKILL.md'), description: 'x' });
    assert.equal(overwrite.ok, false);
    assert.equal(!overwrite.ok && overwrite.code, 'builtin', '旧注册口也不得覆盖内置');

    // 未接线：安装显式拒。
    const noDir = await handleSkillAction({ ...deps, skillsDir: undefined }, { action: 'install-local' }, 14);
    assert.equal(noDir.ok, false);
    assert.equal(!noDir.ok && noDir.code, 'install_unavailable');
    void projectId;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3 项目默认技能集：只收启用项；未知/停用显式拒；成功落 projects.default_skills', async () => {
  const { db, deps, projectId, dir } = setup();
  try {
    const a = addSkill(db, dir, 'a-skill');
    addSkill(db, dir, 'b-skill');
    setSkillEnabled(db, a.id, false);
    const bad = handleProjectSkillsSet(deps, { projectId, refs: ['a-skill'] });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.code, 'unknown_skill');
    const good = handleProjectSkillsSet(deps, { projectId, refs: ['b-skill'] });
    assert.equal(good.ok, true);
    assert.deepEqual(
      JSON.parse((db.prepare('SELECT default_skills FROM projects WHERE id=?').get(projectId) as { default_skills: string }).default_skills),
      ['b-skill'],
    );
    const unknownProject = handleProjectSkillsSet(deps, { projectId: 999, refs: [] });
    assert.equal(unknownProject.ok, false);
    assert.equal(!unknownProject.ok && unknownProject.code, 'not_found');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
