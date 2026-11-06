/**
 * 019_project_default_budget.ts — 迁移内联常量（打包安全；运行时零文件系统依赖）。
 * 与同目录 `019_project_default_budget.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_019_PROJECT_DEFAULT_BUDGET = `-- 019_project_default_budget.sql — v19（项目默认任务预算）
--
-- 为什么需要：设计定稿（2026-10-23）：项目级独立预算口径：
-- 项目提供**新任务默认 token 预算**（不是新增日 USD 闸门）；任务显式预算仍最高优先。
--
-- 语义：
--   default_budget_tokens — 新任务未显式给 budgetTokens 时写入 tasks.budget_tokens；NULL＝不限。
--   已有任务预算/既有成本口径不变；超预算仍由既有 tasks.budget_tokens 门暂停。
ALTER TABLE projects ADD COLUMN default_budget_tokens INTEGER;
`;
