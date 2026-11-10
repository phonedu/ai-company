/**
 * 015_task_pause_reason.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `015_task_pause_reason.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_015_TASK_PAUSE_REASON = `-- 015_task_pause_reason.sql — v15（联动修复：暂停来源）
--
-- 为什么需要：\`paused\` 是同一状态、不同来源（老板手动 / 任务预算 / 公司日预算）。
-- 加预算/继续必须只自动恢复 budget 来源，且 UI 要能说清“为什么暂停”。
ALTER TABLE tasks ADD COLUMN pause_reason TEXT;
`;
