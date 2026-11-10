/**
 * / · 产物版本快照（双轨）——staging＝git 提交即版本；inplace＝登记时快照。
 *
 * staging：worktree 底座已有 git 提交，产物行挂 head_sha（现有行为扩展）。
 * inplace：无 git worktree ⇒ 登记时把文件复制到 `.aico/versions/<artifactId>` 快照。
 * 详情页「与上一版 diff」＝同一 path 的上一版 snapshot 与当前版本做行级 diff。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDb } from '../db/open.js';

/** inplace 产物快照：复制到 `.aico/versions/<artifactId>`；返回快照路径或 null（文件不存在/内存库）。 */
export function snapshotArtifactFile(db: SqliteDb, artifactId: number, absPath: string): string | null {
  try {
    const dbName = (db as unknown as { name?: string }).name ?? ':memory:';
    if (dbName === ':memory:') return null;
    const snapshotDir = join(dbName, '..', '.aico', 'versions');
    mkdirSync(snapshotDir, { recursive: true });
    const dest = join(snapshotDir, String(artifactId));
    copyFileSync(absPath, dest);
    return dest;
  } catch (error) {
    console.error('[artifact-snapshot] 快照失败（不阻塞登记）', error);
    return null;
  }
}

/** 行级 diff（LCS 简化版：返回变更行数与摘要；不生成完整 unified diff）。 */
export function diffSummary(oldText: string, newText: string): { added: number; removed: number; changed: boolean } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => !newSet.has(l)).length;
  return { added, removed, changed: added > 0 || removed > 0 };
}

/** 与上一版 diff（读 `.aico/versions/` 中同 path 的前一个 snapshot）。 */
export function diffWithPrevious(
  db: SqliteDb,
  artifactPath: string,
  currentAbsPath: string,
): { changed: boolean; added: number; removed: number; previousSnapshotPath: string | null } {
  const dbName = (db as unknown as { name?: string }).name ?? ':memory:';
  if (dbName === ':memory:') return { changed: false, added: 0, removed: 0, previousSnapshotPath: null };
  const snapshotDir = join(dbName, '..', '.aico', 'versions');
  if (!existsSync(snapshotDir)) return { changed: false, added: 0, removed: 0, previousSnapshotPath: null };
  const currentContent = existsSync(currentAbsPath) ? readFileSync(currentAbsPath, 'utf8') : '';
  //  终验 P1 修正：按 artifactPath 查库找同产物历史快照 id（不看全部目录——跨产物 diff 是错的）。
  try {
    const rows = db.prepare(
      'SELECT a.id FROM artifacts a WHERE a.path = ? ORDER BY a.id DESC LIMIT 5'
    ).all(artifactPath) as Array<{ id: number }>;
    for (const row of rows) {
      const fp = join(snapshotDir, String(row.id));
      if (!existsSync(fp)) continue;
      try {
        const oldContent = readFileSync(fp, 'utf8');
        const result = diffSummary(oldContent, currentContent);
        if (result.changed) return { ...result, previousSnapshotPath: fp };
      } catch { /* 跳过不可读项 */ }
    }
  } catch { /* 查库失败 */ }
  return { changed: false, added: 0, removed: 0, previousSnapshotPath: null };
}

/** sha256（产物行扩展用）。 */
export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
