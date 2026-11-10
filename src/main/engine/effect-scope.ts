/**
 * `EffectScopeManager` —— 受管工作单元（`docs/next/research-lessons-productization.md §2.1`、``）。
 *
 * 职责：登记/刷新**归属清单**、**超时兜底**、**显式回收**。
 * 铁律：**回收只按清单记录的 PID 树**（`taskkill /PID <root> /T /F`），**永不扫同名进程**；
 *      回收**恰好一次**（先原子置「已回收」，拿到者才 kill）；PID killer 可注入（单测不真杀）。
 *
 * 结合点（供会话池接线）：`EffectExecutor.execute('dispatch')` → `open(...)` 建会话 + 写清单；
 * work item 进终态 → `reclaim(scopeKey, 'release')`；心跳由 `heartbeat(...)` 刷新，
 * 静默超时由本类的 `reclaimDue(now)` 兜底（对应 `timers` 中 `kind='effect_scope'` 的清单行）。
 */
import { execFileSync } from 'node:child_process';

import {
  getEffectScope,
  heartbeatEffectScope,
  listDueEffectScopes,
  listEffectScopes,
  markEffectScopeReclaimed,
  openEffectScope,
  type EffectScope,
  type EffectScopeState,
  type OpenEffectScopeInput,
} from '../db/index.js';
import type { SqliteDb } from '../db/open.js';

/** PID 树回收器（可注入；默认 `taskkill /PID <root> /T /F`）。 */
export interface PidKiller {
  kill(pidRoot: number): void;
}

export function createTaskkillPidKiller(): PidKiller {
  return {
    kill(pidRoot: number): void {
      execFileSync('taskkill', ['/PID', String(pidRoot), '/T', '/F'], { stdio: 'ignore' });
    },
  };
}

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/** effect scope 幂等键：`employee:<id>:wi:<workItemId>:attempt:<n>`（同 attempt 的递归不重复建）。 */
export function effectScopeKey(input: { employeeId: number; workItemId: number; attempt: number }): string {
  return `employee:${input.employeeId}:wi:${input.workItemId}:attempt:${input.attempt}`;
}

export interface OpenScopeInput {
  sessionKey: string;
  employeeId: number;
  workItemId: number;
  attempt: number;
  taskId: number;
  pidTree?: number[];
  tempDir?: string | null;
  port?: number | null;
  dbPath?: string | null;
  userDataDir?: string | null;
}

export type ReclaimReason = 'graceful' | 'timeout' | 'release';

export interface ReclaimResult {
  reclaimed: boolean;
  killedPids: number[];
}

export interface EffectScopeManagerOptions {
  clock?: () => number;
  heartbeatTimeoutMs?: number;
  killer?: PidKiller;
}

export class EffectScopeManager {
  private readonly clock: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly killer: PidKiller;
  /** 记录所有被要求 kill 的 PID（仅用于测试断言「只动清单里的 PID」）。 */
  readonly killedPidsLog: number[] = [];

  constructor(private readonly db: SqliteDb, options: EffectScopeManagerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.killer =
      options.killer ?? {
        // 默认 killer 不再单独记日志（记录统一在 reclaim()），避免与注入用法歧义
        kill: (pidRoot: number) => createTaskkillPidKiller().kill(pidRoot),
      };
  }

  /** 登记（或幂等刷新）一个 effect scope；返回 scopeKey 与是否新建。 */
  open(input: OpenScopeInput): { scopeKey: string; scope: EffectScope; created: boolean } {
    const scopeKey = effectScopeKey({ employeeId: input.employeeId, workItemId: input.workItemId, attempt: input.attempt });
    const now = this.clock();
    const { scope, created } = openEffectScope(this.db, {
      scopeKey,
      sessionKey: input.sessionKey,
      employeeId: input.employeeId,
      workItemId: input.workItemId,
      taskId: input.taskId,
      pidTree: input.pidTree ?? [],
      tempDir: input.tempDir ?? null,
      port: input.port ?? null,
      dbPath: input.dbPath ?? null,
      userDataDir: input.userDataDir ?? null,
      startedAt: now,
      heartbeatAt: now,
      timeoutMs: this.heartbeatTimeoutMs,
    } satisfies OpenEffectScopeInput);
    return { scopeKey, scope, created };
  }

  /** 刷新心跳（延长超时）。返回是否更新到（已回收则 false）。 */
  heartbeat(scopeKey: string): boolean {
    return heartbeatEffectScope(this.db, scopeKey, this.clock(), this.heartbeatTimeoutMs);
  }

  /**
   * 显式回收：**先原子置「已回收」**（恰好一次），拿到者才按**清单 PID 树**回收。
   * 重复调用 / 已回收 → `{reclaimed:false, killedPids:[]}`（不重复 kill）。
   */
  reclaim(scopeKey: string, reason: ReclaimReason): ReclaimResult {
    const current = getEffectScope(this.db, scopeKey);
    if (!current || current.state !== 'open') return { reclaimed: false, killedPids: [] };
    const claimed = markEffectScopeReclaimed(this.db, scopeKey, reason, this.clock());
    if (!claimed) return { reclaimed: false, killedPids: [] };
    const root = current.pidTree[0];
    if (root == null) return { reclaimed: true, killedPids: [] };
    this.killedPidsLog.push(root);
    this.killer.kill(root);
    return { reclaimed: true, killedPids: [root] };
  }

  /** 心跳超时兜底：扫描到期未回收的 scope 并按 `timeout` 回收。返回回收条数。 */
  reclaimDue(now: number = this.clock()): number {
    const due = listDueEffectScopes(this.db, now);
    let reclaimed = 0;
    for (const scope of due) {
      if (this.reclaim(scope.scopeKey, 'timeout').reclaimed) reclaimed += 1;
    }
    return reclaimed;
  }

  get(scopeKey: string): EffectScope | undefined {
    return getEffectScope(this.db, scopeKey);
  }

  list(state?: EffectScopeState): EffectScope[] {
    return listEffectScopes(this.db, state);
  }

  /** OPT-：归因读数（耗时 + 归属，按耗时降序）。 */
  attribution(now: number = this.clock()): ScopeDuration[] {
    return effectScopeAttribution(this.db, { now });
  }
}

// ───────────────────────── OPT- · 长任务归因（耗时读数） ─────────────────────────

export interface ScopeDuration {
  scopeKey: string;
  workItemId: number | null;
  taskId: number;
  employeeId: number;
  pidCount: number;
  state: EffectScopeState;
  startedAt: number;
  /** 已回收 = `reclaimedAt`；未回收 = `now`。 */
  endedAt: number;
  durationMs: number;
  open: boolean;
}

/** 单个 scope 的耗时/归属读数（`durationMs = (reclaimedAt ?? now) - startedAt`，clamp ≥0）。 */
export function scopeDuration(scope: EffectScope, now: number): ScopeDuration {
  const endedAt = scope.reclaimedAt ?? now;
  return {
    scopeKey: scope.scopeKey,
    workItemId: scope.workItemId,
    taskId: scope.taskId,
    employeeId: scope.employeeId,
    pidCount: scope.pidTree.length,
    state: scope.state,
    startedAt: scope.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - scope.startedAt),
    open: scope.state === 'open',
  };
}

/** 批量归因：按耗时降序（同耗按 `scopeKey`），供“哪个工作项/子进程最久”一眼查。 */
export function attributeDurations(scopes: EffectScope[], now: number): ScopeDuration[] {
  return scopes
    .map((s) => scopeDuration(s, now))
    .sort((a, b) => (b.durationMs !== a.durationMs ? b.durationMs - a.durationMs : a.scopeKey < b.scopeKey ? -1 : 1));
}

/** 从清单读归因读数。 */
export function effectScopeAttribution(db: SqliteDb, options: { now: number; state?: EffectScopeState }): ScopeDuration[] {
  return attributeDurations(listEffectScopes(db, options.state), options.now);
}
