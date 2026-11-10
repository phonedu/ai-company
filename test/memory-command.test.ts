/**
 * B-6· 频道记忆命令：解析 + 直通写库（默认项目/全局/忘记/提升/列表/搜索）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMemoryCommand, parseMemoryCommand } from '../src/main/ipc/ipc.js';
import { handleMemoryManage } from '../src/main/ipc/memory.js';

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: 'P', rootDir: 'D:/p', accessMode: 'inplace', now: 1 });
  return { db, repo, projectId: project.id };
}

const lastOut = (repo: ReturnType<typeof createSqliteChatRepo>): string => {
  const row = repo.listMessages({ limit: 1, latest: true })[0];
  return row && row.direction === 'out' ? row.content : '';
};

test('B-6 命令解析：记住/列表/搜索/忘记/提升；非法输入落回聊天', () => {
  assert.deepEqual(parseMemoryCommand('记住 对账用万元'), { kind: 'remember', scope: 'project', value: '对账用万元' });
  assert.deepEqual(parseMemoryCommand('记住全局 输出简洁中文'), { kind: 'remember', scope: 'global', value: '输出简洁中文' });
  assert.deepEqual(parseMemoryCommand('记忆列表'), { kind: 'list', scope: 'project' });
  assert.deepEqual(parseMemoryCommand('记忆列表 全局'), { kind: 'list', scope: 'global' });
  assert.deepEqual(parseMemoryCommand('搜索记忆 万元'), { kind: 'search', scope: 'project', text: '万元' });
  assert.deepEqual(parseMemoryCommand('搜索记忆 全局 简洁'), { kind: 'search', scope: 'global', text: '简洁' });
  assert.deepEqual(parseMemoryCommand('忘记记忆 12'), { kind: 'forget', id: 12 });
  assert.deepEqual(parseMemoryCommand('提升记忆 12'), { kind: 'promote', id: 12 });
  assert.equal(parseMemoryCommand('记住'), null);
  assert.equal(parseMemoryCommand('忘记记忆 0'), null);
  assert.equal(parseMemoryCommand('提升记忆 x'), null);
});

test('B-6 命令直通：默认项目记住/列表/忘记；全局记住不依赖默认项目', async () => {
  const { db, repo, projectId } = setup();
  try {
    repo.setSetting({ key: 'projects.default_id', value: projectId });
    const deps = { repo, db };
    const remembered = await handleMemoryCommand(
      deps,
      { kind: 'remember', scope: 'project', value: '对账用万元' },
      '记住 对账用万元',
      [],
      100,
    );
    assert.equal(remembered.ok, true);
    assert.match(lastOut(repo), /已记住 #\d+/);

    const list = await handleMemoryCommand(deps, { kind: 'list', scope: 'project' }, '记忆列表', [], 101);
    assert.equal(list.ok, true);
    assert.match(lastOut(repo), /对账用万元/);

    const global = await handleMemoryCommand(
      deps,
      { kind: 'remember', scope: 'global', value: '输出简洁中文' },
      '记住全局 输出简洁中文',
      [],
      102,
    );
    assert.equal(global.ok, true);
    const globalList = await handleMemoryCommand(deps, { kind: 'list', scope: 'global' }, '记忆列表 全局', [], 103);
    assert.equal(globalList.ok, true);
    assert.match(lastOut(repo), /输出简洁中文/);

    const search = await handleMemoryCommand(
      deps,
      { kind: 'search', scope: 'project', text: '万元' },
      '搜索记忆 万元',
      [],
      104,
    );
    assert.equal(search.ok, true);
    assert.match(lastOut(repo), /对账用万元/);

    const items = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 105);
    assert.equal(items.ok, true);
    if (!items.ok || items.action !== 'list') return assert.fail('list failed');
    const id = items.items[0]!.id;
    const forget = await handleMemoryCommand(deps, { kind: 'forget', id }, `忘记记忆 ${id}`, [], 106);
    assert.equal(forget.ok, true);
    assert.match(lastOut(repo), /软归档/);
    const after = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 107);
    if (after.ok && after.action === 'list') assert.deepEqual(after.items, []);
  } finally {
    db.close();
  }
});

test('F-3 B-3：频道记忆命令优先当前项目（不写默认项目）；不能跨项目忘记', async () => {
  const { db, repo, projectId } = setup();
  try {
    const other = repo.createProject({ name: 'Q', rootDir: 'D:/q', accessMode: 'inplace', now: 2 });
    repo.setSetting({ key: 'projects.default_id', value: projectId });
    const deps = { repo, db };
    const remembered = await handleMemoryCommand(
      deps,
      { kind: 'remember', scope: 'project', value: 'B 项目事实' },
      '记住 B 项目事实',
      [],
      300,
      other.id,
    );
    assert.equal(remembered.ok, true);
    assert.match(lastOut(repo), new RegExp(`项目 #${other.id}`));

    const listOther = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId: other.id }, 301);
    assert.equal(listOther.ok, true);
    if (listOther.ok && listOther.action === 'list') {
      assert.ok(listOther.items.some((item) => item.value === 'B 项目事实'), '必须写进当前项目');
    }
    const listDefault = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 302);
    if (listDefault.ok && listDefault.action === 'list') {
      assert.equal(listDefault.items.some((item) => item.value === 'B 项目事实'), false, '不得写进默认项目');
    }

    // 当前项目不能忘记/提升别的项目的记忆。
    const own = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, value: 'A 项目事实', kind: 'fact' },
      303,
    );
    if (!own.ok || own.action !== 'remember') return assert.fail('remember failed');
    const forbidden = await handleMemoryCommand(
      deps,
      { kind: 'forget', id: own.item.id },
      `忘记记忆 ${own.item.id}`,
      [],
      304,
      other.id,
    );
    assert.equal(forbidden.ok, true);
    assert.match(lastOut(repo), /不属于当前项目/);
    const still = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 305);
    if (still.ok && still.action === 'list') {
      assert.ok(still.items.some((item) => item.id === own.item.id), '跨项目忘记必须被拒绝');
    }
  } finally {
    db.close();
  }
});

test('B-6 命令：无默认项目时项目写/列显式拒；提升走老板显式确认', async () => {
  const { db, repo, projectId } = setup();
  try {
    const deps = { repo, db };
    const noDefault = await handleMemoryCommand(
      deps,
      { kind: 'remember', scope: 'project', value: 'x' },
      '记住 x',
      [],
      200,
    );
    assert.equal(noDefault.ok, true);
    assert.match(lastOut(repo), /未设置默认项目/);

    const created = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, key: 'k', value: '项目事实', kind: 'fact' },
      201,
    );
    assert.equal(created.ok, true);
    if (!created.ok || created.action !== 'remember') return assert.fail('remember failed');
    const promoted = await handleMemoryCommand(deps, { kind: 'promote', id: created.item.id }, `提升记忆 ${created.item.id}`, [], 202);
    assert.equal(promoted.ok, true);
    assert.match(lastOut(repo), /已提升记忆/);
    const global = handleMemoryManage(deps, { action: 'list', scope: 'global' }, 203);
    if (global.ok && global.action === 'list') {
      assert.ok(global.items.some((item) => item.value === '项目事实'), '提升后全局可见');
    }
  } finally {
    db.close();
  }
});
