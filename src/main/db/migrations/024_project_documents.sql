-- 024_project_documents.sql —：多文档根注册层（素材/知识目录挂项目）。
-- 为什么：方向①——项目唯一 root_dir 无法挂素材/知识等第二目录；只做多文档根（多代码根不做）。
CREATE TABLE IF NOT EXISTS project_documents (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  dir        TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);
