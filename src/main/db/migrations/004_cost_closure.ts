/**
 * 004_cost_closure.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `004_cost_closure.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_004_COST_CLOSURE = `-- 004_cost_closure.sql — v4（OPT-AI-8 成本闭环；2026-10-14）
--   \`costs\` 追加**成本与缓存计量**列——底座已算好、此前被我们丢掉的部分：
--     · \`getSessionStats().cost\`（USD 总额）与 \`.tokens.cacheRead / cacheWrite\`
--   本迁移只加列、不改语义；\`tasks.cost_tokens\` 的预算口径**不变**（仍 = tokens_in + tokens_out；缓存单独入列、可见可审计）。
--     · project_id         = 项目归属（免 join 取项目；历史行为 NULL = 未知，不回填）
--     · cache_read_tokens  = 缓存命中输入（成本大头之一；**不计入预算 tokens**，只入账）
--     · cache_write_tokens = 缓存写入输入
--   约定：add-only（SQLite 旧库不保证 DROP COLUMN）；老库升级零破坏（同 003）。
ALTER TABLE costs ADD COLUMN project_id INTEGER;
ALTER TABLE costs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE costs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
`;
