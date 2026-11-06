// ─────────────────────────────────────────────────────────────────────────────
// 频道流锚（纯逻辑，2026-10-16 频道批）——**日期锚**（今天/昨天/…）与**「新消息」锚**
//   （本次进入频道后到达的第一条；进入即重置）。抽出来可 node 测（`BossChannel` 引 store）。
// ─────────────────────────────────────────────────────────────────────────────

/** 日期分组键（本地日）。 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 日期锚文案：今天 / 昨天 / M 月 D 日（跨年补「Y 年」）。 */
export function dayLabel(ms: number, now: number): string {
  const startOf = (x: number): number => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(ms)) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  const d = new Date(ms);
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()} 年 ${md}`;
}

export interface StreamAnchor {
  /** 该条目之前要画的日期锚（null＝不画）。 */
  showDate: string | null;
  /** 该条目之前要画的「新消息」锚。 */
  showNew: boolean;
}

/**
 * 逐条算出锚：① 首条或跨日 ⇒ 日期锚；② **第一条**「新消息」且**不是首条** ⇒ 锚。
 * 「新」优先按服务端消息游标（`lastReadMessageId`，持久、跨重启）；缺省回落本次进入时刻。
 */
export function streamAnchors(
  items: readonly {
    at: number;
    kind?: string;
    message?: { id: number };
    card?: { id: number };
  }[],
  openedAt: number,
  now: number,
  lastReadMessageId = 0,
): StreamAnchor[] {
  const firstNew =
    lastReadMessageId > 0
      ? items.findIndex((item) => item.kind === 'message' && (item.message?.id ?? 0) > lastReadMessageId)
      : items.findIndex((item) => item.at > openedAt);
  return items.map((item, index) => {
    const prev = index > 0 ? items[index - 1] : null;
    return {
      showDate: prev == null || dayKey(prev.at) !== dayKey(item.at) ? dayLabel(item.at, now) : null,
      showNew: index === firstNew && index > 0,
    };
  });
}
