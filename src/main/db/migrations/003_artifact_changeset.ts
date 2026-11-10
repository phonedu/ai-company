/**
 * 003_artifact_changeset.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `003_artifact_changeset.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_003_ARTIFACT_CHANGESET = `-- 003_artifact_changeset.sql — v3（第 5 项）
--   \`artifacts\` 归属列（**版本化决定**：本迁移取代 \`0a8df72\` 的 (b)「no artifacts provenance columns」；
--   计划口径见设计记录 L100/L134/L236；G2 归属归一化 + diff tab join 需要）
--     · source = 产物来源归属（与 G2 的会话/cwd 归一化同源）
--     · changeset_id = 产物 ↔ 变更集（变更审查；@5 的 diff tab join 用）
--     · commit_sha = 产物所在提交（列名避开 SQL 关键字 commit；DTO 侧映射为 \`commit\`）
--   注：\`at\` 列**不加**——\`artifacts.created_at\` 已存在（@0 2026-10-13 裁定）。
--   \`changesets\` 写者幂等索引（同一 work_item 的同一 head_sha 只写一次）。
-- 约定：只加不减（SQLite 旧库不保证 DROP COLUMN）；add-only、nullable ⇒ 老库升级零破坏。
-- 「列无关口径」：消费端 ipc/repo.ts#listArtifactsForTask 用 PRAGMA table_info 探测列，缺列 → null。
ALTER TABLE artifacts ADD COLUMN source TEXT;
ALTER TABLE artifacts ADD COLUMN changeset_id INTEGER REFERENCES changesets(id);
ALTER TABLE artifacts ADD COLUMN commit_sha TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_changesets_wi_head ON changesets(work_item_id, head_sha);
`;
