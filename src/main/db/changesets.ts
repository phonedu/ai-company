/**
 * `changesets` / `changeset_files` 数据访问（第 5 项，docs/ 变更审查）。
 *
 * 语义：
 *  - 一个 **work item** 的**一次提交**（`head_sha`）⇒ 一条 `changesets`（`state='open'`，等老板合并/丢弃）；
 *  - **幂等键** = `UNIQUE(work_item_id, head_sha)`（`003` 的 `idx_changesets_wi_head`）⇒ 崩溃重放/重复完成
 *    不会写出第二条（`INSERT OR IGNORE` + 读回）。
 *  - **事务边界**：本模块**不自己开事务**（调用方=引擎的批次事务；`engine/loop.ts#finishWorkspace` 在事务内调用）。
 */
import type { SqliteDb } from './open.js';

export interface ChangesetRow {
  id: number;
  task_id: number;
  work_item_id: number | null;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  summary: string;
  commit_msg: string | null;
  state: string;
  created_at: number;
  merged_at: number | null;
}

export interface ChangesetFileRow {
  id: number;
  changeset_id: number;
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  employee_id: number | null;
}

const CS_COLUMNS =
  'id, task_id, work_item_id, branch, base_sha, head_sha, files_changed, insertions, deletions, summary, commit_msg, state, created_at, merged_at';
const CSF_COLUMNS = 'id, changeset_id, path, status, insertions, deletions, employee_id';

export interface InsertChangesetInput {
  taskId: number;
  workItemId: number | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary?: string;
  commitMsg?: string | null;
  state?: string;
  now: number;
}

/**
 * 写一条 changeset（幂等：同 `(work_item_id, head_sha)` 只写一次）。
 * 返回 `{ row, created }`：`created=false` 表示命中幂等键（重放）。
 */
export function insertChangeset(db: SqliteDb, input: InsertChangesetInput): { row: ChangesetRow; created: boolean } {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO changesets
        (task_id, work_item_id, branch, base_sha, head_sha, files_changed, insertions, deletions, summary, commit_msg, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.workItemId,
      input.branch ?? null,
      input.baseSha ?? null,
      input.headSha ?? null,
      input.filesChanged,
      input.insertions,
      input.deletions,
      input.summary ?? '',
      input.commitMsg ?? null,
      input.state ?? 'open',
      input.now,
    );
  const created = info.changes > 0;
  const row = created
    ? (db.prepare(`SELECT ${CS_COLUMNS} FROM changesets WHERE id = ?`).get(Number(info.lastInsertRowid)) as ChangesetRow)
    : (db
        .prepare(`SELECT ${CS_COLUMNS} FROM changesets WHERE work_item_id IS ? AND head_sha IS ?`)
        .get(input.workItemId, input.headSha ?? null) as ChangesetRow);
  return { row, created };
}

export function insertChangesetFile(
  db: SqliteDb,
  input: {
    changesetId: number;
    path: string;
    status: string;
    insertions: number;
    deletions: number;
    employeeId?: number | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO changeset_files(changeset_id, path, status, insertions, deletions, employee_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.changesetId,
      input.path,
      input.status,
      input.insertions,
      input.deletions,
      input.employeeId ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function getChangeset(db: SqliteDb, id: number): ChangesetRow | undefined {
  return db.prepare(`SELECT ${CS_COLUMNS} FROM changesets WHERE id = ?`).get(id) as ChangesetRow | undefined;
}

/**
 * 合并真值表：`open → merged`；已 merged ⇒ 0 行（调用侧按“幂等已合并”处理）。
 * `discarded` 等其他态不迁移（合并入口显式拒绝，不偷偷复活已丢弃改动）。
 */
export function markChangesetMerged(db: SqliteDb, id: number, now: number): number {
  const info = db
    .prepare("UPDATE changesets SET state = 'merged', merged_at = ? WHERE id = ? AND state = 'open'")
    .run(now, id);
  return info.changes;
}

/**
 * 丢弃真值表（B-2）：`open → discarded`；已 discarded 幂等（0 行）；merged/rolled_back 拒绝。
 * 只改清单状态，**不动 git**（主分支/worktree/分支保留作证据）；合并入口对 discarded 显式拒。
 */
export function markChangesetDiscarded(db: SqliteDb, id: number, _now: number): number {
  return db.prepare("UPDATE changesets SET state = 'discarded' WHERE id = ? AND state = 'open'").run(id).changes;
}

/**
 * 回滚真值表：`open → rolled_back`；已 rolled_back/merged/discarded 不动。
 * 回滚产生的是反向提交而非「丢弃」——保留原变更集证据，状态显式区分。
 */
export function markChangesetRolledBack(db: SqliteDb, id: number, _now: number): number {
  return db.prepare("UPDATE changesets SET state = 'rolled_back' WHERE id = ? AND state = 'open'").run(id).changes;
}

export function listChangesetsByTask(db: SqliteDb, taskId: number): ChangesetRow[] {
  return db
    .prepare(`SELECT ${CS_COLUMNS} FROM changesets WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as ChangesetRow[];
}

export function listChangesetFiles(db: SqliteDb, changesetId: number): ChangesetFileRow[] {
  return db
    .prepare(`SELECT ${CSF_COLUMNS} FROM changeset_files WHERE changeset_id = ? ORDER BY path ASC`)
    .all(changesetId) as ChangesetFileRow[];
}

export function findChangesetByWorkItemHead(
  db: SqliteDb,
  workItemId: number,
  headSha: string | null,
): ChangesetRow | undefined {
  return db
    .prepare(`SELECT ${CS_COLUMNS} FROM changesets WHERE work_item_id = ? AND head_sha IS ?`)
    .get(workItemId, headSha) as ChangesetRow | undefined;
}

/** 把该 work item 尚未归属变更集的产物挂到 `changesetId`（`artifacts.changeset_id`，003 列）。 */
export function linkArtifactsToChangeset(db: SqliteDb, workItemId: number, changesetId: number): number {
  const info = db
    .prepare('UPDATE artifacts SET changeset_id = ? WHERE work_item_id = ? AND changeset_id IS NULL')
    .run(changesetId, workItemId);
  return info.changes;
}
