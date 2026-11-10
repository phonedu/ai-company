-- 015_task_pause_reason.sql — v15（联动修复：暂停来源）
--
-- 为什么需要：`paused` 是同一状态、不同来源（老板手动 / 任务预算 / 公司日预算）。
-- 加预算/继续必须只自动恢复 budget 来源，且 UI 要能说清“为什么暂停”。
ALTER TABLE tasks ADD COLUMN pause_reason TEXT;
