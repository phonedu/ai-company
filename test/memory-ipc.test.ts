/**
 * B-6· `memory:manage`：老板显式写 + 作用域 + 冲突 + 提升 + 审计。
 *
 * 只用内存库；不碰真实数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMemoryManage } from '../src/main/ipc/memory.js';

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; projectId: number; otherId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: 'P', rootDir: 'D:/p', accessMode: 'inplace', now: 1 });
  const other = repo.createProject({ name: 'Q', rootDir: 'D:/q', accessMode: 'inplace', now: 1 });
  return { db, repo, projectId: project.id, otherId: other.id };
}

test('B-6: remember/list/update pin/search/forget(archive)/audit —— 项目作用域', () => {
  const { db, repo, projectId, otherId } = setup();
  try {
    const deps = { repo, db };
    const created = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, key: 'billing.unit', value: '对账单以万元为单位', kind: 'decision' },
      100,
    );
    assert.equal(created.ok, true);
    if (!created.ok || created.action !== 'remember') return assert.fail(JSON.stringify(created));
    const id = created.item.id;
    assert.deepEqual(created.item.scope, { type: 'project', projectId });
    assert.equal(created.item.confidence, 'confirmed');
    assert.equal(created.item.source.type, 'boss');

    const listed = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 101);
    assert.equal(listed.ok, true);
    if (listed.ok && listed.action === 'list') {
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0]!.id, id);
    }
    const isolated = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId: otherId }, 102);
    if (isolated.ok && isolated.action === 'list') assert.deepEqual(isolated.items, [], '项目之间不得串记忆');

    const pinned = handleMemoryManage(deps, { action: 'update', id, patch: { pinned: true } }, 103);
    assert.equal(pinned.ok, true);
    if (pinned.ok && pinned.action === 'update') assert.equal(pinned.item.pinned, true);

    const search = handleMemoryManage(deps, { action: 'search', scope: 'project', projectId, text: '万元' }, 104);
    assert.equal(search.ok, true);
    if (search.ok && search.action === 'search') assert.equal(search.hits[0]?.item.id, id);

    const audit = handleMemoryManage(deps, { action: 'audit', scope: 'project', projectId }, 105);
    assert.equal(audit.ok, true);
    if (audit.ok && audit.action === 'audit') {
      assert.equal(audit.audit.total, 1);
      assert.equal(audit.audit.active, 1);
    }

    const forgotten = handleMemoryManage(deps, { action: 'forget', id, mode: 'archive' }, 106);
    assert.equal(forgotten.ok, true);
    const after = handleMemoryManage(deps, { action: 'list', scope: 'project', projectId }, 107);
    if (after.ok && after.action === 'list') assert.deepEqual(after.items, [], '归档默认不可见');
    const archived = handleMemoryManage(
      deps,
      { action: 'list', scope: 'project', projectId, includeArchived: true },
      108,
    );
    if (archived.ok && archived.action === 'list') assert.equal(archived.items.length, 1, 'includeArchived 可见');
  } finally {
    db.close();
  }
});

test('B-6: global 作用域与项目隔离；提升 project → global', () => {
  const { db, repo, projectId } = setup();
  try {
    const deps = { repo, db };
    const global = handleMemoryManage(deps, { action: 'remember', scope: 'global', value: '输出用简洁中文', kind: 'preference' }, 200);
    assert.equal(global.ok, true);
    if (global.ok && global.action === 'remember') assert.deepEqual(global.item.scope, { type: 'global' });

    const project = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, value: '本项目用万元', kind: 'fact' },
      201,
    );
    assert.equal(project.ok, true);
    if (!project.ok || project.action !== 'remember') return assert.fail('project remember failed');

    const promoted = handleMemoryManage(deps, { action: 'promote', id: project.item.id, to: 'global' }, 202);
    assert.equal(promoted.ok, true);
    if (promoted.ok && promoted.action === 'promote') {
      assert.deepEqual(promoted.item.scope, { type: 'global' });
      assert.equal(promoted.item.confidence, 'confirmed');
    }
    const globalList = handleMemoryManage(deps, { action: 'list', scope: 'global' }, 203);
    if (globalList.ok && globalList.action === 'list') {
      assert.equal(globalList.items.filter((i) => i.value === '本项目用万元').length, 1, '提升后全局可见');
    }
  } finally {
    db.close();
  }
});

test('B-6: 冲突不静默覆盖；非法输入/秘密/不存在显式拒', () => {
  const { db, repo, projectId } = setup();
  try {
    const deps = { repo, db };
    const first = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, key: 'client.name', value: '记账系统', kind: 'constraint' },
      300,
    );
    assert.equal(first.ok, true);

    const conflict = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, key: 'client.name', value: '另一套系统', kind: 'constraint' },
      301,
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, 'conflict');
      assert.ok(conflict.existing, '冲突必须带 existing（不静默覆盖）');
    }

    const secret = handleMemoryManage(
      deps,
      { action: 'remember', scope: 'project', projectId, value: 'api_key: sk-1234567890abcdef' },
      302,
    );
    assert.equal(secret.ok, false, '疑似密钥必须拒写');

    const missingProject = handleMemoryManage(
      deps,
      { action: 'list', scope: 'project', projectId: 9999 },
      303,
    );
    assert.equal(missingProject.ok, false);
    if (!missingProject.ok) assert.equal(missingProject.code, 'not_found');

    const noProjectId = handleMemoryManage(deps, { action: 'list', scope: 'project' }, 304);
    assert.equal(noProjectId.ok, false);
    const noValue = handleMemoryManage(deps, { action: 'remember', scope: 'global', value: '   ' }, 305);
    assert.equal(noValue.ok, false);
    const missingId = handleMemoryManage(deps, { action: 'forget', id: 9999 }, 306);
    assert.equal(missingId.ok, false);
    if (!missingId.ok) assert.equal(missingId.code, 'not_found');
  } finally {
    db.close();
  }
});
