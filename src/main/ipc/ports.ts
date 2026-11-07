// T0.5 主进程侧 DTO + 持久化端口。
// 端口实现见 repo.ts（**桥接实现**：优先复用 db DAO；缺的 3 张表用最小 SQL 兜底，
// 等 humanMessages/reports/approvals DAO 落地后替换 repo.ts 内部即可，ipc 层不变）。
import type { ResolverStore } from '../../core/resolver.js';
import type { EmployeeDTO, HallStateDTO } from './hall.js';
import type { EmployeeDetailDTO } from './employee.js';
import type { SkillRow, UpsertSkillInput } from '../db/skills.js';
import type { UpsertMcpServerInput } from '../db/mcp.js';
import type { DiscardChangesetResult, MergeChangesetResult, RollbackChangesetResult } from '../git/index.js';
import type { AssistantWriteMode } from '../permission/gate.js';

/**
 * GAP6：MCP server 的**渲染层视图**——`env` 明文绝不外传，只给 key 名（值由主进程在连接时注入）。
 */
export interface McpServerView {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  envKeys: string[];
  exposure: string;
  hasExternalActions: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface AttachmentMeta {
  name: string;
  size: number;
  type: string;
  /** 不透明文件令牌（D1）：由主进程 `file:import` 生成；**不是路径**。M0 可缺省。 */
  fileToken?: string;
}

export interface StoredMessage {
  id: number;
  direction: 'in' | 'out';
  taskId: number | null;
  content: string;
  attachments: AttachmentMeta[];
  createdAt: number;
}

export interface StoredReport {
  id: number;
  /** v8/BRK21：`null` = 全局卡（不属任何任务；UI 显示「全局」）。 */
  taskId: number | null;
  shortId: string | null;
  /** MP1-9：任务所属项目（全局卡/无任务 → null）；待办卡显示归属用。 */
  projectId: number | null;
  projectName: string | null;
  kind: string;
  state: string;
  createdAt: number;
  approvalId: number | null;
  /** RW-21：审批行 options 兜底（历史卡 payload 缺 options 时由此出按钮）；无/空 → null。 */
  approvalOptions: Array<{ key: string; label?: string }> | null;
  payload: Record<string, unknown>;
  /** GAP12：`reports.verdict` 真列（pass/fail/partial…）；无结论 → null。 */
  verdict: string | null;
  /** GAP12：独立验证者员工 id（`reports.verifier_employee_id`）。 */
  verifierEmployeeId: number | null;
}

export interface StoredApproval {
  id: number;
  taskId: number | null;
  reportId: number | null;
  question: string;
  options: unknown[];
  chosen: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface StoredTask {
  id: number;
  shortId: string | null;
  projectId: number;
  title: string;
  state: string;
  /** paused 来源（v15）：manual | task_budget | company_budget；NULL＝老行/未知。 */
  pauseReason: string | null;
  priority: number;
  riskLevel: number;
  createdAt: number;
  /** UI-2（任务行相对时间）：最近更新（epoch ms；`tasks.updated_at` 直读）。 */
  updatedAt: number;
  readySince: number | null;
  /** M2 尾：截止时刻（epoch ms；NULL＝未设；调度次级排序键）。 */
  deadline: number | null;
  acceptance: unknown[];
  /** BRK13（挂载 3）：预算/已耗/余额（未设预算 ⇒ `budgetTokens=null`、`budgetLeftTokens=null`；不写假 0）。 */
  budgetTokens: number | null;
  costTokens: number;
  budgetLeftTokens: number | null;
  /** 009（N5 余账）：任务级模型（指派链最高档）；NULL = 未指派（回落既有链）。 */
  model: string | null;
  /** `tasks.archived`（0/1）：归档＝**筛选开关**（非 state；M2-A 归档口径）。 */
  archived: number;
  /** 所属项目名（`task:list` 里 join 出来；**零新通道**，M2-A 项目分组）。 */
  projectName: string | null;
  /** 所属项目别名（可空）。 */
  projectAlias: string | null;
  /** 所属项目接入模式（`projects.access_mode`；`inplace` ⇒ 不产生变更集，M2-A 变更区块用）。 */
  projectAccessMode: string | null;
  /**
   * 执行员工（2026-10-16 左栏批）：**最新一件工作项**的负责人（`task:list` 面 join 出来，
   * 「零新通道」同项目名手法）。**只在本字段出现时承诺**——其余面（如 `task:get`）不带（缺省
   * `undefined`）；任务无件 ⇒ `null`（行内不渲染头像，不臆造）。
   */
  executor?: { id: number; name: string | null } | null;
}

/** `plan_steps` 行投影（T0.7「计划与验收」tab；进度条数据源）。 */
export interface StoredPlanStep {
  idx: number;
  text: string;
  state: string;
  workItemId: number | null;
  evidenceRef: string | null;
}

/** `task_events` 行投影（T0.7 时间线 / 行为日志）。`payload` 为解析后的 JSON。 */
export interface StoredTaskEvent {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  workItemId: number | null;
  payload: unknown;
}

/** `task:get` 详情（T0.7）：任务头 + 计划步骤 + 时间线；`behaviorLog` 由 ipc 从时间线筛 `kind='tool_call'`。 */
export interface StoredArtifact {
  id: number;
  kind: string;
  /** 展示名（取自 `path` 的 basename；**不读盘**，D1）。 */
  name: string;
  /** 相对路径；**仅展示**，渲染层不得据此读盘（D1）。 */
  path: string;
  sha256: string | null;
  /** 002 迁移加列；**列未到位时为 null**（不阻塞）。 */
  source: string | null;
  commit: string | null;
  workItemId: number | null;
  at: number | null;
  /** 来源面板（G-A 余项，2026-10-16）：引用副本的来源（`origin_project_id` → 项目名；自产为 null）。 */
  originArtifactId: number | null;
  originProjectId: number | null;
  originProjectName: string | null;
}

/** G-A（007）：引用动作的**源侧最小面**（比 `StoredArtifact` 少展示字段，多「属于哪个任务」）。 */
export interface StoredArtifactRef {
  id: number;
  /** 源产物所属任务（引用要从它取源项目根）。 */
  taskId: number;
  path: string;
  kind: string;
  /** 源**记录**的指纹（实读字节会重算；不一致由 handler 在 note 标注）。 */
  sha256: string | null;
  /** M2 尾：`link:<originProjectId>` 时为链接（读时按源项目根解析）；NULL＝普通副本/自产。 */
  source: string | null;
  /** M2 尾：源项目 id（链接解析用；副本也有 007 来源列）。 */
  originProjectId: number | null;
}

/** GAP12：评审/验证结论（timeline 事件 × `reports.verdict` 的只读投影，供任务详情上屏）。 */
export interface StoredReview {
  eventId: number;
  ts: number;
  stage: 'plan' | 'verification';
  actor: string;
  role: string | null;
  verdict: string | null;
  notes: string | null;
  workItemId: number | null;
  reportId: number | null;
  verifierEmployeeId: number | null;
}

export interface StoredTaskModelResolution {
  model: string;
  source: string;
  /** assistant 选型理由。 */
  reason?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  rejected?: string;
}

export interface StoredTaskDetail {
  task: StoredTask & { goal: string; updatedAt: number };
  /** UG-01：负责人（建单/编制给的；与执行员工分开；未设置 → null）。 */
  owner: { id: number; name: string } | null;
  /** UG-01：前置任务（调度器真值；空数组＝无依赖）。 */
  dependsOn: Array<{ id: number; shortId: string | null; title: string; state: string }>;
  /** D-22：任务头「预计模型＋来源」（执行员工视角；不冒充会话实况）。 */
  modelResolution: StoredTaskModelResolution;
  progress: { done: number; total: number };
  planSteps: StoredPlanStep[];
  timeline: StoredTaskEvent[];
  /** GAP12：critic/verifier 结论（按事件顺序；空数组＝无评审结论）。 */
  reviews: StoredReview[];
  /** GAP12：验证中「被打回的那件」＝最近一个 submitted 工作项；手动打回未带 id 时由服务端补全。 */
  verificationWorkItemId: number | null;
  /** BRK17（挂载 3 余·取消小步）：工作项按状态计数（`running`/`queued`/`submitted`…；空对象＝无件）。 */
  workItemCounts: Record<string, number>;
  /** OPT-M8-1：任务产物元信息（按 id 升序；空数组 = 本任务无产物）。 */
  artifacts: StoredArtifact[];
  /** OPT-AI-1：原始交流派生投影（只读；空数组 = 无）。 */
  rawConversation: import('../agent/raw-conversation.js').RawItem[];
  /** M2-A：本任务变更集（含文件明细；`staging` 才有；空数组 = 无）。 */
  changesets: StoredChangeset[];
  /** CTX1-2：最近 N 轮上下文遥测（新的在前；空数组 = 还没有任何会话遥测）。 */
  contextMetrics: import('../db/context_metrics.js').ContextMetricRow[];
}

/** R2-3 · `project:list/get` 的 DTO（camelCase；JSON 列解析后为数组）。 */
export interface ProjectDTO {
  id: number;
  name: string;
  alias: string | null;
  rootDir: string;
  attention: string;
  accessMode: string;
  defaultEmployeeIds: number[];
  /** 编制（D-11）：默认负责人（`null`＝未设置 → 缺省链兜底）。 */
  defaultOwnerId: number | null;
  /** 编制（D-11）：默认档 0/1/2（`null`＝未设置 → 建任务 db 缺省 1）。 */
  defaultRiskTier: number | null;
  /** D-19 P1：项目级频道助手写权限（read-only/confirm/auto；未设＝confirm）。 */
  assistantWriteMode: AssistantWriteMode;
  /** M3-DOC-4：项目级文档检查开关（默认 true；false＝任务不自动挂文档检查/已有检查记未检查）。 */
  docsCheckEnabled: boolean;
  defaultSkills: string[];
  allowedProviders: string[];
  /** D-22：项目默认模型（NULL＝未设置）。 */
  defaultModel: string | null;
  /** D-22：模型级允许清单（空数组＝不额外限制）。 */
  allowedModels: string[];
  /** v19：新任务默认 token 预算（null＝不限；任务显式预算优先）。 */
  defaultBudgetTokens: number | null;
  /** S13-G/D-N06：合并目标分支（null＝沿用 main/master）。 */
  targetBranch: string | null;
  /** D-22：fixed | employee_first | assistant（assistant 写侧暂拒）。 */
  modelPolicy: 'fixed' | 'employee_first' | 'assistant';
  /** 0/1：归档＝软操作（不搬动文件夹）。 */
  archived: number;
  archivedAt: number | null;
  createdAt: number;
}

/** M2-A 变更集（详情面 DTO；camelCase）。 */
export interface StoredChangeset {
  id: number;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
  state: string;
  createdAt: number;
  files: Array<{
    path: string;
    status: string;
    insertions: number;
    deletions: number;
    employeeId: number | null;
    /** UG-06：产出员工的显示名（查无 → null；不臆造）。 */
    employeeName?: string | null;
  }>;
}

// ── M1 · GenUI 卡片意图（`UI §4.7`）─────────────────────────────────────
export interface CardIntentInput {
  schemaId: string;
  componentId: string;
  action: string;
  payload: Record<string, unknown>;
  now: number;
}
/** 意图回写结果：`human_messages(in)` 必落；审批/已阅/事件按 action 与 payload 决定。 */
export interface CardIntentResult {
  humanMessageId: number;
  answeredApproval: boolean;
  acknowledgedReport: boolean;
  wroteTaskEvent: boolean;
}

/** `chat:send` / `chat:list` / `inbox:*` / `task:approve` 需要的持久化能力。 */
/** N1：成本聚合返回体的共享形状（`cost:summary` 全局与任务级共用）。 */
export interface CostSummaryLike {
  costRows: number;
  tokens: number;
  usd: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 分母 0 ⇒ null（不写假 0）。 */
  cacheHitRate: number | null;
  /** 最近 1 小时美元额。 */
  usdPerHour: number;
  /** GAP10（挂载 3）：按员工归因（null=公司级/无归属）。 */
  byEmployee: Array<{ employeeId: number | null; name: string | null; usd: number; tokensIn: number; tokensOut: number }>;
}

export interface ChatRepo {
  insertMessage(input: {
    direction: 'in' | 'out';
    taskId?: number | null;
    content: string;
    attachments?: AttachmentMeta[];
    now?: number;
  }): StoredMessage;
  listMessages(opts?: { taskId?: number; limit?: number; latest?: boolean }): StoredMessage[];
  listReports(opts?: { taskId?: number; state?: string; kind?: string; limit?: number; latest?: boolean }): StoredReport[];
  acknowledgeReport(reportId: number, now?: number): StoredReport | null;
  getApproval(approvalId: number): StoredApproval | null;
  answerApproval(input: {
    approvalId: number;
    chosen: string;
    decidedBy: 'boss' | 'timeout';
    now?: number;
  }): StoredApproval | null;
  /** 详情操作条直接推进任务（`task:transition`）时，把该任务最新未决审批卡一并作答（防卡/托盘读数悬挂）。 */
  resolvePendingApprovalForTask(taskId: number, chosen: string, now?: number): StoredApproval | null;
  /** M3-P-4 / BRK16-b：把一个 changeset 合并到项目主分支（真值表/幂等/冲突清单由实现返回）。 */
  mergeTaskChangeset(taskId: number, changesetId: number, now?: number): MergeChangesetResult;
  /** M3-N-2 / GAP4：把一个 changeset 回滚到其工作项检查点（只动该次提交改过的文件）。 */
  rollbackTaskChangeset(
    taskId: number,
    changesetId: number,
    scope?: string,
    now?: number,
  ): RollbackChangesetResult;
  /** B-2：丢弃一个 changeset（只改台账；主分支/其他工作项不动；幂等）。 */
  discardTaskChangeset(taskId: number, changesetId: number, now?: number): DiscardChangesetResult;
  /** T0.6：手工建任务（落 `inbox`，与短号同流程）；R3-1：`riskLevel` 可显式选档；BRK13：`budgetTokens` 可带预算；009：`model` 可带任务级模型；D-11：`ownerId` 可带负责人（缺省链③位；编制缺省来自 handler）；M2 尾：`deadline`／`dependsOn`（D4 写入面）。 */
  createTask(input: { projectId?: number; title: string; goal: string; acceptance?: unknown[]; riskLevel?: number; ownerId?: number; budgetTokens?: number; model?: string | null; deadline?: number | null; dependsOn?: number[]; origin?: string }): StoredTask;
  /** D4：加一条任务依赖（存在性＋判环＋审计；幂等）。 */
  addTaskDependency(input: { taskId: number; dependsOn: number; actor?: string; now?: number }): { ok: boolean; added: boolean; code?: string; message?: string };
  /** D4：移除一条任务依赖（幂等＋审计）。 */
  removeTaskDependency(input: { taskId: number; dependsOn: number; actor?: string; now?: number }): { ok: boolean; added: boolean; code?: string; message?: string };
  /** 2026-10-29 P2（D-N07）：合并冲突派回原员工——建续办任务（同一员工）并返回新任务。 */
  reworkMergeConflict(taskId: number, changesetId: number, now?: number):
    | { ok: true; taskId: number; shortId: string | null; employeeId: number; employeeName: string | null; conflicts: string[] }
    | { ok: false; code: string; message: string };
  /** BRK13（挂载 3）：写任务预算（唯一写入口之一；`加预算` 命令走它）。 */
  setTaskBudget(taskId: number, budgetTokens: number, now?: number): StoredTask | null;
  /** 009（N5 余账）：写任务级模型（`模型 T1042 <model>` 命令走它；`null` = 清除回既有链）。 */
  setTaskModel(taskId: number, model: string | null, now?: number): StoredTask | null;
  listTasks(filter?: { state?: string; projectId?: number; includeArchived?: boolean; since?: number; limit?: number }): StoredTask[];
  /** `OPT-EXT-13` 用量可视：成本聚合（`cost:summary`）；N1 追加缓存计量与 $/h 速率。 */
  costSummary(since?: number): CostSummaryLike;
  /** `OPT-EXT-13` 成本 tab：单任务成本汇总 + 按模型拆分；N1 同上。 */
  taskCosts(taskId: number): CostSummaryLike & { byModel: Array<{ model: string; tokensIn: number; tokensOut: number; usd: number }> };
  getTask(id: number): StoredTask | null;
  /** M1-3：任务下的工作项 id（用于把引擎 dispatch hold 过滤到本任务）。 */
  listWorkItemIds(taskId: number): number[];
  /** M1-3：工作项所属任务的短号（`conflictsWith` → `@T-xxxx` 文案用）。 */
  getWorkItemShortId(workItemId: number): string | null;
  /** BRK9（挂载 2）：按短号查任务（`#T1042 要说的话` 插话直通用；查无 → null ⇒ 落回常规路径）。 */
  findTaskByShortId(shortId: string): StoredTask | null;
  /** BRK9：任务下**正在跑**的会话所属工作项（无 → null ⇒ 插话如实回执「不在跑」）。 */
  findRunningWorkItem(taskId: number): { id: number; employeeId: number } | null;
  /** R2-3：`project:list/get`（默认过滤归档；DTO 见 `ProjectDTO`）。 */
  listProjects(opts?: { includeArchived?: boolean }): ProjectDTO[];
  getProject(id: number): ProjectDTO | null;
  /** R2-3：`project:archive`（软归档，幂等；不存在 → null）。 */
  archiveProject(id: number, now: number): ProjectDTO | null;
  /** 撤销软归档（同通道 `{archived:false}`；幂等）。 */
  restoreProject(id: number): ProjectDTO | null;
  /** CR14：只删已归档且无任务的项目行（文件夹不动；非空显式拒）。 */
  deleteProjectIfEmpty(id: number): { ok: true } | { ok: false; code: 'not_found' | 'not_archived' | 'not_empty' };
  /**
   * 编制 v1（D-11）：写项目三项缺省（`project:staffing-set`）。字段**缺省＝不改动**、显式 `null`＝清空；
   * 校验（员工存在且在职 / 档位 0..2）在 `db/projects.ts#setProjectStaffing`——非法拒且不落库。
   */
  projectStaffingSet(input: {
    projectId: number;
    ownerEmployeeId?: number | null;
    defaultEmployeeId?: number | null;
    defaultRiskTier?: number | null;
  }): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string };
  /** M3-DOC-4：项目级文档检查开关（不存在 → null）。 */
  projectDocsCheckSet(input: { projectId: number; enabled: boolean }): ProjectDTO | null;
  /** D-19 P1：项目级频道助手写权限（不存在 → null）。 */
  projectAssistantWriteModeSet(input: { projectId: number; mode: AssistantWriteMode }): ProjectDTO | null;
  /** B3（M3-N-3）：写项目默认技能集（refs 必须先全部解析为启用中的技能；否则拒且不落库）。 */
  projectDefaultSkillsSet(input: {
    projectId: number;
    refs: string[];
  }): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string };
  /** D-22：写项目模型策略（三字段整体；校验在 core，非法拒且不落库）。 */
  projectModelPolicySet(input: {
    projectId: number;
    policy: unknown;
    defaultModel: unknown;
    allowedModels: unknown;
  }): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string };
  projectDefaultBudgetSet(input: {
    projectId: number;
    budgetTokens: unknown;
  }): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string };
  /** S13-G/D-N06：合并目标分支（空串/null ⇒ 清空，回到 main/master）。 */
  projectTargetBranchSet(input: {
    projectId: number;
    branch: string | null;
  }): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string };
  /** 编制 v1（D-11）：建任务缺省（已过在职校验收口；项目不存在 → null）。 */
  projectStaffing(projectId: number): { ownerEmployeeId: number | null; defaultEmployeeId: number | null; defaultRiskTier: number | null } | null;
  /** M2 尾（G-D）：跨项目全局搜索（任务/消息/产物；只读，限条数）。 */
  globalSearch(query: string): GlobalSearchDTO;
  /** OPT-AI-9：技能库（只读列表 / 注册或更新）。 */
  listSkills(includeDisabled?: boolean): SkillRow[];
  upsertSkill(input: UpsertSkillInput): SkillRow;
  /** GAP7：启停（内置也可停用）。 */
  setSkillEnabled(id: number, enabled: boolean): SkillRow | null;
  /** GAP7：删除（内置/被引用 → 显式拒；文件清理由 IPC 层做受管路径校验）。 */
  removeSkill(id: number): { ok: true; skill: SkillRow } | { ok: false; code: string; message: string };
  /** OPT-AI-10/GAP6：MCP server 库（只读列表 / 注册更新；env 只回 key 名）。 */
  listMcpServers(includeDisabled?: boolean): McpServerView[];
  upsertMcpServer(input: UpsertMcpServerInput): McpServerView;
  /** GAP6：启停 MCP server（被员工引用的停用后该员工看不到它）。 */
  setMcpServerEnabled(id: number, enabled: boolean): McpServerView | null;
  /** GAP6：删除 MCP server（被员工引用 → 拒，先取消分配）。 */
  removeMcpServer(id: number): { ok: true; server: McpServerView } | { ok: false; code: string; message: string };
  /** OPT-M4-1 产品化：接缝矩阵行（按项目；未登记 → 空）。 */
  seamRows(projectId?: number): Array<{
    boundary: string;
    status: string;
    coverageRef: string | null;
    owner: string | null;
    milestone: string | null;
  }>;
  /** R2-4：`project:attach`（关联已有文件夹：**只记录路径，不搬动目录**）。 */
  createProject(input: { name: string; rootDir: string; accessMode: string; alias?: string | null; now: number }): ProjectDTO;
  /** 别名占用查询（含归档项目；null＝未占用）。 */
  projectIdByAlias(alias: string): number | null;
  /** 设置/清空项目别名（唯一性由 IPC 前置校验）。 */
  projectAliasSet(input: { projectId: number; alias: string | null }): ProjectDTO | null;
  /**
   * G-A（M2 §7 序 3，迁移 007）：按 id 取产物（**引用动作**读源侧；不存在 → `null`，不臆造）。
   * 返回最小面（引用只需 id/所属任务/相对路径/kind/记录指纹）。
   */
  getArtifact(id: number): StoredArtifactRef | null;
  /**
   * G-A：**登记一次引用**（原子：目标任务新产物行〔截 007 来源两列〕＋ `task_events.artifact_referenced` 审计）。
   * 幂等键＝`(work_item_id=NULL, path)`（同一源产物重复引用 → 同路径命中，`created=false`，不重复插卡）。
   */
  recordArtifactReference(input: {
    targetTaskId: number;
    /** 目标侧相对路径（`refs/…`；link 模式＝源相对路径）。 */
    path: string;
    kind: string;
    note: string;
    sha256: string | null;
    originArtifactId: number;
    originProjectId: number;
    originTaskId: number;
    /** M2 尾：`copy`（缺省）或 `link`（源随动；读时按源项目根解析）。 */
    mode?: 'copy' | 'link';
    /** `link:<originProjectId>`（链接标记；副本为 null）。 */
    source?: string | null;
    now: number;
  }): { artifactId: number; created: boolean };
  /** R2-3：`settings:get/set`（白名单与 secret 掩码由 ipc 层把关；未设值 → `undefined`）。 */
  getSetting(key: string): unknown;
  setSetting(input: { key: string; value: unknown }): void;
  /** M1 公司大厅：员工列表。 */
  listEmployees(): EmployeeDTO[];
  /** UG-11：设置花名册（**含已停用**，`active` 真值；否则停用后 UI 无重新启用入口）。 */
  listRosterEmployees(): EmployeeDTO[];
  /** D-5 补位 ①：员工工位页数据（`employee:get`；不存在 → `null`）。 */
  employeeDetail(id: number): EmployeeDetailDTO | null;
  /** M2 尾：招募一名员工（写库＋回读详情；白名单/枚举校验在 IPC 层）。 */
  recruitEmployee(input: {
    name: string;
    role: string;
    persona?: string;
    model?: string | null;
    thinking?: string | null;
    skills?: Array<string | number>;
    mcps?: Array<string | number>;
    capabilityTier?: string;
  }): EmployeeDetailDTO | null;
  /** M2 尾：改员工档案（人设/模型/思考强度/技能/MCP/能力档/停用；DAO 校验拒且不落库）。 */
  updateEmployee(input: {
    employeeId: number;
    name?: string;
    role?: string;
    persona?: string;
    model?: string | null;
    thinking?: string | null;
    skills?: Array<string | number>;
    mcps?: Array<string | number>;
    capabilityTier?: string;
    active?: boolean;
  }): { ok: true; employee: EmployeeDetailDTO | null } | { ok: false; code: string; message: string };
  /** M1 公司大厅：整块状态（员工 + 部门 + 真实协作流）。 */
  hallState(): HallStateDTO;
  /** T0.7：任务详情（头 + 计划步骤 + 时间线全量）。 */
  getTaskDetail(id: number): StoredTaskDetail | null;
  /** M1：GenUI 卡片意图回写（落 `human_messages(in)` + 按需 `task_events`/审批/已阅）。 */
  recordCardIntent(input: CardIntentInput): CardIntentResult;
  /** R2-2（G7）：未结的同事提问（「待我处理」面列出；老板可代答）。 */
  listOpenAsks(): MailboxAskDTO[];
  /** R2-2（G7）：老板代答一条提问（`via='boss'` 如实入 actor/payload；孤儿答复抛 `E_ASK_NOT_FOUND`）。 */
  answerAskAsBoss(input: { askDedupeKey: string; answer: string; now: number }): { delivered: boolean };
  readonly resolverStore: ResolverStore;
}

/** R2-2（G7）：未结提问的只读 DTO（`mailbox:list` 返回形状）。 */
export interface MailboxAskDTO {
  askDedupeKey: string;
  taskId: number;
  workItemId: number | null;
  /** 提问者（员工 id）。 */
  from: number;
  /** 被问者（员工 id）。 */
  to: number;
  question: string;
  /** 阻塞式（作答后宿主把件从 blocked 回队）。 */
  blocking?: boolean;
  at: number;
}

/** M2 尾（G-D）：跨项目全局搜索结果（只读；各组限条数，查询为空 → 空）。 */
export interface GlobalSearchDTO {
  query: string;
  tasks: Array<{ id: number; shortId: string | null; title: string; projectId: number; projectName: string | null }>;
  messages: Array<{ id: number; taskId: number | null; content: string; projectName: string | null }>;
  artifacts: Array<{ id: number; taskId: number; path: string; projectName: string | null }>;
  total: number;
}
