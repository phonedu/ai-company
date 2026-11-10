-- 018_project_model_policy.sql — v18（``：项目模型策略）
--
-- 为什么需要：项目此前只有供应商白名单（allowed_providers），无法表达“本项目默认用哪个模型、
-- 哪些模型允许用、按什么策略选”。`` 把边界与默认放到项目层，员工偏好只作建议。
--
-- 三列都由应用层校验（`src/core/project-model-policy.ts`）：
--   default_model — 项目默认模型（provider/model 或裸模型名；NULL＝未设置）
--   allowed_models — 模型级允许清单 JSON 数组（空数组＝不额外限制，兼容旧项目）
--   model_policy — fixed | employee_first | assistant（assistant 需模型目录，当前写入会被拒）
--
-- 只新增列、不重建表；旧库全部走 DEFAULT，不丢数据。
ALTER TABLE projects ADD COLUMN default_model TEXT;
ALTER TABLE projects ADD COLUMN allowed_models TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN model_policy TEXT NOT NULL DEFAULT 'employee_first';
