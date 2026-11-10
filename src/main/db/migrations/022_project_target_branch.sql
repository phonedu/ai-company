-- 022_project_target_branch.sql — S13-G/D-N06：项目级合并目标分支（NULL＝沿用 main/master 口径）。
-- 为什么：merge 原先只认 main/master，主干叫 trunk/develop 的项目永远合不进去，且错误文案不说可配。
ALTER TABLE projects ADD COLUMN target_branch TEXT;
