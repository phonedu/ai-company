/**
 * `reports` DAO —— 三类卡片（report 汇报 / ask 决策 / alert 异常，schema.sql）。
 * T0.5 老板频道按 `reports.state` 渲染卡片；`dedupe_key` 供通知去重。
 */
import type { SqliteDb } from './open.js';

export interface ReportRow {
  id: number;
  /** v8/BRK21：可空 = 全局卡（不属任何任务）。 */
  task_id: number | null;
  kind: 'report' | 'ask' | 'alert' | string;
  payload: string;
  state: string;
  dedupe_key: string | null;
  created_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
  /** OPT-M3-1：验证结论 pass|fail|partial（可空）。 */
  verdict: string | null;
  /** OPT-M3-1：验证者员工 id（≠实现者，可空）。 */
  verifier_employee_id: number | null;
}

export interface InsertReportInput {
  /** 承载卡片的任务 id；`null` = **全局卡**（不属任何任务，如空库日报；迁移 008 起可空）。 */
  taskId: number | null;
  kind: 'report' | 'ask' | 'alert' | string;
  payload?: unknown;
  state?: string;
  dedupeKey?: string | null;
  now?: number;
}

const COLUMNS =
  'id, task_id, kind, payload, state, dedupe_key, created_at, delivered_at, acknowledged_at, verdict, verifier_employee_id';

export function insertReport(db: SqliteDb, input: InsertReportInput): ReportRow {
  return db
    .prepare(
      `INSERT INTO reports(task_id, kind, payload, state, dedupe_key, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      input.taskId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.state ?? 'pending',
      input.dedupeKey ?? null,
      input.now ?? Date.now(),
    ) as ReportRow;
}

export interface ListReportsOptions {
  taskId?: number;
  state?: string;
  kind?: string;
  limit?: number;
  /** 取**最新** N 条（仍按时间升序返回）；缺省＝最旧 N 条（历史口径）。 */
  latest?: boolean;
}

export function listReports(db: SqliteDb, options: ListReportsOptions = {}): ReportRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.taskId !== undefined) {
    where.push('task_id = ?');
    params.push(options.taskId);
  }
  if (options.state !== undefined) {
    where.push('state = ?');
    params.push(options.state);
  }
  if (options.kind !== undefined) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  const order = options.latest === true ? 'DESC' : 'ASC';
  let sql = `SELECT ${COLUMNS} FROM reports${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ${order}, id ${order}`;
  if (options.limit != null) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  const rows = db.prepare(sql).all(...params) as ReportRow[];
  return options.latest === true ? rows.reverse() : rows;
}

export function getReport(db: SqliteDb, id: number): ReportRow | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM reports WHERE id = ?`).get(id) as ReportRow | undefined) ?? null;
}

/** 标记已阅（幂等：已 acknowledged 不覆盖）。除 `acknowledged_at` 外同步把 `state` 推到 `'acknowledged'`
 * （卡片 state 徽章与可操作性依赖它；数据不变量归 DB 层单一写者，1132 裁决）。 */
export function acknowledgeReport(db: SqliteDb, id: number, now: number = Date.now()): ReportRow {
  db.prepare(
    "UPDATE reports SET acknowledged_at = ?, state = 'acknowledged' WHERE id = ? AND acknowledged_at IS NULL",
  ).run(now, id);
  const row = getReport(db, id);
  if (!row) throw new Error(`[db] acknowledgeReport: 报告不存在 id=${id}`);
  return row;
}

export interface AcknowledgePendingAsksOptions {
  /** 终态事件才允许清 `payload.card='permission'`；默认不清，避免误清同任务另一张仍待答的权限卡。 */
  includePermission?: boolean;
}

/**
 * RM-2（2026-10-19 真机）：任务已离开 `needs_decision`/`awaiting_approval` 后，把该任务仍 pending 的
 * ask 卡标已阅——老板在老板频道用一句话解决了问题，不应在「待我处理」里继续挂着。
 * 只标 `kind='ask'` 的 pending/delivered；report/alert 不动。
 * **默认排除权限卡**（D4：权限卡不改变任务状态，可能与本任务另一张决策卡同时待答）；
 * 终态清理由调用方显式 `includePermission: true`。返回受影响行数。
 */
export function acknowledgePendingAsksForTask(
  db: SqliteDb,
  taskId: number,
  now: number = Date.now(),
  options: AcknowledgePendingAsksOptions = {},
): number {
  const rows = db
    .prepare(
      "SELECT id, payload FROM reports WHERE task_id = ? AND kind = 'ask' AND state IN ('pending', 'delivered')",
    )
    .all(taskId) as Array<{ id: number; payload: string }>;
  const update = db.prepare(
    "UPDATE reports SET acknowledged_at = COALESCE(acknowledged_at, ?), state = 'acknowledged' WHERE id = ?",
  );
  let changed = 0;
  for (const row of rows) {
    if (!options.includePermission) {
      let card: unknown;
      try {
        card = (JSON.parse(row.payload) as { card?: unknown }).card;
      } catch {
        card = undefined;
      }
      if (card === 'permission') continue;
    }
    changed += Number(update.run(now, row.id).changes);
  }
  return changed;
}

/**
 * RM-2 接线（D4 must-fix 2）：按**任务当前状态**判断，而不是猜事件名。
 * 任务已离开 `needs_decision`/`awaiting_approval` → 清同任务 pending ask；仍在等待 → 不动。
 * 对任何已提交 task 事件都可调用（派生事件同样适用）。
 */
export function acknowledgePendingAsksIfTaskSettled(
  db: SqliteDb,
  taskId: number,
  now: number = Date.now(),
  options: AcknowledgePendingAsksOptions = {},
): number {
  const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as { state: string } | undefined;
  if (!row) return 0;
  if (row.state === 'needs_decision' || row.state === 'awaiting_approval') return 0;
  return acknowledgePendingAsksForTask(db, taskId, now, options);
}

/**
 * GAP8：合并更新卡片 payload（当前用于批准卡上的计划全文）。
 * 只做浅合并：既有 title/question/options 等字段原样保留；坏 JSON → 以空对象为底（不抛）。
 */
export function updateReportPayload(
  db: SqliteDb,
  reportId: number,
  patch: Record<string, unknown>,
): ReportRow {
  const row = getReport(db, reportId);
  if (!row) throw new Error(`[db] updateReportPayload: 报告不存在 id=${reportId}`);
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  db.prepare('UPDATE reports SET payload = ? WHERE id = ?').run(JSON.stringify({ ...payload, ...patch }), reportId);
  return getReport(db, reportId) as ReportRow;
}

/** OPT-M3-1：把验证结论（verdict + verifier）记到报告行（reports）。 */
export function setReportVerdict(db: SqliteDb, reportId: number, verdict: string, verifierEmployeeId: number | null): ReportRow {
  db.prepare('UPDATE reports SET verdict = ?, verifier_employee_id = ? WHERE id = ?').run(
    verdict,
    verifierEmployeeId,
    reportId,
  );
  const row = getReport(db, reportId);
  if (!row) throw new Error(`[db] setReportVerdict: 报告不存在 id=${reportId}`);
  return row;
}

/** 投递标记（幂等：已 delivered 不覆盖）。 */
export function markReportDelivered(db: SqliteDb, id: number, now: number = Date.now()): ReportRow {
  db.prepare('UPDATE reports SET state = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(
    'delivered',
    now,
    id,
  );
  const row = getReport(db, id);
  if (!row) throw new Error(`[db] markReportDelivered: 报告不存在 id=${id}`);
  return row;
}
