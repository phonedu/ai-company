/**
 * `task_checkpoints` DAO（M3-N-2 GAP4：工作项级检查点/回滚）。
 *
 * 一个 work item 的**一次尝试**（attempt）对应一条检查点：
 *  - 派发建 worktree 时记 `base_sha`（该工作项开始前的 HEAD）；
 *  - 完成提交后补 `head_sha` 与 `paths_json`（`base..head` 实际改过的路径）；
 *  - 回滚成功后 `state='restored'`（幂等：已恢复不再跑 git）。
 *
 * 只做行读写；git 语义在 `src/main/git/checkpoint.ts`，引擎接线在 `engine/loop.ts`。
 */
import type { SqliteDb } from './open.js';

export interface TaskCheckpointRow {
  id: number;
  task_id: number;
  work_item_id: number;
  attempt: number;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  worktree_path: string | null;
  paths_json: string;
  state: 'open' | 'restored' | 'invalid' | string;
  created_at: number;
  restored_at: number | null;
}

const COLUMNS =
  'id, task_id, work_item_id, attempt, branch, base_sha, head_sha, worktree_path, paths_json, state, created_at, restored_at';

export interface InsertCheckpointInput {
  taskId: number;
  workItemId: number;
  attempt: number;
  branch?: string | null;
  baseSha?: string | null;
  worktreePath?: string | null;
  now: number;
}

/**
 * 幂等写检查点：同 `(work_item_id, attempt)` 只保留第一条。
 * 返回 `created=false` 表示该尝试已有检查点（重放/恢复），调用方不得改 base。
 */
export function insertCheckpoint(db: SqliteDb, input: InsertCheckpointInput): { row: TaskCheckpointRow; created: boolean } {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO task_checkpoints
        (task_id, work_item_id, attempt, branch, base_sha, worktree_path, paths_json, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'open', ?)`,
    )
    .run(
      input.taskId,
      input.workItemId,
      input.attempt,
      input.branch ?? null,
      input.baseSha ?? null,
      input.worktreePath ?? null,
      input.now,
    );
  const row = getCheckpointForAttempt(db, input.workItemId, input.attempt);
  if (!row) throw new Error(`[db] insertCheckpoint 后读回失败：work_item=${input.workItemId} attempt=${input.attempt}`);
  return { row, created: info.changes > 0 };
}

export function getCheckpoint(db: SqliteDb, id: number): TaskCheckpointRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM task_checkpoints WHERE id = ?`).get(id) as TaskCheckpointRow | undefined;
}

export function getCheckpointForAttempt(db: SqliteDb, workItemId: number, attempt: number): TaskCheckpointRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM task_checkpoints WHERE work_item_id = ? AND attempt = ?`)
    .get(workItemId, attempt) as TaskCheckpointRow | undefined;
}

/** 一个工作项最近一次尝试的检查点（回滚按 changeset 的工作项定位）。 */
export function latestCheckpointForWorkItem(db: SqliteDb, workItemId: number): TaskCheckpointRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM task_checkpoints WHERE work_item_id = ? ORDER BY id DESC LIMIT 1`)
    .get(workItemId) as TaskCheckpointRow | undefined;
}

export function listCheckpointsByTask(db: SqliteDb, taskId: number): TaskCheckpointRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM task_checkpoints WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as TaskCheckpointRow[];
}

/** 完成提交后补头/路径；**只对 open 行**（已 restored 的不改，避免覆盖证据）。 */
export function finishCheckpoint(
  db: SqliteDb,
  input: { checkpointId: number; headSha: string | null; paths: string[] },
): number {
  return db
    .prepare(
      `UPDATE task_checkpoints
          SET head_sha = ?, paths_json = ?
        WHERE id = ? AND state = 'open'`,
    )
    .run(input.headSha, JSON.stringify([...new Set(input.paths)]), input.checkpointId).changes;
}

/** `open → restored`（幂等：只有 open 才迁移；返回 0 表示已恢复/无效）。 */
export function markCheckpointRestored(db: SqliteDb, checkpointId: number, now: number): number {
  return db
    .prepare("UPDATE task_checkpoints SET state = 'restored', restored_at = ? WHERE id = ? AND state = 'open'")
    .run(now, checkpointId).changes;
}

export function parseCheckpointPaths(row: TaskCheckpointRow): string[] {
  try {
    const parsed = JSON.parse(row.paths_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
