/**
 * B3-2/D-31③ · 多文档根注册层——`project_documents` 表＋DAO＋读边界扩展。
 *
 * 口径：只做多**文档**根注册（素材/知识目录挂到项目），**多代码根不做**（代码仍单 root_dir）。
 * 员工读边界扩到已注册文档根（只读）；越根写仍拒（gate.ts path_scope 不扩写）。
 */
import { join } from 'node:path';

import type { SqliteDb } from './open.js';

export interface ProjectDocumentRow {
  id: number;
  project_id: number;
  dir: string;
  label: string;
  enabled: number;
  created_at: number;
}

export function insertProjectDocument(
  db: SqliteDb,
  input: { projectId: number; dir: string; label?: string; now?: number },
): { ok: true; id: number } | { ok: false; error: string } {
  const dir = (input.dir ?? '').trim();
  if (dir.length === 0) return { ok: false, error: 'dir 必填' };
  if (!/^[a-zA-Z]:[\\/]|^\//.test(dir)) return { ok: false, error: 'dir 必须是绝对路径' };
  const label = (input.label ?? dir.split(/[\\/]/).pop() ?? '').trim();
  const info = db
    .prepare(
      'INSERT INTO project_documents(project_id, dir, label, enabled, created_at) VALUES(?, ?, ?, 1, ?)',
    )
    .run(input.projectId, dir, label, input.now ?? Date.now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function listProjectDocuments(db: SqliteDb, projectId: number): ProjectDocumentRow[] {
  return db
    .prepare('SELECT id, project_id, dir, label, enabled, created_at FROM project_documents WHERE project_id = ? AND enabled = 1 ORDER BY id')
    .all(projectId) as ProjectDocumentRow[];
}

export function disableProjectDocument(db: SqliteDb, docId: number): void {
  db.prepare('UPDATE project_documents SET enabled = 0 WHERE id = ?').run(docId);
}

/** 员工读边界扩展：取项目的全部启用文档根绝对路径（权限层 read 圈根扩展用）。 */
export function projectDocRoots(db: SqliteDb, projectId: number): string[] {
  return listProjectDocuments(db, projectId).map((r) => r.dir);
}
