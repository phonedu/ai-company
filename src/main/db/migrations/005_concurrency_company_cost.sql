-- 005_concurrency_company_cost.sql — v5（N3：P20 扇出上限 ＋ C2 公司级开销）
--   **P20 扇出上限**：`tasks` 加 `max_parallel_work_items`（NULL = 用引擎默认，缺省 3）。
--     「同一任务内 agent ≤3、**除幕僚长**」的实现口径：幕僚长**不持有 work item**（它是老板频道会话）
--     ⇒ 本列/闸门**天然不约束它**，无需特判。
--   **C2 公司级开销**：`costs.task_id` 放宽为可空 —— 幕僚长闲聊、全局检索这类**无任务的共享开销**从此可记账。
--     SQLite 改 `NOT NULL` 需**重建表**（12 步法）：本重建**列集保持不变**（含 004 的 `project_id`/`cache_*`），
--     数据原样搬迁、索引重建；**老库升级零破坏**、可重复跑（IF NOT EXISTS 与幂等 INSERT 已保证）。
--   注：`employees.state`（闲置休眠）**本次不加** —— 等实现休眠时随其迁移一起加，避免"加了没人用"的悬空列。
ALTER TABLE tasks ADD COLUMN max_parallel_work_items INTEGER;

CREATE TABLE costs_rebuild (
  id                 INTEGER PRIMARY KEY,
  task_id            INTEGER REFERENCES tasks(id),   -- C2：可空 = 公司级开销（幕僚长/全局检索）
  work_item_id       INTEGER REFERENCES work_items(id),
  employee_id        INTEGER,
  model              TEXT NOT NULL,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  usd                REAL NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  project_id         INTEGER,
  created_at         INTEGER NOT NULL
);

INSERT INTO costs_rebuild (id, task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, cache_read_tokens, cache_write_tokens, project_id, created_at)
  SELECT id, task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, cache_read_tokens, cache_write_tokens, project_id, created_at
  FROM costs;

DROP TABLE costs;
ALTER TABLE costs_rebuild RENAME TO costs;
CREATE INDEX IF NOT EXISTS idx_costs_task ON costs(task_id);
