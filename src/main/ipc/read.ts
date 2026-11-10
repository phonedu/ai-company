/**
 * `inbox:read-state` / `inbox:read-mark`（1c）。
 *
 * 只读/写服务端未读游标；业务事实（`reports`/`approvals`/任务状态）不在这里动。
 * 当前只接受老板桌面（principal='boss'）；远程入口以后复用同一 DAO，并把 source 换成 `remote`。
 */
import type { SqliteDb } from '../db/open.js';
import {
  READ_PRINCIPAL_BOSS,
  ReadCursorError,
  isReadSurface,
  markRead,
  readState,
  type MarkReadResult,
  type ReadSource,
  type ReadState,
  type ReadSurface,
} from '../db/read_cursors.js';

interface ReadDeps {
  db?: SqliteDb;
  /** 写成功后通知主进程推 `evt:read`/刷新托盘（缺省不推＝渲染层靠下一次拉取）。 */
  onReadChanged?: () => void;
}

function dbOf(deps: ReadDeps): SqliteDb {
  if (!deps.db) throw new ReadCursorError('bad_request', '数据库未就绪');
  return deps.db;
}

function surfaceOf(raw: unknown): ReadSurface {
  if (!raw || typeof raw !== 'object') {
    throw new ReadCursorError('bad_request', '缺少 surface');
  }
  const surface = (raw as { surface?: unknown }).surface;
  if (typeof surface !== 'string' || !isReadSurface(surface)) {
    throw new ReadCursorError('unknown_surface', `未知未读 surface：${String(surface)}`);
  }
  return surface;
}

export function handleReadState(deps: ReadDeps, raw: unknown): ReadState {
  const surface = surfaceOf(raw);
  try {
    return readState(dbOf(deps), READ_PRINCIPAL_BOSS, surface);
  } catch (error) {
    // 非法 surface/principal 仍按契约报错；DB/查询失败降级为 unknown（UI 显 —，不写假 0）。
    if (error instanceof ReadCursorError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      principal: READ_PRINCIPAL_BOSS,
      surface,
      lastItemId: 0,
      lastReadAt: null,
      unread: null,
      unreadState: 'unknown',
      reason,
      asOfId: 0,
    };
  }
}

function sourceOf(raw: unknown): ReadSource {
  const source = (raw as { source?: unknown } | null)?.source;
  return source === 'action' ? 'action' : 'desktop';
}

export function handleReadMark(deps: ReadDeps, raw: unknown, at = Date.now()): MarkReadResult {
  const surface = surfaceOf(raw);
  const throughId = (raw as { throughId?: unknown }).throughId;
  if (typeof throughId !== 'number' || !Number.isInteger(throughId) || throughId < 0) {
    throw new ReadCursorError('bad_request', `throughId 需为非负整数：${String(throughId)}`);
  }
  const result = markRead(dbOf(deps), {
    principal: READ_PRINCIPAL_BOSS,
    surface,
    throughId,
    now: at,
    source: sourceOf(raw),
  });
  deps.onReadChanged?.();
  return result;
}
