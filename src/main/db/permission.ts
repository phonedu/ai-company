/**
 * OPT- · `permission_policies` DAO（三级覆盖：global / project / task；``、`schema.sql` 001 已建表）。
 * 有效策略 = global ← project ← task 逐级覆盖（后者优先）；`tier` 取最高级里显式设置的值。
 */
import type { Autonomy, PermissionPolicy } from '../permission/gate.js';
import type { SqliteDb } from './open.js';

export type PolicyScope = 'global' | 'project' | 'task';

export interface PermissionPolicyRow {
  id: number;
  scope_type: PolicyScope;
  scope_id: number;
  tier: Autonomy;
  policy: string;
  updated_at: number;
}

const COLUMNS = 'id, scope_type, scope_id, tier, policy, updated_at';

export function getPermissionPolicy(db: SqliteDb, scopeType: PolicyScope, scopeId: number): PermissionPolicyRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM permission_policies WHERE scope_type = ? AND scope_id = ?`)
    .get(scopeType, scopeId) as PermissionPolicyRow | undefined;
}

/** 写入/覆盖某级策略（UPSERT on UNIQUE(scope_type, scope_id)）。 */
export function setPermissionPolicy(
  db: SqliteDb,
  input: { scopeType: PolicyScope; scopeId: number; tier: Autonomy; policy?: PermissionPolicy; now?: number },
): PermissionPolicyRow {
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO permission_policies(scope_type, scope_id, tier, policy, updated_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(scope_type, scope_id) DO UPDATE SET tier = excluded.tier, policy = excluded.policy, updated_at = excluded.updated_at`,
  ).run(input.scopeType, input.scopeId, input.tier, JSON.stringify(input.policy ?? {}), now);
  return getPermissionPolicy(db, input.scopeType, input.scopeId) as PermissionPolicyRow;
}

function parsePolicy(json: string): PermissionPolicy {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as PermissionPolicy) : {};
  } catch {
    return {};
  }
}

export interface ResolveInput {
  projectId?: number | null;
  taskId?: number | null;
  /** 未设置任何策略时的默认放行档。 */
  defaultTier?: Autonomy;
}

/** 解析有效策略（global(0) ← project ← task）。 */
export function resolvePermissionPolicy(db: SqliteDb, input: ResolveInput = {}): { tier: Autonomy; policy: PermissionPolicy } {
  const chain: PermissionPolicyRow[] = [];
  const global = getPermissionPolicy(db, 'global', 0);
  if (global) chain.push(global);
  if (input.projectId != null) {
    const p = getPermissionPolicy(db, 'project', input.projectId);
    if (p) chain.push(p);
  }
  if (input.taskId != null) {
    const t = getPermissionPolicy(db, 'task', input.taskId);
    if (t) chain.push(t);
  }
  let tier: Autonomy = input.defaultTier ?? 'standard';
  const policy: PermissionPolicy = {};
  for (const row of chain) {
    tier = row.tier;
    Object.assign(policy, parsePolicy(row.policy));
  }
  return { tier, policy };
}
