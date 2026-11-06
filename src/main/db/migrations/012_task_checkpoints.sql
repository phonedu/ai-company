-- 012_task_checkpoints.sql — v12（M3-N-2 GAP4：工作项级检查点/回滚）
--
-- 每个 staging 工作项在派发时记下 worktree 的 `base_sha`（`beginWorkspace`），
-- 完成提交后补 `head_sha`（`finishWorkspace`）。回滚只恢复该工作项 `base..head`
-- 实际改过的路径，不碰无关文件；`state='restored'` 后不可重复执行。
-- 真源：`schema.sql`（task_checkpoints 表）→ 本文件 → `gen-migrations` 生成 012_*.ts。
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id  INTEGER NOT NULL REFERENCES work_items(id),
  attempt       INTEGER NOT NULL DEFAULT 0,
  branch        TEXT,
  base_sha      TEXT,
  head_sha      TEXT,
  worktree_path TEXT,
  paths_json    TEXT NOT NULL DEFAULT '[]',
  state         TEXT NOT NULL DEFAULT 'open', -- open | restored | invalid
  created_at    INTEGER NOT NULL,
  restored_at   INTEGER,
  UNIQUE(work_item_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task ON task_checkpoints(task_id);
