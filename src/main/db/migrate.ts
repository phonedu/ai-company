/**
 * 迁移执行器（DEV §4.1「迁移与台账」）。
 *
 * 机制：
 *  - 台账 `schema_migrations(version PK, name, applied_at, checksum)` 是可审计的已应用清单。
 *  - `PRAGMA user_version` 只作快速门槛/兼容旧库（0 = 空库）。
 *  - **一个迁移 = 一个事务**：应用 DDL + 写 `schema_migrations` + 置 `user_version`；
 *    任一步失败 → 整体 ROLLBACK（`user_version` 也是事务性的，已实测）。
 *  - 版本号已存在于台账 → 跳过；`checksum` 不匹配 → 报错（禁止改写历史迁移）。
 *  - **迁移期 FK 关闭**（sqlite.org 官方「12 步法」）：每个迁移在 `foreign_keys = OFF` 下执行、
 *    `finally` 恢复 ON——**重建带子表外键的表**必须如此（`PRAGMA foreign_keys` 只能在事务外切换；
 *    「一迁移一事务」不受影响：开关在 BEGIN 前 / COMMIT 后）。首个用例：`008` 重建 `reports`
 *    （子表 `notifications`/`approvals` 的 `report_id` 引用；005 重建 `costs` 时无子表引用，故未涉及）。
 *  - 基线 DDL 全部 `IF NOT EXISTS`，可幂等重跑。
 */
import { loadMigrations, type Migration } from './migrations.js';
import type { SqliteDb } from './open.js';

export interface MigrateResult {
  /** 本次实际应用的版本号（升序）。 */
  applied: number[];
  /** 因已应用而跳过的版本号（升序）。 */
  skipped: number[];
  /** 迁移集里的最新版本（迁移集为空时回退为库内 user_version）。 */
  latest: number;
  /** 执行后的 `PRAGMA user_version`。 */
  userVersion: number;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  checksum    TEXT
);`;

interface LedgerRow {
  version: number;
  name: string;
  applied_at: number;
  checksum: string | null;
}

/** 确保台账存在（幂等）。迁移器启动先调它，才能读取「已应用清单」。 */
export function ensureLedger(db: SqliteDb): void {
  db.exec(LEDGER_DDL);
}

export function getUserVersion(db: SqliteDb): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function listApplied(db: SqliteDb): LedgerRow[] {
  ensureLedger(db);
  return db
    .prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version')
    .all() as LedgerRow[];
}

/** 应用所有未执行的迁移；幂等（已应用的跳过）。 */
export function runMigrations(
  db: SqliteDb,
  migrations: Migration[] = loadMigrations(),
  now: number = Date.now(),
): MigrateResult {
  ensureLedger(db);
  const appliedByVersion = new Map<number, LedgerRow>(
    (db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations').all() as LedgerRow[]).map(
      (row) => [row.version, row],
    ),
  );

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of migrations) {
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.checksum && existing.checksum !== migration.checksum) {
        throw new Error(
          `[db] 迁移 ${migration.version} (${existing.name}) checksum 不一致：` +
            `库内=${existing.checksum} 文件=${migration.checksum}；禁止改写历史迁移`,
        );
      }
      skipped.push(migration.version);
      continue;
    }

    // 12 步法：重建带子表外键的表必须在 FK 关闭时做（见文件头注；008 是首个用例）。失败路径同样恢复。
    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      try {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES(?, ?, ?, ?)').run(
          migration.version,
          migration.name,
          now,
          migration.checksum,
        );
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
    applied.push(migration.version);
  }

  return {
    applied,
    skipped,
    latest: migrations.length > 0 ? (migrations[migrations.length - 1] as Migration).version : getUserVersion(db),
    userVersion: getUserVersion(db),
  };
}
