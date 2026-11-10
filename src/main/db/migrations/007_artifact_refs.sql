-- 007_artifact_refs.sql — v7（§7 序 3 · G-A：跨项目引用载体）
--
-- 为 `artifacts` 加**来源链条**两列（G-A 判据：先 `copy` ＋ sha256；`link` 后议）：
--   · origin_artifact_id = 被引用的**源产物 id**（本行是"引用副本"；NULL ＝ 本任务自产）
--   · origin_project_id = 源产物所属**项目 id**（"这份文档从哪来"可查；跨项目引用 ⇒ 本列 ≠ 本行任务的项目）
--   add-only、nullable ⇒ 老库升级零破坏；既有行两列 NULL（＝自产，语义与加列前一致）。
-- 口径（G-B 硬规则 ②）：引用的文档带来源标记（`origin_project_id` ＋ sha256）——sha256 沿用既有列，
-- 引用时按**实读字节**重算（与源记录不一致也照实入库并在 note 标注，不臆造）。
-- 真源：`schema.sql`（artifacts 表注释）→ 本文件 → `gen-migrations` 生成 007_*.ts。
-- 写者（唯一）：`ipc/ipc.ts#handleArtifactReference`（**老板显式发起**；记 `task_events.artifact_referenced` 审计、
-- 源路径做项目根**包含性校验**——AI 侧无此通道，不存在自主跨项目读）。
ALTER TABLE artifacts ADD COLUMN origin_artifact_id INTEGER;
ALTER TABLE artifacts ADD COLUMN origin_project_id INTEGER;
