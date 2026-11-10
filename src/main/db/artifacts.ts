/**
 * `artifacts` 数据访问（产物元信息； 读、 第 5 项**写者**）。
 *
 * 列的口径（003 之后）：`source`（来源归属，与 G2 会话/cwd 归一化同源）· `changeset_id`（产物↔变更集）·
 * `commit_sha`（产物所在提交）。**消费端保持列无关**（`ipc/repo.ts#listArtifactsForTask` 用
 * `PRAGMA table_info` 探测、缺列 → null）⇒ 加列不破任何调用方。
 *
 * **事务边界**：本模块**不自己开事务**（引擎在批次事务内调用；单测直接调用走 autocommit）。
 */
import type { SqliteDb } from './open.js';

export interface ArtifactRow {
  id: number;
  task_id: number;
  work_item_id: number | null;
  path: string;
  kind: string;
  note: string;
  sha256: string | null;
  created_at: number;
  /** 003 起存在；老库（未升 003）读作 undefined。 */
  source?: string | null;
  changeset_id?: number | null;
  commit_sha?: string | null;
  /** 007（G-A）起存在；引用副本的来源链条（NULL＝自产）。 */
  origin_artifact_id?: number | null;
  origin_project_id?: number | null;
}

export interface InsertArtifactInput {
  taskId: number;
  workItemId?: number | null;
  path: string;
  kind?: string;
  note?: string;
  sha256?: string | null;
  /** 归属（G2 归一化口径：`<accessMode>:<collapsePath(cwd)>`）。 */
  source?: string | null;
  changesetId?: number | null;
  /** 007（G-A）：引用副本的来源链条（被引用的源产物 id 与其项目 id）；缺省 NULL＝自产。 */
  originArtifactId?: number | null;
  originProjectId?: number | null;
  now: number;
}

/** 探测列存在性（**列无关**：老库没有 003 列时不写它们）。 */
function artifactColumns(db: SqliteDb): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((c) => c.name));
}

/**
 * 写一条产物（**幂等**：同一 `(task_id, work_item_id, path)` 已存在则跳过）。
 * 返回 `{ id, created }`；被跳过时 `id` 为既有行 id。
 *
 * 幂等键含 `task_id`（2026-10-14 修）：此前只有 `(work_item_id, path)`——任务级产物（`work_item_id=NULL`，
 * 如引用副本）会在**跨任务**之间用同一相对路径互相顶掉（后写方拿不到自己的行）。按任务分区才语义正确。
 */
export function insertArtifact(db: SqliteDb, input: InsertArtifactInput): { id: number; created: boolean } {
  const cols = artifactColumns(db);
  const hasSource = cols.has('source');
  const hasChangeset = cols.has('changeset_id');
  const all = ['task_id', 'work_item_id', 'path', 'kind', 'note', 'sha256', 'created_at'];
  const values: unknown[] = [
    input.taskId,
    input.workItemId ?? null,
    input.path,
    input.kind ?? 'file',
    input.note ?? '',
    input.sha256 ?? null,
    input.now,
  ];
  if (hasSource) {
    all.push('source');
    values.push(input.source ?? null);
  }
  if (hasChangeset) {
    all.push('changeset_id');
    values.push(input.changesetId ?? null);
  }
  if (cols.has('origin_artifact_id')) {
    all.push('origin_artifact_id');
    values.push(input.originArtifactId ?? null);
  }
  if (cols.has('origin_project_id')) {
    all.push('origin_project_id');
    values.push(input.originProjectId ?? null);
  }
  const info = db
    .prepare(
      `INSERT INTO artifacts(${all.join(', ')})
       SELECT ${all.map(() => '?').join(', ')}
       WHERE NOT EXISTS (
         SELECT 1 FROM artifacts
         WHERE task_id = ? AND coalesce(work_item_id, -1) = coalesce(?, -1) AND path = ?
       )`,
    )
    .run(...values, input.taskId, input.workItemId ?? null, input.path);
  if (info.changes > 0) return { id: Number(info.lastInsertRowid), created: true };
  const existing = db
    .prepare('SELECT id FROM artifacts WHERE task_id = ? AND coalesce(work_item_id, -1) = coalesce(?, -1) AND path = ?')
    .get(input.taskId, input.workItemId ?? null, input.path) as { id: number };
  return { id: existing.id, created: false };
}

export function listArtifactsByTask(db: SqliteDb, taskId: number): ArtifactRow[] {
  return db
    .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as ArtifactRow[];
}

/** G-A（007）：按 id 取一条产物（引用动作的源侧读取）；不存在 → `undefined`（不臆造）。 */
export function getArtifactById(db: SqliteDb, id: number): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
}
