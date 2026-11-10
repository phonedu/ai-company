/**
 *  余 · 通知策略（``：合并窗口 / 去重 / **静默时段** / 优先级）。
 *
 * 本文件只落**静默时段**这一维（其余维已在既有机制里：去重＝`notifications.dedupe_key` UNIQUE；
 * 合并窗口＝`merged_into` 列留待 1b 的聚合器；优先级＝调用方传 `urgent`）。
 *
 * 口径（真源＝本文件头注）：
 *  - **静默时段**＝本地时间的 `[start, end)` 分钟区间；**支持跨午夜**（如 22:00–08:00，start > end）；
 *    区间为空（start === end）⇒ **不静默**（用户没设就是没设，不臆造默认值）。
 *  - **静默期的投递**：记 `channel='digest'`（"夜里不弹、日报里见"）——**投递行照写**
 *    （`dedupe_key` 是幂等清单，不许跳过）⇒ 零迁移、零丢件；`urgent`（如员工被卡住的升级）**照常推**。
 *  - 判定是纯函数（可 node 测）；时区＝本机本地时间（`new Date` 的本地分钟数）。
 */

/** 本地时间「距当日 0 点多少分钟」（0..1439）。 */
export function minuteOfDay(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}

export interface QuietWindow {
  /** 静默开始（分；0..1439）。 */
  startMinutes: number;
  /** 静默结束（分；0..1439；可小于 start ＝ 跨午夜）。 */
  endMinutes: number;
}

/** 静默时段是否未配置（start === end ⇒ 不静默；也用于"用户没设"）。 */
export function isQuietDisabled(win: QuietWindow | null | undefined): boolean {
  return !win || win.startMinutes === win.endMinutes;
}

/** `at`（分）是否落在静默窗内（支持跨午夜；未配置 ⇒ false）。 */
export function isQuietAt(minutes: number, win: QuietWindow | null | undefined): boolean {
  if (isQuietDisabled(win)) return false;
  const { startMinutes: s, endMinutes: e } = win as QuietWindow;
  // 归一化到 0..1439，防前端传越界值（策略层不信任入参）。
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const ss = ((Math.floor(s) % 1440) + 1440) % 1440;
  const ee = ((Math.floor(e) % 1440) + 1440) % 1440;
  if (ss === ee) return false;
  return ss < ee ? m >= ss && m < ee : m >= ss || m < ee; // 跨午夜：晚段 or 早段
}

/**
 * 投递通道决策：静默期内的**非紧急**投递改走 `digest`（日报里见），紧急照常 `desktop`。
 * 非静默期一律 `desktop`。
 */
export function deliveryChannel(inQuiet: boolean, urgent: boolean): 'desktop' | 'digest' {
  return inQuiet && !urgent ? 'digest' : 'desktop';
}
