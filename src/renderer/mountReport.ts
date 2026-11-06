// ─────────────────────────────────────────────────────────────────────────────
// `ui:mounted` 上报策略（**纯函数**，可 node 测）
//   背景（设计记录 / 2192）：
//     `AppShell` 原实现 **先把一次性守卫置位、再调 `window.api?.ui?.mounted()`**；
//     若 `window.api`/`api.ui` 此刻未就绪，可选链**静默 no-op**，而守卫已置位 → **永不重试**
//     → 主进程那条 `[ui] shell mounted` 永远等不到（等待它的 harness 只能超时）。
//   修法（2192 口径）：
//     ① **守卫后置** —— 只有**成功送出**后才置位；
//     ② **未就绪就重试**（有上限，避免无止境）；
//     ③ **真的失败要留痕**（`gave_up` → 调用方 `console.warn`，**不静默**）。
// ─────────────────────────────────────────────────────────────────────────────

/** 上报尝试的**上限**（默认 100 次 × 100ms ≈ 10s：足够覆盖 preload 迟到，又不会吊死）。 */
export const MOUNT_REPORT_MAX_ATTEMPTS = 100;
/** 两次尝试的间隔（ms）。 */
export const MOUNT_REPORT_RETRY_MS = 100;

export interface MountReportState {
  /** 是否已**成功**上报过（= 一次性守卫；**只在成功后才为 true**）。 */
  done: boolean;
  /** 已尝试次数（含本次）。 */
  attempts: number;
}

export type MountReportOutcome = 'reported' | 'retry' | 'gave_up';

/**
 * 尝试上报一次「壳已挂载」。
 *
 * @param getReport 取「上报函数」；**未就绪返回 `undefined`**（不要抛）。
 * @param state     可变状态（`done`/`attempts`，由调用方持有）。
 * @param maxAttempts 尝试上限（默认 {@link MOUNT_REPORT_MAX_ATTEMPTS}）。
 */
export function attemptMountReport(
  getReport: () => (() => void) | undefined,
  state: MountReportState,
  maxAttempts: number = MOUNT_REPORT_MAX_ATTEMPTS,
): MountReportOutcome {
  // 已成功过 → 幂等返回（StrictMode 双挂载 / 重复调用都不重复上报）。
  if (state.done) return 'reported';

  state.attempts += 1;
  const report = getReport();
  const exhausted = (): boolean => state.attempts >= maxAttempts;

  if (typeof report === 'function') {
    try {
      report();
    } catch {
      // 上报**抛错**同样视为未成功：不置位，交给调用方重试（到上限则 gave_up）。
      return exhausted() ? 'gave_up' : 'retry';
    }
    state.done = true; // ← 关键：**成功送出之后**才置位（旧实现在此之前置位 → 丢信号且不重试）
    return 'reported';
  }

  return exhausted() ? 'gave_up' : 'retry';
}
