/**
 * SQLite 连接（better-sqlite3）—— 主进程唯一写者（/§7.4）。
 *
 * 连接级 PRAGMA 在此设置（**不放进迁移 SQL**）：
 *  - `journal_mode = WAL`：更好并发读；且该 pragma 不能在事务内执行（迁移是「一个迁移 = 一个事务」）。
 *  - `foreign_keys = ON`：外键约束必须逐连接开启，迁移里的 REFERENCES 才有意义。
 *  - `busy_timeout`：串行写者下给锁等待一个上界。
 */
import Database from 'better-sqlite3';

/** better-sqlite3 的 Database 实例类型（不额外依赖其命名空间导出）。 */
export type SqliteDb = InstanceType<typeof Database>;

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** 默认 true：非只读时应用 WAL / foreign_keys / busy_timeout。 */
  applyPragmas?: boolean;
}

/** 打开（必要时创建）一个 SQLite 文件库，并设置连接级 PRAGMA。 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): SqliteDb {
  const readonly = options.readonly ?? false;
  const db = new Database(file, {
    readonly,
    fileMustExist: options.fileMustExist ?? false,
  });
  if ((options.applyPragmas ?? true) && !readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

/** 打开内存库（测试用）。内存库不支持 WAL，故只开外键。 */
export function openMemoryDatabase(): SqliteDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}
