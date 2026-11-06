/**
 * `task:merge`（M3-P-4 / BRK16-b）——把一个 changeset 合并到项目主分支。
 *
 * 真值表（`changesets.state`）：
 *  - `open --merge--> merged`（唯一正向迁移；同时写 `merged_at`）；
 *  - `merged --merge--> merged`（**幂等**：不再跑 git，返回 alreadyMerged）；
 *  - `discarded` / 其他态 --merge--> 拒绝（不偷偷复活已丢弃改动）。
 *
 * 硬约束：
 *  - 只在**主分支**（main/master）当前检出时合并；其他分支显式拒（不猜目标）；
 *  - 工作区有**已跟踪文件**未提交改动 ⇒ 拒（不把别人的在制改动卷进 merge commit）；
 *  - 冲突 ⇒ 读取冲突文件 → `git merge --abort`（不留半合并现场）→ 返回冲突清单并留审计事件；
 *  - 成功 ⇒ 写 `changeset_merged` 事件（含 mergeCommit），UI/审计可追溯。
 */
import type { SqliteDb } from '../db/open.js';
import { getChangeset, getProjectById, getTaskById, markChangesetMerged } from '../db/index.js';
import { insertTaskEvent } from '../db/task_events.js';
import type { GitRunner } from './worktree.js';

export type MergeChangesetResult =
  | {
      ok: true;
      changesetId: number;
      alreadyMerged: boolean;
      mergeCommit: string | null;
      filesChanged: number;
      message: string;
    }
  | {
      ok: false;
      code:
        | 'bad_request'
        | 'not_found'
        | 'task_archived'
        | 'task_state'
        | 'changeset_state'
        | 'missing_head'
        | 'not_a_repo'
        | 'not_on_base'
        | 'dirty_worktree'
        | 'merge_conflict'
        | 'merge_failed';
      message: string;
      conflicts?: string[];
      detail?: string;
    };

export interface MergeChangesetInput {
  db: SqliteDb;
  git: GitRunner;
  taskId: number;
  changesetId: number;
  /** 项目根（主分支所在仓库）。调用方从 `projects.root_dir` 取。 */
  repoRoot: string;
  /** S13-G/D-N06：项目配置的合并目标分支（缺省/NULL ⇒ 沿用 main/master）。 */
  targetBranch?: string | null;
  now?: number;
}

const TARGET_BRANCHES = new Set(['main', 'master']);

export function mergeChangeset(input: MergeChangesetInput): MergeChangesetResult {
  const now = input.now ?? Date.now();
  const task = getTaskById(input.db, input.taskId);
  if (!task) return { ok: false, code: 'not_found', message: '任务不存在' };
  if (task.archived === 1) return { ok: false, code: 'task_archived', message: '任务已归档——先恢复再合并' };
  if (task.state === 'cancelled') return { ok: false, code: 'task_state', message: '任务已取消，不能合并' };
  const cs = getChangeset(input.db, input.changesetId);
  if (!cs || cs.task_id !== input.taskId) {
    return { ok: false, code: 'not_found', message: '变更集不存在或不属于该任务' };
  }
  if (cs.state === 'merged') {
    return {
      ok: true,
      changesetId: cs.id,
      alreadyMerged: true,
      mergeCommit: null,
      filesChanged: cs.files_changed,
      message: '该变更集已合并（幂等，不重复执行）',
    };
  }
  if (cs.state !== 'open') {
    return {
      ok: false,
      code: 'changeset_state',
      message: `变更集状态为 ${cs.state}，不能合并（只接受 open）`,
    };
  }
  const headSha = cs.head_sha?.trim() ?? '';
  if (headSha.length === 0) {
    return { ok: false, code: 'missing_head', message: '变更集缺少 head_sha，无法合并' };
  }

  const short = task.short_id ?? `#${task.id}`;
  const { git, repoRoot } = input;
  const branchRes = git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (branchRes.status !== 0) {
    return {
      ok: false,
      code: 'not_a_repo',
      message: `项目根不是可用 git 仓库：${branchRes.stderr.trim() || branchRes.stdout.trim()}`,
    };
  }
  const currentBranch = branchRes.stdout.trim();
  const configured = input.targetBranch?.trim() ?? '';
  const allowed = configured.length > 0 ? new Set([configured]) : TARGET_BRANCHES;
  if (!allowed.has(currentBranch)) {
    return {
      ok: false,
      code: 'not_on_base',
      message:
        configured.length > 0
          ? `当前分支是 ${currentBranch || '（未知）'}；该项目配置的合并目标是 ${configured}（可在设置里改）`
          : `当前分支是 ${currentBranch || '（未知）'}；合并只在 main/master 上执行（可在设置里指定目标分支）`,
    };
  }

  const status = git.run(['status', '--porcelain', '--untracked-files=no'], repoRoot);
  if (status.status !== 0) {
    return { ok: false, code: 'not_a_repo', message: `git status 失败：${status.stderr.trim()}` };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'dirty_worktree',
      message: '工作区有已跟踪文件的未提交改动，先提交/暂存后再合并',
      detail: status.stdout.trim().slice(0, 2000),
    };
  }

  // 已在主分支历史里（例如上次合并成功但状态没来得及更新）→ 只补状态，不重复 merge。
  const ancestor = git.run(['merge-base', '--is-ancestor', headSha, 'HEAD'], repoRoot);
  if (ancestor.status === 0) {
    markChangesetMerged(input.db, cs.id, now);
    insertTaskEvent(input.db, {
      taskId: task.id,
      ts: now,
      kind: 'changeset_merged',
      actor: 'boss',
      payload: { changesetId: cs.id, headSha, alreadyMerged: true, mergeCommit: null },
    });
    return {
      ok: true,
      changesetId: cs.id,
      alreadyMerged: true,
      mergeCommit: null,
      filesChanged: cs.files_changed,
      message: '该提交已在主分支历史中（幂等补记状态）',
    };
  }

  const merge = git.run(
    ['merge', '--no-ff', '-m', `aico: merge ${short} changeset #${cs.id}`, headSha],
    repoRoot,
  );
  if (merge.status !== 0) {
    const conflicts = git
      .run(['diff', '--name-only', '--diff-filter=U'], repoRoot)
      .stdout.split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // 冲突/失败后回滚 merge 现场（不留半合并；分支提交本身不动）。
    git.run(['merge', '--abort'], repoRoot);
    const code = conflicts.length > 0 ? 'merge_conflict' : 'merge_failed';
    const message =
      conflicts.length > 0
        ? `合并冲突：${conflicts.join(', ')}（已中止，主分支未改动）`
        : `git merge 失败：${merge.stderr.trim() || merge.stdout.trim() || '未知错误'}`;
    insertTaskEvent(input.db, {
      taskId: task.id,
      ts: now,
      kind: 'action_failed',
      actor: 'boss',
      payload: { action: 'task_merge', changesetId: cs.id, reason: code, conflicts },
    });
    return {
      ok: false,
      code,
      message,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      detail: (merge.stderr || merge.stdout).trim().slice(0, 2000),
    };
  }

  const head = git.run(['rev-parse', 'HEAD'], repoRoot);
  const mergeCommit = head.status === 0 ? head.stdout.trim() : null;
  const changed = markChangesetMerged(input.db, cs.id, now);
  insertTaskEvent(input.db, {
    taskId: task.id,
    ts: now,
    kind: 'changeset_merged',
    actor: 'boss',
    payload: { changesetId: cs.id, headSha, mergeCommit, filesChanged: cs.files_changed, branch: cs.branch },
  });
  if (task.state === 'verifying' || task.state === 'done') {
    insertTaskEvent(input.db, {
      taskId: task.id,
      ts: now,
      kind: 'verification_invalidated',
      actor: 'boss',
      payload: { reason: 'changeset_merged', changesetId: cs.id, mergeCommit },
    });
  }
  return {
    ok: true,
    changesetId: cs.id,
    alreadyMerged: changed === 0,
    mergeCommit,
    filesChanged: cs.files_changed,
    message: changed === 0 ? '合并完成（状态已被其他入口置 merged）' : `已合并到 ${currentBranch}`,
  };
}

/** 按任务解析项目根（`projects.root_dir`）；任务/项目缺失 → null。 */
export function projectRootForTask(db: SqliteDb, taskId: number): string | null {
  const task = getTaskById(db, taskId);
  if (!task) return null;
  const project = getProjectById(db, task.project_id);
  return project?.root_dir ?? null;
}
