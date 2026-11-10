/**
 * `task:rollback`——把**一个工作项的提交**回滚到它开始前的检查点。
 *
 * 口径（v1，只回代码）：
 *  - 只处理 `staging` 项目的 `open` 变更集；`inplace` / 非 open 显式拒（不猜、不偷偷复活）；
 *  - 检查点来自 `task_checkpoints`（派发建 worktree 时记 `base_sha`，完成提交后补 `head_sha`）；
 *  - **只动该工作项 `base..head` 实际改过的路径**：修改/删除按 base 恢复，新增删除；
 *    无关文件（含未提交改动）一律不碰 —— 不用 `reset --hard`；
 *  - 若 `head` 之后有提交碰过同一路径 ⇒ 拒（不覆盖后续工作）；worker 目录/分支对不上 ⇒ 拒；
 *  - 成功产生一个**反向提交**（只含这些路径）并写 `work_item_rolled_back` 事件；
 *    变更集 `open → rolled_back`，检查点 `open → restored`（幂等：已恢复不再跑 git）。
 *
 * 对话回滚：v1 不提供。员工会话是 append-only 日志，删除/倒带会破坏审计；
 * 需要「只回对话」的场景登记为后续（不在本件冒充可用）。
 */
import type { SqliteDb } from '../db/open.js';
import {
  getChangeset,
  getProjectById,
  getTaskById,
  getWorkItem,
  insertTaskEvent,
  latestCheckpointForWorkItem,
  markChangesetRolledBack,
  markCheckpointRestored,
  parseCheckpointPaths,
  type TaskCheckpointRow,
} from '../db/index.js';
import { existsSync } from 'node:fs';
import { findWorktreeByBranch, type GitRunner } from './worktree.js';

export type RollbackChangesetResult =
  | {
      ok: true;
      checkpointId: number;
      changesetId: number;
      workItemId: number;
      rollbackCommit: string | null;
      files: string[];
      alreadyRestored: boolean;
      message: string;
    }
  | {
      ok: false;
      code:
        | 'bad_request'
        | 'not_found'
        | 'task_archived'
        | 'task_state'
        | 'unsupported_mode'
        | 'unsupported_scope'
        | 'changeset_state'
        | 'work_item_active'
        | 'checkpoint_missing'
        | 'checkpoint_stale'
        | 'worktree_missing'
        | 'not_on_branch'
        | 'head_not_ancestor'
        | 'no_changes'
        | 'newer_changes'
        | 'dirty_paths'
        | 'restore_failed'
        | 'commit_failed';
      message: string;
      detail?: string;
    };

export interface RollbackChangesetInput {
  db: SqliteDb;
  git: GitRunner;
  taskId: number;
  changesetId: number;
  /** 项目根（主分支所在仓库）；调用方从 `projects.root_dir` 取。 */
  repoRoot: string;
  /** v1 只支持 `code`（缺省）；`conversation` 显式拒。 */
  scope?: string;
  now?: number;
}

interface DiffPath {
  /** `A` = 新增（回滚时删）；`M`/`D`/`T` = 按 base 恢复。 */
  status: string;
  path: string;
}

function parseNoRenameDiff(stdout: string): DiffPath[] {
  const out: DiffPath[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [code, ...rest] = trimmed.split('\t');
    const path = rest.join('\t');
    if (!code || !path) continue;
    out.push({ status: code[0] ?? 'M', path: path.replace(/^"|"$/g, '') });
  }
  return out;
}

function findWorktree(input: {
  git: GitRunner;
  repoRoot: string;
  branch: string;
  checkpoint: TaskCheckpointRow;
}): { path: string } | null {
  const byBranch = findWorktreeByBranch(input.repoRoot, input.branch, input.git);
  if (byBranch) return { path: byBranch.path };
  // 分支元数据仍可查、目录也还在（find 失败通常是 worktree 根参数化差异）→ 用记录路径兜底。
  const recorded = input.checkpoint.worktree_path;
  if (recorded && existsSync(recorded)) return { path: recorded };
  return null;
}

/**
 * 回滚一个 changeset。**任何一步不满足安全条件都不落库、不动文件**；
 * 成功时先做 git 反向提交，再把状态/事件写库（失败可见）。
 */
export function rollbackChangeset(input: RollbackChangesetInput): RollbackChangesetResult {
  const now = input.now ?? Date.now();
  if (input.scope != null && input.scope !== 'code') {
    return { ok: false, code: 'unsupported_scope', message: 'v1 只支持回滚代码（scope=code）；对话回滚未实现' };
  }

  const task = getTaskById(input.db, input.taskId);
  if (!task) return { ok: false, code: 'not_found', message: '任务不存在' };
  if (task.archived === 1) return { ok: false, code: 'task_archived', message: '任务已归档——先恢复再回滚' };
  if (task.state === 'cancelled') return { ok: false, code: 'task_state', message: '任务已取消，不能回滚' };
  const project = getProjectById(input.db, task.project_id);
  if (!project) return { ok: false, code: 'not_found', message: '任务所属项目不存在' };
  if (project.access_mode !== 'staging') {
    return {
      ok: false,
      code: 'unsupported_mode',
      message: '只有 staging 项目（每任务 worktree）有检查点；inplace 项目没有可回滚的任务分支',
    };
  }

  const cs = getChangeset(input.db, input.changesetId);
  if (!cs || cs.task_id !== input.taskId) {
    return { ok: false, code: 'not_found', message: '变更集不存在或不属于该任务' };
  }
  if (cs.state === 'rolled_back') {
    const cp =
      cs.work_item_id != null ? latestCheckpointForWorkItem(input.db, cs.work_item_id) : undefined;
    return {
      ok: true,
      checkpointId: cp?.id ?? 0,
      changesetId: cs.id,
      workItemId: cs.work_item_id ?? 0,
      rollbackCommit: null,
      files: cp ? parseCheckpointPaths(cp) : [],
      alreadyRestored: true,
      message: '该变更集已回滚（幂等，不重复执行）',
    };
  }
  if (cs.state !== 'open') {
    return {
      ok: false,
      code: 'changeset_state',
      message: `变更集状态为 ${cs.state}，不能回滚（只接受 open）`,
    };
  }
  if (cs.work_item_id == null) {
    return { ok: false, code: 'checkpoint_missing', message: '变更集没有关联工作项，无法定位检查点' };
  }
  const wi = getWorkItem(input.db, cs.work_item_id);
  if (!wi) return { ok: false, code: 'not_found', message: '变更集关联的工作项不存在' };
  if (wi.state === 'running' || wi.state === 'queued' || wi.state === 'blocked') {
    return {
      ok: false,
      code: 'work_item_active',
      message: `工作项还在 ${wi.state}；先暂停/取消任务，确认会话停止后再回滚`,
    };
  }

  const cp = latestCheckpointForWorkItem(input.db, cs.work_item_id);
  if (!cp) {
    return { ok: false, code: 'checkpoint_missing', message: '该工作项没有检查点（非 staging 或检查点未落）' };
  }
  if (cp.state === 'restored') {
    return {
      ok: true,
      checkpointId: cp.id,
      changesetId: cs.id,
      workItemId: cs.work_item_id,
      rollbackCommit: null,
      files: parseCheckpointPaths(cp),
      alreadyRestored: true,
      message: '检查点已恢复（幂等，不重复执行）',
    };
  }
  if (cp.state !== 'open') {
    return { ok: false, code: 'checkpoint_stale', message: `检查点状态为 ${cp.state}，不能回滚` };
  }

  const baseSha = cp.base_sha?.trim() ?? '';
  const headSha = (cs.head_sha ?? cp.head_sha ?? '').trim();
  if (!baseSha || !headSha) {
    return { ok: false, code: 'checkpoint_stale', message: '检查点缺少 base/head 提交，无法安全回滚' };
  }
  if (cp.head_sha != null && cs.head_sha != null && cp.head_sha !== cs.head_sha) {
    return { ok: false, code: 'checkpoint_stale', message: '检查点 head 与变更集 head 不一致（可能已重派）' };
  }

  const branch = (cs.branch ?? cp.branch ?? '').trim();
  if (!branch) return { ok: false, code: 'checkpoint_stale', message: '检查点缺少分支名' };
  const wt = findWorktree({ git: input.git, repoRoot: input.repoRoot, branch, checkpoint: cp });
  if (!wt) {
    return { ok: false, code: 'worktree_missing', message: `找不到分支 ${branch} 的 worktree（可能已清理）` };
  }
  const cwd = wt.path;
  const { git } = input;

  const branchRes = git.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branchRes.status !== 0 || branchRes.stdout.trim() !== branch) {
    return {
      ok: false,
      code: 'not_on_branch',
      message: `worktree 当前分支为 ${branchRes.stdout.trim() || '（未知）'}，期望 ${branch}`,
      detail: branchRes.stderr.trim().slice(0, 500),
    };
  }
  const ancestor = git.run(['merge-base', '--is-ancestor', headSha, 'HEAD'], cwd);
  if (ancestor.status !== 0) {
    return {
      ok: false,
      code: 'head_not_ancestor',
      message: '该工作项的提交已不在当前分支历史中（分支被改写），拒绝猜回滚点',
    };
  }

  const diff = git.run(['diff', '--name-status', '--no-renames', baseSha, headSha], cwd);
  if (diff.status !== 0) {
    return {
      ok: false,
      code: 'checkpoint_stale',
      message: `读取工作项改动失败：${diff.stderr.trim() || diff.stdout.trim()}`,
    };
  }
  const changed = parseNoRenameDiff(diff.stdout);
  if (changed.length === 0) {
    return { ok: false, code: 'no_changes', message: '该工作项没有可回滚的文件改动' };
  }
  const paths = [...new Set(changed.map((d) => d.path))];
  const unsupported = changed.find((d) => !['A', 'M', 'D', 'T'].includes(d.status));
  if (unsupported) {
    return {
      ok: false,
      code: 'restore_failed',
      message: `不支持的改动类型 ${unsupported.status}（${unsupported.path}），未执行回滚`,
    };
  }

  // 之后有人改过同一路径 ⇒ 回滚会覆盖后续工作；显式拒（不静默丢改动）。
  const newer = git.run(['log', '--format=%H', `${headSha}..HEAD`, '--', ...paths], cwd);
  if (newer.status !== 0) {
    return { ok: false, code: 'checkpoint_stale', message: `检查后续提交失败：${newer.stderr.trim()}` };
  }
  if (newer.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'newer_changes',
      message: '该工作项之后还有提交修改同一文件，拒绝覆盖后续工作',
      detail: newer.stdout.trim().split('\n').slice(0, 20).join(', '),
    };
  }

  // 只检查**受影响路径**的未提交改动；无关文件脏不阻塞（也不被碰）。
  const dirty = git.run(['status', '--porcelain', '--untracked-files=all', '--', ...paths], cwd);
  if (dirty.status !== 0) {
    return { ok: false, code: 'restore_failed', message: `git status 失败：${dirty.stderr.trim()}` };
  }
  if (dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'dirty_paths',
      message: '受影响文件有未提交改动，先处理后再回滚（无关文件不受影响）',
      detail: dirty.stdout.trim().slice(0, 2000),
    };
  }

  for (const item of changed) {
    const res =
      item.status === 'A'
        ? git.run(['rm', '-f', '--ignore-unmatch', '--', item.path], cwd)
        : git.run(['restore', '--source', baseSha, '--staged', '--worktree', '--', item.path], cwd);
    if (res.status !== 0) {
      return {
        ok: false,
        code: 'restore_failed',
        message: `恢复 ${item.path} 失败：${res.stderr.trim() || res.stdout.trim()}`,
        detail: `已处理到 ${item.path}；检查工作区后重试或人工恢复`,
      };
    }
  }

  const staged = git.run(['diff', '--cached', '--name-only', '--', ...paths], cwd);
  if (staged.status !== 0) {
    return { ok: false, code: 'restore_failed', message: `读取暂存区失败：${staged.stderr.trim()}` };
  }

  let rollbackCommit: string | null = null;
  if (staged.stdout.trim().length > 0) {
    const short = task.short_id ?? `#${task.id}`;
    const msg = `aico: rollback ${short} work item ${wi.id} to ${baseSha.slice(0, 8)}`;
    const commit = git.run(['commit', '-m', msg, '--', ...paths], cwd);
    if (commit.status !== 0) {
      return {
        ok: false,
        code: 'commit_failed',
        message: `回滚提交失败：${commit.stdout.trim() || commit.stderr.trim()}`,
        detail: '文件已按检查点恢复但未提交；检查 git 状态后重试',
      };
    }
    rollbackCommit = git.run(['rev-parse', 'HEAD'], cwd).stdout.trim() || null;
  }

  // DB 状态/事件在 git 成功后写；事务保证「变更集 + 检查点 + 事件」一起可见。
  input.db.exec('BEGIN');
  try {
    const csChanged = markChangesetRolledBack(input.db, cs.id, now);
    const cpChanged = markCheckpointRestored(input.db, cp.id, now);
    if (csChanged === 0 && cpChanged === 0) {
      input.db.exec('ROLLBACK');
      return {
        ok: true,
        checkpointId: cp.id,
        changesetId: cs.id,
        workItemId: cs.work_item_id,
        rollbackCommit,
        files: paths,
        alreadyRestored: true,
        message: '回滚状态已被其他入口写入（幂等）',
      };
    }
    insertTaskEvent(input.db, {
      taskId: task.id,
      workItemId: cs.work_item_id,
      ts: now,
      kind: 'work_item_rolled_back',
      actor: 'boss',
      payload: {
        checkpointId: cp.id,
        changesetId: cs.id,
        baseSha,
        headSha,
        rollbackCommit,
        files: paths,
        alreadyAtCheckpoint: rollbackCommit == null,
      },
    });
    if (task.state === 'verifying' || task.state === 'done') {
      insertTaskEvent(input.db, {
        taskId: task.id,
        workItemId: cs.work_item_id,
        ts: now,
        kind: 'verification_invalidated',
        actor: 'boss',
        payload: { reason: 'work_item_rolled_back', changesetId: cs.id, rollbackCommit },
      });
    }
    input.db.exec('COMMIT');
  } catch (error) {
    input.db.exec('ROLLBACK');
    return {
      ok: false,
      code: 'commit_failed',
      message: `回滚提交已产生，但状态/事件落库失败：${error instanceof Error ? error.message : String(error)}`,
      detail: `rollbackCommit=${rollbackCommit ?? '(none)'}`,
    };
  }

  return {
    ok: true,
    checkpointId: cp.id,
    changesetId: cs.id,
    workItemId: cs.work_item_id,
    rollbackCommit,
    files: paths,
    alreadyRestored: false,
    message:
      rollbackCommit == null
        ? `已恢复到检查点（文件本来就在检查点状态，未产生新提交）`
        : `已回滚工作项 #${wi.id}（${paths.length} 个文件）到 ${baseSha.slice(0, 8)}`,
  };
}
