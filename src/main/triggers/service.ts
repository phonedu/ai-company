/**
 * GAP1（M3-N-1）：触发式开工 v1。
 *
 * 存储：复用 `timers` 表（**不新增表/迁移**）——
 *  - `kind='cron_fire'` + `task_id=NULL`：周期/每日触发模板（payload 带任务模板与下次 due）；
 *  - `kind='event_trigger'` + `task_id=<源任务>`：一次性事件触发（源任务完成后建新任务）。
 * 幂等：cron 触发后 `markTimerFired` 再同 dedupe_key 重排下一拍；event trigger 触发后删除。
 * 取消：删除对应 timer 行（未触发的立即消失；已触发的已重排/删除，不可复活）。
 * 所有任务创建经宿主注入的 `materialize`（createTask + triage），由宿主负责短号/权限/事件。
 */
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../db/open.js';
import { listTimers, markTimerFired, rescheduleTimer, scheduleTimer, type TimerRow } from '../engine/timers.js';
import type { EngineEvent } from '../engine/types.js';

function isProjectArchived(db: SqliteDb, projectId: number): boolean {
  const row = db.prepare('SELECT archived FROM projects WHERE id = ?').get(projectId) as
    | { archived?: number | null }
    | undefined;
  return row?.archived === 1;
}

export interface TriggerTemplate {
  projectId: number;
  title: string;
  goal: string;
  riskLevel: number;
}

export interface CreateCronTriggerInput extends TriggerTemplate {
  name: string;
  intervalMinutes?: number;
  dailyMinute?: number;
  now?: number;
}

export interface CreateEventTriggerInput extends TriggerTemplate {
  name: string;
  sourceTaskId: number;
  /** v1 只支持 task_completed。 */
  eventKind: 'task_completed';
  now?: number;
}

export interface TriggerView {
  id: number;
  kind: 'cron' | 'event';
  name: string;
  nextDueAt: number | null;
  projectId: number;
  title: string;
  goal: string;
  intervalMinutes: number | null;
  dailyMinute: number | null;
  sourceTaskId: number | null;
  eventKind: string | null;
  lastFiredAt: number | null;
  lastTaskId: number | null;
}

export interface TriggerService {
  createCron(input: CreateCronTriggerInput): TriggerView;
  createEvent(input: CreateEventTriggerInput): TriggerView;
  list(): TriggerView[];
  cancel(id: number): boolean;
  /** 处理到期 cron＋排队事件；返回本次物化的任务数。 */
  tick(now?: number): Promise<number>;
  /** 引擎事件入口（同步入队；真正建任务在 tick 里，避开引擎事务内重入）。 */
  onEngineEvent(event: EngineEvent): void;
  start(intervalMs?: number): void;
  stop(): void;
}

const EVENT_FAR_FUTURE_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 下一拍 due（每日按本地分钟；间隔从 now 起算）。 */
export function nextTriggerDueAt(
  input: { intervalMinutes?: number; dailyMinute?: number },
  now: number,
): number {
  if (typeof input.intervalMinutes === 'number' && input.intervalMinutes > 0) {
    return now + input.intervalMinutes * 60_000;
  }
  if (typeof input.dailyMinute === 'number' && input.dailyMinute >= 0 && input.dailyMinute <= 1439) {
    const d = new Date(now);
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(input.dailyMinute / 60), input.dailyMinute % 60, 0, 0).getTime();
    return today > now ? today : today + DAY_MS;
  }
  throw new Error('cron 触发需要 intervalMinutes 或 dailyMinute');
}

function parsePayload(row: TimerRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toView(row: TimerRow): TriggerView | null {
  const p = parsePayload(row);
  const kind = row.kind === 'cron_fire' ? 'cron' : row.kind === 'event_trigger' ? 'event' : null;
  if (!kind) return null;
  const projectId = typeof p.projectId === 'number' ? p.projectId : null;
  const title = typeof p.title === 'string' ? p.title : '';
  const goal = typeof p.goal === 'string' ? p.goal : '';
  if (projectId == null || title.length === 0 || goal.length === 0) return null;
  return {
    id: row.id,
    kind,
    name: typeof p.name === 'string' ? p.name : title,
    nextDueAt: kind === 'cron' ? row.due_at : null,
    projectId,
    title,
    goal,
    intervalMinutes: typeof p.intervalMinutes === 'number' ? p.intervalMinutes : null,
    dailyMinute: typeof p.dailyMinute === 'number' ? p.dailyMinute : null,
    sourceTaskId: kind === 'event' ? row.task_id : null,
    eventKind: typeof p.eventKind === 'string' ? p.eventKind : null,
    lastFiredAt: typeof p.lastFiredAt === 'number' ? p.lastFiredAt : null,
    lastTaskId: typeof p.lastTaskId === 'number' ? p.lastTaskId : null,
  };
}

function listTriggerRows(db: SqliteDb): TimerRow[] {
  return listTimers(db).filter(
    (row) => row.fired_at == null && (row.kind === 'cron_fire' || row.kind === 'event_trigger'),
  );
}

/** 事件名 → “任务完成”判定（v1 只认这三条真实迁移事件）。 */
function isCompletedEvent(event: EngineEvent): boolean {
  if (event.scope !== 'task') return false;
  if (event.event === 'finish_manual' || event.event === 'finish') return true;
  if (event.event === 'verification_completed') {
    const verdict = (event.payload as { verdict?: unknown } | undefined)?.verdict;
    return verdict === 'pass';
  }
  return false;
}

export function createTriggerService(input: {
  db: SqliteDb;
  /** 宿主物化：createTask + triage；返回新任务 id。失败由宿主抛错（trigger 保持待触发）。 */
  materialize: (template: TriggerTemplate & { kind: 'cron' | 'event'; triggerId: number }) => Promise<number>;
}): TriggerService {
  const { db } = input;
  const pendingEvents: Array<{ triggerId: number; taskId: number }> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  const createCron = (trigger: CreateCronTriggerInput): TriggerView => {
    const now = trigger.now ?? Date.now();
    const dueAt = nextTriggerDueAt(trigger, now);
    const id = scheduleTimer(db, {
      kind: 'cron_fire',
      taskId: null,
      dueAt,
      dedupeKey: `trigger:cron:${randomUUID()}`,
      payload: {
        name: trigger.name,
        projectId: trigger.projectId,
        title: trigger.title,
        goal: trigger.goal,
        riskLevel: trigger.riskLevel,
        intervalMinutes: trigger.intervalMinutes,
        dailyMinute: trigger.dailyMinute,
        createdAt: now,
      },
    });
    return listTriggerRows(db).map(toView).find((v): v is TriggerView => v?.id === id) as TriggerView;
  };

  const createEvent = (trigger: CreateEventTriggerInput): TriggerView => {
    const now = trigger.now ?? Date.now();
    const id = scheduleTimer(db, {
      kind: 'event_trigger',
      taskId: trigger.sourceTaskId,
      dueAt: now + EVENT_FAR_FUTURE_MS,
      dedupeKey: `trigger:event:${randomUUID()}`,
      payload: {
        name: trigger.name,
        projectId: trigger.projectId,
        title: trigger.title,
        goal: trigger.goal,
        riskLevel: trigger.riskLevel,
        eventKind: trigger.eventKind,
        createdAt: now,
      },
    });
    return listTriggerRows(db).map(toView).find((v): v is TriggerView => v?.id === id) as TriggerView;
  };

  const list = (): TriggerView[] =>
    listTriggerRows(db)
      .map(toView)
      .filter((v): v is TriggerView => v != null)
      .sort((a, b) => (a.nextDueAt ?? Number.MAX_SAFE_INTEGER) - (b.nextDueAt ?? Number.MAX_SAFE_INTEGER));

  const cancel = (id: number): boolean => {
    const info = db
      .prepare("DELETE FROM timers WHERE id = ? AND fired_at IS NULL AND kind IN ('cron_fire','event_trigger')")
      .run(id);
    return info.changes > 0;
  };

  const tick = async (now = Date.now()): Promise<number> => {
    if (busy) return 0;
    busy = true;
    let created = 0;
    try {
      // ① 到期 cron：先物化，成功后才记 fired＋重排下一拍；失败保留 due（下拍重试）。
      const dueCron = listTimers(db).filter(
        (row) => row.fired_at == null && row.kind === 'cron_fire' && row.task_id == null && row.due_at <= now,
      );
      for (const row of dueCron) {
        const p = parsePayload(row);
        const projectId = typeof p.projectId === 'number' ? p.projectId : null;
        const title = typeof p.title === 'string' ? p.title : '';
        const goal = typeof p.goal === 'string' ? p.goal : '';
        const riskLevel = typeof p.riskLevel === 'number' ? p.riskLevel : 1;
        if (projectId == null || title.length === 0 || goal.length === 0) continue;
        if (isProjectArchived(db, projectId)) {
          db.prepare("DELETE FROM timers WHERE id = ? AND kind = 'cron_fire'").run(row.id);
          console.warn(`[trigger] 项目已归档，删除定时触发 ${row.id}`);
          continue;
        }
        try {
          const taskId = await input.materialize({ kind: 'cron', triggerId: row.id, projectId, title, goal, riskLevel });
          if (!markTimerFired(db, row.id, now)) continue;
          const next = nextTriggerDueAt(
            {
              intervalMinutes: typeof p.intervalMinutes === 'number' ? p.intervalMinutes : undefined,
              dailyMinute: typeof p.dailyMinute === 'number' ? p.dailyMinute : undefined,
            },
            now + 1,
          );
          rescheduleTimer(db, row.id, next, { ...p, lastFiredAt: now, lastTaskId: taskId });
          created += 1;
        } catch (error) {
          console.error(`[trigger] cron 触发失败（timer=${row.id}）`, error);
        }
      }

      // ② 排队的事件触发：一次性；成功后删除 trigger。
      // 只在**源任务已落库终态**时物化——事件可能在事务提交前入队；未终态则下一拍重试。
      const retry: Array<{ triggerId: number; taskId: number }> = [];
      while (pendingEvents.length > 0) {
        const item = pendingEvents.shift() as { triggerId: number; taskId: number };
        const row = listTimers(db).find((t) => t.id === item.triggerId && t.kind === 'event_trigger');
        if (!row) continue;
        const p = parsePayload(row);
        const projectId = typeof p.projectId === 'number' ? p.projectId : null;
        const title = typeof p.title === 'string' ? p.title : '';
        const goal = typeof p.goal === 'string' ? p.goal : '';
        const riskLevel = typeof p.riskLevel === 'number' ? p.riskLevel : 1;
        if (projectId == null || title.length === 0 || goal.length === 0) continue;
        const source = db.prepare('SELECT state FROM tasks WHERE id = ?').get(item.taskId) as
          | { state: string }
          | undefined;
        if (!source || !['done', 'failed', 'cancelled'].includes(source.state)) {
          // 任务还没到终态（或事件是改动前的旧信号）——下拍再看，不提前建任务。
          retry.push(item);
          continue;
        }
        if (isProjectArchived(db, projectId)) {
          db.prepare("DELETE FROM timers WHERE id = ? AND kind = 'event_trigger'").run(row.id);
          console.warn(`[trigger] 项目已归档，删除事件触发 ${row.id}`);
          continue;
        }
        try {
          const taskId = await input.materialize({ kind: 'event', triggerId: row.id, projectId, title, goal, riskLevel });
          db.prepare("DELETE FROM timers WHERE id = ? AND kind = 'event_trigger'").run(row.id);
          created += 1;
          console.log(`[trigger] 事件触发 ${row.id} → 任务 ${taskId}（源任务 ${item.taskId}）`);
        } catch (error) {
          console.error(`[trigger] 事件触发失败（timer=${row.id}）`, error);
        }
      }
      pendingEvents.push(...retry);
    } finally {
      busy = false;
    }
    return created;
  };

  const onEngineEvent = (event: EngineEvent): void => {
    if (!isCompletedEvent(event)) return;
    for (const row of listTriggerRows(db)) {
      if (row.kind !== 'event_trigger' || row.task_id !== event.id) continue;
      const p = parsePayload(row);
      if (p.eventKind !== 'task_completed') continue;
      if (pendingEvents.some((item) => item.triggerId === row.id)) continue;
      pendingEvents.push({ triggerId: row.id, taskId: event.id });
    }
  };

  const start = (intervalMs = 1000): void => {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { createCron, createEvent, list, cancel, tick, onEngineEvent, start, stop };
}
