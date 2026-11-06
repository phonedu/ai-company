/**
 * M1-4 · 每任务 worktree（M1 部分；`B-5 G-4` / `lessons §2.2`；1632）。
 * 真 `git` + 临时仓库（隔离、用完删）。验收：创建/幂等复用、终态移除、**路径白名单提交（L4 结构性验证）**、
 * 崩溃 `prune`、以及**默认行为不变**（`inplace` 不建 worktree、`staging` 才建）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorktreeManager,
  commitPaths,
  createGitRunner,
  resolveTaskWorkspace,
} from '../src/main/git/index.js';

function initRepo(): { root: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-git-'));
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  const git = createGitRunner();
  const g = (args: string[], cwd = root) => {
    const res = git.run(args, cwd);
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
    return res;
  };
  // 建仓库 + 一次提交（worktree add 需要 HEAD）
  g(['init', '-q', '-b', 'main'], root);
  g(['config', 'user.email', 'a@b.c'], root);
  g(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  g(['add', '--', 'a.ts', 'b.ts']);
  g(['commit', '-q', '-m', 'init']);
  return { root, dir };
}

test('M1-4①: 创建 worktree（分支 aico/<shortId>）+ 幂等复用', () => {
  const { root, dir } = initRepo();
  try {
    const mgr = new WorktreeManager(root, join(dir, 'wt'));
    const a = mgr.ensure('T-1001');
    assert.equal(a.created, true);
    assert.equal(a.info.branch, 'aico/T-1001');
    assert.ok(existsSync(a.info.path));
    assert.equal(mgr.list().length, 1);

    const b = mgr.ensure('T-1001');
    assert.equal(b.created, false, '重复 ensure 应幂等复用');
    assert.equal(b.info.path, a.info.path);
    assert.equal(mgr.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-4③: 终态移除 → worktree 与分支状态不再占用', () => {
  const { root, dir } = initRepo();
  try {
    const mgr = new WorktreeManager(root, join(dir, 'wt'));
    const { info } = mgr.ensure('T-1002');
    assert.ok(existsSync(info.path));
    assert.equal(mgr.remove('T-1002'), true);
    assert.equal(mgr.list().length, 0);
    assert.ok(!existsSync(info.path), 'worktree 目录应已移除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-4④: 路径白名单提交 —— 另一文件的在制改动不被卷进（L4 结构性验证）', () => {
  const { root, dir } = initRepo();
  try {
    const git = createGitRunner();
    const mgr = new WorktreeManager(root, join(dir, 'wt'), git);
    const { info } = mgr.ensure('T-1003');

    // worktree 内改两个文件，但只提交 a.ts
    writeFileSync(join(info.path, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(info.path, 'b.ts'), 'export const b = 2;\n');
    const res = commitPaths(git, info.path, ['a.ts'], 'T-1003: change a');
    assert.equal(res.committed, true, res.detail);

    const names = git.run(['show', '--pretty=format:', '--name-only', 'HEAD'], info.path).stdout.trim().split('\n');
    assert.deepEqual(names, ['a.ts'], '提交只应含 a.ts');
    const status = git.run(['status', '--porcelain'], info.path).stdout;
    assert.match(status, /b\.ts/, 'b.ts 的在制改动应仍留在工作区（未被卷进提交）');
    assert.equal(readFileSync(join(info.path, 'b.ts'), 'utf8'), 'export const b = 2;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-4⑤: 崩溃清理 —— 目录被外部删除后的陈旧条目由 prune 清掉', () => {
  const { root, dir } = initRepo();
  try {
    const mgr = new WorktreeManager(root, join(dir, 'wt'));
    const { info } = mgr.ensure('T-1004');
    rmSync(info.path, { recursive: true, force: true }); // 模拟"进程被杀、目录被手删"
    assert.equal(mgr.list().length, 1, 'prune 前 git 元数据仍列该 entry');
    mgr.prune();
    assert.equal(mgr.list().length, 0, 'prune 后陈旧条目被清');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-4④默认行为不变: inplace 不建 worktree；staging 才建', () => {
  const { root, dir } = initRepo();
  try {
    const base = join(dir, 'wt');
    const inplace = resolveTaskWorkspace({ repoRoot: root, shortId: 'T-1005', accessMode: 'inplace', worktreesBaseDir: base });
    assert.equal(inplace.cwd, root, 'inplace → 工作区原地（默认不变）');
    assert.equal(inplace.worktree, null);
    assert.equal(inplace.created, false);
    assert.ok(!existsSync(join(base, 'T-1005')), 'inplace 不得建 worktree');

    const staging = resolveTaskWorkspace({ repoRoot: root, shortId: 'T-1006', accessMode: 'staging', worktreesBaseDir: base });
    assert.notEqual(staging.cwd, root);
    assert.equal(staging.created, true);
    assert.equal(staging.worktree?.branch, 'aico/T-1006');
    assert.ok(existsSync(staging.cwd));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
