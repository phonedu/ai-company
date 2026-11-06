/**
 * `ResolverStore` 的 better-sqlite3 实现（`src/core/resolver.ts` 的存储接口）。
 *
 * 归属解析（`resolveInbound`）桌面与 IM 共用；本文件把它的只读/会话状态查询接到 SQLite：
 *   im_conversations（sticky 焦点，desktop 复用 channel='desktop'）
 *   outbound_refs（回复链归位）
 *   pending_lists（"只问一次"的候选清单）
 *   projects（别名 / 默认项目）
 *   tasks（短号 / id / 最近活跃）
 * 纯数据访问，无业务逻辑；的 `chat:send` IPC 调用。
 */
import type { ConversationState, PendingList, ProjectRef, ResolverStore } from '../../core/resolver.js';
import type { TaskSnapshot, TaskState } from '../../core/types.js';
import type { SqliteDb } from './open.js';
import { getDefaultProject, getProjectByAlias } from './projects.js';
import { toTaskSnapshot, type TaskRow } from './tasks.js';

/** 非终态（"最近活跃任务"的取值范围）。 */
const ACTIVE_STATES: TaskState[] = [
  'inbox',
  'planning',
  'awaiting_approval',
  'ready',
  'executing',
  'paused',
  'verifying',
  'needs_decision',
  'blocked',
];

export function createResolverStore(db: SqliteDb): ResolverStore {
  const activePlaceholders = ACTIVE_STATES.map(() => '?').join(', ');

  const taskRowById = (id: number): TaskRow | undefined =>
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  const taskRowByShortId = (shortId: string): TaskRow | undefined =>
    db.prepare('SELECT * FROM tasks WHERE short_id = ?').get(shortId) as TaskRow | undefined;
  const toSnapshot = (row: TaskRow | undefined): TaskSnapshot | null => (row ? toTaskSnapshot(row) : null);

  return {
    getConversation(channel: string, conversationRef: string): ConversationState | null {
      const row = db
        .prepare(
          'SELECT kind, project_id, focus_task_id, focus_updated_at FROM im_conversations WHERE channel = ? AND conversation_ref = ?',
        )
        .get(channel, conversationRef) as
        | {
            kind: 'private' | 'group';
            project_id: number | null;
            focus_task_id: number | null;
            focus_updated_at: number | null;
          }
        | undefined;
      if (!row) return null;
      return {
        kind: row.kind,
        projectId: row.project_id,
        focusTaskId: row.focus_task_id,
        focusUpdatedAt: row.focus_updated_at,
      };
    },

    setFocus(channel: string, conversationRef: string, taskId: number, at: number): void {
      db.prepare(
        `INSERT INTO im_conversations(channel, conversation_ref, kind, focus_task_id, focus_updated_at, last_active_at)
         VALUES(?, ?, 'private', ?, ?, ?)
         ON CONFLICT(channel, conversation_ref) DO UPDATE SET
           focus_task_id = excluded.focus_task_id,
           focus_updated_at = excluded.focus_updated_at,
           last_active_at = excluded.last_active_at`,
      ).run(channel, conversationRef, taskId, at, at);
    },

    findOutboundRef(channel: string, platformMsgId: string): { taskId: number; reportId: number | null } | null {
      const row = db
        .prepare('SELECT task_id, report_id FROM outbound_refs WHERE channel = ? AND platform_msg_id = ?')
        .get(channel, platformMsgId) as { task_id: number | null; report_id: number | null } | undefined;
      if (!row || row.task_id == null) return null;
      return { taskId: row.task_id, reportId: row.report_id };
    },

    getTaskByShortId(shortId: string): TaskSnapshot | null {
      return toSnapshot(taskRowByShortId(shortId));
    },

    getTaskById(id: number): TaskSnapshot | null {
      return toSnapshot(taskRowById(id));
    },

    getRecentActiveTasks(limit: number): TaskSnapshot[] {
      const rows = db
        .prepare(
          `SELECT * FROM tasks WHERE state IN (${activePlaceholders}) ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(...ACTIVE_STATES, limit) as TaskRow[];
      return rows.map(toTaskSnapshot);
    },

    getProjectByAlias(alias: string): ProjectRef | null {
      return getProjectByAlias(db, alias);
    },

    getDefaultProject(): ProjectRef | null {
      return getDefaultProject(db);
    },

    getPendingList(channel: string, conversationRef: string): PendingList | null {
      const row = db
        .prepare(
          'SELECT message_ref, created_at, items, expires_at FROM pending_lists WHERE channel = ? AND conversation_ref = ?',
        )
        .get(channel, conversationRef) as
        | { message_ref: string; created_at: number; items: string; expires_at: number | null }
        | undefined;
      if (!row) return null;
      if (row.expires_at != null && row.expires_at < Date.now()) return null;
      let items: PendingList['items'] = [];
      try {
        const parsed = JSON.parse(row.items) as unknown;
        if (Array.isArray(parsed)) items = parsed as PendingList['items'];
      } catch {
        items = [];
      }
      return { messageRef: row.message_ref, createdAt: row.created_at, items };
    },

    setPendingList(
      channel: string,
      conversationRef: string,
      list: { messageRef: string; items: PendingList['items']; ttlMs?: number },
    ): void {
      const now = Date.now();
      const expiresAt = list.ttlMs != null ? now + list.ttlMs : null;
      // 覆盖式（UNIQUE(channel, conversation_ref)）：同一会话只留最新一份「只问一次」清单。
      db.prepare(
        `INSERT INTO pending_lists(channel, conversation_ref, message_ref, items, created_at, expires_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, conversation_ref) DO UPDATE SET
           message_ref = excluded.message_ref,
           items = excluded.items,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      ).run(channel, conversationRef, list.messageRef, JSON.stringify(list.items), now, expiresAt);
    },

    clearPendingList(channel: string, conversationRef: string): void {
      db.prepare('DELETE FROM pending_lists WHERE channel = ? AND conversation_ref = ?').run(channel, conversationRef);
    },
  };
}
