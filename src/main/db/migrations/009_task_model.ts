/**
 * 009_task_model.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `009_task_model.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_009_TASK_MODEL = `-- 009（N5 余账，2026-10-16）：任务级模型（指派优先级链最高档：任务级 > 员工级 > 角色映射 > 全局默认）。
-- add-only 列；NULL = 未指派（回落到既有链）——不臆造默认。写入点＝\`task:create.model\` / \`模型 T1042 <model>\` 命令。
ALTER TABLE tasks ADD COLUMN model TEXT;
`;
