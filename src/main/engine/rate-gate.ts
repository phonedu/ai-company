/**
 * N2 速率闸门（P21）—— 纯判定层（**可 node 测**，无 IO）。
 *
 * 口径（真源＝本文件头注 + `docs/work/research-multi-agent-cost.md` §2.B(f) P21）：
 *  - **"花钱如流水"看的是速率**，不是总额：`usdPerHour`（滚动窗）超阈值即动作；
 *  - **动作阶梯（保进度优先）**：`ok → economy（降档）→ hold（新派发排队）`；
 *    **降档优先于暂停**——暂停是浪费（干一半），降档只是变慢；
 *  - 边界含等号（`>=`）：恰好等于阈值即进入下一档（可测、可预期）。
 */

export type RateTier = 'ok' | 'economy' | 'hold';

export interface RateLimits {
  /** 降档阈值（$/h）：达到即**新装配走省钱档**。 */
  softUsdPerHour: number;
  /** 排队阈值（$/h）：达到即**新派发 hold**（在跑任务不打断）。 */
  hardUsdPerHour: number;
}

/** 默认阈值（可被 env / 引擎选项覆盖；**设置页接管前**的唯一出处在这里）。 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  softUsdPerHour: Number(process.env.AICO_RATE_LIMIT_USD_PER_HOUR ?? 3),
  hardUsdPerHour: Number(process.env.AICO_RATE_LIMIT_USD_PER_HOUR ?? 3) * 1.5,
};

export function rateAction(usdPerHour: number, limits: RateLimits = DEFAULT_RATE_LIMITS): RateTier {
  if (usdPerHour >= limits.hardUsdPerHour) return 'hold';
  if (usdPerHour >= limits.softUsdPerHour) return 'economy';
  return 'ok';
}

/** 人读一句话（用于日志/事件留痕；**不写假值**）。 */
export function describeRateLimit(usdPerHour: number, limits: RateLimits = DEFAULT_RATE_LIMITS): string {
  return `速率 $${usdPerHour.toFixed(4)}/h（降档线 $${limits.softUsdPerHour}/h、排队线 $${limits.hardUsdPerHour}/h）`;
}
