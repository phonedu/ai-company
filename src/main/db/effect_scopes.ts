/**
 * 「受管工作单元（effect scope）· 归属清单」DAO —— （`docs/next/research-lessons-productization.md §2.1`、``）。
 *
 * 一次工作项执行 = 一个受管的 effect scope，引擎持句柄并登记**归属清单**：
 *   `{scopeKey, sessionKey, employeeId, workItemId, taskId, pidTree, tempDir, port, dbPath, userDataDir, startedAt, heartbeatAt}`。
 *
 * **存储选择（M1-minimal）**：清单**复用 `timers` 表**，但用**独立 `kind='effect_scope'`**（**不借 `session_heartbeat` 的语义**——
 * 后者是「会话卡死看门狗」，清单是「资源归属」，生命周期/语义不同；同表不同 kind ⇒ **依旧零 schema 变更**、仍白拿幂等键 + 超时）。
 * 依据 §2.1「回收 = 优雅终止 → 引擎 `timers` 超时兜底 → 按清单 PID 树 kill」。
 * 若将来字段增多，可平滑改为专用表（届时由 `schema.sql`/迁移 owner 落 v2）。
 *
 * 语义映射：`timers.fired_at === null` ⇒ scope `open`；非空 ⇒ 已 `reclaimed`（`fired_at` 即回收时刻）。
 */
import type { SqliteDb } from './open.js';

export const EFFECT_SCOPE_TIMER_KIND = 'effect_scope';

export type EffectScopeState = 'open' | 'reclaimed';

export interface OpenEffectScopeInput {
  scopeKey: string;
  sessionKey: string;
  employeeId: number;
  workItemId?: number | null;
  /** 归属任务（`timers.task_id` FK 需要真实任务；工作项清单必有）。 */
  taskId: number;
  pidTree?: number[];
  tempDir?: string | null;
  port?: number | null;
  dbPath?: string | null;
  userDataDir?: string | null;
  startedAt: number;
  heartbeatAt: number;
  /** 心跳超时（ms）→ `due_at = heartbeatAt + timeoutMs`。 */
  timeoutMs: number;
}

export interface EffectScope {
  timerId: number;
  scopeKey: string;
  sessionKey: string;
  employeeId: number;
  workItemId: number | null;
  taskId: number;
  pidTree: number[];
  tempDir: string | null;
  port: number | null;
  dbPath: string | null;
  userDataDir: string | null;
  state: EffectScopeState;
  startedAt: number;
  heartbeatAt: number;
  dueAt: number;
  reclaimReason: string | null;
  reclaimedAt: number | null;
}

interface ScopePayload {
  scopeKey: string;
  sessionKey: string;
  employeeId: number;
  workItemId: number | null;
  pidTree: number[];
  tempDir: string | null;
  port: number | null;
  dbPath: string | null;
  userDataDir: string | null;
  startedAt: number;
  heartbeatAt: number;
  state: EffectScopeState;
  reclaimReason: string | null;
  reclaimedAt: number | null;
}

const COLUMNS = 'id, kind, task_id, due_at, payload, dedupe_key, fired_at';

function mapRow(row: { id: number; task_id: number | null; due_at: number; payload: string; dedupe_key: string | null; fired_at: number | null }): EffectScope {
  const p = JSON.parse(row.payload) as ScopePayload;
  return {
    timerId: row.id,
    scopeKey: p.scopeKey,
    sessionKey: p.sessionKey,
    employeeId: p.employeeId,
    workItemId: p.workItemId ?? null,
    taskId: row.task_id ?? 0,
    pidTree: p.pidTree ?? [],
    tempDir: p.tempDir ?? null,
    port: p.port ?? null,
    dbPath: p.dbPath ?? null,
    userDataDir: p.userDataDir ?? null,
    state: row.fired_at != null ? 'reclaimed' : (p.state ?? 'open'),
    startedAt: p.startedAt,
    heartbeatAt: p.heartbeatAt,
    dueAt: row.due_at,
    reclaimReason: p.reclaimReason ?? null,
    reclaimedAt: row.fired_at,
  };
}

function readRow(db: SqliteDb, scopeKey: string): { id: number; task_id: number | null; due_at: number; payload: string; dedupe_key: string | null; fired_at: number | null } | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM timers WHERE kind = ? AND dedupe_key = ?`)
    .get(EFFECT_SCOPE_TIMER_KIND, scopeKey) as
    | { id: number; task_id: number | null; due_at: number; payload: string; dedupe_key: string | null; fired_at: number | null }
    | undefined;
}

/** 建/更新清单（幂等：同 `scopeKey` 只一行；已回收的不复活）。返回是否本次新建。 */
export function openEffectScope(db: SqliteDb, input: OpenEffectScopeInput): { scope: EffectScope; created: boolean } {
  const payload: ScopePayload = {
    scopeKey: input.scopeKey,
    sessionKey: input.sessionKey,
    employeeId: input.employeeId,
    workItemId: input.workItemId ?? null,
    pidTree: input.pidTree ?? [],
    tempDir: input.tempDir ?? null,
    port: input.port ?? null,
    dbPath: input.dbPath ?? null,
    userDataDir: input.userDataDir ?? null,
    startedAt: input.startedAt,
    heartbeatAt: input.heartbeatAt,
    state: 'open',
    reclaimReason: null,
    reclaimedAt: null,
  };
  const dueAt = input.heartbeatAt + input.timeoutMs;
  const existing = readRow(db, input.scopeKey);
  if (existing) {
    if (existing.fired_at == null) {
      db.prepare('UPDATE timers SET due_at = ?, payload = ? WHERE id = ? AND fired_at IS NULL').run(
        dueAt,
        JSON.stringify(payload),
        existing.id,
      );
    }
    return { scope: getEffectScope(db, input.scopeKey) as EffectScope, created: false };
  }
  db.prepare('INSERT INTO timers(kind, task_id, due_at, payload, dedupe_key) VALUES(?, ?, ?, ?, ?)').run(
    EFFECT_SCOPE_TIMER_KIND,
    input.taskId,
    dueAt,
    JSON.stringify(payload),
    input.scopeKey,
  );
  return { scope: getEffectScope(db, input.scopeKey) as EffectScope, created: true };
}

export function getEffectScope(db: SqliteDb, scopeKey: string): EffectScope | undefined {
  const row = readRow(db, scopeKey);
  return row ? mapRow(row) : undefined;
}

/** 刷新心跳（仅未回收时）。返回是否更新到。 */
export function heartbeatEffectScope(db: SqliteDb, scopeKey: string, now: number, timeoutMs: number): boolean {
  const row = readRow(db, scopeKey);
  if (!row || row.fired_at != null) return false;
  const p = JSON.parse(row.payload) as ScopePayload;
  p.heartbeatAt = now;
  const info = db
    .prepare('UPDATE timers SET due_at = ?, payload = ? WHERE id = ? AND fired_at IS NULL')
    .run(now + timeoutMs, JSON.stringify(p), row.id);
  return info.changes > 0;
}

export function listEffectScopes(db: SqliteDb, state?: EffectScopeState): EffectScope[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM timers WHERE kind = ? ORDER BY id`)
    .all(EFFECT_SCOPE_TIMER_KIND) as { id: number; task_id: number | null; due_at: number; payload: string; dedupe_key: string | null; fired_at: number | null }[];
  const mapped = rows.map(mapRow);
  return state ? mapped.filter((s) => s.state === state) : mapped;
}

/** 到期未回收的 scope（心跳超时兜底扫描）。 */
export function listDueEffectScopes(db: SqliteDb, now: number): EffectScope[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM timers WHERE kind = ? AND fired_at IS NULL AND due_at <= ? ORDER BY due_at, id`)
    .all(EFFECT_SCOPE_TIMER_KIND, now) as { id: number; task_id: number | null; due_at: number; payload: string; dedupe_key: string | null; fired_at: number | null }[];
  return rows.map(mapRow);
}

/**
 * 标记**已回收**（**恰好一次**：`fired_at IS NULL` 守卫；返回 true 表示本次由你回收）。
 * 调用方拿到 true 后才执行 kill —— 保证重放/并发不会重复回收。
 */
export function markEffectScopeReclaimed(db: SqliteDb, scopeKey: string, reason: string, now: number): boolean {
  const row = readRow(db, scopeKey);
  if (!row || row.fired_at != null) return false;
  const p = JSON.parse(row.payload) as ScopePayload;
  p.state = 'reclaimed';
  p.reclaimReason = reason;
  p.reclaimedAt = now;
  const info = db
    .prepare('UPDATE timers SET fired_at = ?, payload = ? WHERE id = ? AND fired_at IS NULL')
    .run(now, JSON.stringify(p), row.id);
  return info.changes > 0;
}
