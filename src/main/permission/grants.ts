/**
 * G1 余项· **`approvals → grants` 转换回路**：批准一次 `ask` → 发一条**最小范围**的 grant →
 * 下次**同一规则**的调用放行（不再追问）。
 *
 * 口径（2884①）：
 *  - **范围最小**：grant 写到**该任务**的策略里（`permission_policies(scope_type='task')`），
 *    规则键 = `ask` 的 `rule`（`consent:external` / `consent:spend` / `consent:install` / `consent:command`）；
 *  - **幂等**：同一 `(rule, scope, toolName)` 重复批准**只留一条**（重复批不重复发）；
 *  - **留痕**：grant 里记 `grantedBy / grantedAt / toolName / scope`（谁批的/何时/授予什么）；
 *  - **有牙**：不给 grant → 再 `ask`；给了 → 放行（由 `permissionGate` 的 `askOrGrant` 保证）。
 *
 * 与 `permissionGate` 的连接点：`GateContext.policy.grants[]`（`hasGrant`）——本模块**只写策略**，判定仍在 `gate.ts`。
 */
import { getApproval, isPermissionApproval, type ApprovalRow } from '../db/approvals.js';
import { getPermissionPolicy, setPermissionPolicy } from '../db/permission.js';
import type { PermissionPolicy } from './gate.js';
import type { SqliteDb } from '../db/open.js';

/** 权限审批问题里的工具/规则/会话（`[权限] 会话工具 <tool>（<rule>）[<sessionKey|->]`）。 */
export const PERMISSION_TOOL_QUESTION = /^\[权限\]\s*(?:会话工具\s*)?(.+?)\s*（(.+?)）\s*(?:\[(.*?)\])?\s*$/;

export interface ParsedPermissionQuestion {
  toolName: string;
  rule: string;
  /** 会话维度（`-`/缺省 = 无 → 任务级回落）。 */
  sessionKey?: string;
}

export function parsePermissionQuestion(question: string): ParsedPermissionQuestion | null {
  const m = PERMISSION_TOOL_QUESTION.exec(question.trim());
  if (!m) return null;
  const sk = m[3];
  return { toolName: m[1] as string, rule: m[2] as string, ...(sk && sk !== '-' ? { sessionKey: sk } : {}) };
}

/**
 *  P1：**频道助手无任务审批**的问题格式。
 * 任务审批复用 `[权限] 会话工具 …`；频道审批没有 task_id，必须显式带项目与（可选的）本应用会话，
 * 否则批准后无处落 grant（不能静默当成任务审批）。
 */
export const CHANNEL_PERMISSION_PREFIX = '[权限] 频道写操作 ';

export interface ParsedChannelPermissionQuestion {
  toolName: string;
  rule: string;
  projectId: number;
  /** 本应用会话（`-`/缺省 = 无 → 项目级 grant）。 */
  sessionKey?: string;
}

export function formatChannelPermissionQuestion(
  toolName: string,
  rule: string,
  projectId: number,
  sessionKey: string | null | undefined,
): string {
  const sk = sessionKey != null && sessionKey.length > 0 ? sessionKey : '-';
  return `${CHANNEL_PERMISSION_PREFIX}${toolName}（${rule}）[project:${projectId}|session:${sk}]`;
}

export function parseChannelPermissionQuestion(question: string): ParsedChannelPermissionQuestion | null {
  if (!question.startsWith(CHANNEL_PERMISSION_PREFIX)) return null;
  const rest = question.slice(CHANNEL_PERMISSION_PREFIX.length).trim();
  const m = /^(.+?)（(.+?)）\s*\[project:(\d+)\|session:(.*?)\]$/.exec(rest);
  if (!m) return null;
  const projectId = Number(m[3]);
  if (!Number.isInteger(projectId) || projectId < 1) return null;
  const sk = m[4];
  return {
    toolName: m[1] as string,
    rule: m[2] as string,
    projectId,
    ...(sk && sk !== '-' ? { sessionKey: sk } : {}),
  };
}

/** 批准类选项（任务/频道共用）；只有这些会触发 grant。 */
export function isGrantingChoice(chosen: string): boolean {
  return chosen === 'approve' || chosen === 'approve_once' || chosen === 'approve_project';
}

export interface GrantRecord {
  rule: string;
  scope: 'task' | 'session';
  toolName: string;
  grantedBy: string;
  grantedAt: number;
  /** 会话维度（`scope='session'` 时有）；缺省 = 任务级（**回落**，在记录里显式标明）。 */
  sessionKey?: string;
  /** 过期时刻（epoch ms）；null/缺省 = 不过期（由任务生命周期约束）。 */
  expiresAt?: number | null;
}

export interface IssueGrantInput {
  taskId: number;
  rule: string;
  toolName: string;
  grantedBy: string;
  now: number;
  ttlMs?: number;
  /** 会话维度；缺省 → 任务级 grant（并记 `scopeFallback:true`）。 */
  sessionKey?: string;
}

/**
 * 写入（幂等）一条 grant。
 * **最小范围 = 会话 × 规则**（有 `sessionKey` 时）；**缺 `sessionKey` 才回落任务级**。
 * 幂等键 = `(rule, toolName, sessionKey ?? '')`。
 * 返回 `{granted, alreadyPresent}`。
 */
export function issueGrant(db: SqliteDb, input: IssueGrantInput): { granted: boolean; alreadyPresent: boolean } {
  const existing = getPermissionPolicy(db, 'task', input.taskId);
  const policy: PermissionPolicy = existing ? (JSON.parse(existing.policy) as PermissionPolicy) : {};
  const grants = (policy.grants ?? []) as NonNullable<PermissionPolicy['grants']>;
  const scope: 'task' | 'session' = input.sessionKey ? 'session' : 'task';
  const dup = grants.some((g) => g.rule === input.rule && g.toolName === input.toolName && (g.sessionKey ?? '') === (input.sessionKey ?? ''));
  if (dup) return { granted: false, alreadyPresent: true };
  const rec: GrantRecord = {
    rule: input.rule,
    scope,
    toolName: input.toolName,
    grantedBy: input.grantedBy,
    grantedAt: input.now,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    expiresAt: input.ttlMs != null ? input.now + input.ttlMs : null,
  };
  policy.grants = [...grants, rec];
  setPermissionPolicy(db, {
    scopeType: 'task',
    scopeId: input.taskId,
    tier: existing?.tier ?? 'standard',
    policy,
    now: input.now,
  });
  return { granted: true, alreadyPresent: false };
}

/**
 *  安全批（2026-11-09 审查）：spend grant **用后即焚**——「批准一次」语义落地。
 * 会话闸门放行一次花钱调用后消费之；同会话再次调用重新弹卡（gate 文案「逐次批准」自此成立）。
 * 纯 DB 操作；无匹配 grant 时幂等返回 false。external 类 grant 不在此列（对外放行保持会话内有效）。
 */
export function consumeSpendGrant(db: SqliteDb, taskId: number, toolName: string, sessionKey?: string | null): boolean {
  const row = getPermissionPolicy(db, 'task', taskId);
  if (!row) return false;
  let policy: PermissionPolicy;
  try {
    policy = JSON.parse(row.policy) as PermissionPolicy;
  } catch {
    return false;
  }
  const grants = policy.grants ?? [];
  // 消费「可能放行了这次调用」的全部 spend grant：同会话的会话级 grant＋任务级（无 sessionKey）
  // grant——会话闸门两者都认（session-tool-gate grants 过滤），只消精确匹配会漏掉任务级（永不焚）。
  // 两者并存时一并消费＝下次重新问（fail-closed 方向）。
  const rest = grants.filter(
    (g) =>
      !(g.rule === 'consent:spend' && g.toolName === toolName && (!g.sessionKey || g.sessionKey === (sessionKey ?? null))),
  );
  if (rest.length === grants.length) return false;
  policy.grants = rest;
  setPermissionPolicy(db, { scopeType: 'task', scopeId: taskId, tier: row.tier, policy });
  return true;
}

export interface ApplyApprovalResult {
  applied: boolean;
  reason: string;
  grant?: { rule: string; toolName: string; taskId?: number; projectId?: number; sessionKey?: string };
}

export interface IssueChannelGrantInput {
  projectId: number;
  rule: string;
  toolName: string;
  grantedBy: string;
  now: number;
  /** 有＝会话级「本次允许」；无＝项目级「本项目允许」。 */
  sessionKey?: string;
}

/**
 *  P1：写频道助手的**项目级/会话级** grant。
 * - `sessionKey` 有 → `scope='session'`（本应用会话；由 `SessionToolGate` 的会话过滤生效）；
 * - 无 → `scope='project'`（该项目内所有频道助手会话）。
 * 幂等键 = `(rule, toolName, sessionKey ?? '')`；保留项目策略里其它字段（含 `assistantWriteMode`）。
 */
export function issueChannelGrant(
  db: SqliteDb,
  input: IssueChannelGrantInput,
): { granted: boolean; alreadyPresent: boolean } {
  const existing = getPermissionPolicy(db, 'project', input.projectId);
  const policy: PermissionPolicy = existing ? (JSON.parse(existing.policy) as PermissionPolicy) : {};
  const grants = (policy.grants ?? []) as NonNullable<PermissionPolicy['grants']>;
  const scope: 'project' | 'session' = input.sessionKey ? 'session' : 'project';
  const dup = grants.some(
    (g) => g.rule === input.rule && g.toolName === input.toolName && (g.sessionKey ?? '') === (input.sessionKey ?? ''),
  );
  if (dup) return { granted: false, alreadyPresent: true };
  policy.grants = [
    ...grants,
    {
      rule: input.rule,
      scope,
      toolName: input.toolName,
      grantedBy: input.grantedBy,
      grantedAt: input.now,
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      // 频道 grant 只给幕僚长会话；不带标记会扩散到同项目员工任务。
      assistantOnly: true,
      expiresAt: null,
    },
  ];
  // 只加 grants，不改员工任务会话的放行档：新行沿用当前有效 tier（global 缺省 standard）。
  const globalTier = getPermissionPolicy(db, 'global', 0)?.tier;
  setPermissionPolicy(db, {
    scopeType: 'project',
    scopeId: input.projectId,
    tier: existing?.tier ?? globalTier ?? 'standard',
    policy,
    now: input.now,
  });
  return { granted: true, alreadyPresent: false };
}

/**
 * 把一条**已批准**的权限审批转成 grant（幂等）。
 * - 任务审批：`[权限] 会话工具 …` + `task_id` → 任务/会话 grant（G1）。
 * - 频道审批（P1）：`[权限] 频道写操作 … [project:<id>|session:<key>]` + `task_id=null`
 *   → `approve_once` 写会话级、`approve_project` 写项目级 grant。
 * - 非权限审批 / 非批准 / 无上下文 / 问题不可解析 → `applied:false` + 原因（**不静默**）。
 */
export function applyApprovalAsGrant(
  db: SqliteDb,
  approvalId: number,
  opts: { now: number; approvedBy?: string } = { now: Date.now() },
): ApplyApprovalResult {
  const row: ApprovalRow | null = getApproval(db, approvalId);
  if (!row) return { applied: false, reason: 'not_found' };
  if (!isPermissionApproval(row.question)) return { applied: false, reason: 'not_permission_approval' };
  const by = opts.approvedBy ?? row.decided_by ?? 'boss';

  //  P1：频道审批先分流——它没有 task_id，不能落到任务 grant。
  const channel = parseChannelPermissionQuestion(row.question);
  if (channel) {
    if (row.task_id != null) return { applied: false, reason: 'channel_with_task_context' };
    if (!isGrantingChoice(row.chosen ?? '')) return { applied: false, reason: `chosen=${row.chosen ?? 'null'}` };
    // `approve_once`/老 `approve` → 会话级；`approve_project` → 项目级。
    const sessionKey = row.chosen === 'approve_project' ? undefined : channel.sessionKey;
    const res = issueChannelGrant(db, {
      projectId: channel.projectId,
      rule: channel.rule,
      toolName: channel.toolName,
      grantedBy: by,
      now: opts.now,
      ...(sessionKey ? { sessionKey } : {}),
    });
    return {
      applied: true,
      reason: res.alreadyPresent ? 'already_present' : sessionKey ? 'granted(channel_session)' : 'granted(channel_project)',
      grant: {
        rule: channel.rule,
        toolName: channel.toolName,
        projectId: channel.projectId,
        ...(sessionKey ? { sessionKey } : {}),
      },
    };
  }

  if (row.chosen !== 'approve') return { applied: false, reason: `chosen=${row.chosen ?? 'null'}` };
  if (row.task_id == null) return { applied: false, reason: 'no_task_context' };
  const parsed = parsePermissionQuestion(row.question);
  if (!parsed) return { applied: false, reason: 'unparsable_question' };

  const res = issueGrant(db, {
    taskId: row.task_id,
    rule: parsed.rule,
    toolName: parsed.toolName,
    grantedBy: by,
    now: opts.now,
    ...(parsed.sessionKey ? { sessionKey: parsed.sessionKey } : {}),
  });
  return {
    applied: true,
    reason: res.alreadyPresent ? 'already_present' : parsed.sessionKey ? 'granted' : 'granted(task_fallback)',
    grant: { rule: parsed.rule, toolName: parsed.toolName, taskId: row.task_id, ...(parsed.sessionKey ? { sessionKey: parsed.sessionKey } : {}) },
  };
}
