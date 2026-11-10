/**
 *  P1 · 频道助手写权限（项目级 `read-only | confirm | auto`）。
 *
 * 口径（``，设计见设计说明 §4）：
 *  - **两轴不是三档大开关**：写范围恒为 `project-only`（由 `projectRoot` 硬边界保证）；
 *    项目内写模式 = `read-only`（只读）/ `confirm`（每次写/建目录先确认，默认）/ `auto`（项目内写不逐次确认）。
 *  - **`full` v1 不做**；无项目恒 `read-only`。
 *  - 模式存 `permission_policies(scope_type='project', scope_id=<projectId>).policy.assistantWriteMode`；
 *    不新增表/列，复用同一权限清单；不改员工任务会话的 `tier`/`autonomy`。
 *  - 判定仍由 `permissionGate` 完成：本模块只把模式映射为能力档/放行档，并读写项目策略。
 */
import { getPermissionPolicy, setPermissionPolicy } from '../db/permission.js';
import type { SqliteDb } from '../db/open.js';
import type { AssistantWriteMode, Autonomy, CapabilityTier, PermissionPolicy } from './gate.js';

export const DEFAULT_ASSISTANT_WRITE_MODE: AssistantWriteMode = 'confirm';

const MODES: readonly AssistantWriteMode[] = ['read-only', 'confirm', 'auto'];

export function isAssistantWriteMode(value: unknown): value is AssistantWriteMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function parsePolicy(json: string): PermissionPolicy {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? (value as PermissionPolicy) : {};
  } catch {
    return {};
  }
}

/** 解析项目写模式：项目策略 → 全局策略 → 缺省 confirm；无项目恒 read-only。 */
export function resolveAssistantWriteMode(db: SqliteDb, projectId: number | null | undefined): AssistantWriteMode {
  if (projectId == null) return 'read-only';
  const project = getPermissionPolicy(db, 'project', projectId);
  const fromProject = project ? parsePolicy(project.policy).assistantWriteMode : undefined;
  if (isAssistantWriteMode(fromProject)) return fromProject;
  const global = getPermissionPolicy(db, 'global', 0);
  const fromGlobal = global ? parsePolicy(global.policy).assistantWriteMode : undefined;
  return isAssistantWriteMode(fromGlobal) ? fromGlobal : DEFAULT_ASSISTANT_WRITE_MODE;
}

/**
 * 写项目写模式（唯一写入口）。保留该行原有 `tier`/其它 policy 字段，只覆盖 `assistantWriteMode`；
 * 不把频道设置扩散成员工权限变更。调用方须先校验项目存在。
 */
export function setAssistantWriteMode(
  db: SqliteDb,
  projectId: number,
  mode: AssistantWriteMode,
  now: number = Date.now(),
): void {
  const existing = getPermissionPolicy(db, 'project', projectId);
  const policy = existing ? parsePolicy(existing.policy) : {};
  policy.assistantWriteMode = mode;
  // 只加字段，不改员工任务会话的放行档：新行沿用当前有效 tier（global 缺省 standard）。
  const globalTier = getPermissionPolicy(db, 'global', 0)?.tier;
  setPermissionPolicy(db, {
    scopeType: 'project',
    scopeId: projectId,
    tier: existing?.tier ?? globalTier ?? 'standard',
    policy,
    now,
  });
}

/** 模式 → 闸门覆盖（能力档 ∩ 放行档）。 */
export function assistantGatePolicy(mode: AssistantWriteMode): { capabilityTier: CapabilityTier; autonomy: Autonomy } {
  if (mode === 'read-only') return { capabilityTier: 'sandbox', autonomy: 'strict' };
  if (mode === 'confirm') return { capabilityTier: 'standard', autonomy: 'strict' };
  return { capabilityTier: 'standard', autonomy: 'standard' };
}

export function assistantWriteModeLabel(mode: AssistantWriteMode): string {
  if (mode === 'read-only') return '只读';
  if (mode === 'confirm') return '写前确认';
  return '项目内自主';
}

/** 给模型的本轮权限说明（不替代闸门，只让模型先按规则行动）。 */
export function assistantWriteModePrompt(mode: AssistantWriteMode, projectName: string, rootDir: string): string {
  if (mode === 'read-only') {
    return `本轮绑定项目「${projectName}」：只读模式，不得写文件或建目录；需要写入时先请老板在项目设置里改为「写前确认」或「项目内自主」。`;
  }
  if (mode === 'confirm') {
    return `本轮绑定项目「${projectName}」：写前确认模式——只能读写其根目录 ${rootDir} 内的路径；写文件/建目录/危险命令会先出确认卡，老板批准后才继续。`;
  }
  return `本轮绑定项目「${projectName}」：项目内自主模式——只能读写其根目录 ${rootDir} 内的路径；项目内写不逐次确认，越界仍会被拒绝，所有写操作留审计。`;
}
