/**
 *  · 「待我处理」视图的**纯逻辑**（可单测、无 React/DOM/存储依赖）。
 *
 * 口径（`docs//§160/§407/§471`）：
 *  - 待我处理 = **决策 / 验收 / 异常** 三个 tab；本件因 **`` 新增 `kind='notification'`** 来源，
 *    增 **第 4 个 tab「通知」**（tab 数据驱动：哪类有卡才出哪个）。
 *  - **同一张待处理卡片**同时出现在老板频道与「待我处理」→ **同源**（都用 `store.cards.list`，即 `inbox:list()`），
 *    在任一处处理 → 另一处同步消除。
 *  - **空态不伪装**（`UI §471`：0 条 → "暂无待处理事项"）。
 *  - **未读游标**：只有**会催促老板的三类**（决策/验收/异常）产生未读；`createdAt > seenAt` 即未读。
 *    **`notification`（FYI，第四类 tab）与未知来源不计入**（`UI §409`：待办 badge＝三项计数；
 *    日报/提醒不点红点）——**左栏 badge 与顶栏「待办」共用本函数**（同源同口径，2026-10-14 统一）。
 */
import type { ReportDTO } from '../types.js';

export interface InboxTab {
  key: string;
  label: string;
}

/** tab 顺序（即 UI 展示顺序）；`notification` 为 `` 新增来源。
 *  2026-10-16（待我处理批）：撤 icon 字段——胶囊 tab 按设计板＝「标签 ＋ 计数」纯文字（去 emoji）。 */
export const INBOX_TABS: readonly InboxTab[] = [
  { key: 'ask', label: '决策' },
  { key: 'report', label: '验收' },
  { key: 'alert', label: '异常' },
  { key: 'notification', label: '通知' },
];

/** 未知 kind 的兜底 tab（不丢卡、不臆造来源）。 */
export const OTHER_TAB = 'other';

/** 可处理 = 仍需老板动作（`pending`/`delivered`）；已 `resolved`/`acknowledged` 不算。 */
export function isActionable(card: Pick<ReportDTO, 'state'>): boolean {
  return card.state === 'pending' || card.state === 'delivered';
}

/** 待处理条目（**同源** = 与老板频道同一 `cards.list`）；按 `createdAt`（同则 `id`）升序。 */
export function inboxEntries(cards: readonly ReportDTO[]): ReportDTO[] {
  return cards.filter(isActionable).slice().sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

/** `kind` → tab 键（已知四类原样；未知归 `other`）。 */
export function tabKeyOf(kind: string): string {
  return INBOX_TABS.some((tab) => tab.key === kind) ? kind : OTHER_TAB;
}

/** 按 tab 分组（每个 tab 都先建空数组，便于 UI 判断"哪类有卡"）。 */
export function groupByTab(cards: readonly ReportDTO[]): Record<string, ReportDTO[]> {
  const out: Record<string, ReportDTO[]> = {};
  for (const tab of INBOX_TABS) out[tab.key] = [];
  out[OTHER_TAB] = [];
  for (const card of inboxEntries(cards)) out[tabKeyOf(card.kind)].push(card);
  return out;
}

/** 「会催促老板」的三类 kind（`UI §409`：待办 badge／顶栏「待办」＝决策+验收+异常；`notification` 是 FYI 不计）。 */
const NAGGING_KINDS: ReadonlySet<string> = new Set(['ask', 'report', 'alert']);

/**
 * 未读数 = **三类可处理卡**中 `createdAt > seenAt` 的条数（FYI 通知与未知来源不计）。
 * @deprecated 1c 起生产读数走服务端 `inbox:read-state`；本函数只留作旧测试/对照，
 * 新代码不得再用它算 badge（服务端 `read_cursors` 是唯一权威）。
 */
export function unreadCount(cards: readonly ReportDTO[], seenAt: number): number {
  return cards.filter(
    (card) => isActionable(card) && NAGGING_KINDS.has(tabKeyOf(card.kind)) && card.createdAt > seenAt,
  ).length;
}

/** 来源标签（tab 名；未知 kind → 通用「卡片」，不假装知道来源）。 */
export function sourceLabel(kind: string): string {
  if (kind === OTHER_TAB) return '卡片';
  return INBOX_TABS.find((tab) => tab.key === kind)?.label ?? '卡片';
}

/** 「等了 X」卡头时间锚（2026-10-16 待我处理批；真读数：由 `createdAt` 起算）。 */
export function waitedText(createdAt: number, now: number): string {
  const diff = now - createdAt;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 日报读数行（2026-10-17）：只渲染 payload 里真实存在的字段；`usd` 缺省 → 不写成本，
 * 显式 `null` → `—`。全部缺失 → null（不造一行 0）。
 */
export function digestLine(digest: ReportDTO['payload']['digest']): string | null {
  if (!digest) return null;
  const parts: string[] = [];
  if (digest.completedShortIds !== undefined) parts.push(`完成 ${digest.completedShortIds.length}`);
  if (digest.failedCount !== undefined) parts.push(`失败 ${digest.failedCount}`);
  if (digest.cancelledCount !== undefined) parts.push(`取消 ${digest.cancelledCount}`);
  // 2026-10-29 P2：口径说清——这是「完成任务的人」，不是全公司在册人数；完成 0 时不写假读数。
  if (digest.employeeCount !== undefined && (digest.completedShortIds?.length ?? 0) > 0) {
    parts.push(`参与员工 ${digest.employeeCount} 人`);
  }
  if (digest.usd !== undefined) parts.push(`成本 ${digest.usd == null ? '—' : `$${digest.usd.toFixed(4)}`}`);
  if (digest.pendingCards !== undefined) parts.push(`待你处理 ${digest.pendingCards} 张卡`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 待批卡的计划摘要（列表里看得到改了哪几条，不必先进频道）。
 * 只取前 `max` 步、带序号；超出部分如实写「另 N 步」。缺省/空 → null（不造一行）。
 */
export function planSummary(steps: readonly string[] | undefined | null, max = 3): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const head = steps.slice(0, max).map((step, index) => `${index + 1}. ${step}`).join(' · ');
  return steps.length > max ? `${head} · 另 ${steps.length - max} 步` : head;
}

/** **只保留"有卡"的 tab**（**空 tab 不渲染** —— `` 口径，2997；独立验证的 `F-B`）。 */
export function visibleTabs(cards: readonly ReportDTO[]): InboxTab[] {
  const groups = groupByTab(cards);
  return INBOX_TABS.filter((tab) => groups[tab.key].length > 0);
}
