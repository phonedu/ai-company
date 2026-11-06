/**
 * CR14：删除项目只允许“已归档且无任务”的空项目；非空/未归档显式拒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectDelete } from '../src/main/ipc/ipc.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, repo };
}

test('CR14：空归档项目可删；未归档/有任务显式拒', () => {
  const { db, repo } = setup();
  try {
    const empty = repo.createProject({ name: 'Empty', rootDir: 'D:/empty', accessMode: 'staging', now: 1 });
    const busy = repo.createProject({ name: 'Busy', rootDir: 'D:/busy', accessMode: 'staging', now: 1 });
    createTask(db, new SqliteCounterStore(db), { projectId: busy.id, title: 'T', goal: 'g', now: 1 });

    const active = handleProjectDelete({ repo }, { projectId: empty.id });
    assert.equal(active.ok, false);
    if (!active.ok) assert.equal(active.code, 'not_archived');

    repo.archiveProject(empty.id, 2);
    const ok = handleProjectDelete({ repo }, { projectId: empty.id });
    assert.equal(ok.ok, true);
    assert.equal(repo.getProject(empty.id), null);

    repo.archiveProject(busy.id, 2);
    const nonEmpty = handleProjectDelete({ repo }, { projectId: busy.id });
    assert.equal(nonEmpty.ok, false);
    if (!nonEmpty.ok) assert.equal(nonEmpty.code, 'not_empty');
    assert.notEqual(repo.getProject(busy.id), null, '非空项目不得被删');
  } finally {
    db.close();
  }
});
