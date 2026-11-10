/**
 * OPT- · 独立验证的**强制度分级**（`` verify + `review.lessons`/`差距图` 落点）。
 *
 * 按 `tasks.risk_level` 分级（1960 冻结）：**L0 免 / L1 抽验 / L2 强制**；
 * 默认「**实现者 ≠ 验证者**」（应用层断言，`db.assignWorkItemVerifier`）。
 * 本文件是**纯函数**（可单测、无 IO）；编排器/引擎据此决定是否要求验证与是否可置 `done`。
 */
export type VerificationStrength = 'none' | 'sampled' | 'required';

/** L1 抽验频率：每 N 个 work item 抽一个（确定性，便于复现与测试）。 */
export const DEFAULT_SAMPLE_EVERY = 3;

/**
 * 返回该 work item 的验证强度：
 *  - `risk_level <= 0`（L0）→ `none`（免）；
 *  - `risk_level === 1`（L1）→ **抽验**：命中（`workItemId % sampleEvery === 0`）为 `sampled`，否则 `none`；
 *  - `risk_level >= 2`（L2）→ `required`（强制）。
 */
export function verificationStrength(riskLevel: number, workItemId: number, sampleEvery: number = DEFAULT_SAMPLE_EVERY): VerificationStrength {
  if (riskLevel <= 0) return 'none';
  if (riskLevel === 1) return workItemId % sampleEvery === 0 ? 'sampled' : 'none';
  return 'required';
}

/** 是否**必须**有独立验证者（`sampled`/`required` 皆要求 verifier ≠ 实现者）。 */
export function verificationRequired(riskLevel: number, workItemId: number, sampleEvery?: number): boolean {
  return verificationStrength(riskLevel, workItemId, sampleEvery) !== 'none';
}
