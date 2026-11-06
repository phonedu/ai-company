-- 009（N5 余账，2026-10-16）：任务级模型（指派优先级链最高档：任务级 > 员工级 > 角色映射 > 全局默认）。
-- add-only 列；NULL = 未指派（回落到既有链）——不臆造默认。写入点＝`task:create.model` / `模型 T1042 <model>` 命令。
ALTER TABLE tasks ADD COLUMN model TEXT;
