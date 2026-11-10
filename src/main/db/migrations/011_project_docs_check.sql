-- 011_project_docs_check.sql — v11（M3-DOC-4：项目级文档检查开关）
--
-- 默认开（1）：新建任务自动挂 `acceptance[].check='aico:docs-check'`；
-- 关闭（0）：不自动挂；已有任务里的该检查在运行时记 `skip`（未检查），不冒充通过。
-- 真源：`schema.sql`（projects 表注释）→ 本文件 → `gen-migrations` 生成 011_*.ts。
ALTER TABLE projects ADD COLUMN docs_check_enabled INTEGER NOT NULL DEFAULT 1;
