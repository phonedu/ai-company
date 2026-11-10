/**
 * 016_memory_items.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `016_memory_items.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_016_MEMORY_ITEMS = `-- 016_memory_items.sql — v16（记忆体系 v1：L2/L3 事实层 + 审计）
--
-- 为什么需要：\`employee_memory\` 是按员工×项目的任务摘要（L1），不能当项目共享事实，
-- 也不能承载用户确认的全局偏好；本迁移新增 \`memory_items\`（L2 项目事实 / L3 全局事实）
-- 与 \`memory_events\`（写入/取代/归档审计）。时间化：valid_from/valid_to 表示现实有效性，
-- created_at/updated_at 表示系统何时知道；旧事实失效不删除（superseded_by 保留历史）。
--
-- 口径见 \`docs/work/design-memory-v1.md\` §6；。
CREATE TABLE IF NOT EXISTS memory_items (
  id              INTEGER PRIMARY KEY,
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('project', 'global')),
  scope_id        INTEGER NOT NULL DEFAULT 0,          -- project.id；global=0
  kind            TEXT NOT NULL,                       -- fact / decision / preference / glossary / constraint
  key             TEXT,                                -- 结构化键；自由文本可空
  value           TEXT NOT NULL,
  source_type     TEXT NOT NULL,                       -- boss / assistant / employee / task / doc / artifact
  source_ref      TEXT,
  source_excerpt  TEXT,
  confidence      TEXT NOT NULL DEFAULT 'provisional' CHECK (confidence IN ('confirmed', 'provisional', 'inferred')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  pinned          INTEGER NOT NULL DEFAULT 0,
  valid_from      INTEGER,
  valid_to        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  last_verified_at INTEGER,
  superseded_by   INTEGER REFERENCES memory_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_scope
  ON memory_items(scope_type, scope_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_key
  ON memory_items(scope_type, scope_id, kind, key)
  WHERE status = 'active' AND key IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER,
  action      TEXT NOT NULL,                           -- create / update / supersede / archive / delete / promote
  actor       TEXT NOT NULL,
  source_type TEXT,
  source_ref  TEXT,
  before_json TEXT,
  after_json  TEXT,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_item
  ON memory_events(item_id, id);
`;
