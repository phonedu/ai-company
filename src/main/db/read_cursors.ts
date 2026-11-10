/**
 * 未读游标 DAO（1a/1c；口径真源＝`docs/work/spec-remote-preconditions.md` §4）。
 *
 * 这是**服务端**的未读高水位，不是 renderer 的 `localStorage`：
 *  - `(principal, surface)` 唯一；游标只前进、幂等；
 *  - `channel:cards` 源＝`reports`，未读资格＝`ask/report/alert` 的 `pending/delivered`；
 *  - `channel:messages` 源＝`human_messages`，未读资格＝`out`（`in` 只推进 transcript 位置）；
 *  - 读**不改变** `reports.state` / `approvals` / 任务状态。
 *
 * 本次只开放 `boss` 的老板频道两个 surface；IM/mailbox 的 surface 已预留校验位置，
 * 等对应实现接入时再加白名单（不靠客户端任意拼接 surface）。
 */
import type { SqliteDb } from './open.js';

export const READ_PRINCIPAL_BOSS = 'boss';
export const READ_SURFACE_CARDS = 'channel:cards';
export const READ_SURFACE_MESSAGES = 'channel:messages';

export type ReadSurface = typeof READ_SURFACE_CARDS | typeof READ_SURFACE_MESSAGES;
export type ReadSource =
  | 'desktop'
  | 'remote'
  | 'action'
  | 'employee_session'
  | 'im_receipt'
  | 'migration';

export type ReadCursorErrorCode = 'unknown_surface' | 'bad_request' | 'unsupported_principal';

export class ReadCursorError extends Error {
  readonly code: ReadCursorErrorCode;
  constructor(code: ReadCursorErrorCode, message: string) {
    super(message);
    this.name = 'ReadCursorError';
    this.code = code;
  }
}

export interface ReadCursorRow {
  principal: string;
  surface: string;
  last_item_id: number;
  last_read_at: number | null;
  updated_at: number;
  source: string;
}

export interface ReadState {
  principal: string;
  surface: ReadSurface;
  lastItemId: number;
  lastReadAt: number | null;
  unread: number | null;
  unreadState: 'exact' | 'unknown';
  reason?: string;
  asOfId: number;
}

export interface MarkReadInput {
  principal: string;
  surface: string;
  throughId: number;
  now?: number;
  source?: ReadSource;
}

export interface MarkReadResult {
  changed: boolean;
  state: ReadState;
}

export function isReadSurface(value: string): value is ReadSurface {
  return value === READ_SURFACE_CARDS || value === READ_SURFACE_MESSAGES;
}

function assertPrincipal(principal: string): void {
  if (principal !== READ_PRINCIPAL_BOSS) {
    throw new ReadCursorError('unsupported_principal', `未读 principal 暂只支持 boss：${principal}`);
  }
}

function assertSurface(surface: string): asserts surface is ReadSurface {
  if (!isReadSurface(surface)) {
    throw new ReadCursorError('unknown_surface', `未知未读 surface：${surface}`);
  }
}

function maxId(db: SqliteDb, surface: ReadSurface): number {
  if (surface === READ_SURFACE_CARDS) {
    return (
      db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM reports').get() as { id: number }
    ).id;
  }
  return (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM human_messages').get() as { id: number }
  ).id;
}

function sourceHasId(db: SqliteDb, surface: ReadSurface, id: number): boolean {
  if (surface === READ_SURFACE_CARDS) {
    return db.prepare('SELECT 1 AS ok FROM reports WHERE id = ?').get(id) != null;
  }
  return db.prepare('SELECT 1 AS ok FROM human_messages WHERE id = ?').get(id) != null;
}

/** 托盘/日报共用：老板卡片未读数（与 badge 完全同口径；FYI/已处理不计）。 */
export function unreadCardsCount(db: SqliteDb): number {
  const cursor = getReadCursor(db, READ_PRINCIPAL_BOSS, READ_SURFACE_CARDS);
  return unreadCount(db, READ_SURFACE_CARDS, cursor?.last_item_id ?? 0);
}

function unreadCount(db: SqliteDb, surface: ReadSurface, lastItemId: number): number {
  if (surface === READ_SURFACE_CARDS) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM reports
           WHERE id > ? AND state IN ('pending','delivered') AND kind IN ('ask','report','alert')`,
        )
        .get(lastItemId) as { n: number }
    ).n;
  }
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM human_messages WHERE id > ? AND direction = 'out'")
      .get(lastItemId) as { n: number }
  ).n;
}

export function getReadCursor(db: SqliteDb, principal: string, surface: ReadSurface): ReadCursorRow | null {
  assertPrincipal(principal);
  assertSurface(surface);
  return (
    (db
      .prepare(
        `SELECT principal, surface, last_item_id, last_read_at, updated_at, source
         FROM read_cursors WHERE principal = ? AND surface = ?`,
      )
      .get(principal, surface) as ReadCursorRow | undefined) ?? null
  );
}

export function readState(db: SqliteDb, principal: string, surface: string): ReadState {
  assertPrincipal(principal);
  assertSurface(surface);
  const cursor = getReadCursor(db, principal, surface);
  const lastItemId = cursor?.last_item_id ?? 0;
  return {
    principal,
    surface,
    lastItemId,
    lastReadAt: cursor?.last_read_at ?? null,
    unread: unreadCount(db, surface, lastItemId),
    unreadState: 'exact',
    asOfId: maxId(db, surface),
  };
}

/**
 * 推进游标到 `throughId`（只前进）。`throughId` 必须在当前 source 的 id 范围内；
 * 越界/负数显式拒（防“预先标记未来”）；相等/更小是幂等 no-op。
 */
export function markRead(db: SqliteDb, input: MarkReadInput): MarkReadResult {
  assertPrincipal(input.principal);
  assertSurface(input.surface);
  if (!Number.isInteger(input.throughId) || input.throughId < 0) {
    throw new ReadCursorError('bad_request', `throughId 需为非负整数：${String(input.throughId)}`);
  }
  const surface = input.surface;
  const max = maxId(db, surface);
  if (input.throughId > max) {
    throw new ReadCursorError('bad_request', `throughId ${input.throughId} 超过当前最大 id ${max}`);
  }
  // 高水位不能跨过不存在的 id（防未来/缺口 id 把未见过的消息永久标读）。
  if (input.throughId > 0 && !sourceHasId(db, surface, input.throughId)) {
    throw new ReadCursorError('bad_request', `throughId ${input.throughId} 不在 ${surface} 的源数据中`);
  }
  const now = input.now ?? Date.now();
  const source = input.source ?? 'desktop';
  const existing = getReadCursor(db, input.principal, surface);
  if (existing && input.throughId <= existing.last_item_id) {
    return { changed: false, state: readState(db, input.principal, surface) };
  }
  const info = db
    .prepare(
      `INSERT INTO read_cursors(principal, surface, last_item_id, last_read_at, updated_at, source)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal, surface) DO UPDATE SET
         last_item_id = excluded.last_item_id,
         last_read_at = excluded.last_read_at,
         updated_at = excluded.updated_at,
         source = excluded.source
       WHERE excluded.last_item_id > read_cursors.last_item_id`,
    )
    .run(input.principal, surface, input.throughId, now, now, source);
  return {
    changed: info.changes > 0,
    state: readState(db, input.principal, surface),
  };
}
