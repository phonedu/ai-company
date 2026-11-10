/**
 *  · 旧版「待我处理」未读游标（**只作一次性迁移来源**）。
 *
 * 1c 起，权威游标在服务端 `read_cursors`（`inbox:read-state` / `inbox:read-mark`）。
 * 本文件的 `aico.inbox.seenAt` 只用来把升级前“已看过”的卡片一次性标读；成功后由 store 清除。
 * 无 `localStorage` 环境（单测/非浏览器）→ 安全降级（读返回 0、写/清为 no-op），**不抛**。
 */
const SEEN_AT_KEY = 'aico.inbox.seenAt';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** 读未读游标（epoch ms）；无/非法 → `0`（= 全部未读）。 */
export function loadSeenAt(): number {
  const s = safeStorage();
  if (!s) return 0;
  try {
    const raw = s.getItem(SEEN_AT_KEY);
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 写旧版游标（仅为兼容测试/回滚；生产不再写）。失败**静默降级**。 */
export function saveSeenAt(at: number): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(SEEN_AT_KEY, String(at));
  } catch {
    /* 存储不可用不致命 */
  }
}

/** 一次性迁移完成后删除旧游标；失败静默（下轮仍可重试）。 */
export function clearSeenAt(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(SEEN_AT_KEY);
  } catch {
    /* 清不掉不影响服务端游标 */
  }
}

/** 旧 `seenAt` → 服务端卡片游标的**纯归约**：只取 createdAt ≤ seenAt 的最大 id。 */
export function seenThroughId(
  cards: readonly { id: number; createdAt: number }[],
  seenAt: number,
): number {
  if (!Number.isFinite(seenAt) || seenAt <= 0) return 0;
  return cards.reduce((max, card) => (card.createdAt <= seenAt ? Math.max(max, card.id) : max), 0);
}
