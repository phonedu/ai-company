/**
 * `timers.ts` —— 持久化时钟与看门狗（PLAN §19.2、schema.sql 的 `timers`）。
 *
 * 幂等：
 *  - 登记：`dedupe_key` 非空时按 (kind, task_id, dedupe_key) 部分唯一索引 UPSERT，
 *    同逻辑定时器重复登记只更新 due_at（不新增行）。
 *  - 重启重建（DEV §4.5 步骤④）：先 `DELETE WHERE fired_at IS NULL` 再按物化状态重计划；
 *    或依赖 UPSERT 幂等。二者都提供。
 */
import type { TaskState } from '../../core/types.js';
import type { SqliteDb } from '../db/open.js';

export interface TimerRow {
  id: number;
  kind: string;
  task_id: number | null;
  due_at: number;
  payload: string;
  dedupe_key: string | null;
  fired_at: number | null;
}

export interface ScheduleTimerInput {
  kind: string;
  taskId?: number | null;
  dueAt: number;
  payload?: unknown;
  dedupeKey?: string | null;
}

export type TimerKind =
  | 'askcard_timeout'
  | 'blocked_watchdog'
  | 'session_heartbeat'
  | 'cron_fire'
  /** UG-02：截止前提醒（一次性；不自动暂停）。 */
  | 'task_deadline_remind'
  /** UG-02：截止后逾期卡（一次性；不自动暂停）。 */
  | 'task_deadline_overdue'
  /** GAP1：一次性事件触发（`task_id`=源任务；due 远未来，仅由 trigger service 消费）。 */
  | 'event_trigger';

const COLUMNS = 'id, kind, task_id, due_at, payload, dedupe_key, fired_at';

/** 登记定时器；`dedupe_key` 非空时 UPSERT（同逻辑只一行）。返回定时器 id。 */
export function scheduleTimer(db: SqliteDb, input: ScheduleTimerInput): number {
  const row = db
    .prepare(
      `INSERT INTO timers(kind, task_id, due_at, payload, dedupe_key)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(kind, task_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload, fired_at = NULL
       RETURNING id`,
    )
    .get(
      input.kind,
      input.taskId ?? null,
      input.dueAt,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
    ) as { id: number };
  return row.id;
}

export function listTimers(db: SqliteDb): TimerRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM timers ORDER BY due_at, id`).all() as TimerRow[];
}

export function listUnfiredTimers(db: SqliteDb): TimerRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM timers WHERE fired_at IS NULL ORDER BY due_at, id`).all() as TimerRow[];
}

export function listDueTimers(db: SqliteDb, now: number): TimerRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM timers WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at, id`)
    .all(now) as TimerRow[];
}

/**
 * 原地重排（GAP1 cron 用）：保持 timer id 不变，更新 due/payload 并清 fired_at。
 * 适用 task_id=NULL 的触发器（`(kind, task_id, dedupe_key)` 唯一索引对 NULL 不生效，不能靠 UPSERT）。
 */
export function rescheduleTimer(db: SqliteDb, id: number, dueAt: number, payload: unknown): boolean {
  const info = db
    .prepare('UPDATE timers SET due_at = ?, payload = ?, fired_at = NULL WHERE id = ?')
    .run(dueAt, JSON.stringify(payload ?? {}), id);
  return info.changes > 0;
}

/** 标记定时器已触发（仅未触发时）。返回是否本次触发。 */
export function markTimerFired(db: SqliteDb, id: number, now: number): boolean {
  const info = db.prepare('UPDATE timers SET fired_at = ? WHERE id = ? AND fired_at IS NULL').run(now, id);
  return info.changes > 0;
}

/** 清除某任务某类**未触发**定时器（离开对应状态时用，避免残留看门狗误触发）。返回删除条数。 */
export function clearUnfiredTimers(db: SqliteDb, kind: string, taskId: number): number {
  const info = db.prepare('DELETE FROM timers WHERE kind = ? AND task_id = ? AND fired_at IS NULL').run(kind, taskId);
  return info.changes;
}

// 看门狗默认超时（M0 常量；M1 起从 settings 读）。
export const ASK_CARD_TIMEOUT_MS = 30 * 60 * 1000;
export const BLOCKED_WATCHDOG_MS = 30 * 60 * 1000;
/** BRK-R6：工作项会话心跳超时（任意 agent 事件都会刷新；无事件超过此值 → 判卡死）。 */
export const SESSION_HEARTBEAT_MS = 10 * 60 * 1000;
/** UG-02：截止前多久提醒（24h；只提醒，不暂停任务）。 */
export const DEADLINE_REMIND_MS = 24 * 60 * 60 * 1000;

/** UG-02：登记截止提醒 + 逾期卡（幂等：同任务同 dedupe_key UPSERT）。 */
export function scheduleTaskDeadlineTimers(
  db: SqliteDb,
  input: { taskId: number; deadline: number; now?: number },
): { remindAt: number | null; overdueAt: number } {
  const now = input.now ?? Date.now();
  const overdueAt = input.deadline;
  let remindAt: number | null = input.deadline - DEADLINE_REMIND_MS;
  // 截止已在 24h 内：给一条很快的提醒；已过期则不再提醒，只等逾期卡。
  if (remindAt <= now) remindAt = input.deadline > now ? now + 60_000 : null;
  if (remindAt != null && remindAt < input.deadline) {
    scheduleTimer(db, {
      kind: 'task_deadline_remind',
      taskId: input.taskId,
      dueAt: remindAt,
      dedupeKey: 'deadline:remind',
      payload: { deadline: input.deadline },
    });
  }
  scheduleTimer(db, {
    kind: 'task_deadline_overdue',
    taskId: input.taskId,
    dueAt: overdueAt,
    dedupeKey: 'deadline:overdue',
    payload: { deadline: input.deadline },
  });
  return { remindAt, overdueAt };
}

/** BRK-R6：登记/刷新工作项心跳（UPSERT；同 work item 只一行）。 */
export function heartbeatWorkItem(db: SqliteDb, input: { taskId: number; workItemId: number; now: number; timeoutMs?: number }): void {
  scheduleTimer(db, {
    kind: 'session_heartbeat',
    taskId: input.taskId,
    dueAt: input.now + (input.timeoutMs ?? SESSION_HEARTBEAT_MS),
    dedupeKey: `heartbeat:wi:${input.workItemId}`,
    payload: { workItemId: input.workItemId },
  });
}

/** 清除某工作项未触发的心跳（件离开 running / 已提交 / 已失败时）。 */
export function clearWorkItemHeartbeat(db: SqliteDb, workItemId: number): number {
  const info = db
    .prepare("DELETE FROM timers WHERE kind = 'session_heartbeat' AND dedupe_key = ? AND fired_at IS NULL")
    .run(`heartbeat:wi:${workItemId}`);
  return info.changes;
}

/**
 * 从物化状态重计划定时器（重启重建用）。
 * M0 覆盖：`awaiting_approval`（AskCard 超时）、`blocked`（阻塞看门狗）；
 * B6 补：`needs_decision`（同样有 AskCard 超时）。
 */
export function planTimersFromState(
  tasks: Array<{ id: number; state: TaskState; deadline?: number | null }>,
  now: number,
): ScheduleTimerInput[] {
  const out: ScheduleTimerInput[] = [];
  for (const t of tasks) {
    if (t.state === 'awaiting_approval' || t.state === 'needs_decision') {
      out.push({ kind: 'askcard_timeout', taskId: t.id, dueAt: now + ASK_CARD_TIMEOUT_MS, dedupeKey: 'askcard' });
    }
    if (t.state === 'blocked') {
      out.push({ kind: 'blocked_watchdog', taskId: t.id, dueAt: now + BLOCKED_WATCHDOG_MS, dedupeKey: 'watchdog:blocked' });
    }
    // UG-02：未终态且有截止 → 重建提醒/逾期卡（只提醒，不改状态）。
    if (t.deadline != null && t.state !== 'done' && t.state !== 'cancelled') {
      let remindAt: number | null = t.deadline - DEADLINE_REMIND_MS;
      if (remindAt <= now) remindAt = t.deadline > now ? now + 60_000 : null;
      if (remindAt != null && remindAt < t.deadline) {
        out.push({
          kind: 'task_deadline_remind',
          taskId: t.id,
          dueAt: remindAt,
          dedupeKey: 'deadline:remind',
          payload: { deadline: t.deadline },
        });
      }
      out.push({
        kind: 'task_deadline_overdue',
        taskId: t.id,
        dueAt: t.deadline,
        dedupeKey: 'deadline:overdue',
        payload: { deadline: t.deadline },
      });
    }
  }
  return out;
}

/** 重建：先删未触发，再按物化状态重计划（DEV §4.5 步骤④策略 a）。返回重建条数。 */
export function rebuildTimers(
  db: SqliteDb,
  tasks: Array<{ id: number; state: TaskState; deadline?: number | null }>,
  now: number,
): number {
  // GAP1 的触发定义不是看门狗：cron/事件触发器跨重启必须保留（否则重启即丢所有定时）。
  db.exec("DELETE FROM timers WHERE fired_at IS NULL AND kind NOT IN ('cron_fire','event_trigger')");
  const planned = planTimersFromState(tasks, now);
  for (const p of planned) scheduleTimer(db, p);
  return planned.length;
}
