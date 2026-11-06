/**
 * 件 A · 调度与费率可配面 —— **设置 → `EngineConfig` 的唯一映射**（纯函数，可 node 测）。
 *
 * 口径（真源＝本文件头注）：
 *  - **真实读者**：`main/index.ts` 装配期调用本函数，把结果展开进 `new Engine(...)` 的配置
 *    → 写入即生效于**下次装配**（与 `models.default` 同款语义，不发明新语义）。
 *  - **不臆造**：未设值 / 值不合法（越界、类型错）→ **该字段不出现**，Engine 回落它自己的缺省
 *    （校验真源＝`db/settings.ts` 的 `validateSettingValue`，本函数不另立一套）。
 *  - **派生规则不变**：速率只暴露降档线（`rate.softUsdPerHour`），排队线 = 降档线 ×1.5
 *    （与 env 口径 `AICO_RATE_LIMIT_USD_PER_HOUR` 一致——同一公式，不两套）。
 */
import type { EngineConfig } from './types.js';
import { validateSettingValue, type KnownSettingKey } from '../db/settings.js';

export type EngineTuning = Pick<EngineConfig, 'scheduler' | 'concurrency' | 'rateLimit'>;

/** 读一个数字键：未设值/非数字/越界 → `undefined`（调用方回落缺省）。 */
function numFrom(read: (key: KnownSettingKey) => unknown, key: KnownSettingKey): number | undefined {
  const value = read(key);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!validateSettingValue(key, value).ok) return undefined;
  return value;
}

export function engineTuningFromSettings(read: (key: KnownSettingKey) => unknown): EngineTuning {
  const scheduler: NonNullable<EngineConfig['scheduler']> = {};
  const maxActiveTasks = numFrom(read, 'scheduler.maxActiveTasks');
  const agingMinutes = numFrom(read, 'scheduler.agingMinutes');
  const agingCap = numFrom(read, 'scheduler.agingCap');
  if (maxActiveTasks !== undefined) scheduler.maxActiveTasks = maxActiveTasks;
  if (agingMinutes !== undefined) scheduler.agingMinutes = agingMinutes;
  if (agingCap !== undefined) scheduler.agingCap = agingCap;

  const concurrency: NonNullable<EngineConfig['concurrency']> = {};
  const maxPerTask = numFrom(read, 'concurrency.maxPerTask');
  const maxCompany = numFrom(read, 'concurrency.maxCompany');
  if (maxPerTask !== undefined) concurrency.maxPerTask = maxPerTask;
  if (maxCompany !== undefined) concurrency.maxCompany = maxCompany;

  const soft = numFrom(read, 'rate.softUsdPerHour');
  const rateLimit = soft === undefined ? {} : { softUsdPerHour: soft, hardUsdPerHour: soft * 1.5 };

  return { scheduler, concurrency, rateLimit };
}
