#!/usr/bin/env node
// gen-migrations.mjs — 从审计 SQL 生成打包内联的迁移常量 `NNN_*.ts`（单一真源自动化）。
//
// 背景（`708329c`）：打包后 main 产物在 `out/`（并进 asar），按"源码树/cwd"探测找不到迁移 SQL；
// 故迁移 DDL 内联为 TS 常量。人工"改 SQL → 重新生成 .ts"这步易漏，本脚本把它变成一条命令。
//
// 真源链：`schema.sql`（唯一权威）→ `src/main/db/migrations/NNN_*.sql`（审计件）
//         →（本脚本）→ `src/main/db/migrations/NNN_*.ts`（打包内联常量）。
// `src/main/db/migrations.ts` 运行时只读常量；`test/migrations-packaging.test.ts` 在源码树存在时
// 断言「常量 === 对应 .sql 逐字一致」——与 G-10「单一真源」同族：让两处不一致**结构上被测试抓到**。
//
// 用法：node scripts/gen-migrations.mjs （或 `pnpm gen:migrations`，其接线由 package.json owner 添加）
// 说明：扫描目录下全部 `NNN_name.sql`（升序）；若目标 `.ts` 已存在则**保留其原有头部注释**，
//       只重写 `export const ... = \`...\`;` 主体，避免无谓 diff。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src', 'main', 'db', 'migrations');

// 模板字面量转义：反斜杠 → 先转；反引号；${ 组合。
function escapeTemplate(sql) {
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** `003_artifact_changeset.sql` → `SQL_003_ARTIFACT_CHANGESET`。 */
function constName(file) {
  const base = file.replace(/\.sql$/, '');
  const [version, ...rest] = base.split('_');
  return `SQL_${version}_${rest.join('_').toUpperCase()}`;
}

const files = readdirSync(dir)
  .filter((f) => /^\d{3}_.+\.sql$/.test(f))
  .sort();

let wrote = 0;
for (const file of files) {
  const srcSql = join(dir, file);
  const outTs = join(dir, file.replace(/\.sql$/, '.ts'));
  const name = constName(file);
  const sql = readFileSync(srcSql, 'utf8');

  const header = existsSync(outTs)
    ? (readFileSync(outTs, 'utf8').split('export const')[0] ?? '')
    : `/** \n * ${file.replace(/\.sql$/, '.ts')} — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。\n * 与同目录 \`${file}\` 逐字一致（\`test/migrations-packaging.test.ts\` 校验漂移）。\n */\n`;

  writeFileSync(outTs, `${header}export const ${name} = \`${escapeTemplate(sql)}\`;\n`);
  wrote += 1;
  console.log(`[gen-migrations] wrote ${outTs} (source: ${srcSql}, ${Buffer.byteLength(sql, 'utf8')} bytes)`);
}
console.log(`[gen-migrations] ${wrote} migration(s)`);
