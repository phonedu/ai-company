/**
 * OPT-M4-1 · `seams` DAO（接缝矩阵的行载体；`schema.sql` 由迁移 `002` 建表）。
 * `UNIQUE(project_id, boundary)`；`status ∈ covered|gap`；`coverage_ref`/`owner`/`milestone` 为行属性。
 */
import type { SeamStatus } from '../seams/index.js';
import type { SqliteDb } from './open.js';

export interface SeamRow {
  id: number;
  project_id: number;
  boundary: string;
  status: SeamStatus | string;
  coverage_ref: string | null;
  owner: string | null;
  milestone: string | null;
  created_at: number;
}

export interface UpsertSeamInput {
  projectId: number;
  boundary: string;
  status: SeamStatus;
  coverageRef?: string | null;
  owner?: string | null;
  milestone?: string | null;
  now?: number;
}

const COLUMNS = 'id, project_id, boundary, status, coverage_ref, owner, milestone, created_at';

export function upsertSeam(db: SqliteDb, input: UpsertSeamInput): SeamRow {
  db.prepare(
    `INSERT INTO seams(project_id, boundary, status, coverage_ref, owner, milestone, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, boundary) DO UPDATE SET
       status = excluded.status, coverage_ref = excluded.coverage_ref,
       owner = excluded.owner, milestone = excluded.milestone`,
  ).run(
    input.projectId,
    input.boundary,
    input.status,
    input.coverageRef ?? null,
    input.owner ?? null,
    input.milestone ?? null,
    input.now ?? Date.now(),
  );
  return getSeam(db, input.projectId, input.boundary) as SeamRow;
}

export function getSeam(db: SqliteDb, projectId: number, boundary: string): SeamRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM seams WHERE project_id = ? AND boundary = ?`)
    .get(projectId, boundary) as SeamRow | undefined;
}

export function listSeams(db: SqliteDb, projectId?: number): SeamRow[] {
  if (projectId == null) {
    return db.prepare(`SELECT ${COLUMNS} FROM seams ORDER BY project_id, boundary`).all() as SeamRow[];
  }
  return db.prepare(`SELECT ${COLUMNS} FROM seams WHERE project_id = ? ORDER BY boundary`).all(projectId) as SeamRow[];
}

export function setSeamStatus(db: SqliteDb, projectId: number, boundary: string, status: SeamStatus): boolean {
  const info = db.prepare('UPDATE seams SET status = ? WHERE project_id = ? AND boundary = ?').run(status, projectId, boundary);
  return info.changes > 0;
}
