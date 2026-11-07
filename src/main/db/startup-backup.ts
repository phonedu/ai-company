/**
 * B0-12（57 D 路 P2）：**迁移前自动备份**。
 *
 * 背景：`backupDatabase`（VACUUM INTO）此前全仓零调用；迁移写坏真实库时老板没有可回退副本。
 * 口径：库非空（user_version>0）且有未应用迁移 → 备份到 `<dataDir>/backups/`（保留最近 N 份，默认 3）。
 * 备份失败**向上抛**（调用方拒绝继续迁移）——宁可不启动，也不在无副本的情况下动真实数据。
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadMigrations } from './migrations.js';
import { backupDatabase } from './maintenance.js';
import { getUserVersion } from './migrate.js';
import type { SqliteDb } from './open.js';

export interface BackupBeforeMigrationResult {
  path: string | null;
  bytes?: number;
  /** `backed_up` | `up_to_date` | `empty_db` */
  reason: string;
}

export interface BackupBeforeMigrationOptions {
  /** 数据目录（备份落在 `<dataDir>/backups/`）。 */
  dataDir: string;
  /** 测试注入：迁移集最新版本（缺省读 loadMigrations()）。 */
  latestVersion?: number;
  /** 注入时钟（文件名可测）。 */
  now?: number;
  /** 保留份数（默认 3；最小 1）。 */
  keep?: number;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 迁移前的安全副本；返回 `path:null` 表示无需备份（空库/已最新）。 */
export function backupBeforeMigration(
  db: SqliteDb,
  options: BackupBeforeMigrationOptions,
): BackupBeforeMigrationResult {
  const current = getUserVersion(db);
  if (!Number.isFinite(current) || current <= 0) return { path: null, reason: 'empty_db' };
  const migrations = loadMigrations();
  const latest = options.latestVersion ?? (migrations.length > 0 ? migrations[migrations.length - 1]!.version : current);
  if (current >= latest) return { path: null, reason: 'up_to_date' };

  const keep = Math.max(1, Math.trunc(options.keep ?? 3));
  const dir = join(options.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const now = options.now ?? Date.now();
  let dest = join(dir, `aico-before-v${latest}-${stamp(now)}.sqlite`);
  // 同秒重入（测试/快速重启）：加序号，绝不覆盖既有备份（backupDatabase 也会拒绝覆盖）。
  let seq = 1;
  while (true) {
    try {
      statSync(dest);
      dest = join(dir, `aico-before-v${latest}-${stamp(now)}-${seq}.sqlite`);
      seq += 1;
    } catch {
      break;
    }
  }
  const res = backupDatabase(db, dest);
  // 保留最近 N 份（按文件名倒序＝时间序）；清理失败只报告，不阻断本次启动。
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('aico-before-v') && f.endsWith('.sqlite'))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch (error) {
    console.error('[db] 旧备份清理失败（不影响本次备份）', error);
  }
  return { path: res.path, bytes: res.bytes, reason: 'backed_up' };
}
