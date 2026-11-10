// ─────────────────────────────────────────────────────────────────────────────
// 卡片文案/读数（纯逻辑，2026-10-16 频道批）——抽出来是可 node 测（`Card.tsx` 引 store，
//   测试编不动；口径搬到这里＝「无死读数/人话 chip/倒计时」的判据可以脱离 app 断言）。
// ─────────────────────────────────────────────────────────────────────────────

/** `kind` → 语义色点 tone ＋ 人话标签（设计板 v4：不再 emoji）。 */
export const CARD_KIND_META: Record<string, { tone: string; label: string }> = {
  ask: { tone: 'accent', label: '需要你决策' },
  report: { tone: 'ok', label: '汇报' },
  alert: { tone: 'danger', label: '异常' },
  notification: { tone: 'dim', label: '通知' },
};

/** `state` → 人话 chip（未知 state 如实显示原文，不猜）。 */
export const CARD_STATE_TEXT: Record<string, string> = {
  pending: '待你处理',
  delivered: '待阅',
  acknowledged: '已读',
  resolved: '已处理',
};

/** 可操作性：pending/delivered 才可点（其余态按钮禁用——`Card` 同源引用）。 */
export function isActionable(state: string): boolean {
  return state === 'pending' || state === 'delivered';
}

/**
 * 评审/验证结论的人话（`reports.verdict` 或事件 payload.verdict）。
 * 未知值如实回显原文（不猜、不吞）。
 */
export function verdictText(verdict: string | null | undefined): string | null {
  if (typeof verdict !== 'string' || verdict.length === 0) return null;
  if (verdict === 'approve' || verdict === 'pass') return '通过';
  if (verdict === 'revise') return '打回';
  if (verdict === 'fail' || verdict === 'reject') return '未通过';
  if (verdict === 'partial') return '部分通过';
  return verdict;
}

/** 结论色调（卡片/行内点色第二编码）：通过=ok，打回/未通过=danger，部分=warn，未知=dim。 */
export function verdictTone(verdict: string | null | undefined): 'ok' | 'danger' | 'warn' | 'dim' {
  if (verdict === 'approve' || verdict === 'pass') return 'ok';
  if (verdict === 'revise' || verdict === 'fail' || verdict === 'reject') return 'danger';
  if (verdict === 'partial') return 'warn';
  return 'dim';
}

/** 超时读秒（`timeoutAt` 真读数）：小时＋分 / 分 / 已到点——不写假读数。 */
export function remainText(until: number, now: number): string {
  const diff = until - now;
  if (diff <= 0) return '已到点';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** 卡片头部时间（本地 HH:MM；与频道气泡同口径）。无有效时间 → `—`（不写假 0）。 */
export function formatCardClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
