/**
 *  余 · 日报（``「提醒而不轰炸：长期未处理的决策与待验收，每天并进日报提醒一次」；
 * ``「日报：每项目一份 ＋ 全局一份，**由事件流自动生成**」）。
 *
 * 本版（v1）只做**全局一份**、内容**全部由真数据推导**（不臆造、空就是空）：
 *  - 当日完成/失败/取消的任务（`tasks.closed_at` 在窗内）＋ 参与员工数（按完成任务的 owner 去重）；
 *  - 当日成本（`costs.usd` 求和；**无行 ⇒ `null`**，显示 `—` 而不是假 0）；
 *  - **待处理提醒**：`reports.state='pending'` 的卡数（决策/验收/异常都在内）——这正是 §157 的"每天提醒一次"。
 *
 * 幂等：`emitDailyDigest` 用 `digest:<YYYY-MM-DD>` 作 dedupe key（`notify` 短路）⇒ **当天只发一次**，
 * 重启/多次 tick 都安全。
 */
import type { SqliteDb } from '../db/open.js';
import { unreadCardsCount } from '../db/read_cursors.js';
import { notify } from './index.js';

export interface DigestContent {
  /** 窗内完成（含失败/取消？不——分开列）：完成的短号。 */
  completedShortIds: string[];
  failedCount: number;
  cancelledCount: number;
  /** 参与员工数（完成任务 owner 去重；无 → 0）。 */
  employeeCount: number;
  /** 当日花费美元额；**无成本行 → null**（不写假 0）。 */
  usd: number | null;
  /** 待处理卡数（`reports.state='pending'`）。 */
  pendingCards: number;
}

export interface DigestInput {
  /** 窗口起点（本地当日 0 点）。 */
  since: number;
  /** 窗口终点（一般是 now）。 */
  until: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地当日 0 点（epoch ms）。 */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildDigestContent(db: SqliteDb, input: DigestInput): DigestContent {
  const tasks = db
    .prepare('SELECT short_id, state, owner_id FROM tasks WHERE closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?')
    .all(input.since, input.until) as Array<{ short_id: string; state: string; owner_id: number | null }>;
  const completedShortIds = tasks.filter((t) => t.state === 'done').map((t) => t.short_id);
  const owners = new Set(
    tasks.filter((t) => t.state === 'done' && t.owner_id != null).map((t) => Number(t.owner_id)),
  );

  const costRow = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(usd), 0) usd FROM costs WHERE created_at >= ? AND created_at < ?').get(input.since, input.until) as {
    n: number;
    usd: number;
  };
  // 与左栏 badge/托盘同口径：只数 ask/report/alert 的未读（FYI notification/已处理不计）。
  const pendingCards = unreadCardsCount(db);

  return {
    completedShortIds,
    failedCount: tasks.filter((t) => t.state === 'failed').length,
    cancelledCount: tasks.filter((t) => t.state === 'cancelled').length,
    employeeCount: owners.size,
    usd: costRow.n > 0 ? Number(costRow.usd) : null,
    pendingCards,
  };
}

/** 日报（人话）——**空就是空**：无完成/无成本都如实写。 */
export function digestText(content: DigestContent): string {
  const done = content.completedShortIds.length;
  const parts: string[] = [];
  parts.push(
    done > 0
      ? `今天 ${content.employeeCount} 位员工完成 ${done} 件任务（${content.completedShortIds.slice(0, 8).join(' ')}${done > 8 ? ' …' : ''}）`
      : '今天暂无完成的任务',
  );
  if (content.failedCount > 0) parts.push(`${content.failedCount} 件失败`);
  if (content.cancelledCount > 0) parts.push(`${content.cancelledCount} 件取消`);
  parts.push(content.usd == null ? '成本 —（记录中暂无当日数据）' : `成本 $${content.usd.toFixed(4)}`);
  const tail =
    content.pendingCards > 0
      ? `待你处理：${content.pendingCards} 张卡（决策 / 验收 / 异常）——「待我处理」里点一点即可。`
      : '待你处理：暂无。';
  return `${parts.join('；')}。${tail}`;
}

export interface EmitDigestResult {
  /** false = 当天已发过（幂等短路）。 */
  delivered: boolean;
  content: DigestContent;
}

/**
 * 发当日日报（幂等：`digest:<YYYY-MM-DD>`；**同一天重复调用只发一次**）。
 * `dateKey` 用**本地日期**——用户看到的是本地日历天。
 */
export function emitDailyDigest(db: SqliteDb, input: { now: number }): EmitDigestResult {
  const since = startOfLocalDay(input.now);
  const content = buildDigestContent(db, { since, until: input.now + 1 });
  const d = new Date(input.now);
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const res = notify(db, {
    taskId: digestAnchorTaskId(db), // 最近活跃任务；无任务 ⇒ null（全局卡；/008：该列已可空）
    kind: 'notification', // FYI（`UI §4.1` 第四类）；不占决策/验收 tab
    dedupeKey: `digest:${dateKey}`,
    payload: { title: `日报 · ${dateKey}`, tldr: digestText(content), digest: content },
    now: input.now,
  });
  return { delivered: res.delivered, content };
}

/**
 * 日报落点的 `task_id`：挂**当日最近活跃任务的 id**；**无任务 ⇒ `null`**（全局卡）。
 *
 * 修正（/ 迁移 `008`，2026-10-15）：此前用哨兵 `0` 且注释声称「`reports.task_id` 无 FK 校验到 tasks」——
 * **与实况不符**（`schema.sql` 该列 `REFERENCES tasks(id)`）⇒ 空库首启日报撞 FOREIGN KEY、当天永远收不到。
 * 现口径：`reports.task_id` 已放宽**可空**（008），`null` = 不属任何任务的全局卡；UI 显示「全局」。
 */
function digestAnchorTaskId(db: SqliteDb): number | null {
  const row = db.prepare('SELECT id FROM tasks ORDER BY updated_at DESC LIMIT 1').get() as { id: number } | undefined;
  return row?.id ?? null;
}
