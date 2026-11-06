/**
 * 020_context_metrics.ts — 迁移内联常量（打包安全；运行时零文件系统依赖）。
 * 与同目录 `020_context_metrics.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_020_CONTEXT_METRICS = `-- 020_context_metrics.sql — CTX-1 P0（CTX1-2）：上下文遥测落库（每会话每轮一行）。
-- 为什么新表：查询/聚合方便（A/B、多项目对照）；不走 task_events（事件流是审计，不是指标）。
CREATE TABLE IF NOT EXISTS context_metrics (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id),
  work_item_id  INTEGER,
  employee_id   INTEGER,
  project_id    INTEGER,
  session_key   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  total_tokens  INTEGER NOT NULL,
  system_tokens INTEGER NOT NULL,
  user_tokens   INTEGER NOT NULL,
  context_window INTEGER,            -- NULL = 未知（渲染层显 —）
  utilization   REAL,                -- NULL = 未知
  truncated     INTEGER NOT NULL DEFAULT 0,
  layers_json   TEXT NOT NULL DEFAULT '[]',  -- [{name,chars,estTokens,truncated,tokensBeforeCap}]
  compaction_count INTEGER,          -- NULL = 未观测（不写假 0）；本会话累计成功压缩次数
  tokens_before_compaction INTEGER,  -- 最近一次压缩前 token（无压缩 → NULL）
  cache_read_tokens  INTEGER,        -- NULL = 本轮无用量回执（不写假 0）
  cache_write_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_context_metrics_task ON context_metrics(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_context_metrics_session ON context_metrics(session_key, ts);
`;
