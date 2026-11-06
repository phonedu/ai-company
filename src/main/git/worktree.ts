/**
 * M1-4 · 每任务独立 `git worktree`（**M1 部分**）—— `PLAN §18 / §15.3`、`B-5 G-4`、`lessons §2.2`。
 *
 * 目标（结构性消除 L4/L14）：每任务一个 worktree + 分支 `aico/<shortId>` → **独立 index/HEAD**，
 * 「共享 index 把别人在制改动卷进提交」「`--amend` 改写他人提交」的根因**结构上不存在**。
 *
 * 范围（1632 圈定）：
 *  - ✅ 创建 / **幂等复用**、**终态移除** + `prune`、**引擎独占写的路径白名单提交**（`add -- <paths>` + `commit -- <paths>`）、**崩溃清理**；
 *  - ⛔ merge/diff/changesets、运行时 `path→work_item` 锁表、冲突事件 → **M2**。
 *
 * **默认行为不变（硬要求）**：`inplace` 项目（M0 现状）**不走 worktree**，仍在工作区按路径白名单提交；
 * worktree 仅在 **`access_mode='staging'`**（或显式开关）时启用 —— 见 `resolveTaskWorkspace`。
 *
 * 台账 = **推导**（`git worktree list` + 命名规则；`.git/worktrees` 即账本）→ **零 schema 变更**。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], cwd?: string): GitResult;
}

export function createGitRunner(): GitRunner {
  return {
    run(args: string[], cwd?: string): GitResult {
      try {
        const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
      }
    },
  };
}

export interface WorktreeInfo {
  taskShortId: string;
  path: string;
  branch: string;
}

export function branchName(shortId: string): string {
  return `aico/${shortId}`;
}

export function defaultWorktreesBaseDir(repoRoot: string): string {
  return resolve(repoRoot, '..', '.aico-worktrees');
}

export function worktreePathFor(baseDir: string, shortId: string): string {
  return join(baseDir, shortId);
}

interface PorcelainEntry {
  path: string;
  branch: string | null;
}

function parseWorktreeList(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim();
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * M3-N-2：按分支找**任意位置**的 worktree（回滚时不知道装配方把 worktree 根放哪：
 * 生产落 `userData/worktrees`，测试落任意临时目录）。找不到 ⇒ null（调用方显式拒，不猜路径）。
 */
export function findWorktreeByBranch(
  repoRoot: string,
  branch: string,
  git: GitRunner = createGitRunner(),
): WorktreeInfo | undefined {
  const res = git.run(['worktree', 'list', '--porcelain'], repoRoot);
  if (res.status !== 0) return undefined;
  const target = `refs/heads/${branch}`;
  const entry = parseWorktreeList(res.stdout).find((e) => e.branch === target);
  if (!entry) return undefined;
  return { taskShortId: branch.replace(/^aico\//, ''), path: resolve(entry.path), branch };
}

export class WorktreeManager {
  private readonly baseDir: string;

  constructor(
    private readonly repoRoot: string,
    baseDir: string = defaultWorktreesBaseDir(repoRoot),
    private readonly git: GitRunner = createGitRunner(),
  ) {
    this.baseDir = baseDir;
  }

  /** 台账推导：列出由本管理器命名规则（`baseDir/<shortId>` + 分支 `aico/<shortId>`）产生的 worktree。 */
  list(): WorktreeInfo[] {
    const res = this.git.run(['worktree', 'list', '--porcelain'], this.repoRoot);
    if (res.status !== 0) return [];
    const base = resolve(this.baseDir).replace(/\\/g, '/').toLowerCase();
    const out: WorktreeInfo[] = [];
    for (const e of parseWorktreeList(res.stdout)) {
      const p = resolve(e.path).replace(/\\/g, '/').toLowerCase();
      if (!e.branch || !p.startsWith(`${base}/`)) continue;
      const shortId = e.path.replace(/\\/g, '/').split('/').pop() as string;
      if (e.branch !== `refs/heads/${branchName(shortId)}`) continue;
      out.push({ taskShortId: shortId, path: resolve(e.path), branch: e.branch.replace('refs/heads/', '') });
    }
    return out;
  }

  find(shortId: string): WorktreeInfo | undefined {
    return this.list().find((w) => w.taskShortId === shortId);
  }

  /** 创建或**幂等复用** worktree 与分支。返回 info 与是否新建。 */
  ensure(shortId: string): { info: WorktreeInfo; created: boolean } {
    const existing = this.find(shortId);
    if (existing) return { info: existing, created: false };

    const path = worktreePathFor(this.baseDir, shortId);
    const branch = branchName(shortId);
    const hasBranch = this.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], this.repoRoot).status === 0;
    const args = hasBranch
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', path, '-b', branch];
    const res = this.git.run(args, this.repoRoot);
    if (res.status !== 0) {
      throw new Error(`[git] worktree add 失败（${shortId}）：${res.stderr.trim() || res.stdout.trim()}`);
    }
    return { info: { taskShortId: shortId, path, branch }, created: true };
  }

  /** 移除 worktree（保留分支，供后续合并/审查；M1 部分）。返回是否移除了。 */
  remove(shortId: string): boolean {
    const existing = this.find(shortId);
    if (!existing) return false;
    const res = this.git.run(['worktree', 'remove', '--force', existing.path], this.repoRoot);
    if (res.status !== 0) {
      // 目录已被外部删除等 → 清元数据兜底
      this.git.run(['worktree', 'prune'], this.repoRoot);
      if (existsSync(existing.path)) rmSync(existing.path, { recursive: true, force: true });
    }
    return true;
  }

  /** 崩溃清理：清掉 `.git/worktrees` 里指向已不存在目录的陈旧条目。 */
  prune(): void {
    this.git.run(['worktree', 'prune'], this.repoRoot);
  }
}

/**
 * 引擎独占写的**路径白名单提交**（`add -- <paths>` + `commit -- <paths>`）。
 * 只提交列出的路径 → **另一文件的在制改动不会被卷进**（L4 结构性验证）；空改动返回 `committed:false`。
 */
export function commitPaths(
  git: GitRunner,
  cwd: string,
  paths: string[],
  message: string,
): { committed: boolean; detail: string } {
  if (paths.length === 0) return { committed: false, detail: 'empty paths' };
  const add = git.run(['add', '--', ...paths], cwd);
  if (add.status !== 0) return { committed: false, detail: `add failed: ${add.stderr.trim()}` };
  const commit = git.run(['commit', '-m', message, '--', ...paths], cwd);
  if (commit.status !== 0) return { committed: false, detail: commit.stdout.trim() || commit.stderr.trim() };
  return { committed: true, detail: commit.stdout.trim() };
}

/**
 * 把工作区**全部**改动提交（`git add -A`）。
 *
 * 只允许在**任务独占工作区**（staging worktree）或调用方已确认派发前工作区干净时使用；
 * `inplace` 共享工作区必须走 `commitPaths` 的路径白名单，避免把老板在制改动卷进提交。
 */
export function commitAll(
  git: GitRunner,
  cwd: string,
  message: string,
): { committed: boolean; detail: string } {
  const status = git.run(['status', '--porcelain'], cwd);
  if (status.status !== 0) return { committed: false, detail: status.stderr.trim() || status.stdout.trim() };
  if (status.stdout.trim().length === 0) return { committed: false, detail: 'no changes' };
  const add = git.run(['add', '-A'], cwd);
  if (add.status !== 0) return { committed: false, detail: add.stderr.trim() || add.stdout.trim() };
  const commit = git.run(['commit', '-m', message], cwd);
  if (commit.status !== 0) return { committed: false, detail: commit.stdout.trim() || commit.stderr.trim() };
  return { committed: true, detail: commit.stdout.trim() };
}

/** `git status --porcelain` 是否有改动（工作区/暂存区/未跟踪）。 */
export function hasWorkingTreeChanges(git: GitRunner, cwd: string): boolean {
  const status = git.run(['status', '--porcelain'], cwd);
  return status.status === 0 && status.stdout.trim().length > 0;
}

/**
 * 真实改动路径（工作区/暂存区/未跟踪；**不含 gitignored**）。
 *
 * 用途：inplace 自动提交前把员工自报的 artifacts 与真实 diff 对账——artifacts 可能漏文件
 * （如 `Cargo.lock`）或混入 gitignored 产物（如 `out/*.png`，`git add` 会直接失败）。
 * 只返回路径，不提交；调用方仍可只提交白名单交集。
 */
export function listChangedPaths(
  git: GitRunner,
  cwd: string,
): { ok: boolean; paths: string[]; detail: string } {
  const status = git.run(['status', '--porcelain', '--untracked-files=all'], cwd);
  if (status.status !== 0) {
    return { ok: false, paths: [], detail: status.stderr.trim() || status.stdout.trim() };
  }
  const paths: string[] = [];
  for (const line of status.stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    let path = line.slice(3);
    // rename/copy: `R  old -> new`（提交新路径）
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path.length > 0) paths.push(path);
  }
  return { ok: true, paths: [...new Set(paths)], detail: '' };
}

/** 生成物/锁文件：员工常忘报，但属于本次改动的必要提交面。 */
export function isLockfilePath(path: string): boolean {
  return /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(path);
}

/**
 * 软件代建项目：初始化 git 仓库并落初始提交。
 *
 * 为什么需要：staging 的检查点/回滚/合并依赖 `git worktree`；没有仓库时 worktree 会失败并回退，
 * 变更链就永远没有 base/head。只在**本函数刚创建的空目录**调用（调用方保证不覆盖既有目录）。
 */
export function initGitRepo(rootDir: string, git: GitRunner = createGitRunner()): { ok: boolean; detail: string } {
  const init = git.run(['init', '-q', '-b', 'main'], rootDir);
  if (init.status !== 0) {
    const fallback = git.run(['init', '-q'], rootDir);
    if (fallback.status !== 0) {
      return { ok: false, detail: fallback.stderr.trim() || fallback.stdout.trim() || init.stderr.trim() };
    }
    git.run(['symbolic-ref', 'HEAD', 'refs/heads/main'], rootDir);
  }
  // 本机不一定配了全局 user.name/email；只写仓库级配置，不动用户全局配置。
  git.run(['config', 'user.name', 'ai-company'], rootDir);
  git.run(['config', 'user.email', 'ai-company@local'], rootDir);
  const add = git.run(['add', '-A'], rootDir);
  if (add.status !== 0) return { ok: false, detail: add.stderr.trim() || add.stdout.trim() };
  const commit = git.run(['commit', '-q', '-m', 'chore: init project'], rootDir);
  if (commit.status !== 0) return { ok: false, detail: commit.stdout.trim() || commit.stderr.trim() };
  return { ok: true, detail: '' };
}

export interface TaskWorkspaceInput {
  repoRoot: string;
  shortId: string;
  /** 项目接入模式：`inplace`（默认，工作区原地）| `staging`（每任务 worktree）。 */
  accessMode: string;
  /** 显式开关（可选，覆盖 access_mode 判定）。 */
  useWorktree?: boolean;
  worktreesBaseDir?: string;
  git?: GitRunner;
}

/**
 * 解析任务工作目录（**默认行为不变**）：
 *  - `inplace`（或显式 `useWorktree:false`）→ 直接返回 `repoRoot`，**不建 worktree**；
 *  - `staging`（或显式 `useWorktree:true`）→ 幂等建/复用 worktree，返回其路径。
 */
export function resolveTaskWorkspace(input: TaskWorkspaceInput): { cwd: string; worktree: WorktreeInfo | null; created: boolean } {
  const useWorktree = input.useWorktree ?? input.accessMode === 'staging';
  if (!useWorktree) return { cwd: input.repoRoot, worktree: null, created: false };
  const manager = new WorktreeManager(input.repoRoot, input.worktreesBaseDir ?? defaultWorktreesBaseDir(input.repoRoot), input.git);
  const { info, created } = manager.ensure(input.shortId);
  return { cwd: info.path, worktree: info, created };
}
