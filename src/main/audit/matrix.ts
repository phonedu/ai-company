/**
 * `matrix.ts` —— 组合矩阵（`pnpm test:matrix`）的**纯逻辑**：环境 × 场景格子账本 ＋ 汇总。
 *
 * 缘起（C4 计划 P4）：「状态 × 环境」逐格有交代——**执行 / 已知断 / 由既有件承担 / 待补** 四态如实，
 * 不许留暗格。跑器 `scripts/matrix/run.mjs` 执行 `run`/`known` 格（headless 真引擎，零真调）；
 * 真机/长稳格由既有件承担（`pointer` 指过去）。
 *
 * 口径（v1）：未引 PICT（矩阵小、手工列格更诚实）；`run` 格失败＝红（regression）；`known` 格
 * "断点消失"＝黄（翻案提示）。
 *
 * ⚠️ 首跑抓的两条真实断点（2026-10-15）——**均已于当日成对（修复 ⇄ 翻案为 `run` 格断言）**：
 *  - **`no-credential × planning-stage`**：曾抓到「无凭据时任务**静默卡 `planning`**」——
 *    `dispatch_planning`/`dispatch_critic`/`dispatch_verifier` 不被兜底执行器接管、无卡、无工作项、
 *    配好 Key 也不重试（动作已置 done）。**已修（2026-10-15）**：兜底执行器×2 接管任务级 phase 派发
 *    → `escalate`（`needs_decision` ＋决策卡）。恢复面「答卡后再派规划」为共缺口（`decision_made`
 *    回边无再派发＋幂等键轮次问题）——报备，随批 R 一并设计。
 *  - **`empty-db × daily-digest`：`` 已修（2026-10-15，迁移 `008`「可空列」方案 A）**——
 *    曾实锤：哨兵 `task_id=0` 撞 `reports.task_id REFERENCES tasks(id)`、`digest.ts` 注释「无 FK 校验」
 *    不成立；现 `task_id` 可空、无任务 ⇒ `null`（全局卡）、UI 显示「全局」。
 */
export type MatrixEnv = 'empty-db' | 'no-credential' | 'legacy-db' | 'live';
export type MatrixCellStatus = 'run' | 'known' | 'pending' | 'pointer';

export interface MatrixCell {
  env: MatrixEnv;
  scenario: string;
  status: MatrixCellStatus;
  /** 指针/账目（BRK 编号、配方名、既有测试）。 */
  ref: string;
  note: string;
  /** `run`/`known` 格的可执行判据（给人读；跑器实现在 `scripts/matrix/run.mjs`）。 */
  assertion?: string;
}

export const MATRIX_CELLS: readonly MatrixCell[] = [
  {
    env: 'empty-db',
    scenario: 'daily-digest',
    status: 'run',
    ref: 'BRK21（已修：迁移 008，2026-10-15）',
    assertion: '空库 emitDailyDigest：不抛；恰一张卡 `task_id IS NULL`（全局卡）＋ kind=notification；二次调用幂等（不叠第二张）',
    note: '可空列迁移（方案 A）；`digest.ts` 旧注释「无 FK 校验」已同批改正',
  },
  {
    env: 'empty-db',
    scenario: 'docs-check',
    status: 'pointer',
    ref: '`docs-check-handler.test.ts`（真临时目录）＋ `ipc.ts` 的 `hasDocsTree:false` 契约',
    note: 'handler 在 ipc 层（electron 依赖）⇒ headless 跑器不复刻，指既有件；契约：无树不代建、零计数、不假 0',
  },
  {
    env: 'live',
    scenario: 'audit-self',
    status: 'run',
    ref: 'audit-chain 门',
    assertion: '当前树 `audit:chain` 退出码 0（自检本仓）',
    note: '与提交门同口径',
  },
  {
    env: 'no-credential',
    scenario: 'planning-stage',
    status: 'run',
    ref: '规划静默（已修 2026-10-15；BRK2 同族）',
    assertion: '装配失败时任务级 phase 派发不再静默跳过：任务进 `needs_decision` ＋决策卡（老板可见、可处置）；不再「无卡/无件/不重开」',
    note: '恢复面「答卡后再派规划」为共缺口（`decision_made` 回边无再派发＋幂等键轮次）——已报备随批 R',
  },
  {
    env: 'live',
    scenario: 'l0-chain',
    status: 'pointer',
    ref: '`planning-session.test.ts` / `chain-e2e` 真机配方',
    note: 'L0 全链由既有单测＋真机承担',
  },
  {
    env: 'live',
    scenario: 'l1-l2-chain',
    status: 'pointer',
    ref: '`l1-approval-e2e` / `l2-verification-e2e` 真机配方',
    note: '人工批准与强制验证由真机配方承担',
  },
  {
    env: 'no-credential',
    scenario: 'boot-assembly',
    status: 'pointer',
    ref: 'G8 横幅（`evt:agent` 装配三态）＋ `unavailable-executor.test.ts`',
    note: '装配失败横幅与工作项失败面由既有件承担（BRK2 已修）',
  },
  {
    env: 'legacy-db',
    scenario: 'migrations-upgrade',
    status: 'pending',
    ref: '—',
    note: '需旧版 schema fixture（尚无）——登记待补',
  },
  {
    env: 'legacy-db',
    scenario: '大库 / 长稳',
    status: 'pending',
    ref: '—',
    note: '库规模与长跑场景登记待补（P4 后续）',
  },
];

export interface MatrixSummary {
  run: number;
  known: number;
  pending: number;
  pointer: number;
  total: number;
}

export function summarizeMatrix(cells: readonly MatrixCell[]): MatrixSummary {
  return {
    run: cells.filter((c) => c.status === 'run').length,
    known: cells.filter((c) => c.status === 'known').length,
    pending: cells.filter((c) => c.status === 'pending').length,
    pointer: cells.filter((c) => c.status === 'pointer').length,
    total: cells.length,
  };
}
