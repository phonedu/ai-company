/**
 *  持久化端口实现。
 *
 * 复用 `src/main/db/**` DAO（human_messages / reports / approvals / resolver_store）——
 * 不再重复写 SQL。报告状态投影（`acknowledged` / `resolved`）已收归 DAO（`ccdbf3c`，幂等），
 * 此处**只读**；仅保留一个视图层富化：`StoredReport` 的 `shortId / approvalId`（卡片标签 + 决策按钮寻址）。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  getApproval as dbGetApproval,
  answerApproval as dbAnswerApproval,
  latestPendingApproval as dbLatestPendingApproval,
} from '../db/approvals.js';
import { applyApprovalAsGrant, isGrantingChoice, parsePermissionQuestion } from '../permission/grants.js';
import { resolveAssistantWriteMode, setAssistantWriteMode } from '../permission/assistant-write.js';
import type { AssistantWriteMode } from '../permission/gate.js';
import type { EmployeeDTO } from './hall.js';
import { DOCS_CHECK_COMMAND } from '../docs/contract.js';
import type { ApprovalRow } from '../db/approvals.js';
import { insertHumanMessage, listHumanMessages } from '../db/human_messages.js';
import type { HumanMessageRow } from '../db/human_messages.js';
import { listPlanSteps, planStepProgress } from '../db/plan_steps.js';
import { listContextMetricsByTask } from '../db/context_metrics.js';
import { insertTaskEvent, listTaskEvents } from '../db/task_events.js';
import {
  SqliteCounterStore,
  archiveProject as dbArchiveProject,
  restoreProject as dbRestoreProject,
  deleteProjectIfEmpty as dbDeleteProjectIfEmpty,
  createProject as dbCreateProject,
  findProjectIdByAlias as dbFindProjectIdByAlias,
  setProjectAlias as dbSetProjectAlias,
  createTask as dbCreateTask,
  getArtifactById as dbGetArtifactById,
  getDefaultProject,
  getEmployeeById,
  getEmployeeModelPref,
  getProjectById,
  getProjectModelPolicy,
  getProjectStaffing,
  setProjectStaffing,
  setProjectDocsCheck,
  setProjectTargetBranch,
  getTaskById,
  updateTask,
  getWorkItem,
  getChangeset,
  insertArtifact as dbInsertArtifact,
  listProjects as dbListProjects,
  listTasks as dbListTasks,
  latestWorkersByTask,
  listWorkItemsByTask,
  insertEmployee as dbInsertEmployee,
  updateEmployee as dbUpdateEmployee,
  listSkills as dbListSkills,
  getSkillById as dbGetSkillById,
  upsertSkill as dbUpsertSkill,
  setSkillEnabled as dbSetSkillEnabled,
  countSkillReferences as dbCountSkillReferences,
  deleteSkill as dbDeleteSkill,
  resolveEnabledSkills as dbResolveEnabledSkills,
  setProjectDefaultSkills as dbSetProjectDefaultSkills,
  setProjectModelPolicy as dbSetProjectModelPolicy,
  setProjectDefaultBudget as dbSetProjectDefaultBudget,
  listMcpServers as dbListMcpServers,
  getMcpServerById as dbGetMcpServerById,
  upsertMcpServer as dbUpsertMcpServer,
  setMcpServerEnabled as dbSetMcpServerEnabled,
  countMcpReferences as dbCountMcpReferences,
  deleteMcpServer as dbDeleteMcpServer,
  listSeams as dbListSeams,
  readSetting,
  writeSetting,
} from '../db/index.js';
import { acknowledgeReport as dbAcknowledgeReport, getReport as dbGetReport, listReports as dbListReports } from '../db/reports.js';
import type { ReportRow } from '../db/reports.js';
import type { ProjectRow } from '../db/projects.js';
import type { TaskRow } from '../db/tasks.js';
import { createResolverStore } from '../db/resolver_store.js';
import { addTaskDependencyChecked, listTaskDependencies, removeTaskDependencyChecked } from '../db/task_deps.js';
import { summarizeCosts, summarizeTaskCosts } from '../db/costs.js';
import { listChangesetFiles, listChangesetsByTask } from '../db/changesets.js';
import { createGitRunner, discardChangeset, mergeChangeset, projectRootForTask, rollbackChangeset } from '../git/index.js';
import { scheduleTaskDeadlineTimers } from '../engine/timers.js';
import type { SqliteDb } from '../db/open.js';
import { buildHallState, ORG_MEMBERSHIP, UNGROUPED_ID } from './hall.js';
import { buildEmployeeDetail } from './employee.js';
import { answerAsk, getAsk, listOpenAsks, MAILBOX_ERROR, MailboxError } from '../engine/mailbox.js';
import { projectRawConversation } from '../agent/raw-conversation.js';
import { resolveSessionModel } from '../agent/model-policy.js';
import type {
  AttachmentMeta,
  CardIntentInput,
  CardIntentResult,
  ChatRepo,
  ProjectDTO,
  StoredApproval,
  StoredArtifact,
  StoredMessage,
  StoredPlanStep,
  StoredReport,
  StoredReview,
  StoredTask,
  StoredTaskDetail,
  StoredTaskEvent,
  McpServerView,
} from './ports.js';
import type { McpServerRow } from '../db/mcp.js';

/** basename（不读盘）：取 `path` 最后一段（兼容 `/` 与 `\\`）。 */
function basenameOf(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * OPT-：任务产物元信息（`artifacts` 表，只读、按 id 升序、按 `task_id` 定界）。
 * **列无关（口径冻结前）**：若存在 `source`/`commit_sha`/`at`（`003`）则映射；**缺列一律 `null`**（不阻塞）。
 * `commit_sha` → DTO `commit`（列名避开 SQL 关键字 `commit`）。
 */
// 事实：`artifacts` 的 `source`/`commit_sha`/`at`（若有）与 `changesets.head_sha` 目前均**无写者（属）**
//   → 恒 `null`，**非数据缺失**；将来由产出方填入，本函数**零改动**即可显示。
function listArtifactsForTask(db: SqliteDb, taskId: number): StoredArtifact[] {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const hasSource = cols.has('source');
  const hasCommit = cols.has('commit_sha');
  const hasAt = cols.has('at');
  const hasOrigin = cols.has('origin_artifact_id') && cols.has('origin_project_id');
  const sql =
    'SELECT id, kind, path, sha256, work_item_id, created_at' +
    `${hasSource ? ', source' : ''}${hasCommit ? ', commit_sha' : ''}${hasAt ? ', at' : ''}` +
    `${hasOrigin ? ', origin_artifact_id, origin_project_id' : ''}` +
    ' FROM artifacts WHERE task_id = ? ORDER BY id ASC';
  const rows = db.prepare(sql).all(taskId) as Array<Record<string, unknown>>;
  // 来源面板（G-A 余项，2026-10-16）：引用副本**结构化**带来源（origin_project_id → 项目名；查无 → null 不臆造）。
  const projectName = (id: number | null): string | null => {
    if (id == null) return null;
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? null;
  };
  return rows.map((r) => {
    const originArtifactId = hasOrigin && r.origin_artifact_id != null ? Number(r.origin_artifact_id) : null;
    const originProjectId = hasOrigin && r.origin_project_id != null ? Number(r.origin_project_id) : null;
    return {
      id: Number(r.id),
      kind: String(r.kind ?? 'file'),
      name: basenameOf(String(r.path ?? '')),
      path: String(r.path ?? ''),
      sha256: r.sha256 == null ? null : String(r.sha256),
      source: hasSource && r.source != null ? String(r.source) : null,
      commit: hasCommit && r.commit_sha != null ? String(r.commit_sha) : null,
      workItemId: r.work_item_id == null ? null : Number(r.work_item_id),
      at: hasAt && r.at != null ? Number(r.at) : r.created_at == null ? null : Number(r.created_at),
      originArtifactId,
      originProjectId,
      originProjectName: projectName(originProjectId),
    };
  });
}

function parseAttachments(raw: unknown): AttachmentMeta[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: AttachmentMeta[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? '');
      if (name.length === 0) continue;
      const meta: AttachmentMeta = {
        name,
        size: Number(record.size ?? 0),
        type: String(record.type ?? ''),
      };
      if (typeof record.fileToken === 'string' && record.fileToken.length > 0) {
        meta.fileToken = record.fileToken; //  例外③：不透明令牌（非路径）
      }
      out.push(meta);
    }
    return out;
  } catch {
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toMessage(row: HumanMessageRow): StoredMessage {
  return {
    id: row.id,
    direction: row.direction === 'out' ? 'out' : 'in',
    taskId: row.task_id,
    content: row.content,
    attachments: parseAttachments(row.attachments),
    createdAt: row.created_at,
  };
}

function toApproval(row: ApprovalRow): StoredApproval {
  return {
    id: row.id,
    taskId: row.task_id,
    reportId: row.report_id,
    question: row.question,
    options: parseJsonArray(row.options),
    chosen: row.chosen,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

/**  视图投影：卡片标签需要 short_id；决策按钮需要该 report 对应的 approval id。 */function enrichReport(db: SqliteDb, row: ReportRow): StoredReport {
  const task = db
    .prepare('SELECT t.short_id, t.project_id, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
    .get(row.task_id) as { short_id: string | null; project_id: number | null; project_name: string | null } | undefined;
  const approval = db
    .prepare('SELECT id, options FROM approvals WHERE report_id = ? ORDER BY id LIMIT 1')
    .get(row.id) as { id: number; options: string | null } | undefined;
  // 审批行 options 作为卡的兜底选项源——卡 payload 缺 options 的历史卡（升级卡修复前发出的）
  // 靠它复活按钮；新卡 payload 自带时以 payload 为准。
  let approvalOptions: Array<{ key: string; label?: string }> | null = null;
  if (approval?.options) {
    try {
      const parsed: unknown = JSON.parse(approval.options);
      if (Array.isArray(parsed) && parsed.length > 0) approvalOptions = parsed as Array<{ key: string; label?: string }>;
    } catch {
      // 坏 JSON → 不兜底（不猜）
    }
  }
  return {
    id: row.id,
    taskId: row.task_id,
    shortId: task?.short_id ?? null,
    projectId: task?.project_id ?? null,
    projectName: task?.project_name ?? null,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    approvalId: approval?.id ?? null,
    approvalOptions,
    payload: parseJsonObject(row.payload),
    verdict: row.verdict,
    verifierEmployeeId: row.verifier_employee_id,
  };
}

function toStoredTask(
  row: TaskRow,
  project: { name: string; alias: string | null; accessMode?: string } | null = null,
  executor?: { id: number; name: string | null } | null,
): StoredTask {
  let acceptance: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.acceptance);
    if (Array.isArray(parsed)) acceptance = parsed;
  } catch {
    acceptance = [];
  }
  return {
    id: row.id,
    shortId: row.short_id,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    pauseReason: row.pause_reason ?? null,
    priority: row.priority,
    riskLevel: row.risk_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readySince: row.ready_since,
    deadline: row.deadline ?? null,
    acceptance,
    budgetTokens: row.budget_tokens,
    costTokens: row.cost_tokens,
    budgetLeftTokens: row.budget_tokens == null ? null : row.budget_tokens - row.cost_tokens,
    model: row.model,
    archived: row.archived,
    projectName: project?.name ?? null,
    projectAlias: project?.alias ?? null,
    projectAccessMode: project?.accessMode ?? null,
    // 执行员工（2026-10-16 左栏批）：只在**给值时**出现（缺省面不带＝不承诺，见 ports.ts 注释）。
    ...(executor !== undefined ? { executor } : {}),
  };
}

/**
 * F-CS-1（真机抓到）：详情路径也要带**项目引用** —— 否则 `toStoredTask(row)` 不传 project
 * ⇒ `projectAccessMode` 恒 `null` ⇒ `inplace` 空态（「本次为就地修改、无变更集」）**在真实路径上永不出现**。
 */
function taskProjectRef(
  db: SqliteDb,
  projectId: number,
): { name: string; alias: string | null; accessMode: string } | null {
  const p = getProjectById(db, projectId);
  return p ? { name: p.name, alias: p.alias, accessMode: p.access_mode } : null;
}

/**
 * 任务头「预计模型＋来源」——用**执行员工**视角预览（实际会话可能由规划/评审角色跑；
 * 这里只回答“这件活会落到哪个模型”，不冒充会话实况）。无工作项时用负责人；无员工偏好走项目默认。
 */
function taskModelPreview(db: SqliteDb, row: TaskRow): {
  model: string;
  source: string;
  reason?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  rejected?: string;
} {
  const latest = db
    .prepare('SELECT employee_id FROM work_items WHERE task_id = ? ORDER BY id DESC LIMIT 1')
    .get(row.id) as { employee_id: number } | undefined;
  const employeeId = latest?.employee_id ?? row.owner_id ?? 0;
  const pref = getEmployeeModelPref(db, employeeId);
  const project = getProjectModelPolicy(db, row.project_id);
  const tier = resolveSessionModel({
    role: 'employee',
    riskLevel: row.risk_level,
    taskModel: row.model,
    employeeModel: pref.model,
    employeeThinking: pref.thinking,
    project,
  });
  return {
    model: tier.model,
    source: tier.source,
    ...(tier.reason ? { reason: tier.reason } : {}),
    ...(tier.fallbackFrom ? { fallbackFrom: tier.fallbackFrom } : {}),
    ...(tier.fallbackReason ? { fallbackReason: tier.fallbackReason } : {}),
    ...(tier.rejected ? { rejected: tier.rejected } : {}),
  };
}

/** R2-3 · `projects` 行 → `ProjectDTO`（camelCase；JSON 列防御解析——坏值 → `[]`，不抛）。 */
/** MCP 行 → 渲染视图；**env 值绝不进 renderer**（只给 key 名）。 */
function toMcpServerView(row: McpServerRow): McpServerView {
  let args: string[] = [];
  try {
    const parsed = JSON.parse(row.args) as unknown;
    if (Array.isArray(parsed)) args = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    args = [];
  }
  let envKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.env) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envKeys = Object.keys(parsed);
  } catch {
    envKeys = [];
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args,
    url: row.url,
    envKeys,
    exposure: row.exposure,
    hasExternalActions: row.has_external_actions === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function toProjectDTO(db: SqliteDb, row: ProjectRow): ProjectDTO {
  const arr = (raw: string): unknown[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    name: row.name,
    alias: row.alias,
    rootDir: row.root_dir,
    attention: row.attention,
    accessMode: row.access_mode,
    defaultEmployeeIds: arr(row.default_employee_ids).filter((v): v is number => typeof v === 'number'),
    defaultOwnerId: row.default_owner_id ?? null,
    defaultRiskTier: row.default_risk_tier ?? null,
    /**  P1：项目级频道助手写权限（读面＝permission_policies；未设＝confirm）。 */
    assistantWriteMode: resolveAssistantWriteMode(db, row.id),
    docsCheckEnabled: row.docs_check_enabled !== 0,
    defaultSkills: arr(row.default_skills).filter((v): v is string => typeof v === 'string'),
    allowedProviders: arr(row.allowed_providers).filter((v): v is string => typeof v === 'string'),
    defaultModel: typeof row.default_model === 'string' && row.default_model.trim().length > 0 ? row.default_model.trim() : null,
    allowedModels: arr(row.allowed_models).filter((v): v is string => typeof v === 'string'),
    defaultBudgetTokens:
      typeof row.default_budget_tokens === 'number' && Number.isInteger(row.default_budget_tokens) && row.default_budget_tokens > 0
        ? row.default_budget_tokens
        : null,
    targetBranch:
      typeof row.target_branch === 'string' && row.target_branch.trim().length > 0 ? row.target_branch.trim() : null,
    modelPolicy:
      row.model_policy === 'fixed' || row.model_policy === 'assistant' ? row.model_policy : 'employee_first',
    archived: row.archived,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

/** 没指定项目时给一个默认项目（tasks.project_id NOT NULL）。 */
function ensureDefaultProject(db: SqliteDb): number {
  const existing = getDefaultProject(db);
  if (existing) return existing.id;
  // 幂等（深件同批）：设置未设时**复用**既有「默认项目」行——旧实现每次 INSERT，
  // 归属拿不准路径（未设默认 + 多次建任务）会累积出多个同名「默认项目」。
  const legacy = db
    .prepare("SELECT id FROM projects WHERE name = '默认项目' AND archived = 0 ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined;
  if (legacy) return legacy.id;
  // （真机带回）：回退根改为**用户主目录下的应用工作区**并当场创建——
  // 旧默认模板路径不存在 ⇒
  // 落到该项目的任务员工全部工具失败（write EPERM / bash cwd 不存在）。这是应用自己的
  // 工作区目录（不碰用户已有文件）；用户随时可在设置·项目里改根或接入自己的文件夹。
  const defaultRoot = process.env.AICO_DEFAULT_PROJECT_ROOT?.trim() || join(homedir(), '.aico', 'projects', 'default');
  try {
    mkdirSync(defaultRoot, { recursive: true });
  } catch { /* 建不出来就让任务失败在明处（root_dir 指向不可写路径，报错可读） */ }
  const row = db
    .prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?) RETURNING id')
    .get('默认项目', defaultRoot, Date.now()) as { id: number };
  return row.id;
}

/** 基于 better-sqlite3 + DAO 的端口实现。 */
export function createSqliteChatRepo(db: SqliteDb): ChatRepo {
  return {
    resolverStore: createResolverStore(db),

    insertMessage(input) {
      return toMessage(
        insertHumanMessage(db, {
          direction: input.direction,
          taskId: input.taskId ?? null,
          content: input.content,
          attachments: input.attachments ?? [],
          now: input.now,
        }),
      );
    },

    listMessages(opts) {
      return listHumanMessages(db, {
        taskId: opts?.taskId,
        limit: opts?.limit ?? 100,
        latest: opts?.latest === true,
      }).map(toMessage);
    },

    listReports(opts) {
      return dbListReports(db, {
        taskId: opts?.taskId,
        state: opts?.state,
        kind: opts?.kind,
        limit: opts?.limit ?? 50,
        latest: opts?.latest === true,
      }).map((row) => enrichReport(db, row));
    },

    acknowledgeReport(reportId, now) {
      // 状态投影已在 DAO（ccdbf3c：置 acknowledged_at + `state='acknowledged'`，幂等）；此处只读回。
      if (!dbGetReport(db, reportId)) return null;
      dbAcknowledgeReport(db, reportId, now ?? Date.now());
      const row = dbGetReport(db, reportId);
      return row ? enrichReport(db, row) : null;
    },

    getApproval(approvalId) {
      const row = dbGetApproval(db, approvalId);
      return row ? toApproval(row) : null;
    },

    // ── R2-3：三桩第一批（project:list/get ＋ settings:get/set）──
    listProjects(opts) {
      return dbListProjects(db, { includeArchived: opts?.includeArchived ?? false }).map((row) => toProjectDTO(db, row));
    },

    getProject(id) {
      const row = getProjectById(db, id);
      return row ? toProjectDTO(db, row) : null;
    },

    archiveProject(id, now) {
      const row = dbArchiveProject(db, id, now);
      return row ? toProjectDTO(db, row) : null;
    },

    restoreProject(id) {
      const row = dbRestoreProject(db, id);
      return row ? toProjectDTO(db, row) : null;
    },

    deleteProjectIfEmpty(id) {
      return dbDeleteProjectIfEmpty(db, id);
    },

    createProject(input) {
      return toProjectDTO(
        db,
        dbCreateProject(db, {
          name: input.name,
          rootDir: input.rootDir,
          accessMode: input.accessMode,
          ...(input.alias !== undefined ? { alias: input.alias } : {}),
          now: input.now,
        }),
      );
    },

    /** 别名占用（含归档；null＝未占用）。 */
    projectIdByAlias(alias) {
      return dbFindProjectIdByAlias(db, alias);
    },

    /** 设置/清空别名（唯一性由 IPC 前置校验；返回更新后的 DTO）。 */
    projectAliasSet(input) {
      const row = dbSetProjectAlias(db, input.projectId, input.alias);
      return row ? toProjectDTO(db, row) : null;
    },

    // 编制 v1：写三项缺省（校验/落库在 `db/projects.ts#setProjectStaffing`——非法拒且不落库）。
    projectStaffingSet(input) {
      const res = setProjectStaffing(db, input.projectId, {
        ...(input.ownerEmployeeId !== undefined ? { ownerEmployeeId: input.ownerEmployeeId } : {}),
        ...(input.defaultEmployeeId !== undefined ? { defaultEmployeeId: input.defaultEmployeeId } : {}),
        ...(input.defaultRiskTier !== undefined ? { defaultRiskTier: input.defaultRiskTier } : {}),
      });
      if (!res.ok) return res;
      return { ok: true, project: toProjectDTO(db, res.row) };
    },

    // 编制 v1：建任务缺省（已过在职校验收口；项目不存在 → null）。
    projectStaffing(projectId) {
      const s = getProjectStaffing(db, projectId);
      if (!s) return null;
      return { ownerEmployeeId: s.ownerEmployeeId, defaultEmployeeId: s.defaultEmployeeId, defaultRiskTier: s.defaultRiskTier };
    },

    // 项目级文档检查开关（不存在 → null）。
    projectDocsCheckSet(input) {
      const row = setProjectDocsCheck(db, input.projectId, input.enabled);
      return row ? toProjectDTO(db, row) : null;
    },

    //  P1：项目级频道助手写权限（不存在 → null；只写 permission_policies 的 assistantWriteMode）。
    projectAssistantWriteModeSet(input: { projectId: number; mode: AssistantWriteMode }) {
      if (!getProjectById(db, input.projectId)) return null;
      setAssistantWriteMode(db, input.projectId, input.mode);
      const row = getProjectById(db, input.projectId);
      return row ? toProjectDTO(db, row) : null;
    },

    // 项目模型策略（三字段整体写；校验在 core/model-tiers.ts；非法拒且不落库）。
    projectModelPolicySet(input) {
      const res = dbSetProjectModelPolicy(db, {
        projectId: input.projectId,
        policy: input.policy,
        defaultModel: input.defaultModel,
        allowedModels: input.allowedModels,
      });
      if (!res.ok) return res;
      return { ok: true, project: toProjectDTO(db, res.row) };
    },

    // v19：项目默认任务预算（NULL＝不限；只影响之后新建且未显式给预算的任务）。
    projectDefaultBudgetSet(input) {
      const res = dbSetProjectDefaultBudget(db, { projectId: input.projectId, budgetTokens: input.budgetTokens });
      if (!res.ok) return res;
      const row = getProjectById(db, input.projectId);
      if (!row) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
      return { ok: true, project: toProjectDTO(db, row) };
    },

    // /：合并目标分支（空串/null ⇒ 清空，回到 main/master 口径）。
    projectTargetBranchSet(input) {
      const row = setProjectTargetBranch(db, input.projectId, input.branch);
      if (!row) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
      return { ok: true, project: toProjectDTO(db, row) };
    },

    // 项目默认技能集（先解析校验，再落库；不可解析项显式拒）。
    projectDefaultSkillsSet(input) {
      const project = getProjectById(db, input.projectId);
      if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
      const rows = dbResolveEnabledSkills(db, input.refs);
      const missing = input.refs.filter(
        (ref) => !rows.some((row) => row.name === ref || String(row.id) === ref),
      );
      if (missing.length > 0) {
        return { ok: false, code: 'unknown_skill', message: `未登记或已停用：${missing.join('、')}` };
      }
      const updated = dbSetProjectDefaultSkills(db, input.projectId, rows.map((row) => row.name));
      if (!updated) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
      return { ok: true, project: toProjectDTO(db, updated) };
    },

    // G-A（§7 序 3，迁移 007）：跨项目引用——源侧读 ＋ 原子登记（新产物行 ＋ 审计事件）。
    getArtifact(id) {
      const row = dbGetArtifactById(db, id);
      if (!row) return null;
      return {
        id: row.id,
        taskId: row.task_id,
        path: row.path,
        kind: row.kind,
        sha256: row.sha256 ?? null,
        source: row.source ?? null,
        originProjectId: row.origin_project_id ?? null,
      };
    },

    recordArtifactReference(input) {
      db.exec('BEGIN');
      try {
        const ins = dbInsertArtifact(db, {
          taskId: input.targetTaskId,
          workItemId: null,
          path: input.path,
          kind: input.kind,
          // 人话来源进 note（面板直读；结构化列另存，见 007 注释）。
          note: input.note,
          sha256: input.sha256,
          source: input.source ?? null,
          originArtifactId: input.originArtifactId,
          originProjectId: input.originProjectId,
          now: input.now,
        });
        // 审计：老板显式发起的引用（G-B 规则①"记 task_events"）；重复引用也留痕（duplicate 标注）。
        insertTaskEvent(db, {
          taskId: input.targetTaskId,
          workItemId: null,
          ts: input.now,
          kind: 'artifact_referenced',
          actor: 'boss',
          payload: {
            artifactId: ins.id,
            originArtifactId: input.originArtifactId,
            originTaskId: input.originTaskId,
            originProjectId: input.originProjectId,
            mode: input.mode ?? 'copy',
            path: input.path,
            sha256: input.sha256,
            duplicate: !ins.created,
          },
        });
        db.exec('COMMIT');
        return { artifactId: ins.id, created: ins.created };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    getSetting(key) {
      return readSetting(db, key);
    },

    setSetting(input) {
      writeSetting(db, input.key, input.value);
    },

    // R2-2（G7）：未结提问 / 老板代答（复用 `engine/mailbox.ts`，不复制口径）
    listOpenAsks() {
      return listOpenAsks(db);
    },

    answerAskAsBoss(input) {
      // 用 getAsk（含已答）：重复作答走 answerAsk 的幂等（delivered:false），只有**提问本身不存在**才拒。
      const ask = getAsk(db, input.askDedupeKey);
      if (!ask) throw new MailboxError(MAILBOX_ERROR.ASK_NOT_FOUND, `找不到待答的提问：${input.askDedupeKey}`);
      const res = answerAsk(db, {
        taskId: ask.taskId,
        workItemId: ask.workItemId,
        from: ask.to,
        to: ask.from,
        askDedupeKey: ask.askDedupeKey,
        answer: input.answer,
        via: 'boss',
        now: input.now,
      });
      return { delivered: res.delivered };
    },

    createTask(input) {
      const projectId = input.projectId ?? ensureDefaultProject(db);
      const project = getProjectById(db, projectId);
      const provided = Array.isArray(input.acceptance) ? input.acceptance : [];
      const hasDocsCheck = provided.some(
        (item) => item != null && typeof item === 'object' && (item as { check?: unknown }).check === DOCS_CHECK_COMMAND,
      );
      // L1/L2 新任务默认挂文档检查（项目开关默认开；L0 直通免验不挂；显式同检查不重复）。
      const acceptance =
        (input.riskLevel ?? 1) > 0 && project?.docs_check_enabled !== 0 && !hasDocsCheck
          ? [...provided, { text: '文档检查通过（.aico/docs）', check: DOCS_CHECK_COMMAND }]
          : provided;
      const row = dbCreateTask(db, new SqliteCounterStore(db), {
        projectId,
        title: input.title,
        goal: input.goal,
        acceptance,
        // （编制）：负责人随建任务落库（显式 > 编制缺省，已由 handler 解析；`undefined` → NULL＝缺省链兜底）
        ...(typeof input.ownerId === 'number' ? { ownerId: input.ownerId } : {}),
        // R3-1：显式选档透传（`undefined` → db 缺省 1＝L1 审计划）
        ...(typeof input.riskLevel === 'number' ? { riskLevel: input.riskLevel } : {}),
        // （挂载 3）：预算随建任务落库（存在性以 db 列为准）
        ...(typeof input.budgetTokens === 'number' ? { budgetTokens: input.budgetTokens } : {}),
        // 009（N5 余账）：任务级模型随建任务落库（白名单拦点在 ipc 侧先行——本层只如实落库）
        ...(typeof input.model === 'string' && input.model.trim().length > 0 ? { model: input.model.trim() } : {}),
        // 触发建任务保留来源（audit/timeline 不再一律记 boss）。
        ...(typeof input.origin === 'string' && input.origin.trim().length > 0 ? { origin: input.origin.trim() } : {}),
        //  尾：截止时刻与依赖边随建任务落库（依赖存在性/同事务由 db/tasks 保证）
        ...(input.deadline != null ? { deadline: input.deadline } : {}),
        ...(input.dependsOn && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
      });
      // 截止提醒/逾期卡落在 timers；只提醒，不自动暂停。
      if (row.deadline != null) {
        scheduleTaskDeadlineTimers(db, { taskId: row.id, deadline: row.deadline, now: row.created_at });
      }
      return toStoredTask(row);
    },

    addTaskDependency(input) {
      const res = addTaskDependencyChecked(db, input);
      return res.ok ? { ok: true, added: res.added } : { ok: false, added: false, code: res.code, message: res.message };
    },

    removeTaskDependency(input) {
      const res = removeTaskDependencyChecked(db, input);
      return res.ok ? { ok: true, added: res.added } : { ok: false, added: false, code: res.code, message: res.message };
    },

    setTaskModel(taskId, model, now) {
      // 009（N5 余账）：任务级模型写入口（`模型 T1042 <model>` 命令走它）。
      // 与 setTaskBudget 同规：只用**本列**直写 UPDATE（不借 updateTask——OPT-M2-1c 状态位同源门）。
      const row = getTaskById(db, taskId);
      if (!row) return null;
      db.prepare('UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?').run(
        typeof model === 'string' && model.trim().length > 0 ? model.trim() : null,
        now ?? Date.now(),
        taskId,
      );
      const after = getTaskById(db, taskId);
      return after ? toStoredTask(after) : null;
    },

    setTaskBudget(taskId, budgetTokens, now) {
      // 唯一写入口之一（`加预算 T1042 N` 命令与将来的表单共用）。
      // 只用**预算列**的直写 UPDATE——不借 `updateTask`（OPT-M2-1c 状态位同源门：state 写者唯一＝引擎）。
      const row = getTaskById(db, taskId);
      if (!row) return null;
      db.prepare('UPDATE tasks SET budget_tokens = ?, updated_at = ? WHERE id = ?').run(
        budgetTokens,
        now ?? Date.now(),
        taskId,
      );
      const after = getTaskById(db, taskId);
      return after ? toStoredTask(after) : null;
    },

    listTasks(filter) {
      //  项目分组：**零新通道**——用 `projects` 表建 id→{name,alias} map，逐行 join 到 `TaskDTO`。
      const projectById = new Map(
        dbListProjects(db, { includeArchived: true }).map(
          (p) => [p.id, { name: p.name, alias: p.alias, accessMode: p.access_mode }] as const,
        ),
      );
      // 2026-10-16 左栏批：执行员工（**最新一件**工作项的负责人）同法 join——零新通道。
      const workers = latestWorkersByTask(db);
      const rows = dbListTasks(db, { includeArchived: filter?.includeArchived, since: filter?.since })
        .filter(
          (row) =>
            (filter?.state == null || row.state === filter.state) &&
            (filter?.projectId == null || row.project_id === filter.projectId),
        )
        .map((row) => {
          const worker = workers.get(row.id);
          return toStoredTask(
            row,
            projectById.get(row.project_id) ?? null,
            worker ? { id: worker.employeeId, name: worker.name } : null,
          );
        });
      // `limit` 在**最终结果集**上应用（DAO 的 SQL LIMIT 会在 state/projectId 过滤前截断 → 计数不准）。
      return filter?.limit != null ? rows.slice(0, filter.limit) : rows;
    },

    //  用量可视：聚合成本（`since` 缺省 = 全部）。
    costSummary(since) {
      return summarizeCosts(db, since === undefined ? {} : { since });
    },

    //  成本 tab：单任务成本 + 按模型拆分。
    taskCosts(taskId) {
      return summarizeTaskCosts(db, taskId);
    },

    getTask(id) {
      const row = getTaskById(db, id);
      return row ? toStoredTask(row) : null;
    },

    listWorkItemIds(taskId) {
      return listWorkItemsByTask(db, taskId).map((row) => row.id);
    },

    getWorkItemShortId(workItemId) {
      const item = getWorkItem(db, workItemId);
      if (!item) return null;
      return getTaskById(db, item.task_id)?.short_id ?? null;
    },

    findTaskByShortId(shortId) {
      const row = db.prepare('SELECT * FROM tasks WHERE short_id = ?').get(shortId) as TaskRow | undefined;
      return row ? toStoredTask(row) : null;
    },

    findRunningWorkItem(taskId) {
      const row = listWorkItemsByTask(db, taskId).find((r) => r.state === 'running');
      return row ? { id: row.id, employeeId: row.employee_id } : null;
    },

    listEmployees() {
      return buildHallState(db).employees;
    },

    // 花名册含已停用（active 真值），否则停用后从 UI 消失、无法重新启用。
    listRosterEmployees() {
      const active = buildHallState(db).employees;
      const rows = db
        .prepare('SELECT id, name, role, avatar, is_assistant, active FROM employees ORDER BY id')
        .all() as Array<{ id: number; name: string; role: string; avatar: string | null; is_assistant: number; active: number }>;
      return rows.map((row): EmployeeDTO => {
        const live = active.find((e) => e.id === row.id);
        if (live) return live;
        return {
          id: row.id,
          name: row.name,
          role: row.role,
          avatar: row.avatar,
          isAssistant: row.is_assistant === 1,
          active: row.active === 1,
          // 已停用员工仍按归属映射显部门（与在职同一 `ORG_MEMBERSHIP`；未命中＝未分组）。
          departmentId: ORG_MEMBERSHIP[row.id] ?? UNGROUPED_ID,
          mcpRefs: [],
        };
      });
    },

    globalSearch(query) {
      const q = query.trim();
      if (q.length === 0) return { query: '', tasks: [], messages: [], artifacts: [], total: 0 };
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const tasks = (
        db
          .prepare(
            `SELECT t.id, t.short_id, t.title, t.project_id, p.name AS project_name
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.short_id LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\'
             ORDER BY t.updated_at DESC, t.id DESC LIMIT 6`,
          )
          .all(like, like) as Array<{
          id: number;
          short_id: string | null;
          title: string;
          project_id: number;
          project_name: string | null;
        }>
      ).map((r) => ({
        id: r.id,
        shortId: r.short_id,
        title: r.title,
        projectId: r.project_id,
        projectName: r.project_name,
      }));
      const messages = (
        db
          .prepare(
            `SELECT m.id, m.task_id, m.content, p.name AS project_name
             FROM human_messages m
             LEFT JOIN tasks t ON t.id = m.task_id
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE m.content LIKE ? ESCAPE '\\'
             ORDER BY m.created_at DESC, m.id DESC LIMIT 6`,
          )
          .all(like) as Array<{ id: number; task_id: number | null; content: string; project_name: string | null }>
      ).map((r) => ({ id: r.id, taskId: r.task_id, content: r.content, projectName: r.project_name }));
      const artifacts = (
        db
          .prepare(
            `SELECT a.id, a.task_id, a.path, p.name AS project_name
             FROM artifacts a
             JOIN tasks t ON t.id = a.task_id
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE a.path LIKE ? ESCAPE '\\' OR a.note LIKE ? ESCAPE '\\'
             ORDER BY a.id DESC LIMIT 6`,
          )
          .all(like, like) as Array<{ id: number; task_id: number; path: string; project_name: string | null }>
      ).map((r) => ({ id: r.id, taskId: r.task_id, path: r.path, projectName: r.project_name }));
      return { query: q, tasks, messages, artifacts, total: tasks.length + messages.length + artifacts.length };
    },

    listSkills(includeDisabled = false) {
      return dbListSkills(db, { includeDisabled });
    },

    upsertSkill(input) {
      return dbUpsertSkill(db, input);
    },

    setSkillEnabled(id, enabled) {
      return dbSetSkillEnabled(db, id, enabled) ?? null;
    },

    removeSkill(id) {
      const row = dbGetSkillById(db, id);
      if (!row) return { ok: false, code: 'not_found', message: `技能不存在：#${id}` };
      if (row.source === 'builtin') {
        return { ok: false, code: 'builtin', message: '内置技能不可删（可停用）' };
      }
      const refs = dbCountSkillReferences(db, row.name, row.id);
      if (refs > 0) {
        return {
          ok: false,
          code: 'in_use',
          message: `技能仍被 ${refs} 个员工/项目引用；先取消勾选再删除`,
        };
      }
      dbDeleteSkill(db, id);
      return { ok: true, skill: row };
    },

    listMcpServers(includeDisabled = false) {
      return dbListMcpServers(db, { includeDisabled }).map(toMcpServerView);
    },

    upsertMcpServer(input) {
      return toMcpServerView(dbUpsertMcpServer(db, input));
    },

    setMcpServerEnabled(id, enabled) {
      const row = dbSetMcpServerEnabled(db, id, enabled);
      return row ? toMcpServerView(row) : null;
    },

    removeMcpServer(id) {
      const row = dbGetMcpServerById(db, id);
      if (!row) return { ok: false, code: 'not_found', message: `MCP server 不存在：#${id}` };
      const refs = dbCountMcpReferences(db, row.name, row.id);
      if (refs > 0) {
        return { ok: false, code: 'in_use', message: `仍被 ${refs} 个员工引用；先在员工「MCP」tab 取消勾选` };
      }
      dbDeleteMcpServer(db, id);
      return { ok: true, server: toMcpServerView(row) };
    },

    seamRows(projectId) {
      return dbListSeams(db, projectId).map((row) => ({
        boundary: row.boundary,
        status: row.status,
        coverageRef: row.coverage_ref,
        owner: row.owner,
        milestone: row.milestone,
      }));
    },

    employeeDetail(id) {
      return buildEmployeeDetail(db, id);
    },

    recruitEmployee(input) {
      const id = dbInsertEmployee(db, {
        name: input.name,
        role: input.role,
        ...(input.persona !== undefined ? { persona: input.persona } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mcps !== undefined ? { mcps: input.mcps } : {}),
        ...(input.capabilityTier !== undefined ? { capabilityTier: input.capabilityTier } : {}),
      });
      return buildEmployeeDetail(db, id);
    },

    updateEmployee(input) {
      const { employeeId, ...patch } = input;
      const res = dbUpdateEmployee(db, employeeId, patch);
      if (!res.ok) return { ok: false, code: res.code, message: res.message };
      return { ok: true, employee: buildEmployeeDetail(db, employeeId) };
    },

    hallState() {
      return buildHallState(db);
    },

    getTaskDetail(id): StoredTaskDetail | null {
      const row = getTaskById(db, id);
      if (!row) return null;

      const planSteps: StoredPlanStep[] = listPlanSteps(db, id).map((step) => ({
        idx: step.idx,
        text: step.text,
        state: step.state,
        workItemId: step.work_item_id,
        evidenceRef: step.evidence_ref,
      }));

      const timeline: StoredTaskEvent[] = listTaskEvents(db, id).map((event) => ({
        id: event.id,
        ts: event.ts,
        kind: event.kind,
        actor: event.actor,
        workItemId: event.work_item_id,
        payload: parseJson(event.payload),
      }));

      // 结论上屏的只读投影。**reports.verdict 优先**（独立验证真列），
      // 事件 payload 兜底；`plan_reviewed` 只取带 verdict 的行，避免 critic 打回时
      // 「plan_reviewed(revise) + revise(plan_reviewed)」同一结论上两块。
      const reviews: StoredReview[] = [];
      for (const event of timeline) {
        if (event.kind !== 'plan_reviewed' && event.kind !== 'verification_completed') continue;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const reportId = typeof payload.reportId === 'number' ? payload.reportId : null;
        const report = reportId != null ? dbGetReport(db, reportId) : null;
        const reportPayload = report ? parseJsonObject(report.payload) : {};
        const eventVerdict = typeof payload.verdict === 'string' ? payload.verdict : null;
        if (event.kind === 'plan_reviewed' && eventVerdict == null && report?.verdict == null) continue;
        const verdict =
          report?.verdict ??
          eventVerdict ??
          (typeof reportPayload.verdict === 'string' ? reportPayload.verdict : null);
        const notes =
          (typeof payload.notes === 'string' && payload.notes.trim().length > 0
            ? payload.notes.trim()
            : null) ??
          (typeof reportPayload.notes === 'string' && reportPayload.notes.trim().length > 0
            ? reportPayload.notes.trim()
            : null);
        reviews.push({
          eventId: event.id,
          ts: event.ts,
          stage: event.kind === 'plan_reviewed' ? 'plan' : 'verification',
          actor: event.actor,
          role: typeof payload.role === 'string' ? payload.role : null,
          verdict,
          notes,
          workItemId:
            typeof payload.workItemId === 'number'
              ? payload.workItemId
              : (event.workItemId ?? null),
          reportId,
          verifierEmployeeId: report?.verifier_employee_id ?? null,
        });
      }
      const latestSubmitted = db
        .prepare("SELECT id FROM work_items WHERE task_id = ? AND state = 'submitted' ORDER BY id DESC LIMIT 1")
        .get(id) as { id: number } | undefined;

      // （挂载 3 余·取消小步）：工作项**按状态计数**——UI「取消」确认文案的**真读数**
      //（在跑 N / 已提交 M；无行 ⇒ 空对象，UI 不写数字——不臆造）。
      const workItemCounts: Record<string, number> = {};
      const wiRows = db
        .prepare('SELECT state, COUNT(*) AS n FROM work_items WHERE task_id = ? GROUP BY state')
        .all(id) as Array<{ state: string; n: number }>;
      for (const row of wiRows) workItemCounts[row.state] = row.n;

      // 负责人 + 前置任务 + 执行员工（详情与列表同源；不再让详情只剩标题）。
      const ownerRow = row.owner_id == null ? null : getEmployeeById(db, row.owner_id);
      const worker = latestWorkersByTask(db).get(id);
      const dependsOn = listTaskDependencies(db, id).flatMap((dependsOnId) => {
        const dep = getTaskById(db, dependsOnId);
        return dep
          ? [{ id: dep.id, shortId: dep.short_id, title: dep.title, state: dep.state }]
          : [];
      });

      return {
        task: {
          ...toStoredTask(
            row,
            taskProjectRef(db, row.project_id),
            worker ? { id: worker.employeeId, name: worker.name } : null,
          ),
          goal: row.goal,
          updatedAt: row.updated_at,
        },
        owner: ownerRow ? { id: ownerRow.id, name: ownerRow.name } : null,
        dependsOn,
        modelResolution: taskModelPreview(db, row),
        progress: planStepProgress(db, id),
        planSteps,
        timeline,
        reviews,
        verificationWorkItemId: latestSubmitted?.id ?? null,
        workItemCounts,
        artifacts: listArtifactsForTask(db, id),
        rawConversation: projectRawConversation(db, id),
        //  变更区块：本任务变更集 + 文件明细（`staging` 才有；空数组 = 无）。
        changesets: listChangesetsByTask(db, id).map((cs) => ({
          id: cs.id,
          branch: cs.branch,
          baseSha: cs.base_sha,
          headSha: cs.head_sha,
          filesChanged: cs.files_changed,
          insertions: cs.insertions,
          deletions: cs.deletions,
          summary: cs.summary,
          state: cs.state,
          createdAt: cs.created_at,
          files: listChangesetFiles(db, cs.id).map((f) => ({
            path: f.path,
            status: f.status,
            insertions: f.insertions,
            deletions: f.deletions,
            employeeId: f.employee_id,
            employeeName: f.employee_id == null ? null : (getEmployeeById(db, f.employee_id)?.name ?? null),
          })),
        })),
        // CTX1-2：最近 N 轮上下文遥测（新的在前；空数组 = 本任务还没有任何会话遥测）。
        contextMetrics: listContextMetricsByTask(db, id, 20),
      };
    },

    recordCardIntent(input: CardIntentInput): CardIntentResult {
      const payload = input.payload;
      const taskId = typeof payload.taskId === 'number' ? payload.taskId : null;
      const approvalId = typeof payload.approvalId === 'number' ? payload.approvalId : null;
      const reportId = typeof payload.reportId === 'number' ? payload.reportId : null;

      // ① 意图落 `human_messages(in)`（人话摘要，老板频道可见、可审计）
      const summary = `卡片操作：${input.action}${typeof payload.key === 'string' ? `（${payload.key}）` : ''}`;
      const message = insertHumanMessage(db, {
        direction: 'in',
        taskId,
        content: summary,
        attachments: [],
        now: input.now,
      });

      // ② 路由：审批/已阅走**既有**路径（M1；危险动作的 `permissionGate` 统一入口在后续接入）
      let answeredApproval = false;
      if (approvalId != null && (input.action === 'select' || input.action === 'approve' || input.action === 'reject')) {
        const chosen = typeof payload.key === 'string' && payload.key.length > 0 ? payload.key : input.action;
        dbAnswerApproval(db, { approvalId, chosen, decidedBy: 'boss', now: input.now });
        // G1 余项接线：老板**批准**权限审批 → 发 grant（最小范围=会话×规则；缺会话回落任务级）→ 下次同规则放行。
        if (chosen === 'approve') applyApprovalAsGrant(db, approvalId, { now: input.now, approvedBy: 'boss' });
        answeredApproval = true;
      }
      let acknowledgedReport = false;
      if (input.action === 'ack' && reportId != null) {
        dbAcknowledgeReport(db, reportId, input.now);
        acknowledgedReport = true;
      }

      // ③ 事件落 `task_events`（唯一事实来源；kind 用白名单内的 `decision_made`，细节在 payload）
      let wroteTaskEvent = false;
      if (taskId != null) {
        insertTaskEvent(db, {
          taskId,
          ts: input.now,
          kind: 'decision_made',
          actor: 'boss',
          payload: { schemaId: input.schemaId, componentId: input.componentId, action: input.action, payload },
        });
        wroteTaskEvent = true;
      }

      return { humanMessageId: message.id, answeredApproval, acknowledgedReport, wroteTaskEvent };
    },

    answerApproval(input) {
      // 状态投影已在 DAO（ccdbf3c：联动 `reports.state='resolved'`，幂等）；此处只读回。
      const row = dbAnswerApproval(db, {
        approvalId: input.approvalId,
        chosen: input.chosen,
        decidedBy: input.decidedBy,
        now: input.now,
      });
      // G1 余项接线（共用处）：**任一批准入口**（`task:approve` / `inbox:answer` / 卡片动作）→ 发 grant。
      // 幂等：同 `(rule,toolName,sessionKey)` 重复批准只留一条；非批准类选项不动。
      //  P1：频道审批用 `approve_once`/`approve_project`（无 task_id → 项目级/会话级 grant）。
      if (isGrantingChoice(input.chosen)) {
        applyApprovalAsGrant(db, input.approvalId, { now: input.now ?? Date.now(), approvedBy: input.decidedBy });
      }
      return toApproval(row);
    },

    /**
     *  决定 8：按**这张**权限审批找到发起它的工作项。
     * 第三轮复核-3 发现：只按 toolName+rule 取「最近一条」会在同规则多卡时补错件。
     * 现在优先用审批问题里带的会话键（`…:wi:<id>`，发起请求时写进去的真相）直接定位件；
     * 会话键缺失/解析不出时才回落 toolName+rule 匹配。
     */
    permissionRequestWorkItem(approvalId: number): number | null {
      const row = dbGetApproval(db, approvalId);
      if (row == null || row.task_id == null) return null;
      const parsed = parsePermissionQuestion(row.question);
      if (parsed == null) return null;
      const belongs = (wiId: number): boolean =>
        db.prepare('SELECT id FROM work_items WHERE id = ? AND task_id = ?').get(wiId, row.task_id) != null;
      // 会话键形态：employee:<emp>:task:<tid>:wi:<workItemId>——取最后一段数字。
      const parts = (parsed.sessionKey ?? '').split(':');
      const tail = parts[parts.length - 2];
      const last = parts[parts.length - 1];
      if (tail === 'wi' && last != null && /^\d+$/.test(last)) {
        const wiId = Number(last);
        if (belongs(wiId)) return wiId;
      }
      // 引擎动作级权限卡（B-14 SEC-EGRESS-5，2026-11-09）：问题是
      // `[权限] <kind>（<actionKey>）`，而 actionKey 形如 `<kind>:<subjectKind>:<subjectId>:<rev>`
      // ——件归属本来就在里面（subjectKind==='work_item' 时第 3 段就是 workItemId），此前没解析。
      const actionParts = (parsed.rule ?? '').split(':');
      if (actionParts.length >= 3 && actionParts[1] === 'work_item') {
        const wiId = Number(actionParts[2]);
        if (Number.isInteger(wiId) && belongs(wiId)) return wiId;
      }
      const rows = db
        .prepare(
          "SELECT work_item_id, payload FROM task_events WHERE task_id = ? AND kind = 'permission_requested' ORDER BY id DESC LIMIT 50",
        )
        .all(row.task_id) as Array<{ work_item_id: number | null; payload: string }>;
      for (const e of rows) {
        let p: { toolName?: string; rule?: string | null } = {};
        try {
          p = JSON.parse(e.payload) as { toolName?: string; rule?: string | null };
        } catch {
          continue;
        }
        if (p.toolName === parsed.toolName && (p.rule ?? null) === (parsed.rule ?? null)) return e.work_item_id ?? null;
      }
      return null;
    },

    resolvePendingApprovalForTask(taskId, chosen, now) {
      const pending = dbLatestPendingApproval(db, taskId);
      if (!pending) return null;
      const row = dbAnswerApproval(db, {
        approvalId: pending.id,
        chosen,
        decidedBy: 'boss',
        now: now ?? Date.now(),
      });
      if (isGrantingChoice(chosen)) {
        applyApprovalAsGrant(db, pending.id, { now: now ?? Date.now(), approvedBy: 'boss' });
      }
      return toApproval(row);
    },

    mergeTaskChangeset(taskId, changesetId, now) {
      const repoRoot = projectRootForTask(db, taskId);
      if (!repoRoot) return { ok: false, code: 'not_found', message: '任务或所属项目不存在' };
      const branchRow = db
        .prepare('SELECT p.target_branch FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
        .get(taskId) as { target_branch: string | null } | undefined;
      return mergeChangeset({
        db,
        git: createGitRunner(),
        taskId,
        changesetId,
        repoRoot,
        targetBranch: branchRow?.target_branch ?? null,
        now: now ?? Date.now(),
      });
    },

    reworkMergeConflict(taskId, changesetId, now) {
      const task = getTaskById(db, taskId);
      if (!task) return { ok: false, code: 'not_found', message: '任务不存在' };
      const cs = getChangeset(db, changesetId);
      if (!cs || cs.task_id !== taskId) return { ok: false, code: 'not_found', message: '变更集不存在或不属于该任务' };
      // 冲突文件：取最近一次 task_merge 失败事件（真读数；没有就为空，不猜）。
      const last = db
        .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'action_failed' AND payload LIKE '%task_merge%' ORDER BY id DESC LIMIT 1")
        .get(taskId) as { payload: string } | undefined;
      let conflicts: string[] = [];
      if (last) {
        try {
          const payload = JSON.parse(last.payload) as { conflicts?: unknown };
          if (Array.isArray(payload.conflicts)) conflicts = payload.conflicts.filter((x): x is string => typeof x === 'string');
        } catch {
          conflicts = [];
        }
      }
      // 派回原员工：变更集的工作项执行者优先，其次原任务负责人；都没有 → 如实拒。
      const wi = cs.work_item_id != null ? getWorkItem(db, cs.work_item_id) : undefined;
      const employeeId = wi?.employee_id ?? task.owner_id ?? null;
      if (employeeId == null) {
        return { ok: false, code: 'no_employee', message: '找不到原执行员工（工作项/负责人均缺失）——请先指定负责人' };
      }
      const employee = getEmployeeById(db, employeeId);
      let acceptance: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(task.acceptance ?? '[]');
        if (Array.isArray(parsed)) acceptance = parsed;
      } catch {
        acceptance = [];
      }
      const short = task.short_id ?? `#${taskId}`;
      const files = conflicts.length > 0 ? conflicts.join('、') : '（未记录文件，重试合并可复现）';
      const branch = cs.branch ?? `aico/${short}`;
      const row = dbCreateTask(db, new SqliteCounterStore(db), {
        projectId: task.project_id,
        title: `修复合并冲突：${short}（${branch}）`,
        goal:
          `任务 ${short} 的变更集 ${branch} 合并回目标分支时冲突：${files}。` +
          '请在该分支上合并目标分支、解决冲突并提交，然后回到原任务详情点「重试合并」；不要改写无关文件。',
        acceptance,
        riskLevel: task.risk_level,
        ownerId: employeeId,
        origin: 'renew',
        parentTaskId: taskId,
        renewedFrom: taskId,
        now: now ?? Date.now(),
      });
      insertTaskEvent(db, {
        taskId,
        ts: now ?? Date.now(),
        kind: 'merge_conflict_rework',
        actor: 'boss',
        payload: { changesetId, reworkTaskId: row.id, employeeId, conflicts },
      });
      return {
        ok: true,
        taskId: row.id,
        shortId: row.short_id,
        employeeId,
        employeeName: employee?.name ?? null,
        conflicts,
      };
    },

    rollbackTaskChangeset(taskId, changesetId, scope, now) {
      const repoRoot = projectRootForTask(db, taskId);
      if (!repoRoot) return { ok: false, code: 'not_found', message: '任务或所属项目不存在' };
      return rollbackChangeset({
        db,
        git: createGitRunner(),
        taskId,
        changesetId,
        repoRoot,
        ...(scope ? { scope } : {}),
        now: now ?? Date.now(),
      });
    },

    discardTaskChangeset(taskId, changesetId, now) {
      return discardChangeset({ db, taskId, changesetId, now: now ?? Date.now() });
    },
  };
}
