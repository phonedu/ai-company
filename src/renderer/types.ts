// 渲染层 DTO（与主进程 IPC 返回结构一致；形状以 DEV §7.3 为准）。
// 附件只带元信息、**不带路径**（D1 铁律）。
import type { TaskWaitDTO } from './components/waitingReason.js';

export interface AttachmentDTO {
  name: string;
  size: number;
  type: string;
  /** 不透明文件令牌（D1）：非路径。M0 可缺省。 */
  fileToken?: string;
}

export interface ResolutionDTO {
  kind: string;
  taskId?: number;
  via?: string;
  [key: string]: unknown;
}

export interface HumanMessageDTO {
  id: number;
  direction: 'in' | 'out';
  taskId: number | null;
  content: string;
  attachments: AttachmentDTO[];
  createdAt: number;
  resolution?: ResolutionDTO;
}

export type ReportKind = 'report' | 'ask' | 'alert' | 'notification';

/** M3-REM-1c：服务端未读游标读数（`inbox:read-state` / `inbox:read-mark`）。 */
export interface ReadStateDTO {
  principal: string;
  surface: string;
  lastItemId: number;
  lastReadAt: number | null;
  unread: number | null;
  unreadState: 'exact' | 'unknown';
  reason?: string;
  asOfId: number;
}

export interface CardOptionDTO {
  key: string;
  label: string;
  recommended?: boolean;
}

/** 卡片（由 `reports` 行投影；`kind` 决定版式，`state` 决定可操作性）。 */
export interface ReportDTO {
  id: number;
  /** v8/BRK21：`null` = 全局卡（不属任何任务；UI 显示「全局」）。 */
  taskId: number | null;
  shortId?: string | null;
  /** MP1-9：任务所属项目（全局卡/无任务 → null/缺省）。 */
  projectId?: number | null;
  projectName?: string | null;
  kind: ReportKind;
  state: string;
  createdAt: number;
  approvalId?: number | null;
  /** RW-21：审批行 options 兜底（卡 payload 缺 options 的历史卡由此出按钮）；无/空 → null/缺省。 */
  approvalOptions?: Array<{ key: string; label?: string }> | null;
  /** GAP12：`reports.verdict` 真列（pass/fail/partial…）；无结论 → null/缺省。 */
  verdict?: string | null;
  /** GAP12：独立验证者员工 id（`reports.verifier_employee_id`）。 */
  verifierEmployeeId?: number | null;
  payload: {
    title?: string;
    /** 卡片版式（approval/decision/permission/report/alert）；缺省按 kind 推断。 */
    card?: string;
    tldr?: string;
    question?: string;
    /** GAP12：评审/验证文字批注（critic/verifier/manual reject）。 */
    notes?: string;
    /** D-22：模型/Key 硬拒的人话原因（决策卡卡面直接展示）。 */
    modelRejected?: string;
    /** GAP12：结论来源角色（critic/verifier）。 */
    role?: string;
    /** GAP12：结论（`reports.verdict` 缺省时的事件/payload 兜底）。 */
    verdict?: string;
    options?: CardOptionDTO[];
    /** 多选＋自定义作答（老板 2026-10-28 指令）：'multi'＝选项可勾选、统一提交（chosen=k1+k2）；缺省＝单选即点。 */
    selection?: string;
    /** 权限卡结构化读法（卡片可读性批）：who/action/project 三行人话＋折叠 session；缺省回落 question 原串。 */
    permissionDetail?: { who: string; action: string; project: string; session?: string | null };
    defaultAction?: string | null;
    timeoutAt?: number | null;
    summary?: string;
    /** E-16：卡正文（多行 Markdown 纯文本；招募卡的人设/模型/技能等）。频道卡与收件行都渲染；缺省不渲染。 */
    body?: string;
    /** GAP8：计划批准卡携带的计划全文（编辑后随 `task:edit-plan` 同步刷新）。 */
    planSteps?: string[];
    /** 日报（notification）的结构化摘要；缺省/空 → 不渲染读数行。 */
    digest?: {
      completedShortIds?: string[];
      failedCount?: number;
      cancelledCount?: number;
      employeeCount?: number;
      /** 无成本行 ⇒ null（渲染 `—`，不写假 0）。 */
      usd?: number | null;
      pendingCards?: number;
    };
    /** M1（`UI §4.7`）：GenUI 受控卡片 schema；缺省 → legacy 渲染。 */
    schema?: unknown;
  };
}

/** 频道流的一条：人类消息或卡片。 */
export type ChannelItem =
  | { kind: 'message'; at: number; message: HumanMessageDTO }
  | { kind: 'card'; at: number; card: ReportDTO };

/** `OPT-EXT-13` 用量可视：成本聚合（`cost:summary` 返回）。 */
export interface CostSummaryDTO {
  /** 计入的成本行数（**0 ⇒ 顶栏显 `—`，不写假 0**）。 */
  costRows: number;
  tokens: number;
  usd: number;
  /** N1：缓存计量与速率（`cacheHitRate` 分母 0 ⇒ `null`；`usdPerHour` ＝最近 1 小时）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number | null;
  usdPerHour?: number;
  /** 成本 tab：按模型拆分（**任务级查询才有**；全局/今日无此字段）。 */
  byModel?: ReadonlyArray<{ model: string; tokensIn: number; tokensOut: number; usd: number }>;
}

/** 任务（左栏分组用，形状 = IPC `task:list` 返回）。 */
export interface TaskDTO {
  id: number;
  shortId: string | null;
  projectId: number;
  title: string;
  state: string;
  /** paused 来源（v15）：manual | task_budget | company_budget；NULL＝老行/未知。 */
  pauseReason?: string | null;
  priority: number;
  riskLevel: number;
  createdAt: number;
  readySince: number | null;
  /** M2 尾：截止时刻（epoch ms；未设 ⇒ null）。 */
  deadline?: number | null;
  acceptance: unknown[];
  /** BRK13（挂载 3）：预算/已耗/余额（未设 ⇒ null；任务头与成本面板显示用）。 */
  budgetTokens?: number | null;
  costTokens?: number;
  budgetLeftTokens?: number | null;
  /** `tasks.archived`（0/1）：归档＝**筛选开关**（非 state；M2-A 归档口径）。 */
  archived: number;
  /** 所属项目名/别名（`task:list` join 出来；M2-A 项目分组/概览）。 */
  projectName: string | null;
  projectAlias: string | null;
  /** 所属项目接入模式（`inplace` ⇒ 不产生变更集）。 */
  projectAccessMode: string | null;
  /** M1-3（`PLAN §10 第 4 条`）：当前等待原因（空/缺省 = 不等待）。数据来自引擎 hold，渲染层**不得推断**。 */
  waits?: TaskWaitDTO[];
  /** 执行员工（2026-10-16 左栏批；`task:list` 面 join：**最新一件**工作项的负责人）。无件 ⇒ null。 */
  executor?: { id: number; name: string | null } | null;
}

// ── 公司大厅（简单版，B0/B1；`docs/work/spec-company-layout.md`）────────────
// 老板口径：**轻量部门**（零迁移配置）、**不显示负责人**、**协作只呈现真实流向 + 真实次数**。

// ── R2-3：项目 DTO（`project:list/get/archive`；与主进程 `ports.ts` 的 `ProjectDTO` 同形）──

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
  assistantWriteMode: 'read-only' | 'confirm' | 'auto';
  /** M3-DOC-4：项目级文档检查开关（默认 true）。 */
  docsCheckEnabled: boolean;
  defaultSkills: string[];
  allowedProviders: string[];
  /** D-22：项目默认模型（null＝未设置）。 */
  defaultModel: string | null;
  /** D-22：模型级允许清单（空数组＝不额外限制）。 */
  allowedModels: string[];
  /** D-22：fixed | employee_first | assistant（assistant 写侧暂拒）。 */
  modelPolicy: 'fixed' | 'employee_first' | 'assistant';
  /** v19：新任务默认 token 预算（null＝不限）。 */
  defaultBudgetTokens: number | null;
  /** S13-G/D-N06：合并目标分支（null＝沿用 main/master）。 */
  targetBranch: string | null;
  archived: number;
  archivedAt: number | null;
  createdAt: number;
}

/** B-1：项目概览·定时（与主进程 `TriggerView` 同形；`nextDueAt=null`＝事件触发等源任务完成）。 */
export interface TriggerDTO {
  id: number;
  kind: 'cron' | 'event';
  name: string;
  nextDueAt: number | null;
  projectId: number;
  title: string;
  goal: string;
  intervalMinutes: number | null;
  dailyMinute: number | null;
  sourceTaskId: number | null;
  eventKind: string | null;
  lastFiredAt: number | null;
  lastTaskId: number | null;
}

/** B-6：记忆 `P1b`（与主进程 `MemoryItem` 同形；JSON 往返用）。 */
export type MemoryScopeDTO = { type: 'global' } | { type: 'project'; projectId: number };

export interface MemoryItemDTO {
  id: number;
  scope: MemoryScopeDTO;
  kind: 'fact' | 'decision' | 'preference' | 'glossary' | 'constraint';
  key: string | null;
  value: string;
  source: { type: string; ref?: string | null; excerpt?: string | null; at?: number };
  confidence: 'confirmed' | 'provisional' | 'inferred';
  status: 'active' | 'superseded' | 'archived';
  pinned: boolean;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastVerifiedAt: number | null;
  supersededBy: number | null;
}

export interface MemoryHitDTO {
  item: MemoryItemDTO;
  score: number;
  snippet: string;
}

export interface MemoryAuditDTO {
  scope: MemoryScopeDTO | null;
  total: number;
  active: number;
  duplicates: MemoryItemDTO[];
  conflicts: MemoryItemDTO[];
  stale: MemoryItemDTO[];
  oversize: MemoryItemDTO[];
  missingSource: MemoryItemDTO[];
  tokens: number;
}

export interface EmployeeDTO {
  id: number;
  name: string;
  /** 自由文本角色（`employees.role`）。 */
  role: string;
  avatar?: string | null;
  /** 幕僚长（0 号）也在墙上（`UI §6.1`）。 */
  isAssistant?: boolean;
  active?: boolean;
  /** GAP6：MCP 分配 refs（设置·MCP 分配矩阵只读）。 */
  mcpRefs?: readonly string[];
  /** 2026-10-16（大厅批）：员工卡读数（主进程聚合）；缺省 ⇒ 按无数据渲染（不臆造动作）。 */
  activity?: {
    status: 'running' | 'waiting' | 'idle' | 'stuck';
    currentAction: string | null;
    taskShortId: string | null;
    /** 当前/上一件任务 id（可点进任务详情；缺省 ⇒ 不可点）。 */
    taskId?: number | null;
    /** 当前件已运行分钟数（running/waiting 才有；其余 0/缺省）。 */
    currentMinutes?: number;
    todayOutput: number;
    todayMinutes: number;
    /** 今日登记产物数（0 是有源的 0；缺省 ⇒ 不显示该读数）。 */
    todayArtifacts?: number;
  };
}

// ── D-5 补位 ①：员工工位页（`employee:get`；与主进程 `ipc/employee.ts` 的 DTO 同形）──────

export interface EmployeeRefItem {
  /** 原样保留 `employees.skills|mcps` JSON 里的条目（id/名字），名字解析不到 → null（如实）。 */
  id: string;
  name: string | null;
}

export interface EmployeeMemoryBlock {
  projectId: number;
  /** `project_id=0`（通用分区）无 projects 行 → null（UI 显「通用记忆」）。 */
  projectName: string | null;
  memory: string;
  updatedAt: number;
}

export interface EmployeeWorkItemRef {
  workItemId: number;
  taskId: number;
  taskShortId: string | null;
  taskTitle: string;
  state: string;
}

export interface EmployeeRecentTask {
  id: number;
  shortId: string | null;
  title: string;
  state: string;
  updatedAt: number;
}

export interface McpServerDTO {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  /** 只给环境变量名；值绝不进 renderer。 */
  envKeys: readonly string[];
  exposure: string;
  hasExternalActions: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface SkillDTO {
  id: number;
  name: string;
  description: string;
  source: string;
  path: string;
  version: string | null;
  enabled: number;
}

export interface EmployeeDetailDTO {
  employee: {
    id: number;
    name: string;
    role: string;
    avatar: string | null;
    persona: string;
    /** `NULL` = 跟随全局默认（UI 显「跟随全局默认」）。 */
    model: string | null;
    thinking: string | null;
    skills: EmployeeRefItem[];
    mcps: EmployeeRefItem[];
    capabilityTier: string;
    isAssistant: boolean;
    active: boolean;
    createdAt: number;
  };
  memory: EmployeeMemoryBlock[];
  currentWork: EmployeeWorkItemRef[];
  recentTasks: EmployeeRecentTask[];
  cost: { usd: number | null; tokensIn: number; tokensOut: number; rows: number };
}

export interface DepartmentDTO {
  id: string;
  name: string;
  /** 预留，**MVP 不显示**（老板口径）。 */
  leadEmployeeId?: number | null;
  memberIds: number[];
}

/** 部门间协作（**只放真实发生的**；没往来不出边，`UI §6` 底线）。 */
export interface CollabEdgeDTO {
  /** 部门 id（`DepartmentDTO.id`）。 */
  from: string;
  to: string;
  /** 近 `windowDays` 天真实次数。 */
  count: number;
  /** 可选：按动作拆分（`assign`/`ask`/`review`/`deliver` …）。 */
  kinds?: Record<string, number>;
}

/** 大厅实时活动流的一条（`task_events` 只读投影）。 */
export interface HallActivityDTO {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  actorName: string;
  taskId: number;
  taskShortId: string | null;
  taskTitle: string | null;
  text: string;
  detail: string | null;
  tone: 'ok' | 'warn' | 'danger' | 'dim';
}

export interface HallStateDTO {
  employees: EmployeeDTO[];
  departments: DepartmentDTO[];
  collab: CollabEdgeDTO[];
  /** 最近公司活动流（缺省/空 ⇒ 显式空态，不造动态）。 */
  activityLog?: HallActivityDTO[];
  /** `collab.count` 的统计窗口（如 7），用于「近 7 天」文案。 */
  windowDays?: number;
}

/** R2-2（G7）：未结的同事提问（`mailbox:list` 返回；「待我处理」面列出、老板可代答）。 */
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

/** M2 尾（G-D）：跨项目全局搜索结果（只读；各组 ≤6）。 */
export interface GlobalSearchDTO {
  query: string;
  tasks: Array<{ id: number; shortId: string | null; title: string; projectId: number; projectName: string | null }>;
  messages: Array<{ id: number; taskId: number | null; content: string; projectName: string | null }>;
  artifacts: Array<{ id: number; taskId: number; path: string; projectName: string | null }>;
  total: number;
}

/** M3：IM 通道状态（`im:bind {action:'status'}` 返回；本轮只做微信 1:1）。 */
export interface ImStatusView {
  channel: 'im:wechat';
  state: 'disabled' | 'login_required' | 'login_pending' | 'connecting' | 'connected' | 'error';
  qr: string | null;
  qrStatus: string | null;
  ownerId: string | null;
  accountId: string | null;
  lastError: string | null;
  pendingOutbox: number;
}

/** 设置·模型与供应商：本机 Key 状态（只含掩码/来源，**不含明文**）。 */
export interface ProviderStatusDTO {
  provider: string;
  label: string;
  configured: boolean;
  source: 'env' | 'file' | null;
  masked: string | null;
  envConfigured: boolean;
  fileConfigured: boolean;
}

/** D-22 配套：模型目录条目（只读；价格 USD/1M tokens；Key 只回来源）。 */
export interface ProviderCatalogEntryDTO {
  provider: string;
  providerLabel: string;
  modelCount: number;
  keyConfigured: boolean;
  keySource: 'env' | 'file' | null;
}

export interface ModelCatalogEntryDTO {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: readonly string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  keyConfigured: boolean;
  keySource: 'env' | 'file' | null;
}
