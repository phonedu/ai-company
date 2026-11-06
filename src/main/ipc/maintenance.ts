/**
 * B-4（M4）· 数据保留/清理的 IPC（`settings:maintenance`）。
 *
 * 口径（`D-21` ②）：
 *  - 只清四张临时表：`remote_event_log`（过期）/`im_outbox`（sent/cancelled/expired >30d）/
 *    `task_checkpoints`（restored/invalid >30d）/`timers`（fired >30d）；
 *  - **不删** tasks/reports/artifacts/changesets；不动活跃数据；
 *  - `preview` 只数不删；`run` 返回真实删除行数（不写假读数）；
 *  - 保留期固定缺省 30 天，可显式传 1–3650（设置页只暴露 30 天文案）。
 */
import type { SqliteDb } from '../db/open.js';
import { previewRetention, runRetention, type RetentionResult } from '../db/maintenance.js';

export interface MaintenanceHandlerDeps {
  db?: SqliteDb;
}

export type MaintenanceManageResult =
  | { ok: true; action: 'preview' | 'run'; retentionDays: number; counts: RetentionResult }
  | { ok: false; code: string; message: string };

export function handleSettingsMaintenance(
  deps: MaintenanceHandlerDeps,
  raw: unknown,
  now: number = Date.now(),
): MaintenanceManageResult {
  if (!deps.db) return { ok: false, code: 'not_ready', message: '数据库未装配' };
  const input = (raw ?? {}) as { action?: unknown; retentionDays?: unknown };
  const action = input.action;
  if (action !== 'preview' && action !== 'run') {
    return { ok: false, code: 'bad_request', message: 'action 需为 preview 或 run' };
  }
  const retentionDays = input.retentionDays === undefined ? 30 : input.retentionDays;
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return { ok: false, code: 'bad_request', message: 'retentionDays 需为 1–3650 的整数' };
  }
  const counts = action === 'preview' ? previewRetention(deps.db, now, retentionDays) : runRetention(deps.db, now, retentionDays);
  return { ok: true, action, retentionDays, counts };
}
