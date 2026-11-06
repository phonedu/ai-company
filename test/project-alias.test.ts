/**
 * 验收后复查 A：项目别名写入口。新建项目/既有项目都能设别名，`#别名` 解析才有对象。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getProjectByAlias, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectAliasSet, normalizeProjectAlias } from '../src/main/ipc/ipc.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, repo };
}

test('别名归一：中文/数字/下划线/连字符通过；空格/#/路径拒绝；空串=清空', () => {
  assert.deepEqual(normalizeProjectAlias('记账'), { ok: true, alias: '记账' });
  assert.deepEqual(normalizeProjectAlias('  book-1 '), { ok: true, alias: 'book-1' });
  assert.deepEqual(normalizeProjectAlias(''), { ok: true, alias: null });
  assert.equal(normalizeProjectAlias('bad alias').ok, false);
  assert.equal(normalizeProjectAlias('#记账').ok, false);
  assert.equal(normalizeProjectAlias('a/b').ok, false);
});

test('project:alias-set：新项目可设别名并被 #别名 解析；重复/非法拒；清空后不可解析', () => {
  const { db, repo } = setup();
  try {
    const p1 = repo.createProject({ name: 'P1', rootDir: 'D:/p1', accessMode: 'staging', now: 1 });
    const p2 = repo.createProject({ name: 'P2', rootDir: 'D:/p2', accessMode: 'staging', now: 1 });
    const deps = { repo };

    const set = handleProjectAliasSet(deps, { projectId: p1.id, alias: '新项目' });
    assert.equal(set.ok, true);
    if (!set.ok) return;
    assert.equal(set.project.alias, '新项目');
    assert.equal(getProjectByAlias(db, '新项目')?.id, p1.id, '#别名 解析到新项目');

    const dup = handleProjectAliasSet(deps, { projectId: p2.id, alias: '新项目' });
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.code, 'alias_taken');

    const bad = handleProjectAliasSet(deps, { projectId: p2.id, alias: 'bad alias' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, 'bad_request');

    const clear = handleProjectAliasSet(deps, { projectId: p1.id, alias: '' });
    assert.equal(clear.ok, true);
    if (clear.ok) assert.equal(clear.project.alias, null);
    assert.equal(getProjectByAlias(db, '新项目'), null);
  } finally {
    db.close();
  }
});
