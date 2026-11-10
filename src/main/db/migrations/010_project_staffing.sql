-- 010_project_staffing.sql — v10（编制 v1 · 裁决 D-11：默认负责人 / 默认执行员工 / 默认档）
--
-- 编制＝项目级三项缺省（落 `projects` 表；读面＝`ProjectDTO`（project:list/get），零新读通道）：
--   · default_owner_id     新列：默认负责人（NULL＝未设置 → 缺省链兜底；建任务预填、可改）
--   · default_employee_ids 既有列（001 为"项目默认员工"预留，本批落写者）：编制·默认执行员工
--                          （有序数组；派发缺省链②取**首个在职者**，离岗/幻影跳过——fail-open 回落负责人）
--   · default_risk_tier    新列：新任务档位预填（0/1/2；NULL＝未设置 → db 缺省 1）
-- 写者（唯一）：`project:staffing-set`（`ipc/ipc.ts#handleProjectStaffingSet` → `db/projects.ts#setProjectStaffing`；
-- 写校验＝员工**存在且在职**、档位 0..2 或 null；非法拒且不落库）。
-- add-only、nullable ⇒ 老库升级零破坏；既有行三列＝未设置（语义与加列前一致：缺省链/建任务缺省逐字不变）。
-- 生效面**只影响新建**（建任务预填与派发缺省），在跑/已建任务不被回溯改动。
-- 真源：`schema.sql`（projects 表注释）→ 本文件 → `gen-migrations` 生成 010_*.ts。
ALTER TABLE projects ADD COLUMN default_owner_id INTEGER;
ALTER TABLE projects ADD COLUMN default_risk_tier INTEGER;
