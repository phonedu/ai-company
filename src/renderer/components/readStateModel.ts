/**
 * 未读读数分面（纯函数； 联动审计 P0-2）。
 *
 * `channel:cards` 与 `channel:messages` 是两个独立 surface：任何一侧的返回都**只能**写自己那组字段。
 * 这里先做严格的 surface/数值校验，再由 store 落状态——防止 messages 读数把卡片 badge 覆盖成 0。
 */
export type ReadSurface = 'channel:cards' | 'channel:messages';

export interface ParsedReadState {
  surface: ReadSurface;
  lastItemId: number;
  unread: number | null;
  unreadState: 'exact' | 'unknown';
  /** 仅 `unreadState='unknown'` 时有值。 */
  reason: string | null;
}

export function parseReadState(raw: unknown, expected: ReadSurface): ParsedReadState | null {
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as {
    surface?: unknown;
    lastItemId?: unknown;
    unread?: unknown;
    unreadState?: unknown;
    reason?: unknown;
  };
  // 分面铁律：返回的 surface 与请求不一致 ⇒ 整条丢弃（绝不串写）。
  if (state.surface !== expected) return null;
  if (
    typeof state.lastItemId !== 'number' ||
    !Number.isInteger(state.lastItemId) ||
    state.lastItemId < 0
  ) {
    return null;
  }
  const exact = state.unreadState === 'exact';
  const reason =
    typeof state.reason === 'string' && state.reason.trim().length > 0 ? state.reason : '未读读数不可用';
  return {
    surface: expected,
    lastItemId: state.lastItemId,
    unread: typeof state.unread === 'number' ? state.unread : null,
    unreadState: exact ? 'exact' : 'unknown',
    reason: exact ? null : reason,
  };
}
