/**
 * `project:open-dir`（dogfood L-01 补口）：项目页「打开目录」。
 * 口径：renderer 只传 projectId，路径由主进程从 DB 解析；失败面如实返回，不静默。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectOpenDir } from '../src/main/ipc/ipc.js';

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, repo };
}

test('project:open-dir：无/坏 projectId → bad_request（不碰 openPath）', async () => {
  const { db, repo } = setup();
  try {
    let opened = 0;
    const deps = { repo, openPath: async () => { opened += 1; return ''; } };
    for (const raw of [undefined, {}, { projectId: 0 }, { projectId: -1 }, { projectId: 1.5 }, { projectId: 'x' }]) {
      const result = await handleProjectOpenDir(deps, raw);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'bad_request');
    }
    assert.equal(opened, 0, '参数不合法时不得调用系统打开');
  } finally {
    db.close();
  }
});

test('project:open-dir：项目不存在 → not_found', async () => {
  const { db, repo } = setup();
  try {
    const result = await handleProjectOpenDir({ repo, openPath: async () => '' }, { projectId: 999 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'not_found');
  } finally {
    db.close();
  }
});

test('project:open-dir：项目没有根目录 → no_project_root', async () => {
  const { db, repo } = setup();
  try {
    const project = repo.createProject({ name: 'NoRoot', rootDir: '', accessMode: 'staging', now: 1 });
    const result = await handleProjectOpenDir({ repo, openPath: async () => '' }, { projectId: project.id });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'no_project_root');
  } finally {
    db.close();
  }
});

test('project:open-dir：无 openPath（非桌面环境）→ open_unavailable', async () => {
  const { db, repo } = setup();
  try {
    const root = mkdtempSync(join(tmpdir(), 'aico-open-'));
    try {
      const project = repo.createProject({ name: 'P', rootDir: root, accessMode: 'staging', now: 1 });
      const result = await handleProjectOpenDir({ repo }, { projectId: project.id });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'open_unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});

test('project:open-dir：打开的是 DB 里的 rootDir（renderer 不能传路径）；系统报错如实回', async () => {
  const { db, repo } = setup();
  try {
    const root = mkdtempSync(join(tmpdir(), 'aico-open-'));
    try {
    const project = repo.createProject({ name: 'P', rootDir: root, accessMode: 'inplace', now: 1 });
    const seen: string[] = [];
    const ok = await handleProjectOpenDir(
      { repo, openPath: async (p) => { seen.push(p); return ''; } },
      // 多传 path 也不生效：只认 projectId
      { projectId: project.id, path: 'C:/Windows' },
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(seen, [root]);

    const failed = await handleProjectOpenDir(
      { repo, openPath: async (p) => { seen.push(p); return 'Explorer 拒绝'; } },
      { projectId: project.id },
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.code, 'open_failed');
      assert.match(failed.message, /Explorer 拒绝/);
    }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});

test('project:open-dir：目录不存在 → no_dir + 人话（不依赖系统报错）', async () => {
  const { db, repo } = setup();
  try {
    const missing = join(tmpdir(), 'aico-open-missing-xyz-2026');
    const project = repo.createProject({ name: 'P', rootDir: missing, accessMode: 'inplace', now: 1 });
    let opened = 0;
    const result = await handleProjectOpenDir(
      { repo, openPath: async () => { opened += 1; return ''; } },
      { projectId: project.id },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'no_dir');
      assert.match(result.message, /项目目录不存在/);
    }
    assert.equal(opened, 0, '目录不存在时不得调用系统打开');
  } finally {
    db.close();
  }
});

test('project:open-dir：与 createTask 无耦合（只读打开，不改项目状态）', async () => {
  const { db, repo } = setup();
  try {
    const root = mkdtempSync(join(tmpdir(), 'aico-open-'));
    try {
    const project = repo.createProject({ name: 'P', rootDir: root, accessMode: 'staging', now: 1 });
    createTask(db, new SqliteCounterStore(db), {
      projectId: project.id,
      title: 'T',
      goal: 'g',
      now: 1,
    });
    const before = repo.getProject(project.id);
    await handleProjectOpenDir({ repo, openPath: async () => '' }, { projectId: project.id });
    assert.deepEqual(repo.getProject(project.id), before, '打开目录不得改项目行');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});
