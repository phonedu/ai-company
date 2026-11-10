-- 002_verification_seams.sql — v2
--   OPT- 独立验证：reports.verdict / reports.verifier_employee_id / tasks.verifier_employee_id / work_items.verifier_employee_id
--   OPT- 接缝矩阵：seams 表（boundary 枚举真源在；schema 只存文本）
-- 注：ALTER ADD COLUMN 不支持 IF NOT EXISTS；本迁移由清单保证只跑一次（schema_migrations）。
ALTER TABLE reports ADD COLUMN verdict TEXT;
ALTER TABLE reports ADD COLUMN verifier_employee_id INTEGER REFERENCES employees(id);
ALTER TABLE tasks ADD COLUMN verifier_employee_id INTEGER REFERENCES employees(id);
ALTER TABLE work_items ADD COLUMN verifier_employee_id INTEGER REFERENCES employees(id);

CREATE TABLE IF NOT EXISTS seams (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  boundary      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  coverage_ref  TEXT,
  owner         TEXT,
  milestone     TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(project_id, boundary)
);
CREATE INDEX IF NOT EXISTS idx_seams_project ON seams(project_id);
