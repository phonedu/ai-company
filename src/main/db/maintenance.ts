/**
 * M2-D · 数据生命周期（器）—— WAL checkpoint ＋ 一致性备份。
 *
 * 口径（`PLAN §929`「staging 沙盒清理策略、备份一致性（WAL checkpoint）、schema 迁移机制」）：
 *  - **checkpoint**：`PRAGMA wal_checkpoint(TRUNCATE)`——把 WAL 并回主库并截断（防 `-wal` 无限增长）；
 *    **选取可控时点**调用（启动装配完成后；不在热路径里）。
 *  - **backup**：`VACUUM INTO ?`——**一致性快照**（WAL 模式下亦安全：写事务与外读互不干扰），
 *    产出**单文件**（自带全部数据、无 `-wal` 伴随文件）→ 备份/导出/迁移一个文件搞定。
 *  - **不静默**：目标文件已存在 → **抛错**（绝不静默覆盖既有备份）；调用方自己选新名字（如带时间戳）。
 *  - 内存库（测试）无 WAL：checkpoint 返回 `ok:true, busy:false`（无副作用）；backup 同样可用。
 */
import { statSync } from 'node:fs';

import type { SqliteDb } from './open.js';

export interface CheckpointResult {
  /** 是否完成（`busy=0`）。 */
  ok: boolean;
  /** SQLite 的 busy 标志（true = 有别的连接正在读/写，未能完成截断；下次时点再试即可）。 */
  busy: boolean;
}

/** WAL 合并回主库并截断 `-wal`（可控时点调用；见文件头注）。 */
export function checkpointWal(db: SqliteDb): CheckpointResult {
  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
  const busy = Number(row?.busy ?? 0) === 1;
  return { ok: !busy, busy };
}

export interface RetentionResult {
  remoteEvents: number;
  outbox: number;
  checkpoints: number;
  timers: number;
}

/** 保留期截止时刻（`retentionDays` 最小 1 天）。 */
function retentionCutoff(now: number, retentionDays: number): number {
  return now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
}

/**
 * B-4（M4）：**预览**保留清理将删除的行数（与 `runRetention` 同一判据；不删任何数据）。
 * 只覆盖四张临时表；tasks/reports/artifacts/changesets 永不在清理面。
 */
export function previewRetention(
  db: SqliteDb,
  now: number = Date.now(),
  retentionDays = 30,
): RetentionResult {
  const cutoff = retentionCutoff(now, retentionDays);
  const count = (sql: string, ...args: unknown[]): number =>
    Number((db.prepare(sql).get(...args) as { c: number }).c);
  return {
    remoteEvents: count('SELECT count(*) AS c FROM remote_event_log WHERE expires_at < ?', now),
    outbox: count(
      "SELECT count(*) AS c FROM im_outbox WHERE state IN ('sent','cancelled','expired') AND COALESCE(sent_at, created_at) < ?",
      cutoff,
    ),
    checkpoints: count(
      "SELECT count(*) AS c FROM task_checkpoints WHERE state IN ('restored','invalid') AND created_at < ?",
      cutoff,
    ),
    timers: count('SELECT count(*) AS c FROM timers WHERE fired_at IS NOT NULL AND fired_at < ?', cutoff),
  };
}

/**
 * CR15（2026-10-20）：可控数据保留。
 * - `remote_event_log` 按其自带 `expires_at`（设计字段，过期即可清）；
 * - `im_outbox` 只清 sent/cancelled/expired 且超过 30 天；
 * - `task_checkpoints` 只清 restored/invalid 且超过 30 天（open 检查点保留给回滚）；
 * - `timers` 只清已 fired 且超过 30 天。
 * 不删除 tasks/reports/artifacts/changesets；调用于启动装配后，返回真实行数（不写假读数）。
 */
export function runRetention(
  db: SqliteDb,
  now: number = Date.now(),
  retentionDays = 30,
): RetentionResult {
  const cutoff = retentionCutoff(now, retentionDays);
  const remote = db.prepare('DELETE FROM remote_event_log WHERE expires_at < ?').run(now);
  const outbox = db
    .prepare(
      "DELETE FROM im_outbox WHERE state IN ('sent','cancelled','expired') AND COALESCE(sent_at, created_at) < ?",
    )
    .run(cutoff);
  const checkpoints = db
    .prepare("DELETE FROM task_checkpoints WHERE state IN ('restored','invalid') AND created_at < ?")
    .run(cutoff);
  const timers = db.prepare('DELETE FROM timers WHERE fired_at IS NOT NULL AND fired_at < ?').run(cutoff);
  return {
    remoteEvents: Number(remote.changes),
    outbox: Number(outbox.changes),
    checkpoints: Number(checkpoints.changes),
    timers: Number(timers.changes),
  };
}

export interface BackupResult {
  path: string;
  bytes: number;
}

/**
 * 一致性备份到 `destPath`（单文件）。**目标已存在 → 抛错**（不静默覆盖；调用方选新名字）。
 * 失败（磁盘满/权限）→ 让错误冒泡（不假装成功）。
 */
export function backupDatabase(db: SqliteDb, destPath: string): BackupResult {
  let existed = true;
  try {
    statSync(destPath);
  } catch {
    existed = false;
  }
  if (existed) throw new Error(`[db] 备份目标已存在（不静默覆盖）：${destPath}`);
  db.prepare('VACUUM INTO ?').run(destPath);
  return { path: destPath, bytes: statSync(destPath).size };
}
