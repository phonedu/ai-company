/**
 * UG-09 · 权限页只读审计 + 撤销。
 *
 * 口径：
 *  - 只列 `permission_policies`（global/project/task）与 `[权限] ` 前缀的 approvals；
 *  - 撤销只删整条 scope 策略（不逐条改 policy JSON 里的 grants，避免误改）；
 *  - 不返回密钥/路径；无数据返回空数组（UI 显空态）。
 */
import type { SqliteDb } from '../db/open.js';

export interface PermissionPolicyDTO {
  id: number;
  scopeType: 'global' | 'project' | 'task' | string;
  scopeId: number;
  scopeName: string | null;
  tier: string;
  /** policy JSON 解析后的 grants 条数（解析失败 → null，不臆造 0）。 */
  grants: number | null;
  updatedAt: number;
}

export interface PermissionApprovalDTO {
  id: number;
  taskId: number | null;
  question: string;
  chosen: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  timeoutAt: number | null;
}

export interface PermissionOverview {
  policies: PermissionPolicyDTO[];
  approvals: PermissionApprovalDTO[];
}

function grantCount(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { grants?: unknown };
    return Array.isArray(parsed?.grants) ? parsed.grants.length : 0;
  } catch {
    return null;
  }
}

export function listPermissionOverview(db: SqliteDb): PermissionOverview {
  const policies = (
    db
      .prepare(
        `SELECT p.id, p.scope_type, p.scope_id, p.tier, p.policy, p.updated_at,
                CASE WHEN p.scope_type = 'project' THEN (SELECT name FROM projects WHERE id = p.scope_id) ELSE NULL END AS scope_name
         FROM permission_policies p
         ORDER BY CASE p.scope_type WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, p.scope_id`,
      )
      .all() as Array<{
      id: number;
      scope_type: string;
      scope_id: number;
      tier: string;
      policy: string;
      updated_at: number;
      scope_name: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeName: row.scope_name,
    tier: row.tier,
    grants: grantCount(row.policy),
    updatedAt: row.updated_at,
  }));

  const approvals = (
    db
      .prepare(
        `SELECT id, task_id, question, chosen, decided_by, decided_at, timeout_at
         FROM approvals WHERE question LIKE '[权限] %' ORDER BY id DESC LIMIT 20`,
      )
      .all() as Array<{
      id: number;
      task_id: number | null;
      question: string;
      chosen: string | null;
      decided_by: string | null;
      decided_at: number | null;
      timeout_at: number | null;
    }>
  ).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    question: row.question,
    chosen: row.chosen,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    timeoutAt: row.timeout_at,
  }));

  return { policies, approvals };
}

/** 撤销一条 scope 策略；不存在/非法 → 显式失败（不静默成功）。 */
export function revokePermissionPolicy(
  db: SqliteDb,
  raw: unknown,
): { ok: true; removed: number } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { scopeType?: unknown; scopeId?: unknown };
  const scopeType = typeof input.scopeType === 'string' ? input.scopeType : '';
  if (!['global', 'project', 'task'].includes(scopeType)) {
    return { ok: false, code: 'bad_request', message: 'scopeType 需为 global/project/task' };
  }
  const scopeId = Number(input.scopeId);
  if (!Number.isInteger(scopeId) || scopeId < 0) {
    return { ok: false, code: 'bad_request', message: 'scopeId 需为非负整数' };
  }
  const res = db
    .prepare('DELETE FROM permission_policies WHERE scope_type = ? AND scope_id = ?')
    .run(scopeType, scopeId);
  const removed = Number(res.changes ?? 0);
  if (removed === 0) return { ok: false, code: 'not_found', message: '该作用域没有可撤销的权限策略' };
  return { ok: true, removed };
}
