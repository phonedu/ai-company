/**
 * `project:create`（2026-10-16，D 批余项）：**软件代建项目骨架**守据——父目录经注入假件（真机＝主进程 dialog）、
 * **不覆盖同名目录**、README 骨架、探测建行（`accessMode` 取探测建议）；取消/非法名显式拒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectCreate } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import { createGitRunner } from '../src/main/git/index.js';

const AT = 1_800_000_000_000;

function fixture(): { dir: string; db: ReturnType<typeof openMemoryDatabase>; deps: IpcDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-projcreate-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { dir, db, deps: { repo, pickDirectory: async () => dir } };
}

test('happy：建 `<父>/<名>/` ＋ README 骨架 ＋ probe ＋ 项目行（根目录/名/建议档如实）', async () => {
  const f = fixture();
  try {
    const res = await handleProjectCreate(f.deps, { name: '新项目' }, AT);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const target = join(f.dir, '新项目');
    assert.equal(res.createdDir, target);
    assert.equal(res.project.name, '新项目');
    assert.equal(res.project.rootDir, target, '项目行指向代建目录（不藏私）');
    assert.ok(existsSync(join(target, 'README.md')), 'README 骨架落盘');
    assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /# 新项目/, '骨架标题＝项目名');
    assert.equal(typeof res.probe.suggestedAccessMode, 'string', '探测建议档在场（建行值取自它）');
    // D-15：代建项目默认 staging；staging 依赖 git worktree，因此必须先 git init + 初始提交。
    assert.equal(res.project.accessMode, 'staging', '代建项目默认 staging');
    assert.equal(res.gitInitialized, true, 'git 初始化成功');
    assert.ok(existsSync(join(target, '.git')), '.git 目录落盘');
    const git = createGitRunner();
    const head = git.run(['rev-parse', 'HEAD'], target);
    assert.equal(head.status, 0, `初始提交必须存在：${head.stderr}`);
    assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('取消 / 缺目录选择器 → 显式码且**什么都不建**（不静默、不建行）', async () => {
  const f = fixture();
  try {
    const cancelled: IpcDeps = { repo: f.deps.repo, pickDirectory: async () => null };
    const r1 = await handleProjectCreate(cancelled, { name: 'X' }, AT);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'cancelled');
    assert.ok(!existsSync(join(f.dir, 'X')), '取消不建目录');

    const bare: IpcDeps = { repo: f.deps.repo };
    const r2 = await handleProjectCreate(bare, { name: 'X' }, AT);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'dialog_unavailable');

    assert.equal(f.deps.repo.listProjects().length, 0, '两种拒绝都不建项目行');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('同名目录已存在 → `already_exists` **不覆盖**（既有文件原样）；非法名 → bad_request', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, '旧项目'));
    writeFileSync(join(f.dir, '旧项目', 'keep.txt'), '别动我', 'utf8');
    const r1 = await handleProjectCreate(f.deps, { name: '旧项目' }, AT);
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.equal(r1.code, 'already_exists');
      assert.match(r1.message, /不覆盖|接入已有文件夹/);
    }
    assert.equal(readFileSync(join(f.dir, '旧项目', 'keep.txt'), 'utf8'), '别动我', '既有内容原样（绝不覆盖）');
    assert.equal(f.deps.repo.listProjects().length, 0, '拒绝不建行');

    for (const bad of ['', '  ', 'a/b', 'a\\b', '..', 'x*y']) {
      const r = await handleProjectCreate(f.deps, { name: bad }, AT);
      assert.equal(r.ok, false, `名「${bad}」应拒`);
      if (!r.ok) assert.equal(r.code, 'bad_request');
    }
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ── RW-7（M5 真机带回，2026-10-27）：父目录不得与现有项目根互相包含（嵌套项目＝隔离边界缺口）──

test('RW-7①: 父目录选到现有项目根之内 → 显式拒（parent_inside_project）且不建目录不建行', async () => {
  const f = fixture();
  try {
    // 先建一个现有项目（根＝f.dir/outer）
    const parent = join(f.dir, 'outer');
    mkdirSync(parent, { recursive: true });
    const d1: IpcDeps = { repo: f.deps.repo, db: f.db, pickDirectory: async () => parent };
    const first = await handleProjectCreate(d1, { name: '旧项目' }, AT);
    assert.equal(first.ok, true);
    // 再把新项目父目录选到旧项目根里面
    const d2: IpcDeps = { repo: f.deps.repo, db: f.db, pickDirectory: async () => join(parent, '旧项目') };
    const res = await handleProjectCreate(d2, { name: '嵌套项目' }, AT);
    assert.equal(res.ok, false, '必须拒绝');
    if (!res.ok) {
      assert.equal(res.code, 'parent_inside_project');
      assert.match(res.message, /现有项目/, '人话必须点明与现有项目冲突');
    }
    assert.ok(!existsSync(join(parent, '旧项目', '嵌套项目')), '不得建目录');
    const n = (f.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    assert.equal(n, 1, '只应有第一个项目行');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('RW-7②: 反向包含也拒（新项目根将包住现有项目根）', async () => {
  const f = fixture();
  try {
    // 现有项目在 f.dir/projects/旧项目（目录由代建流程自建；父目录预建为空）
    const parent = join(f.dir, 'projects');
    mkdirSync(parent, { recursive: true });
    const d1: IpcDeps = { repo: f.deps.repo, db: f.db, pickDirectory: async () => parent };
    const first = await handleProjectCreate(d1, { name: '旧项目' }, AT);
    assert.equal(first.ok, true);
    // 新项目父目录选 f.dir ⇒ target=f.dir/新项目——不包含旧项目（projects/旧项目 在 projects 下不在 新项目 下）⇒ 放行
    const okCase = await handleProjectCreate({ repo: f.deps.repo, db: f.db, pickDirectory: async () => f.dir }, { name: '旁支' }, AT);
    assert.equal(okCase.ok, true, '互不包含 ⇒ 放行');
    // 反向：父目录选 f.dir，名字取 projects ⇒ target=f.dir/projects 会包住现有项目根 ⇒ 拒
    const res = await handleProjectCreate({ repo: f.deps.repo, db: f.db, pickDirectory: async () => f.dir }, { name: 'projects' }, AT);
    assert.equal(res.ok, false, '新根包住现有根也必须拒');
    if (!res.ok) assert.equal(res.code, 'parent_inside_project');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
