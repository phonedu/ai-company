/**
 *  · 按需披露 / 强制技能 / load_skill 白名单。
 *
 * - 正常技能只进「技能索引」（name+description），全文不注入；
 * - 员工只看到自己勾选 ∪ 项目默认（别人的技能不出现）；
 * - `task_skill_forced`（最后一条）→ 全文注入；停用/文件缺失 → 显式「不可用」；
 * - `load_skill` 只读本会话白名单，越权显式错误。
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
  insertTaskEvent,
  openMemoryDatabase,
  runMigrations,
  getSkillByName,
  setProjectDefaultSkills,
  setSkillEnabled,
  upsertSkill,
  type SqliteDb,
} from '../src/main/db/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { clearSessionSkillRefs, createLoadSkillTool, setSessionSkillRefs } from '../src/main/agent/skill-tool.js';

function setup(): { db: SqliteDb; taskId: number; projectId: number; dir: string; paths: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-skill-ctx-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 1, name: '实施', role: 'engineer', skills: ['employee-skill'], now: 1 });
  insertEmployee(db, { id: 2, name: '别人', role: 'writer', skills: ['other-skill'], now: 1 });
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  const projectId = Number(
    db
      .prepare('INSERT INTO projects(name, root_dir, default_skills, created_at) VALUES(?, ?, ?, 1)')
      .run('P', root, JSON.stringify(['project-skill'])).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });

  const paths: Record<string, string> = {};
  for (const [name, body] of [
    ['employee-skill', 'BODY_EMPLOYEE'],
    ['project-skill', 'BODY_PROJECT'],
    ['other-skill', 'BODY_OTHER'],
    ['forced-skill', 'BODY_FORCED'],
  ] as const) {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    const p = join(d, 'SKILL.md');
    writeFileSync(
      p,
      `---\nname: ${name}\ndescription: ${name} 的用途\n---\n\n${body}\n`,
      'utf8',
    );
    upsertSkill(db, { name, description: `${name} 的用途`, source: 'local', path: p, now: 2 });
    paths[name] = p;
  }
  return { db, taskId: task.id, projectId, dir, paths };
}

test('GAP7 按需披露：只有员工∪项目默认进索引；全文不注入；别人的技能不可见', () => {
  const { db, taskId, dir } = setup();
  try {
    const ctx = buildEmployeeContext(db, { employeeId: 1, taskId });
    assert.match(ctx.systemPrompt, /\[技能索引\]/);
    assert.match(ctx.systemPrompt, /employee-skill/);
    assert.match(ctx.systemPrompt, /project-skill/);
    assert.doesNotMatch(ctx.systemPrompt, /BODY_EMPLOYEE|BODY_PROJECT/, '全文只在 load_skill 时读');
    assert.doesNotMatch(ctx.systemPrompt, /other-skill|BODY_OTHER/, '不出现别人的技能');
    assert.deepEqual((ctx.meta.skillRefs ?? []).map((s) => s.name).sort(), ['employee-skill', 'project-skill']);
    assert.equal(ctx.meta.forcedSkill, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B6 强制技能：事件最后一条为准；全文注入；清除/停用显式；规划/评审上下文同源', () => {
  const { db, taskId, projectId, dir } = setup();
  try {
    insertTaskEvent(db, {
      taskId,
      ts: 10,
      kind: 'task_skill_forced',
      actor: 'boss',
      payload: { skill: 'forced-skill' },
    });
    const ctx = buildEmployeeContext(db, { employeeId: 1, taskId });
    assert.match(ctx.systemPrompt, /\[强制技能：forced-skill\]/);
    assert.match(ctx.systemPrompt, /BODY_FORCED/);
    assert.equal(ctx.meta.forcedSkill, 'forced-skill');
    assert.ok((ctx.meta.skillRefs ?? []).some((s) => s.name === 'forced-skill'), '强制技能也进 load_skill 白名单');

    // 清除：最后一条 skill:null 不再注入。
    insertTaskEvent(db, { taskId, ts: 11, kind: 'task_skill_forced', actor: 'boss', payload: { skill: null } });
    const cleared = buildEmployeeContext(db, { employeeId: 1, taskId });
    assert.doesNotMatch(cleared.systemPrompt, /BODY_FORCED|\[强制技能：forced-skill\]/);
    assert.equal(cleared.meta.forcedSkill, null);

    // 停用后强制 → 显式不可用（不注入全文）。
    const forced = getSkillByName(db, 'forced-skill');
    assert.ok(forced);
    setSkillEnabled(db, forced!.id, false);
    insertTaskEvent(db, { taskId, ts: 13, kind: 'task_skill_forced', actor: 'boss', payload: { skill: 'forced-skill' } });
    const disabled = buildEmployeeContext(db, { employeeId: 1, taskId });
    assert.match(disabled.systemPrompt, /\[强制技能不可用\].*forced-skill/);
    assert.doesNotMatch(disabled.systemPrompt, /BODY_FORCED/);

    // 项目默认技能集真值参与索引。
    setProjectDefaultSkills(db, projectId, ['project-skill', 'employee-skill']);
    assert.equal(buildEmployeeContext(db, { employeeId: 1, taskId }).meta.skillRefs?.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load_skill：只读本会话白名单；未分配技能显式错误', async () => {
  const { db, dir, paths } = setup();
  try {
    void db;
    const tool = await createLoadSkillTool();
    setSessionSkillRefs('session-a', [
      { name: 'employee-skill', description: 'x', path: paths['employee-skill']! },
    ]);
    const ok = await tool.execute(
      'call-1',
      { name: 'employee-skill' },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 'session-a' } } as never,
    );
    assert.equal((ok.details as { loaded: boolean }).loaded, true);
    assert.match((ok.content[0] as { text: string }).text, /BODY_EMPLOYEE/);

    const denied = await tool.execute(
      'call-2',
      { name: 'other-skill' },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 'session-a' } } as never,
    );
    assert.equal(denied.isError, true);
    assert.match((denied.content[0] as { text: string }).text, /不能加载别人的技能/);

    // 换会话后名单隔离。
    setSessionSkillRefs('session-b', []);
    const empty = await tool.execute(
      'call-3',
      { name: 'employee-skill' },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 'session-b' } } as never,
    );
    assert.equal(empty.isError, true);
  } finally {
    clearSessionSkillRefs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
