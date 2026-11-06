/**
 * M3-N-3 · GAP7/B1：技能解析、内置包、本地/URL 安装、启停/删除。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  insertEmployee,
  listSkills,
  openMemoryDatabase,
  runMigrations,
  setSkillEnabled,
  getSkillByName,
  type SqliteDb,
} from '../src/main/db/index.js';
import { assignBuiltinSkillsToAssistantIfEmpty, BUILTIN_SKILL_NAMES, ensureBuiltinSkills } from '../src/main/agent/builtin-skills.js';
import { installSkillsFromDirectory, installSkillsFromUrl, parseSkillMarkdown } from '../src/main/agent/skill-install.js';

function freshDb(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aico-skills-'));
}

const SKILL = (name: string, body = 'BODY'): string => `---
name: ${name}
description: ${name} 的用途
---

# ${name}

${body}
`;

test('parseSkillMarkdown：合法 frontmatter；坏 name/空 description/无 frontmatter 显式拒', () => {
  const ok = parseSkillMarkdown(SKILL('my-skill'));
  assert.equal(ok.name, 'my-skill');
  assert.equal(ok.description, 'my-skill 的用途');
  assert.equal(ok.body.includes('BODY'), true);
  assert.throws(() => parseSkillMarkdown('# no frontmatter'), /frontmatter/);
  assert.throws(() => parseSkillMarkdown('---\nname: Bad_Name\ndescription: x\n---\n'), /name 非法/);
  assert.throws(() => parseSkillMarkdown('---\nname: ok\ndescription: \n---\n'), /description 不能为空/);
});

test('B1 内置技能包：三个内置落盘/登记；重跑保留停用状态；新库默认勾给幕僚长', () => {
  const dir = tmp();
  const db = freshDb();
  try {
    insertEmployee(db, { id: 0, name: '幕僚长', role: 'assistant', isAssistant: true, now: 1 });
    const first = ensureBuiltinSkills(db, join(dir, 'skills'), 1);
    assert.equal(first.length, 3);
    assert.deepEqual(first.map((r) => r.name).sort(), [...BUILTIN_SKILL_NAMES].sort());
    for (const row of first) {
      assert.equal(row.source, 'builtin');
      assert.ok(existsSync(row.path), `${row.name} 的 SKILL.md 应落盘`);
      assert.match(readFileSync(row.path, 'utf8'), /^---\nname: /);
    }
    assert.equal(assignBuiltinSkillsToAssistantIfEmpty(db), true, '空技能表的幕僚长默认勾内置');
    assert.deepEqual(
      JSON.parse((db.prepare('SELECT skills FROM employees WHERE id=0').get() as { skills: string }).skills),
      [...BUILTIN_SKILL_NAMES],
    );
    assert.equal(assignBuiltinSkillsToAssistantIfEmpty(db), false, '已有配置不覆盖');

    const one = first[0]!;
    setSkillEnabled(db, one.id, false);
    const second = ensureBuiltinSkills(db, join(dir, 'skills'), 2);
    assert.equal(second.find((r) => r.name === one.name)?.enabled, 0, '升级内置包保留老板的停用选择');
    assert.equal(listSkills(db).some((r) => r.name === one.name), false, '停用后默认列表不含');
    assert.equal(listSkills(db, { includeDisabled: true }).some((r) => r.name === one.name), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本地安装：复制整个技能目录（含 assets）；重跑不重复；与内置重名显式拒', () => {
  const dir = tmp();
  const db = freshDb();
  try {
    insertEmployee(db, { id: 0, name: '幕僚长', role: 'assistant', isAssistant: true, now: 1 });
    ensureBuiltinSkills(db, join(dir, 'skills'), 1);
    const source = join(dir, 'source', 'team-style');
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(source, '.git', 'objects'), { recursive: true });
    writeFileSync(join(source, '.git', 'config'), 'not-a-skill', 'utf8');
    writeFileSync(join(source, 'SKILL.md'), SKILL('team-style', 'TEAM_BODY'), 'utf8');
    writeFileSync(join(source, 'assets', 'note.txt'), 'asset', 'utf8');

    const res = installSkillsFromDirectory({ db, sourceDir: join(dir, 'source'), installRoot: join(dir, 'skills'), now: 2 });
    assert.equal(res.installed.length, 1);
    const row = getSkillByName(db, 'team-style');
    assert.ok(row);
    assert.equal(row!.source, 'local');
    assert.ok(readFileSync(row!.path, 'utf8').includes('TEAM_BODY'));
    assert.equal(readFileSync(join(dirnameOf(row!.path), 'assets', 'note.txt'), 'utf8'), 'asset', 'assets 随目录复制');
    assert.equal(existsSync(join(dirnameOf(row!.path), '.git')), false, 'Git 元数据不得复制进技能目录（Windows 只读对象会破坏后续清理）');
    assert.equal(row!.enabled, 1);

    // 同源重装：同一行（name 唯一）不新增。
    installSkillsFromDirectory({ db, sourceDir: join(dir, 'source'), installRoot: join(dir, 'skills'), now: 3 });
    assert.equal(listSkills(db, { includeDisabled: true }).filter((r) => r.name === 'team-style').length, 1);

    // 与内置重名 → 拒（内置不可覆盖）。
    const clash = join(dir, 'clash', 'fact-check');
    mkdirSync(clash, { recursive: true });
    writeFileSync(join(clash, 'SKILL.md'), SKILL('fact-check', 'CLASH'), 'utf8');
    assert.throws(
      () => installSkillsFromDirectory({ db, sourceDir: join(dir, 'clash'), installRoot: join(dir, 'skills'), now: 4 }),
      /内置技能重名/,
    );
    assert.match(readFileSync(getSkillByName(db, 'fact-check')!.path, 'utf8'), /事实核查/, '内置内容未被覆盖');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function dirnameOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return file.slice(0, i);
}

test('URL 安装：直接 SKILL.md 下载并登记（source=url:<url>）', async () => {
  const dir = tmp();
  const db = freshDb();
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.end(SKILL('web-skill', 'WEB_BODY'));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/SKILL.md`;
    const res = await installSkillsFromUrl({ db, url, installRoot: join(dir, 'skills'), now: 5 });
    assert.equal(res.installed.length, 1);
    const row = getSkillByName(db, 'web-skill');
    assert.ok(row);
    assert.equal(row!.source, `url:${url}`);
    assert.ok(readFileSync(row!.path, 'utf8').includes('WEB_BODY'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
