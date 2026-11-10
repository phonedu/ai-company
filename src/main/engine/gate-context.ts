/**
 * G1· 权限闸门**上下文解析共享件**。
 *
 * 目的：**引擎动作**（`engine/loop.ts#buildDefaultGate`）与**会话内工具调用**（`agent/session-tool-gate.ts`）
 * 用**同一套口径**解析 `GateContext`（能力档 ∩ 放行档 / L2 收紧 / 项目根），避免"两套口径"。
 *
 * 口径（与 OPT- 一致）：
 *  - 能力档 = `employees.capability_tier`（缺省 `standard`，不自造）；
 *  - 放行档 = `resolvePermissionPolicy`（global ← project ← task，缺省 `defaultAutonomy` / `standard`）；
 *  - 项目根 = 项目 `root_dir`（缺省 `defaults.projectRoot` / `process.cwd()`）。
 */
import { getCapabilityTier, getProjectById, getTaskById, resolvePermissionPolicy, type SqliteDb } from '../db/index.js';
import { projectDocRoots } from '../db/project_documents.js';
import type { Autonomy, CapabilityTier, GateContext, PermissionPolicy } from '../permission/gate.js';

export interface GateDefaults {
  capabilityTier?: CapabilityTier;
  defaultAutonomy?: Autonomy;
  projectRoot?: string;
}

export interface GateSubject {
  /** 归属任务（可为 null：无任务上下文时用默认值）。 */
  taskId: number | null;
  /** 无任务但已绑定项目时（频道助手），项目上下文从这里取。 */
  projectId?: number | null;
  /** 员工（缺省：取任务的 owner；再缺省用 `defaults.capabilityTier`/`standard`）。 */
  employeeId?: number | null;
  /** 工作目录（路径层"项目内/工作目录内"判定用）。 */
  cwd?: string;
}

export interface ResolvedGateContext extends GateContext {
  /** 观测用：是否真的取到了员工能力档。 */
  capabilityTierSource: 'employee' | 'default';
}

export function resolveGateContext(db: SqliteDb, subject: GateSubject, defaults: GateDefaults = {}): ResolvedGateContext {
  const task = subject.taskId != null ? getTaskById(db, subject.taskId) : undefined;
  const projectId = task?.project_id ?? subject.projectId ?? null;
  const project = projectId != null ? getProjectById(db, projectId) : undefined;
  const { tier, policy }: { tier: Autonomy; policy: PermissionPolicy } = resolvePermissionPolicy(db, {
    projectId,
    taskId: subject.taskId ?? null,
    defaultTier: defaults.defaultAutonomy ?? 'standard',
  });

  let employeeId = subject.employeeId ?? null;
  if (employeeId == null && task) employeeId = task.owner_id ?? null;

  const fromEmployee = employeeId != null ? (getCapabilityTier(db, employeeId) as CapabilityTier | null) : null;
  const capabilityTier: CapabilityTier = fromEmployee ?? defaults.capabilityTier ?? 'standard';

  return {
    capabilityTier,
    autonomy: tier,
    riskLevel: task?.risk_level ?? 0,
    projectRoot: project?.root_dir ?? defaults.projectRoot ?? process.cwd(),
    cwd: subject.cwd,
    policy,
    capabilityTierSource: fromEmployee != null ? 'employee' : 'default',
    // /：多文档根只读边界扩展（read_doc 等工具可访问已注册文档根）。
    ...(projectId != null ? { docRoots: getProjectDocRootsForGate(db, projectId) } : {}),
  };
}

/** 查项目文档根。 */
function getProjectDocRootsForGate(db: SqliteDb, projectId: number): string[] {
  try {
    return projectDocRoots(db, projectId);
  } catch {
    return [];
  }
}
