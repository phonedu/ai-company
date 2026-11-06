/** `projects` DAO（resolver 归位与默认项目用）。 */
import {
  isProjectModelPolicyName,
  projectModelPolicyError,
  type ProjectModelPolicy,
  type ProjectModelPolicyName,
} from '../../core/model-tiers.js';
import type { SqliteDb } from './open.js';

export interface ProjectRef {
  id: number;
  name: string;
}

export interface ProjectRow extends ProjectRef {
  alias: string | null;
  root_dir: string;
  attention: string;
  access_mode: string;
  default_employee_ids: string;
  /** 编制（D-11）：默认负责人（NULL＝未设置 → 缺省链兜底）。 */
  default_owner_id: number | null;
  /** 编制（D-11）：默认档 0/1/2（NULL＝未设置 → 建任务 db 缺省 1）。 */
  default_risk_tier: number | null;
  /** M3-DOC-4：项目级文档检查开关（1=任务验收默认挂文档检查；0=不挂/未检查）。 */
  docs_check_enabled: number;
  default_skills: string;
  allowed_providers: string;
  /** D-22：项目默认模型（NULL＝未设置）。 */
  default_model: string | null;
  /** D-22：模型级允许清单 JSON 数组（空数组＝不额外限制）。 */
  allowed_models: string;
  /** D-22：fixed | employee_first | assistant（assistant 写侧暂拒）。 */
  model_policy: string;
  /** v19：新任务默认 token 预算（NULL＝不限；任务显式预算优先）。 */
  default_budget_tokens: number | null;
  /** S13-G/D-N06：合并目标分支（NULL＝沿用 main/master）。 */
  target_branch: string | null;
  archived: number;
  archived_at: number | null;
  created_at: number;
}

const COLUMNS =
  'id, name, alias, root_dir, attention, access_mode, default_employee_ids, default_owner_id, default_risk_tier, docs_check_enabled, default_skills, allowed_providers, default_model, allowed_models, model_policy, default_budget_tokens, target_branch, archived, archived_at, created_at';

export function getProjectById(db: SqliteDb, id: number): ProjectRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
}

/** 别名寻址只认未归档项目（FLOWS：归档项目不再被别名寻址）。 */
export function getProjectByAlias(db: SqliteDb, alias: string): ProjectRef | null {
  const row = db
    .prepare('SELECT id, name FROM projects WHERE alias = ? AND archived = 0')
    .get(alias) as ProjectRef | undefined;
  return row ?? null;
}

export function listProjects(db: SqliteDb, options: { includeArchived?: boolean } = {}): ProjectRow[] {
  const where = options.includeArchived ? '' : ' WHERE archived = 0';
  return db.prepare(`SELECT ${COLUMNS} FROM projects${where} ORDER BY id`).all() as ProjectRow[];
}

/** R2-4：新建项目（**只记录路径，不搬动/不复制目录**——PLAN §15.2「关联已有文件夹」口径）。 */
export function createProject(
  db: SqliteDb,
  input: { name: string; rootDir: string; accessMode?: string; alias?: string | null; now: number },
): ProjectRow {
  const row = db
    .prepare('INSERT INTO projects(name, root_dir, access_mode, alias, created_at) VALUES(?, ?, ?, ?, ?) RETURNING id')
    .get(input.name, input.rootDir, input.accessMode ?? 'inplace', input.alias ?? null, input.now) as { id: number };
  const created = getProjectById(db, row.id);
  if (!created) throw new Error(`[db] createProject 失败：id=${row.id} 读不回`);
  return created;
}

/** 别名占用查询（含归档项目；恢复归档时也不能撞名）。 */
export function findProjectIdByAlias(db: SqliteDb, alias: string): number | null {
  const row = db.prepare('SELECT id FROM projects WHERE alias = ?').get(alias) as { id: number } | undefined;
  return row?.id ?? null;
}

/** 设置/清空项目别名（唯一性由 IPC 层前置校验；空串归一为 NULL）。 */
export function setProjectAlias(db: SqliteDb, id: number, alias: string | null): ProjectRow | undefined {
  const next = alias == null || alias.trim().length === 0 ? null : alias.trim();
  db.prepare('UPDATE projects SET alias = ? WHERE id = ?').run(next, id);
  return getProjectById(db, id);
}

/** S13-G/D-N06：设置/清空合并目标分支（空串归一为 NULL＝沿用 main/master）。 */
export function setProjectTargetBranch(
  db: SqliteDb,
  id: number,
  branch: string | null,
): ProjectRow | undefined {
  const next = branch == null || branch.trim().length === 0 ? null : branch.trim();
  db.prepare('UPDATE projects SET target_branch = ? WHERE id = ?').run(next, id);
  return getProjectById(db, id);
}

/** R2-3：软归档（**不搬动/不删除文件夹**；幂等——已归档再归档不改 `archived_at`）。 */
export function archiveProject(db: SqliteDb, id: number, now: number): ProjectRow | undefined {
  db.prepare('UPDATE projects SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0').run(now, id);
  return getProjectById(db, id);
}

/** 撤销软归档（幂等；不复活归档时停用的触发，需要老板重建）。 */
export function restoreProject(db: SqliteDb, id: number): ProjectRow | undefined {
  db.prepare('UPDATE projects SET archived = 0, archived_at = NULL WHERE id = ?').run(id);
  return getProjectById(db, id);
}

/**
 * CR14（2026-10-20）：**只删“已归档且无任务”的项目行**（文件夹不动、不做任务级联）。
 * 非空项目显式拒（`not_empty`），避免在没有级联口径时误删任务/产物/检查点。
 */
export function deleteProjectIfEmpty(
  db: SqliteDb,
  id: number,
): { ok: true } | { ok: false; code: 'not_found' | 'not_archived' | 'not_empty' } {
  const project = getProjectById(db, id);
  if (!project) return { ok: false, code: 'not_found' };
  if (project.archived !== 1) return { ok: false, code: 'not_archived' };
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(id) as { n: number };
  if (Number(tasks.n) > 0) return { ok: false, code: 'not_empty' };
  // B-3：删项目行前清掉**项目级附属行**，不留孤儿（无任务的空归档项目才走到这里）。
  const run = db.transaction((): void => {
    // 触发器的 projectId 存在 payload JSON 里（无 FK）；逐条解析，只删指向本项目的。
    const timers = db
      .prepare("SELECT id, payload FROM timers WHERE fired_at IS NULL AND kind IN ('cron_fire','event_trigger')")
      .all() as Array<{ id: number; payload: string }>;
    for (const timer of timers) {
      try {
        const payload = JSON.parse(timer.payload) as { projectId?: unknown };
        if (payload.projectId === id) db.prepare('DELETE FROM timers WHERE id = ?').run(timer.id);
      } catch {
        // 坏 payload 不阻塞删除（与归档一致）
      }
    }
    // IM 会话可保留历史，但解除项目引用，避免悬空。
    db.prepare('UPDATE im_conversations SET project_id = NULL WHERE project_id = ?').run(id);
    // 记忆（项目事实 + 员工项目分区）与审计事件。
    db.prepare(
      'DELETE FROM memory_events WHERE item_id IN (SELECT id FROM memory_items WHERE scope_type = ? AND scope_id = ?)',
    ).run('project', id);
    db.prepare('DELETE FROM memory_items WHERE scope_type = ? AND scope_id = ?').run('project', id);
    db.prepare('DELETE FROM employee_memory WHERE project_id = ?').run(id);
    // 项目级权限策略 / 接缝矩阵。
    db.prepare('DELETE FROM permission_policies WHERE scope_type = ? AND scope_id = ?').run('project', id);
    db.prepare('DELETE FROM seams WHERE project_id = ?').run(id);
    // 默认项目指针若指向本项 → 清掉（不留下悬空 id）。
    db.prepare("DELETE FROM settings WHERE key = 'projects.default_id' AND (value = ? OR value = ?)").run(
      String(id),
      JSON.stringify(String(id)),
    );
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  run();
  return { ok: true };
}

/** 默认项目：`settings['projects.default_id']`（空 = 未设置 → null，由 resolver 走"模糊时问你一次"）。 */
export function getDefaultProject(db: SqliteDb): ProjectRef | null {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('projects.default_id') as
    | { value: string }
    | undefined;
  if (!setting) return null;
  let id: number | null = null;
  try {
    const parsed = JSON.parse(setting.value) as unknown;
    if (typeof parsed === 'number') id = parsed;
    else if (typeof parsed === 'string' && parsed.trim() !== '') id = Number(parsed);
  } catch {
    id = null;
  }
  if (id == null || Number.isNaN(id)) return null;
  const row = db.prepare('SELECT id, name FROM projects WHERE id = ? AND archived = 0').get(id) as
    | ProjectRef
    | undefined;
  return row ?? null;
}

// ── 编制 v1（D-11）：项目级三项缺省（默认负责人 / 默认执行员工 / 默认档）──────────────
// 写者（唯一）：`project:staffing-set`（ipc handler）。读面＝`ProjectDTO`（零新读通道）。
// 语义：**只影响之后派发的工作项**（owner/tier 建任务时快照；默认执行员工在派发缺省链②读取）；
// 已派发工作项不回改；未设置 ⇒ 回落（缺省链 / db 缺省），绝不臆造。

export interface ProjectStaffing {
  ownerEmployeeId: number | null;
  defaultEmployeeId: number | null;
  defaultRiskTier: 0 | 1 | 2 | null;
}

export type StaffingWriteResult =
  | { ok: true; row: ProjectRow }
  | { ok: false; code: 'not_found' | 'unknown_employee' | 'bad_value'; message: string };

/** 在职校验（写侧守卫与读侧回落共用：不存在 / active=0 一律不认）。 */
/** 编制只能选**在职且非幕僚长**的员工：幕僚长只协调，不做执行兜底（D-20）。 */
function isActiveEmployee(db: SqliteDb, employeeId: number): boolean {
  const row = db.prepare('SELECT active, is_assistant FROM employees WHERE id = ?').get(employeeId) as
    | { active: number; is_assistant: number }
    | undefined;
  return row?.active === 1 && row.is_assistant !== 1;
}

/**
 * 写编制（**唯一写入口**）。`patch` 语义：字段**缺省＝不改动**；显式 `null`＝清空（回落未设置）。
 * 校验：员工必须**存在、在职且非幕僚长**（否则 `unknown_employee`）；档位必须 0/1/2 或 null（否则 `bad_value`）；
 * 非法**拒且不落库**。`defaultEmployeeId` 落 `default_employee_ids` ＝ `[id]`（有序数组，v1 单值）。
 */
export function setProjectStaffing(
  db: SqliteDb,
  projectId: number,
  patch: { ownerEmployeeId?: number | null; defaultEmployeeId?: number | null; defaultRiskTier?: number | null },
): StaffingWriteResult {
  const row = getProjectById(db, projectId);
  if (!row) return { ok: false, code: 'not_found', message: `项目不存在：${projectId}` };

  if (patch.ownerEmployeeId != null && !isActiveEmployee(db, patch.ownerEmployeeId)) {
    return { ok: false, code: 'unknown_employee', message: `员工不存在或不在职：${patch.ownerEmployeeId}` };
  }
  if (patch.defaultEmployeeId != null && !isActiveEmployee(db, patch.defaultEmployeeId)) {
    return { ok: false, code: 'unknown_employee', message: `员工不存在或不在职：${patch.defaultEmployeeId}` };
  }
  if (patch.defaultRiskTier != null && ![0, 1, 2].includes(patch.defaultRiskTier)) {
    return { ok: false, code: 'bad_value', message: `档位需为 0/1/2 或清空（收到：${String(patch.defaultRiskTier)}）` };
  }

  if (patch.ownerEmployeeId !== undefined) {
    db.prepare('UPDATE projects SET default_owner_id = ? WHERE id = ?').run(patch.ownerEmployeeId, projectId);
  }
  if (patch.defaultEmployeeId !== undefined) {
    const list = patch.defaultEmployeeId == null ? [] : [patch.defaultEmployeeId];
    db.prepare('UPDATE projects SET default_employee_ids = ? WHERE id = ?').run(JSON.stringify(list), projectId);
  }
  if (patch.defaultRiskTier !== undefined) {
    db.prepare('UPDATE projects SET default_risk_tier = ? WHERE id = ?').run(patch.defaultRiskTier, projectId);
  }

  const updated = getProjectById(db, projectId);
  if (!updated) throw new Error(`[db] setProjectStaffing 失败：id=${projectId} 读不回`);
  return { ok: true, row: updated };
}

/** M3-DOC-4：项目级文档检查开关（唯一写入口；不存在 → null，不臆造）。 */
export function setProjectDocsCheck(db: SqliteDb, projectId: number, enabled: boolean): ProjectRow | undefined {
  db.prepare('UPDATE projects SET docs_check_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  return getProjectById(db, projectId);
}

/**
 * B3（M3-N-3）：项目默认技能集（唯一写入口）。存**技能名**数组（稳定、可读）；
 * 调用方（IPC）已校验全部为启用中的技能。只影响该项目下新会话的装配，不改员工档案。
 */
export function setProjectDefaultSkills(
  db: SqliteDb,
  projectId: number,
  names: readonly string[],
): ProjectRow | undefined {
  db.prepare('UPDATE projects SET default_skills = ? WHERE id = ?').run(JSON.stringify([...new Set(names)]), projectId);
  return getProjectById(db, projectId);
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** D-22：读项目模型策略（坏 JSON/未知策略 → 防御性回落；不抛）。 */
export function getProjectModelPolicy(db: SqliteDb, projectId: number): ProjectModelPolicy | null {
  const row = getProjectById(db, projectId);
  if (!row) return null;
  return {
    policy: isProjectModelPolicyName(row.model_policy) ? row.model_policy : 'employee_first',
    defaultModel: typeof row.default_model === 'string' && row.default_model.trim().length > 0 ? row.default_model.trim() : null,
    allowedModels: parseStringArray(row.allowed_models),
  };
}

/**
 * D-22：写项目模型策略（唯一写入口；校验在 `core/model-tiers.ts#projectModelPolicyError`）。
 * 三字段整体提交（未给的字段视为默认值：policy=employee_first / default=null / allowed=[]）。
 */
export function setProjectModelPolicy(
  db: SqliteDb,
  input: {
    projectId: number;
    policy: unknown;
    defaultModel: unknown;
    allowedModels: unknown;
  },
): { ok: true; row: ProjectRow } | { ok: false; code: string; message: string } {
  const row = getProjectById(db, input.projectId);
  if (!row) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  const allowedProviders = parseStringArray(row.allowed_providers);
  const error = projectModelPolicyError(
    { policy: input.policy, defaultModel: input.defaultModel, allowedModels: input.allowedModels },
    allowedProviders,
  );
  if (error) return { ok: false, code: 'bad_value', message: error };
  const defaultModel = typeof input.defaultModel === 'string' && input.defaultModel.trim().length > 0 ? input.defaultModel.trim() : null;
  const allowedModels = (input.allowedModels as string[]).map((m) => m.trim());
  db.prepare('UPDATE projects SET default_model = ?, allowed_models = ?, model_policy = ? WHERE id = ?').run(
    defaultModel,
    JSON.stringify(allowedModels),
    input.policy as ProjectModelPolicyName,
    input.projectId,
  );
  const updated = getProjectById(db, input.projectId);
  if (!updated) throw new Error(`[db] setProjectModelPolicy 失败：id=${input.projectId} 读不回`);
  return { ok: true, row: updated };
}

/** v19：项目默认任务预算（NULL/非正数 = 不限；只影响之后新建且未显式给预算的任务）。 */
export function getProjectDefaultBudget(db: SqliteDb, projectId: number): number | null {
  const row = db.prepare('SELECT default_budget_tokens FROM projects WHERE id = ?').get(projectId) as
    | { default_budget_tokens: number | null }
    | undefined;
  const value = row?.default_budget_tokens;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function setProjectDefaultBudget(
  db: SqliteDb,
  input: { projectId: number; budgetTokens: unknown },
): { ok: true; value: number | null } | { ok: false; code: string; message: string } {
  const row = getProjectById(db, input.projectId);
  if (!row) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  const raw = input.budgetTokens;
  if (raw !== null && (!Number.isInteger(raw) || (raw as number) <= 0)) {
    return { ok: false, code: 'bad_value', message: 'default_budget_tokens 需为正整数 token，或 null（不限）' };
  }
  const value = raw === null ? null : (raw as number);
  db.prepare('UPDATE projects SET default_budget_tokens = ? WHERE id = ?').run(value, input.projectId);
  return { ok: true, value };
}

/**
 * 派发缺省链②（D-6/D-11）：取项目编制里的**首个在职且非幕僚长**默认执行员工；跳过失活/幻影/幕僚长；
 * 无一可用 ⇒ `null`（调用方回落负责人 → 首个可执行员工/自动招募，D-20；不猜、不报错）。
 */
export function resolveDefaultEmployeeId(db: SqliteDb, projectId: number): number | null {
  const row = db.prepare('SELECT default_employee_ids FROM projects WHERE id = ?').get(projectId) as
    | { default_employee_ids: string }
    | undefined;
  if (!row) return null;
  let list: unknown;
  try {
    list = JSON.parse(row.default_employee_ids) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (typeof item === 'number' && Number.isInteger(item) && isActiveEmployee(db, item)) return item;
  }
  return null;
}

/** 建任务缺省（handler 用）：解析**已过在职校验**的默认负责人/默认执行员工 + 默认档（未设置＝null）。 */
export function getProjectStaffing(db: SqliteDb, projectId: number): ProjectStaffing | null {
  const row = getProjectById(db, projectId);
  if (!row) return null;
  let employeeId: number | null = null;
  try {
    const list = JSON.parse(row.default_employee_ids) as unknown;
    if (Array.isArray(list)) {
      const first = list.find((v): v is number => typeof v === 'number' && Number.isInteger(v) && isActiveEmployee(db, v));
      employeeId = first ?? null;
    }
  } catch {
    employeeId = null;
  }
  const tier = row.default_risk_tier === 0 || row.default_risk_tier === 1 || row.default_risk_tier === 2 ? row.default_risk_tier : null;
  return {
    ownerEmployeeId: row.default_owner_id != null && isActiveEmployee(db, row.default_owner_id) ? row.default_owner_id : null,
    defaultEmployeeId: employeeId,
    defaultRiskTier: tier,
  };
}
