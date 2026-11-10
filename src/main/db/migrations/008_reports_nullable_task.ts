/**
 * 008_reports_nullable_task.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `008_reports_nullable_task.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_008_REPORTS_NULLABLE_TASK = `-- 008_reports_nullable_task.sql — v8（BRK21 修）：\`reports.task_id\` 放宽为可空 —— 「全局卡」的立锥之地
--
--   语义：NULL = 不属任何任务的**全局卡**（首个用例＝空库首启的日报）。
--   此前用哨兵 \`task_id=0\` 且注释声称「无 FK 校验」——与实况不符（该列 \`REFERENCES tasks(id)\`）
--   ⇒ 空库首启日报撞 FOREIGN KEY、当天永远收不到（BRK21）。
--   改动：\`reports.task_id NOT NULL REFERENCES tasks(id)\` → \`REFERENCES tasks(id)\`
--   （仅放宽可空；列集/列序不变）。
--
--   SQLite 不能直接去掉 NOT NULL ⇒ **重建表**（sqlite.org 12 步法）。与 005 重建 \`costs\` 的差异：
--   \`reports\` **有子表外键**（\`notifications.report_id\` / \`approvals.report_id\` 等）——
--   重建必须在 \`foreign_keys=OFF\` 下执行（\`migrate.ts\` 已按 12 步法包裹每个迁移；FK 开关只能在事务外）。
--   数据原样搬迁、索引重建；老库升级零破坏、可重复跑（IF NOT EXISTS 幂等）。

CREATE TABLE reports_rebuild (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id),   -- v8/BRK21：可空 = 全局卡（不属任何任务）
  kind          TEXT NOT NULL,              -- report | ask | alert
  payload       TEXT NOT NULL,              -- JSON：TL;DR/产物/证据/成本；或 问题/选项/推荐/默认动作/超时
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | acknowledged | resolved
  dedupe_key    TEXT,                       -- 同任务同类型去重
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  acknowledged_at INTEGER,
  verdict       TEXT,                       -- pass | fail | partial（M3 独立验证结论）
  verifier_employee_id INTEGER REFERENCES employees(id) -- 验证者员工 id（≠实现者；M3 复用员工 id）
);

INSERT INTO reports_rebuild (id, task_id, kind, payload, state, dedupe_key, created_at, delivered_at, acknowledged_at, verdict, verifier_employee_id)
  SELECT id, task_id, kind, payload, state, dedupe_key, created_at, delivered_at, acknowledged_at, verdict, verifier_employee_id
  FROM reports;

DROP TABLE reports;
ALTER TABLE reports_rebuild RENAME TO reports;

CREATE INDEX IF NOT EXISTS idx_reports_pending ON reports(state, kind, created_at);
`;
