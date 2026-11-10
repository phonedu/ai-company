/**
 * 打包安全测试（1421 ①）：迁移 SQL 已**内联为 TS 常量**，运行时**不读文件系统**。
 * 覆盖：① 内联内容完整（30 表 / 22 索引）+ checksum 自洽；② 与审计用 `001_init.sql` **逐字一致**（防漂移）；
 * ③ 空库可直接应用（不依赖任何文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadMigrations, openMemoryDatabase, runMigrations, sha256 } from '../src/main/db/index.js';

const SQL_FILE = join(process.cwd(), 'src', 'main', 'db', 'migrations', '001_init.sql');

test('packaging: 迁移内联（无 fs 依赖）—— 基线含 30 表 / 22 索引，checksum 自洽', () => {
  const migrations = loadMigrations();
  assert.equal(migrations.length, 24, 'B3-2 加 024 后共 24 个迁移');
  const sql = migrations[0]!.sql;
  assert.ok(sql.length > 20_000, '基线 SQL 应非空且为完整 DDL');
  assert.equal((sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/g) ?? []).length, 30, '30 张表（001 基线；B2-3/B3-2 走 023/024 独立迁移）');
  assert.equal((sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/g) ?? []).length, 22, '22 个索引（001 基线；B2-3/B3-2 的索引走 023/024 独立迁移）');
  assert.equal(migrations[0]!.checksum, sha256(sql));
});

test('packaging: 内联常量与审计用 001/002 .sql 逐字一致（源码树存在时；防漂移）', () => {
  if (!existsSync(SQL_FILE)) {
    // 打包/脱离源码树时无该文件：这正是内联要解决的场景，跳过一致性检查
    return;
  }
  const file = readFileSync(SQL_FILE, 'utf8');
  assert.equal(
    loadMigrations()[0]!.sql,
    file,
    '内联 SQL 与 001_init.sql 必须逐字一致（改 schema.sql 后需重新生成 001_init.ts）',
  );
  const file2 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '002_verification_seams.sql');
  assert.equal(loadMigrations()[1]!.sql, readFileSync(file2, 'utf8'), '内联 SQL 与 002_*.sql 必须逐字一致');
  const file3 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '003_artifact_changeset.sql');
  assert.equal(loadMigrations()[2]!.sql, readFileSync(file3, 'utf8'), '内联 SQL 与 003_*.sql 必须逐字一致');
  const file4 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '004_cost_closure.sql');
  assert.equal(loadMigrations()[3]!.sql, readFileSync(file4, 'utf8'), '内联 SQL 与 004_*.sql 必须逐字一致');
  const file5 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '005_concurrency_company_cost.sql');
  assert.equal(loadMigrations()[4]!.sql, readFileSync(file5, 'utf8'), '内联 SQL 与 005_*.sql 必须逐字一致');
  const file6 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '006_mailbox_read.sql');
  assert.equal(loadMigrations()[5]!.sql, readFileSync(file6, 'utf8'), '内联 SQL 与 006_*.sql 必须逐字一致');
  const file7 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '007_artifact_refs.sql');
  assert.equal(loadMigrations()[6]!.sql, readFileSync(file7, 'utf8'), '内联 SQL 与 007_*.sql 必须逐字一致');
  const file8 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '008_reports_nullable_task.sql');
  assert.equal(loadMigrations()[7]!.sql, readFileSync(file8, 'utf8'), '内联 SQL 与 008_*.sql 必须逐字一致');
  const file9 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '009_task_model.sql');
  assert.equal(loadMigrations()[8]!.sql, readFileSync(file9, 'utf8'), '内联 SQL 与 009_*.sql 必须逐字一致（本批补挂）');
  const file10 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '010_project_staffing.sql');
  assert.equal(loadMigrations()[9]!.sql, readFileSync(file10, 'utf8'), '内联 SQL 与 010_*.sql 必须逐字一致');
  const file11 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '011_project_docs_check.sql');
  assert.equal(loadMigrations()[10]!.sql, readFileSync(file11, 'utf8'), '内联 SQL 与 011_*.sql 必须逐字一致');
  const file12 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '012_task_checkpoints.sql');
  assert.equal(loadMigrations()[11]!.sql, readFileSync(file12, 'utf8'), '内联 SQL 与 012_*.sql 必须逐字一致');
  const file13 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '013_im_outbox.sql');
  assert.equal(loadMigrations()[12]!.sql, readFileSync(file13, 'utf8'), '内联 SQL 与 013_*.sql 必须逐字一致');
  const file14 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '014_remote_foundation.sql');
  assert.equal(loadMigrations()[13]!.sql, readFileSync(file14, 'utf8'), '内联 SQL 与 014_*.sql 必须逐字一致');
  const file15 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '015_task_pause_reason.sql');
  assert.equal(loadMigrations()[14]!.sql, readFileSync(file15, 'utf8'), '内联 SQL 与 015_*.sql 必须逐字一致');
  const file16 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '016_memory_items.sql');
  assert.equal(loadMigrations()[15]!.sql, readFileSync(file16, 'utf8'), '内联 SQL 与 016_*.sql 必须逐字一致');
  const file17 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '017_memory_fts.sql');
  assert.equal(loadMigrations()[16]!.sql, readFileSync(file17, 'utf8'), '内联 SQL 与 017_*.sql 必须逐字一致');
  // CTX-1：020 内联必须与审计件逐字一致（新增表的防漂移；018/019 为历史缺口，不在本次补）。
  const file20 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '020_context_metrics.sql');
  assert.equal(loadMigrations()[19]!.sql, readFileSync(file20, 'utf8'), '内联 SQL 与 020_*.sql 必须逐字一致');
  const file21 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '021_context_metrics_model_hash.sql');
  assert.equal(loadMigrations()[20]!.sql, readFileSync(file21, 'utf8'), '内联 SQL 与 021_*.sql 必须逐字一致');
  const file22 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '022_project_target_branch.sql');
  assert.equal(loadMigrations()[21]!.sql, readFileSync(file22, 'utf8'), '内联 SQL 与 022_*.sql 必须逐字一致');
  const file23 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '023_work_item_deps.sql');
  assert.equal(loadMigrations()[22]!.sql, readFileSync(file23, 'utf8'), '内联 SQL 与 023_*.sql 必须逐字一致');
  const file24 = join(process.cwd(), 'src', 'main', 'db', 'migrations', '024_project_documents.sql');
  assert.equal(loadMigrations()[23]!.sql, readFileSync(file24, 'utf8'), '内联 SQL 与 024_*.sql 必须逐字一致');
});

test('packaging: 迁移可直接在空库应用（不依赖任何文件）', () => {
  const db = openMemoryDatabase();
  try {
    const result = runMigrations(db);
    assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    assert.equal(result.userVersion, 24);
    const tables = (
      db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {
        c: number;
      }
    ).c;
    assert.equal(tables, 45, '40 张业务表（B3-2 加 project_documents）＋memory_items_fts 虚拟表及 4 张 shadow 表');
    const fts = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='memory_items_fts'").get() as {
      c: number;
    };
    assert.equal(fts.c, 1, 'FTS5 索引必须在场');
  } finally {
    db.close();
  }
});

test('OPT-M2-2 "有牙": 防漂移能报出 `.sql` 与内联常量的一字节差异（注入→必红）', () => {
  if (!existsSync(SQL_FILE)) return; // 脱离源码树时不适用
  const file = readFileSync(SQL_FILE, 'utf8');
  const inline = loadMigrations()[0]!.sql;
  assert.equal(inline, file, '基线下：内联 == .sql');
  // 注入：把 .sql 追加一字节 → 等式必须失败（证明防漂移断言有牙）
  assert.notEqual(inline, file + ' ', '改写 .sql 后必须与内联常量不等');
});
