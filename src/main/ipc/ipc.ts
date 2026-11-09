import type { IpcMain } from 'electron';

import { normalizePlanSteps } from '../../core/plan.js';
import { isTerminal, parseCommand, parseCreateTaskDirective, resolveInbound } from '../../core/resolver.js';
import { approvalAnswerEvent } from '../../core/approval-events.js';
import { extractProjectAlias } from '../../core/short-id.js';
import type { Classify, Inbound, Resolution, SemanticSignal } from '../../core/resolver.js';
import type { EngineEvent } from '../engine/types.js';
import type { TaskState, WaitingReason } from '../../core/types.js';
import type { AttachmentMeta, CardIntentResult, ChatRepo, MailboxAskDTO, ProjectDTO, StoredArtifact, StoredChangeset, StoredMessage, StoredReport, StoredReview, StoredTask, StoredTaskModelResolution } from './ports.js';
import { summarizeDeviations, type DeviationSummary } from './deviation.js';
import { probeProject, type ProjectProbe } from './project-probe.js';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deleteProviderKey, insertArtifact, isKnownSettingKey, isSecretSettingKey, SETTING_REDACTED, upsertProviderKey, validateSettingValue, writeSetting } from '../db/index.js';
import type { ContextMetricRow } from '../db/context_metrics.js';
import { getEmployeeById, insertEmployee, updateEmployee } from '../db/index.js';
import { stagedFilePath } from './staged-files.js';
import { setDefaultModel, setFallbackChain, setRoleMap } from '../agent/model-policy.js';
import { loadModelCatalog } from '../agent/model-catalog.js';
import { customModelsPath, listCustomProviders, removeCustomProvider, upsertCustomProvider } from '../agent/custom-providers.js';
import { customProvidersShapeError } from '../../core/custom-provider.js';
import { isAssistantWriteMode } from '../permission/assistant-write.js';
import { clearProviderKey, ProviderKeyError, providerStatuses, resolveProviderKey, saveProviderKey } from '../agent/provider-keys.js';
import { employeeSessionKey } from '../agent/employee-runtime.js';
import { installSkillsFromDirectory, installSkillsFromUrl } from '../agent/skill-install.js';
import { getSkillByName } from '../db/skills.js';
import { insertTaskEvent } from '../db/task_events.js';
import { handleCompanyConfig } from './company.js';
import { handleProjectTriggerManage } from './triggers.js';
import { handleMemoryManage } from './memory.js';
import { listPermissionOverview, revokePermissionPolicy } from './permission.js';
import { handleSettingsMaintenance } from './maintenance.js';
import { handleExportProject } from './project-export.js';
import { handleReadToolOutput } from './tool-output.js';
import { SqliteMemoryStore, type MemoryScope } from '../memory/index.js';
import { handleResolveAttachment } from './attachment.js';
import { inferType, kindFor } from './attachment.js';
import { createPreviewToken } from './attachment-preview.js';
import { employeeModelWhitelistError, modelWhitelistError } from '../company/model-whitelist.js';
import { listCheckpointsByTask } from '../db/checkpoints.js';
import { MailboxError } from '../engine/mailbox.js';
import type { TriggerService } from '../triggers/service.js';
import { checkDocs, defaultDocsPolicy, type DocCounts, type DocIssue } from '../docs/check.js';
import { applyDocsTemplate, type DocsTemplateResult } from '../docs/template.js';
import { readDocText, walkDocsTree } from '../docs/fs.js';
import {
  applyDocsIndexChanges,
  buildDocsIndexPlan,
  createDocsOrganizeIo,
  docsOrganizeToken,
  type DocsIndexChange,
} from '../docs/organize.js';
import type { EmployeeDetailDTO } from './employee.js';
import { buildEmployeeDetail } from './employee.js';
import { SEAM_BOUNDARIES } from '../seams/boundaries.js';
import type { ImBindPort, ImStatus } from '../im/types.js';
import { handleReadMark, handleReadState } from './read.js';
import { createGitRunner, initGitRepo } from '../git/index.js';
import { READ_PRINCIPAL_BOSS, READ_SURFACE_CARDS, markRead } from '../db/read_cursors.js';
import { digestText, emitDailyDigest } from '../notify/digest.js';

// ─────────────────────────────────────────────────────────────────────────────
// T0.5 IPC 通道实现（DEV §7.3 域集合：chat / inbox / task 本轮覆盖）。
//   铁律：入参不接受 renderer 给的任何文件系统路径（D1）；附件只收元信息。
//   处理逻辑抽成导出的纯函数（handle*），便于用内存库单测（test/chat.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/** 幕僚长真实会话（`createPiAssistantRuntime` 返回的 `AssistantRuntime` 的结构子集）。 */
export interface AssistantPort {
  runTurn(input: { text: string; taskId?: number | null; projectId?: number | null }): Promise<{ replyMessageId: number; reply?: string }>;
  /** RM-5：卡片落库时中止同任务幕僚长会话（可选；未接线 → false）。 */
  abortForTask?(taskId: number | null): Promise<boolean>;
}

export interface IpcDeps {
  repo: ChatRepo;
  /** 引擎（T0.6：手工推进）；缺失时 `task:transition` 返回 engine_unavailable。 */
  engine?: {
    dispatch(event: EngineEvent): Promise<void>;
    /** M1-2/M1-3/BRK14：引擎派发 hold（WI 级：路径/速率/并发；任务级：无槽位/超预算/员工正忙）→ `waits`。可选。 */
    listDispatchHolds?(): Array<{
      workItemId: number | null;
      taskId?: number;
      reason: string;
      conflictsWith: number[];
      detail?: string;
    }>;
    /** R3-2：顶栏槽位真读数（`scheduler:slots`）。可选（旧装配 → `null` → UI 显 `—`）。 */
    schedulerSlots?(): { running: number; total: number };
    /** C4：公司日预算 hold 文案（超支时返回原因；未超/未设 → undefined）。 */
    companyDailyBudgetHold?(): string | undefined;
  };
  /** 幕僚长真实会话（T0.4）；**懒加载后回填**（可为 null：缺 key / 未就绪）。 */
  assistant?: AssistantPort | null;
  /** BRK9（挂载 2）：老板插话 → steer 进行中的员工会话（由 main 注入 `LazyEmployeeRuntime.steer`）。 */
  steerEmployee?: ((sessionKey: string, text: string) => boolean) | null;
  /** 凭据变更（保存/清除 Key）→ 丢弃已装配运行时，下一次员工会话重新装配。 */
  onProviderKeyChanged?: (() => void) | null;
  /** 语义分类器；T0.4 接真实 Pi 语义前用占位（一律 'chat'，绝不误建任务）。 */
  classify?: Classify;
  /**
   * B2-2（D-30①）：分诊模式开关——`assistant`（缺省）＝自由文本交幕僚长唯一分诊
   * （零 LLM 分诊、不自动建任务）；`classifier`＝v0.2.1 旧链路（可回退）。
   * index.ts 从 `AICO_TRIAGE` 读取（readTriageMode）。
   */
  triageMode?: 'assistant' | 'classifier';
  /** R2-4：目录选择器（`project:attach` 用；由 main 注入 electron `dialog`——**handler 不直接碰 electron**）。 */
  pickDirectory?: () => Promise<string | null>;
  /** 2026-11-03：故障注入开关（仅非打包态由 main 注入；测试用，生产恒 false）。 */
  allowFaultInjection?: boolean;
  /** 2026-10-29 P2（P-N05）：应用信息（版本/数据目录）——由 main 注入，handler 不直接碰 electron。 */
  appInfo?: () => { version: string; userDataDir: string };
  /** M4-C：主题切换（由 main 注入 electron `nativeTheme.themeSource`）。 */
  setTheme?: (theme: 'light' | 'dark' | 'system') => void;
  /** BRK16-a（挂载 3）：系统打开文件（由 main 注入 electron `shell.openPath`；成功=空串、失败=错误文案）。 */
  openPath?: (absPath: string) => Promise<string> | string;
  /** BRK16-a：在文件夹中显示（由 main 注入 electron `shell.showItemInFolder`）。 */
  revealPath?: (absPath: string) => void;
  /** BRK16-a/GAP11：导出包落盘目录（由 main 注入 `userData/exports`；缺失 ⇒ 回执 export_unavailable）。 */
  exportDir?: () => string;
  /** UG-06：只读 diff 的 git runner（缺省 `createGitRunner()`；测试可注入假实现）。 */
  git?: import('../git/index.js').GitRunner;
  /** M4-D-1（P2）：工具大输出归档根（由 main 注入 `userData/tool-output`；缺失 ⇒ 展开不可用）。 */
  toolOutputDir?: string;
  /** GAP7（M3-N-3）：技能受管根（由 main 注入 `userData/skills`；缺失 ⇒ 安装不可用）。 */
  skillsDir?: () => string;
  /** GAP7：技能安装 DAO 直连（安装函数写 `skills` 表；由 main 注入同一库句柄）。 */
  db?: import('../db/open.js').SqliteDb;
  /** 设置·模型与供应商：本机 secrets 目录（缺省 `~/.aico/secrets`；测试注入临时目录）。 */
  providerSecretsDir?: () => string;
  /** 附件：file-import 的暂存目录（缺省主进程 `userData/staged-inputs`；测试注入临时目录）。 */
  stagedFilesDir?: () => string;
  /** GAP7：选择技能文件夹（标题与项目目录选择区分；缺省回退 `pickDirectory`）。 */
  pickSkillDirectory?: () => Promise<string | null>;
  /** 真机反馈（2026-10-17）：设置·通知「发送测试通知」——main 注入一次 `notify()`（系统通知+托盘刷新）。 */
  notifyTest?: () => void;
  /** GAP3：待办读数变化（答题/批准/详情直接推进）——main 注入托盘刷新，防橙点/计数悬挂。 */
  onInboxChanged?: () => void;
  /** M3-REM-1c：读游标变化（桌面动作/IM 批准）——main 注入 `evt:read` 推送 + 托盘刷新。 */
  onReadChanged?: () => void;
  /** GAP1：cron/事件触发服务（main 注入；缺省 → 命令明确拒，不静默）。 */
  triggerService?: TriggerService | null;
  /** IM 通道端口（main 装配；缺省 → `im:bind/unbind` 明确回 im_unavailable，不静默）。 */
  im?: ImBindPort | null;
  now?: () => number;
}

/** M0 占位分类器：非命令文本按闲聊处理。 */
export const defaultClassify: Classify = async (): Promise<SemanticSignal> => ({
  intent: 'chat',
  confidence: 0.5,
});

/**
 * B2-2：assistant 分诊模式的语义信号——**恒 chat、零 LLM 调用**。
 * resolver 的确定性路径（命令/#引用/回复链/序号）不走本函数、不受影响；自由文本裁定
 * 全部收敛为 chat，由幕僚长会话（create_task/steer 工具）唯一分诊（D-30①）。
 */
export const assistantTriageClassify: Classify = async (): Promise<SemanticSignal> => ({
  intent: 'chat',
  confidence: 0.51,
});

/** B2-2：`AICO_TRIAGE` 环境变量解析（缺省/非法 → 'assistant'；大小写宽松；非法响亮告警）。 */
export function readTriageMode(raw: string | undefined): 'assistant' | 'classifier' {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'classifier') return 'classifier';
  if (v !== '' && v !== 'assistant') {
    console.warn(`[ipc] AICO_TRIAGE='${raw}' 非法（合法：assistant|classifier）→ 回落 assistant`);
  }
  return 'assistant';
}

/** 附件只保留元信息；**显式丢弃任何 path/url 字段**（D1）。 */
function normalizeAttachments(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (name.length === 0) continue;
    const fileToken = typeof record.fileToken === 'string' ? record.fileToken : '';
    out.push({
      name,
      size: typeof record.size === 'number' ? record.size : 0,
      type: typeof record.type === 'string' ? record.type : '',
      // 保留主进程 staging 令牌（D1 例外③）；**丢弃任何 path/url 字段**。
      ...(fileToken.length > 0 ? { fileToken } : {}),
    });
  }
  return out.slice(0, 10); // 单条 ≤ 10 个（UI §4.6）
}

/** UG-04：把建单消息的附件复制到项目 `inputs/T-xxxx/` 并登记为 `artifacts.kind='input'`。 */
export function registerTaskInputArtifacts(
  deps: IpcDeps,
  taskId: number,
  messageId: number,
  attachments: AttachmentMeta[],
  now: number,
): { registered: number; errors: string[] } {
  if (attachments.length === 0) return { registered: 0, errors: [] };
  if (!deps.db) return { registered: 0, errors: ['数据库未装配'] };
  if (!deps.stagedFilesDir) return { registered: 0, errors: ['附件暂存目录不可用'] };
  const task = deps.repo.getTask(taskId);
  const project = task ? deps.repo.getProject(task.projectId) : null;
  if (!task || !project?.rootDir) return { registered: 0, errors: ['任务/项目根目录不可用'] };

  const stagedDir = deps.stagedFilesDir();
  const folder = task.shortId ?? `T${task.id}`;
  let registered = 0;
  const errors: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const name = attachment.name;
    if (!attachment.fileToken) {
      errors.push(`${name}：缺少暂存令牌`);
      continue;
    }
    const source = stagedFilePath(stagedDir, attachment.fileToken, name);
    if (!source) {
      errors.push(`${name}：暂存文件不存在或已清理`);
      continue;
    }
    // 文件名只取 basename + 白名单字符；序号前缀防同名覆盖（不信任原始路径）。
    const safe = basename(name)
      .replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'file';
    const relative = `inputs/${folder}/${index + 1}-${safe}`;
    const absolute = join(project.rootDir, relative);
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      copyFileSync(source, absolute);
      const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      insertArtifact(deps.db, {
        taskId,
        path: relative,
        kind: 'input',
        note: `message:${messageId}`,
        sha256,
        source: `message:${messageId}`,
        now,
      });
      registered += 1;
    } catch {
      // 不回传绝对路径（D1）；只给文件名与原因类别。
      errors.push(`${name}：归档失败`);
    }
  }
  return { registered, errors };
}

function resolutionTaskId(resolution: Resolution): number | null {
  switch (resolution.kind) {
    case 'task_message':
      return resolution.taskId;
    case 'pending_answer':
      return resolution.taskId;
    case 'command':
      return resolution.taskId ?? null;
    default:
      return null;
  }
}

/**
 * 老板**实际处理**一张卡（批准/打回/标已阅）→ 同步推进 `channel:cards` 游标（source='action'）。
 * 主进程兜底：IM 批准、桌面按钮、其它入口都走同一口径；失败只记日志（处理器自己已有结果，不反噬）。
 */
function markCardActionRead(deps: IpcDeps, reportId: number | null | undefined, at: number): void {
  if (!deps.db || typeof reportId !== 'number' || reportId <= 0) return;
  try {
    markRead(deps.db, {
      principal: READ_PRINCIPAL_BOSS,
      surface: READ_SURFACE_CARDS,
      throughId: reportId,
      now: at,
      source: 'action',
    });
    deps.onReadChanged?.();
  } catch (error) {
    console.warn('[ipc] 动作推进未读游标失败（不改变动作结果）', error);
  }
}

interface HumanMessageDTO {
  id: number;
  direction: 'in' | 'out';
  taskId: number | null;
  content: string;
  attachments: AttachmentMeta[];
  createdAt: number;
}

interface ReportDTO {
  id: number;
  /** v8/BRK21：`null` = 全局卡（不属任何任务；渲染层显示「全局」）。 */
  taskId: number | null;
  shortId: string | null;
  /** MP1-9：任务所属项目（全局卡/无任务 → null）。 */
  projectId?: number | null;
  projectName?: string | null;
  kind: string;
  state: string;
  createdAt: number;
  approvalId: number | null;
  /** RW-21：审批行的 options（卡 payload 缺 options 的历史卡由此兜底出按钮）；无审批行/空 → null。 */
  approvalOptions: Array<{ key: string; label?: string }> | null;
  payload: Record<string, unknown>;
  /** GAP12：`reports.verdict` 真列（pass/fail/partial…）；无结论 → null。 */
  verdict: string | null;
  verifierEmployeeId: number | null;
}

interface TaskDTO {
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
  /** UI-2（任务行相对时间）：最近更新（`tasks.updated_at` 直读）。 */
  updatedAt: number;
  readySince: number | null;
  /** M2 尾：截止时刻（epoch ms；NULL＝未设）。 */
  deadline: number | null;
  acceptance: unknown[];
  /** BRK13（挂载 3）：预算/已耗/余额（未设 ⇒ null；「任务头显示预算」的数据面）。 */
  budgetTokens: number | null;
  costTokens: number;
  budgetLeftTokens: number | null;
  /** 009（N5 余账）：任务级模型（指派链最高档）；NULL = 未指派。 */
  model: string | null;
  /** `tasks.archived`（0/1）：归档＝**筛选开关**（非 state；M2-A 归档口径）。 */
  archived: number;
  /** 所属项目名（`task:list` join 出来；M2-A 项目分组）。 */
  projectName: string | null;
  projectAlias: string | null;
  /** 所属项目接入模式（`projects.access_mode`；M2-A 变更区块用）。 */
  projectAccessMode: string | null;
  /** M1-3：当前等待原因（空 = 不等待）。数据来自引擎 hold，**渲染层不得自行推断**。 */
  waits?: WaitDTO[];
}

function toTaskDTO(task: StoredTask): TaskDTO {
  return {
    id: task.id,
    shortId: task.shortId,
    projectId: task.projectId,
    title: task.title,
    state: task.state,
    pauseReason: task.pauseReason,
    priority: task.priority,
    riskLevel: task.riskLevel,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    readySince: task.readySince,
    deadline: task.deadline ?? null,
    acceptance: task.acceptance,
    budgetTokens: task.budgetTokens,
    costTokens: task.costTokens,
    budgetLeftTokens: task.budgetLeftTokens,
    model: task.model,
    archived: task.archived,
    projectName: task.projectName,
    projectAlias: task.projectAlias,
    projectAccessMode: task.projectAccessMode,
  };
}

/** M1-3：**当前在等什么**（`UI §7`；枚举 = `src/core/types.ts` 的 `WaitingReason`，唯一权威）。 */
export interface WaitDTO {
  /** WI 级等待＝该件；**任务级等待**（`no_slot`/`budget`/`employee_busy`，BRK14）＝`null`。 */
  workItemId: number | null;
  reason: WaitingReason;
  detail?: string;
  conflictsWith: number[];
  conflictsWithShortIds: string[];
}

/** 把引擎派发 hold 过滤到某任务（WI 级经 `work_item→task`；任务级直接按 `taskId`），并补 `conflictsWith` 的短号。 */
function computeWaits(deps: IpcDeps, taskId: number): WaitDTO[] {
  const engine = deps.engine;
  if (!engine?.listDispatchHolds) return [];
  let holds: Array<{ workItemId: number | null; taskId?: number; reason: string; conflictsWith: number[]; detail?: string }> = [];
  try {
    holds = engine.listDispatchHolds();
  } catch {
    return [];
  }
  const ids = new Set(deps.repo.listWorkItemIds(taskId));
  return holds
    .filter((hold) => hold.taskId === taskId || (hold.workItemId != null && ids.has(hold.workItemId)))
    .map((hold) => ({
      workItemId: hold.workItemId,
      reason: hold.reason as WaitingReason,
      // R3-2：`detail` 由**引擎决策点**直给（数字/阈值只有那里知道；渲染层不猜）
      ...(hold.detail ? { detail: hold.detail } : {}),
      conflictsWith: hold.conflictsWith,
      conflictsWithShortIds: hold.conflictsWith
        .map((id) => deps.repo.getWorkItemShortId(id))
        .filter((s): s is string => typeof s === 'string'),
    }));
}

/**
 * R3-2：顶栏「槽位 x/y」——任务级活跃槽位**真读数**（`scheduler:slots`）。
 * 引擎缺失 / 未装配 → `null`（渲染层显 `—`，**不写假 0**；同 `cost:summary` 空态口径）。
 */
export function handleSchedulerSlots(deps: IpcDeps): { running: number; total: number } | null {
  const engine = deps.engine;
  if (!engine?.schedulerSlots) return null;
  try {
    return engine.schedulerSlots();
  } catch {
    return null;
  }
}

// ── T0.7 任务详情（DEV §8 T0.7）────────────────────────────────────────

export interface AcceptanceItemDTO {
  text: string;
  /** 可选的可执行检查命令（schema：`tasks.acceptance` = `[{text, check?}]`）。 */
  check?: string;
}

/**
 * `task:get` 返回体（T0.7 三 tab 的数据源）。
 * - `planSteps`  = `plan_steps`（按 idx）
 * - `timeline`   = `task_events` 全量（按 id 升序）
 * - `behaviorLog`= `timeline` 中 `kind='tool_call'` 子集（保证是子集，审计层）
 * - `counts`     = **查询返回条数**，DOM 条数断言的依据（与上方数组同源）
 */
export interface TaskDetailDTO {
  task: Omit<TaskDTO, 'acceptance'> & { goal: string; updatedAt: number; acceptance: AcceptanceItemDTO[] };
  /** UG-01：负责人（建单/编制；null＝未设置）。 */
  owner: { id: number; name: string } | null;
  /** UG-01：前置任务（短号/标题/状态；空数组＝无依赖）。 */
  dependsOn: Array<{ id: number; shortId: string | null; title: string; state: string }>;
  /** D-22：任务头「预计模型＋来源」（执行员工视角）；读面沿用 task:get，零新通道。 */
  modelResolution: StoredTaskModelResolution;
  progress: { done: number; total: number };
  planSteps: Array<{ idx: number; text: string; state: string; workItemId: number | null; evidenceRef: string | null }>;
  /** GAP12：critic/verifier 结论（reports.verdict 优先；空数组＝无评审结论）。 */
  reviews: StoredReview[];
  /** GAP12：验证中被打回的最近 submitted 件；手动打回未带 id 时服务端补全。 */
  verificationWorkItemId: number | null;
  timeline: Array<{ id: number; ts: number; kind: string; actor: string; workItemId: number | null; payload: unknown }>;
  behaviorLog: Array<{ id: number; ts: number; actor: string; workItemId: number | null; payload: unknown }>;
  /** M1-3：当前等待原因（空数组 = 不等待；渲染层不得按 state 推断）。 */
  waits?: WaitDTO[];
  /** OPT-M8-1：任务产物元信息（只读、按 id 升序；空数组 = 本任务无产物）。`path` 仅展示（D1）。 */
  artifacts?: StoredArtifact[];
  /** OPT-M6-1：差异台账读数（由 `timeline` 的 `deviation_recorded` 派生；收尾 `openWithoutOwner` 必须为空）。 */
  deviations?: DeviationSummary;
  /** OPT-AI-1：原始交流派生投影（只读；由 `human_messages`/`agent_message`/`tool_call` 派生；空数组 = 无）。 */
  rawConversation?: import('../agent/raw-conversation.js').RawItem[];
  /** M2-A：本任务变更集（含文件明细；`staging` 才有；空数组 = 无）。 */
  changesets?: StoredChangeset[];
  /** BRK17（挂载 3 余·取消小步）：工作项按状态计数——UI 危险动作（取消）确认文案的真读数。 */
  workItemCounts?: Record<string, number>;
  /** CTX1-2：最近 20 轮上下文遥测（新的在前；空数组 = 本任务还没有任何会话遥测）。 */
  contextMetrics?: ContextMetricRow[];
  counts: { planSteps: number; timeline: number; behaviorLog: number; acceptance: number };
}

/** 验收项 JSON → 强类型（容忍旧格式：纯字符串 / 缺 check）。 */
function normalizeAcceptance(raw: unknown[]): AcceptanceItemDTO[] {
  const out: AcceptanceItemDTO[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text.length > 0) out.push({ text });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text : '';
    if (text.length === 0) continue;
    out.push(typeof record.check === 'string' && record.check.length > 0 ? { text, check: record.check } : { text });
  }
  return out;
}

function toMessageDTO(row: StoredMessage): HumanMessageDTO {
  return {
    id: row.id,
    direction: row.direction,
    taskId: row.taskId,
    content: row.content,
    attachments: row.attachments,
    createdAt: row.createdAt,
  };
}

function toReportDTO(row: StoredReport): ReportDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    shortId: row.shortId,
    projectId: row.projectId,
    projectName: row.projectName,
    kind: row.kind,
    state: row.state,
    createdAt: row.createdAt,
    approvalId: row.approvalId,
    approvalOptions: row.approvalOptions ?? null,
    payload: row.payload,
    verdict: row.verdict,
    verifierEmployeeId: row.verifierEmployeeId,
  };
}

// ── 可单测的通道处理器 ──────────────────────────────────────────────────

export interface ChatSendResult {
  ok: true;
  messageId: number;
  resolution: Resolution;
  /** 命令/入站处理的回执文本（IM 发回手机；桌面忽略）。 */
  reply?: string | null;
  /** UG-03：命令被拒绝时的人话原因（回执已落频道；渲染层据此就地显示，不当成功）。 */
  rejected?: string | null;
  /** D0：本条消息自动建出的任务（自由文本 new_task 裁定；B2-2 起 assistant 模式恒 null）。 */
  createdTaskId?: number | null;
}

/** BRK9（挂载 2）：`#T-1001 要说的话` / `#T1042 要说的话` 解析（FLOWS §6 命令表；简写归一为 `T-<n>`）；不匹配 → null。 */
export function parseSteerCommand(text: string): { shortId: string; body: string } | null {
  const m = /^#(T-?\d+)\s+([\s\S]+)$/.exec(text.trim());
  if (!m) return null;
  const raw = m[1] as string;
  const shortId = raw.includes('-') ? raw : `T-${raw.slice(1)}`;
  const body = (m[2] ?? '').trim();
  return body.length > 0 ? { shortId, body } : null;
}

/**
 * BRK9：插话直通（`#T1042 要说的话`）。
 * - 任务**在跑**（有 running 工作项）⇒ `steerEmployee(sessionKey, body)` 到**进行中的员工会话**（下一个工具调用前生效）；
 *   未送达（运行时会话不在飞/未接线）⇒ **如实回执**（绝不假装送出、绝不丢输入）；
 * - 任务不在跑 / 短号查无 ⇒ **不拦截**，落回常规裁定（`task_message` 寻址：消息挂任务、原语义不变）。
 */
export function handleSteerCommand(
  deps: IpcDeps,
  cmd: { shortId: string; body: string },
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
): ChatSendResult | null {
  const task = deps.repo.findTaskByShortId(cmd.shortId);
  if (!task) return null;
  const running = deps.repo.findRunningWorkItem(task.id);
  if (!running) return null; // 不在跑：不拦截（走既有 `task_message` 路径）
  const label = task.shortId ?? cmd.shortId;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: task.id, content: rawText, attachments, now: at });
  const sessionKey = employeeSessionKey({ employeeId: running.employeeId, taskId: task.id, workItemId: running.id });
  const delivered = deps.steerEmployee ? deps.steerEmployee(sessionKey, cmd.body) : false;
  deps.repo.insertMessage({
    direction: 'out',
    taskId: task.id,
    attachments: [],
    content: delivered ? `已插话到 ${label}（员工下一个工具调用前生效）` : `${label} 的会话未在飞——没送出去（稍后再试）`,
    now: at,
  });
  return { ok: true, messageId: stored.id, resolution: { kind: 'chat' } };
}

/** BRK13（挂载 3）：`加预算 T1042 500000` 解析（FLOWS §6）；不匹配 → null。 */
export function parseBudgetCommand(text: string): { shortId: string; tokens: number } | null {
  const m = /^(?:加预算|调预算|set-budget)\s+(T-?\d+)\s+(\d+)$/.exec(text.trim());
  if (!m) return null;
  const raw = m[1] as string;
  const shortId = raw.includes('-') ? raw : `T-${raw.slice(1)}`;
  const tokens = Number(m[2]);
  return Number.isSafeInteger(tokens) ? { shortId, tokens } : null;
}

/** BRK13：加预算直通——写预算；**因超预算暂停的任务同时继续**（FLOWS §3.1.4）；短号查无 → null 落回。 */
export async function handleBudgetCommand(
  deps: IpcDeps,
  cmd: { shortId: string; tokens: number },
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
): Promise<ChatSendResult | null> {
  const task = deps.repo.findTaskByShortId(cmd.shortId);
  if (!task) return null;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: task.id, content: rawText, attachments, now: at });
  if (cmd.tokens <= 0) {
    const rejected = '预算必须是正整数（token 数）——这条没改';
    deps.repo.insertMessage({
      direction: 'out',
      taskId: task.id,
      attachments: [],
      content: rejected,
      now: at,
    });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' }, rejected };
  }
  const updated = deps.repo.setTaskBudget(task.id, cmd.tokens, at);
  if (!updated) return null; // 查得到却写不动：落回不猜
  let resumed = false;
  let resumeNote = '';
  if (updated.state === 'paused' && deps.engine) {
    // 只自动恢复「任务预算」来源；手动/公司日预算来源必须由老板显式「继续」。
    if (updated.pauseReason === 'task_budget') {
      await deps.engine.dispatch({ scope: 'task', id: task.id, event: 'resume', actor: 'boss', payload: { via: 'set-budget' } });
      resumed = true;
    } else if (updated.pauseReason === 'company_budget') {
      resumeNote = '；该任务是公司日预算暂停，未自动继续（提高预算后请用「继续」）';
    } else if (updated.pauseReason === 'manual') {
      resumeNote = '；该任务是手动暂停，未自动继续';
    } else {
      resumeNote = '；暂停来源未知，未自动继续';
    }
  }
  deps.repo.insertMessage({
    direction: 'out',
    taskId: task.id,
    attachments: [],
    content: resumed
      ? `已把 ${updated.shortId ?? cmd.shortId} 预算调为 ${cmd.tokens} tokens，并继续执行`
      : `已把 ${updated.shortId ?? cmd.shortId} 预算调为 ${cmd.tokens} tokens${resumeNote}`,
    now: at,
  });
  return { ok: true, messageId: stored.id, resolution: { kind: 'chat' } };
}

// ── N5 余账（2026-10-16）：任务级模型（指派链最高档）+ 项目白名单拦点 ──────────
// 判据真源在 `src/main/company/model-whitelist.ts`（company.json apply 也走同一函数）；
// 这里 re-export 保持既有调用/测试入口不变。
export { modelWhitelistError, providerOfModel } from '../company/model-whitelist.js';

/** `模型 T1042 <provider/model>`（或 `模型 T1042 默认` = 清除回既有链）直通解析。 */
export function parseModelCommand(text: string): { shortId: string; model: string | null } | null {
  const m = /^(?:模型|换模型|set-model)\s+(T-?\d+)\s+(\S+)$/.exec(text.trim());
  if (!m) return null;
  const raw = m[1] as string;
  const shortId = raw.includes('-') ? raw : `T-${raw.slice(1)}`;
  const value = m[2] as string;
  const cleared = value === '默认' || value === '清除' || value === 'default';
  return { shortId, model: cleared ? null : value };
}

/**
 * N5 余账：`模型 T1042 deepseek/deepseek-v4-pro` 直通——写 `tasks.model`（该任务**全部会话角色**按此模型；
 * 显式人工指派压过 role_map，不参与降档），白名单不符**回执拒绝**（不静默）；短号查无 → null 落回。
 */
export async function handleModelCommand(
  deps: IpcDeps,
  cmd: { shortId: string; model: string | null },
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
): Promise<ChatSendResult | null> {
  const task = deps.repo.findTaskByShortId(cmd.shortId);
  if (!task) return null;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: task.id, content: rawText, attachments, now: at });
  const reject = async (content: string, isRejection = false): Promise<ChatSendResult> => {
    deps.repo.insertMessage({ direction: 'out', taskId: task.id, attachments: [], content, now: at });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' }, ...(isRejection ? { rejected: content } : {}) };
  };
  if (cmd.model != null) {
    const project = deps.repo.getProject(task.projectId);
    const error = modelWhitelistError({
      model: cmd.model,
      allowedProviders: project?.allowedProviders ?? [],
      projectLabel: project ? `${project.name}` : null,
    });
    if (error) return reject(`${error}——这条没改`, true);
  }
  const updated = deps.repo.setTaskModel(task.id, cmd.model, at);
  if (!updated) return null; // 查得到却写不动：落回不猜
  return reject(
    cmd.model == null
      ? `已清除 ${updated.shortId ?? cmd.shortId} 的任务级模型（回到 员工/角色映射/全局 常规链）`
      : `已把 ${updated.shortId ?? cmd.shortId} 的任务级模型设为 ${cmd.model}（该任务全部会话按此；指派链最高档，EMPLOYEES §10.1）`,
  );
}

/**
 * B6（M3-N-3）：`用技能 <name> T1042` / `取消技能 T1042` 直通解析（对应底座 `/skill:<name>` 的强制加载）。
 * 技能名按 Agent Skills 规范（小写字母/数字/连字符）。
 */
export function parseSkillCommand(text: string): { shortId: string; skill: string | null } | null {
  const t = text.trim();
  const clear = /^(?:取消技能|不用技能|clear-skill)\s+#?(T-?\d+)$/i.exec(t);
  if (clear) {
    const raw = clear[1] as string;
    return { shortId: raw.includes('-') ? raw.toUpperCase() : `T-${raw.slice(1)}`, skill: null };
  }
  const m = /^(?:用技能|强制技能|use-skill)\s+([a-z0-9][a-z0-9-]{0,63})\s+#?(T-?\d+)$/i.exec(t);
  if (!m) return null;
  const raw = m[2] as string;
  return {
    skill: (m[1] as string).toLowerCase(),
    shortId: raw.includes('-') ? raw.toUpperCase() : `T-${raw.slice(1)}`,
  };
}

/**
 * B6：任务级强制技能（写 `task_skill_forced` 事件；最后一条为准）。
 * 只影响**之后的会话装配**（当前在跑的会话不打断）；技能须已登记且启用；短号查无 → null 落回。
 */
export function handleSkillCommand(
  deps: IpcDeps,
  cmd: { shortId: string; skill: string | null },
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
): ChatSendResult | null {
  const task = deps.repo.findTaskByShortId(cmd.shortId);
  if (!task) return null;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: task.id, content: rawText, attachments, now: at });
  const reply = (content: string, isRejection = false): ChatSendResult => {
    deps.repo.insertMessage({ direction: 'out', taskId: task.id, attachments: [], content, now: at });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' }, ...(isRejection ? { rejected: content } : {}) };
  };
  if (cmd.skill != null) {
    const row = deps.db ? getSkillByName(deps.db, cmd.skill) : deps.repo.listSkills(true).find((s) => s.name === cmd.skill);
    if (!row) return reply(`没有这个技能：${cmd.skill}（先在 设置 · 技能 安装）——这条没改`, true);
    if (row.enabled !== 1) return reply(`技能已停用：${cmd.skill}（先启用）——这条没改`, true);
    if (!deps.db) return reply('主进程数据库未接线，强制技能未写入', true);
    insertTaskEvent(deps.db, {
      taskId: task.id,
      ts: at,
      kind: 'task_skill_forced',
      actor: 'boss',
      payload: { skill: cmd.skill },
    });
    return reply(
      `已给 ${task.shortId ?? cmd.shortId} 设置强制技能：${cmd.skill}（之后的规划/执行会话加载全文；` +
        `正在跑的这一轮不打断，下次派工生效）`,
    );
  }
  if (!deps.db) return reply('主进程数据库未接线，强制技能未清除');
  insertTaskEvent(deps.db, {
    taskId: task.id,
    ts: at,
    kind: 'task_skill_forced',
    actor: 'boss',
    payload: { skill: null },
  });
  return reply(`已清除 ${task.shortId ?? cmd.shortId} 的强制技能（之后按员工勾选 ∪ 项目默认）`);
}

/**
 * M2 尾（D4）：`依赖 T1042 T1000[,T1001]` / `移除依赖 T1042 T1000` 直通——
 * **唯一带守卫的写入口**（存在性＋判环＋审计；拒绝不落库、回执点名）。
 * 短号查无目标 → `null`（落回常规路径，不吞消息）。
 */
export function parseDependencyCommand(
  text: string,
): { shortId: string; dependsOn: string[]; remove: boolean } | null {
  const m = /^(?:依赖|添加依赖|depend|移除依赖|删依赖|undepend)\s+(T-?\d+)\s+(.+)$/.exec(text.trim());
  if (!m) return null;
  const raw = m[1] as string;
  const shortId = raw.includes('-') ? raw.toUpperCase() : `T-${raw.slice(1)}`;
  const remove = /^(?:移除依赖|删依赖|undepend)$/.test((text.trim().split(/\s+/)[0] ?? ''));
  const deps = (m[2] as string)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.includes('-') ? s.toUpperCase() : /^T\d+$/i.test(s) ? `T-${s.slice(1)}` : s));
  if (deps.length === 0) return null;
  return { shortId, dependsOn: deps, remove };
}

export function handleDependencyCommand(
  deps: IpcDeps,
  cmd: { shortId: string; dependsOn: string[]; remove: boolean },
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
): ChatSendResult | null {
  const task = deps.repo.findTaskByShortId(cmd.shortId);
  if (!task) return null;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: task.id, content: rawText, attachments, now: at });
  const reject = (content: string): ChatSendResult => {
    deps.repo.insertMessage({ direction: 'out', taskId: task.id, attachments: [], content, now: at });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' } };
  };

  const targets = cmd.dependsOn.map((shortId) => deps.repo.findTaskByShortId(shortId));
  const missing = cmd.dependsOn.filter((_, i) => !targets[i]);
  if (missing.length > 0) return reject(`未改：找不到 ${missing.join('、')}（短号不存在；依赖关系保持原样）`);

  const lines: string[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const dep = targets[i];
    if (!dep) continue;
    const res = cmd.remove
      ? deps.repo.removeTaskDependency({ taskId: task.id, dependsOn: dep.id, actor: 'boss', now: at })
      : deps.repo.addTaskDependency({ taskId: task.id, dependsOn: dep.id, actor: 'boss', now: at });
    const depLabel = dep.shortId ?? `#${dep.id}`;
    if (!res.ok) {
      lines.push(`未改 ${depLabel}：${res.message ?? res.code ?? '未知原因'}`);
    } else if (cmd.remove) {
      lines.push(res.added ? `已移除依赖：${depLabel}` : `本来就没有这条依赖：${depLabel}（未重复移除）`);
    } else {
      lines.push(
        res.added
          ? `已加上依赖：${depLabel}（${depLabel} 全部完成后本任务自动开工）`
          : `已是依赖：${depLabel}（未重复添加）`,
      );
    }
  }
  return reject(`${cmd.remove ? '依赖移除结果' : '依赖设置结果'}：\n${lines.join('\n')}`);
}

/**
 * GAP1（M3-N-1）触发命令（FLOWS §6 同风格）：
 *  - `定时 每30分钟 <目标>` / `定时 每天 09:00 <目标>`
 *  - `当 T1042 完成 <目标>`（源任务完成后建新任务）
 *  - `触发列表` / `取消触发 <id>`
 * 解析纯函数；不命中 → null（落回普通聊天）。
 */
export type TriggerCommand =
  | { kind: 'cron'; goal: string; intervalMinutes?: number; dailyMinute?: number }
  | { kind: 'event'; goal: string; sourceShortId: string }
  | { kind: 'list' }
  | { kind: 'cancel'; id: number };

export function parseTriggerCommand(text: string): TriggerCommand | null {
  const t = text.trim();
  if (/^(?:触发列表|定时列表|triggers?)$/i.test(t)) return { kind: 'list' };
  const cancel = /^(?:取消触发|取消定时|cancel-trigger)\s+(\d+)\s*$/i.exec(t);
  if (cancel) {
    const id = Number(cancel[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: 'cancel', id } : null;
  }
  const daily = /^(?:定时|schedule)\s+每天\s*(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(t);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    const goal = (daily[3] ?? '').trim();
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || goal.length === 0) return null;
    return { kind: 'cron', goal, dailyMinute: hour * 60 + minute };
  }
  const interval = /^(?:定时|schedule)\s+每\s*(\d+)\s*分钟\s+([\s\S]+)$/i.exec(t);
  if (interval) {
    const minutes = Number(interval[1]);
    const goal = (interval[2] ?? '').trim();
    if (!Number.isSafeInteger(minutes) || minutes <= 0 || goal.length === 0) return null;
    return { kind: 'cron', goal, intervalMinutes: minutes };
  }
  const when = /^当\s+(T-?\d+)\s+完成\s+([\s\S]+)$/i.exec(t);
  if (when) {
    const raw = when[1] as string;
    const sourceShortId = raw.includes('-') ? raw.toUpperCase() : `T-${raw.slice(1)}`;
    const goal = (when[2] ?? '').trim();
    return goal.length > 0 ? { kind: 'event', goal, sourceShortId } : null;
  }
  return null;
}

/** GAP1：触发命令直通（默认项目 + 风险 L1；事件触发只支持“任务完成”）。 */
export async function handleTriggerCommand(
  deps: IpcDeps,
  cmd: TriggerCommand,
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
  contextProjectId: number | null = null,
): Promise<ChatSendResult> {
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: null, content: rawText, attachments, now: at });
  const reply = (content: string): ChatSendResult => {
    deps.repo.insertMessage({ direction: 'out', taskId: null, attachments: [], content, now: at });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' } };
  };
  const service = deps.triggerService;
  if (!service) return reply('触发服务未就绪（主进程未装配）——本条未生效');

  // B-3：桌面有选中项目时以它为准（此前一律落默认项目，项目卡与频道会各说各话）。
  const contextProject = contextProjectId != null ? deps.repo.getProject(contextProjectId) : null;
  if (contextProjectId != null && !contextProject) {
    return reply(`当前项目 #${contextProjectId} 不存在——本条未生效。`);
  }

  if (cmd.kind === 'list') {
    const rows = service
      .list()
      .filter((row) => contextProject == null || row.projectId === contextProject.id);
    if (rows.length === 0) return reply(contextProject ? '本项目暂无定时/事件触发。' : '暂无定时/事件触发。');
    // F-4 P-05：无当前项目时列全部，并逐行标项目，避免“不知道这是哪个项目的”。
    const projectNames = contextProject
      ? new Map<number, string>()
      : new Map(deps.repo.listProjects({ includeArchived: true }).map((p) => [p.id, p.name]));
    const lines = rows.map((row) => {
      const when =
        row.kind === 'cron'
          ? row.intervalMinutes != null
            ? `每 ${row.intervalMinutes} 分钟`
            : `每天 ${String(Math.floor((row.dailyMinute ?? 0) / 60)).padStart(2, '0')}:${String((row.dailyMinute ?? 0) % 60).padStart(2, '0')}`
          : `当 ${row.sourceTaskId != null ? `#${row.sourceTaskId}` : '源任务'} 完成`;
      const next = row.nextDueAt != null ? ` · 下次 ${new Date(row.nextDueAt).toLocaleString('zh-CN', { hour12: false })}` : '';
      const projectTag = contextProject ? '' : ` · 项目 ${projectNames.get(row.projectId) ?? `#${row.projectId}`}`;
      return `#${row.id} · ${when} · ${row.goal}${next}${projectTag}`;
    });
    return reply(`触发列表（${rows.length}）：\n${lines.join('\n')}`);
  }
  if (cmd.kind === 'cancel') {
    const row = service.list().find((trigger) => trigger.id === cmd.id);
    if (contextProject != null && row != null && row.projectId !== contextProject.id) {
      return reply(`当前项目没有触发 #${cmd.id}——本条未生效。`);
    }
    return reply(service.cancel(cmd.id) ? `已取消触发 #${cmd.id}（不会再开新任务）` : `未找到未触发的 #${cmd.id}（可能已触发或已取消）`);
  }

  const projectId = contextProject?.id ?? deps.repo.resolverStore.getDefaultProject()?.id ?? null;
  if (projectId == null) {
    return reply(
      contextProjectId != null
        ? '当前项目不可用——本条未生效。'
        : '未设置默认项目——先设置默认项目，或接入已有项目后再建触发。',
    );
  }
  if (contextProject?.archived === 1) return reply('项目已归档——不能新建触发（先恢复项目）。');
  const title = cmd.goal.slice(0, 40) || '定时任务';
  try {
    if (cmd.kind === 'event') {
      const source = deps.repo.findTaskByShortId(cmd.sourceShortId);
      if (!source) return reply(`未找到源任务 ${cmd.sourceShortId}——触发未创建。`);
      if (source.projectId !== projectId) return reply(`源任务 ${source.shortId ?? cmd.sourceShortId} 不属于当前项目——触发未创建。`);
      if (isTerminal(source.state as TaskState)) {
        return reply(`源任务 ${source.shortId ?? cmd.sourceShortId} 已是终态（${source.state}），不会再“完成”——触发未创建。`);
      }
      const row = service.createEvent({
        name: title,
        projectId,
        title,
        goal: cmd.goal,
        riskLevel: 1,
        sourceTaskId: source.id,
        eventKind: 'task_completed',
        now: at,
      });
      return reply(`已创建事件触发 #${row.id}：${source.shortId ?? `#${source.id}`} 完成后自动新建任务「${title}」`);
    }
    const row = service.createCron({
      name: title,
      projectId,
      title,
      goal: cmd.goal,
      riskLevel: 1,
      ...(cmd.intervalMinutes != null ? { intervalMinutes: cmd.intervalMinutes } : {}),
      ...(cmd.dailyMinute != null ? { dailyMinute: cmd.dailyMinute } : {}),
      now: at,
    });
    const when = cmd.intervalMinutes != null ? `每 ${cmd.intervalMinutes} 分钟` : `每天 ${String(Math.floor((cmd.dailyMinute ?? 0) / 60)).padStart(2, '0')}:${String((cmd.dailyMinute ?? 0) % 60).padStart(2, '0')}`;
    return reply(
      `已创建定时触发 #${row.id}（${when}）：到点自动新建任务「${title}」；下次 ${new Date(row.nextDueAt ?? at).toLocaleString('zh-CN', { hour12: false })}`,
    );
  } catch (error) {
    return reply(`触发未创建：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * B-6（M4）记忆命令（老板显式写；不烧模型，桌面/IM 同源）：
 *  - `记住 <内容>` / `记住全局 <内容>`
 *  - `记忆列表` / `记忆列表 全局`
 *  - `搜索记忆 <词>` / `搜索记忆 全局 <词>`
 *  - `忘记记忆 <id>` / `提升记忆 <id>`（项目 → 全局；老板命令即显式确认）
 */
export type MemoryCommand =
  | { kind: 'list'; scope: 'project' | 'global' }
  | { kind: 'remember'; scope: 'project' | 'global'; value: string }
  | { kind: 'forget'; id: number }
  | { kind: 'promote'; id: number }
  | { kind: 'search'; scope: 'project' | 'global'; text: string };

export function parseMemoryCommand(text: string): MemoryCommand | null {
  const t = text.trim();
  const list = /^(?:记忆列表|记忆列表\s+(全局|项目))$/i.exec(t);
  if (list) return { kind: 'list', scope: list[1] === '全局' ? 'global' : 'project' };
  const forget = /^(?:忘记记忆|删除记忆)\s+(\d+)$/i.exec(t);
  if (forget) {
    const id = Number(forget[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: 'forget', id } : null;
  }
  const promote = /^提升记忆\s+(\d+)$/i.exec(t);
  if (promote) {
    const id = Number(promote[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: 'promote', id } : null;
  }
  const globalRemember = /^记住全局\s+([\s\S]+)$/i.exec(t);
  if (globalRemember) {
    const value = (globalRemember[1] ?? '').trim();
    return value.length > 0 ? { kind: 'remember', scope: 'global', value } : null;
  }
  const remember = /^记住\s+([\s\S]+)$/i.exec(t);
  if (remember) {
    const value = (remember[1] ?? '').trim();
    return value.length > 0 ? { kind: 'remember', scope: 'project', value } : null;
  }
  const search = /^搜索记忆\s+([\s\S]+)$/i.exec(t);
  if (search) {
    const body = (search[1] ?? '').trim();
    if (body.startsWith('全局 ')) return { kind: 'search', scope: 'global', text: body.slice(3).trim() };
    return body.length > 0 ? { kind: 'search', scope: 'project', text: body } : null;
  }
  return null;
}

/** B-6：记忆命令直通（项目作用域＝默认项目；无默认项目时只允许全局命令）。 */
export async function handleMemoryCommand(
  deps: IpcDeps,
  cmd: MemoryCommand,
  rawText: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
  contextProjectId: number | null = null,
): Promise<ChatSendResult> {
  const stored = deps.repo.insertMessage({ direction: 'in', taskId: null, content: rawText, attachments, now: at });
  const reply = (content: string): ChatSendResult => {
    deps.repo.insertMessage({ direction: 'out', taskId: null, attachments: [], content, now: at });
    return { ok: true, messageId: stored.id, resolution: { kind: 'chat' } };
  };
  if (!deps.db) return reply('记忆库未就绪（主进程未装配 db）——本条未生效');
  const store = new SqliteMemoryStore(deps.db);
  // B-3：桌面有选中项目时以它为准；没有才回落默认项目。
  const contextProject = contextProjectId != null ? deps.repo.getProject(contextProjectId) : null;
  if (contextProjectId != null && !contextProject) {
    return reply(`当前项目 #${contextProjectId} 不存在——本条未生效。`);
  }
  const defaultProject = deps.repo.resolverStore.getDefaultProject();
  const project = contextProject ?? defaultProject;
  const projectScope = (): MemoryScope | null =>
    project ? { type: 'project', projectId: project.id } : null;
  const scopeFor = (scope: 'project' | 'global'): MemoryScope | null => {
    if (scope === 'global') return { type: 'global' };
    return projectScope();
  };

  try {
    if (cmd.kind === 'remember') {
      const scope = scopeFor(cmd.scope);
      if (!scope) return reply('未设置默认项目——先设置默认项目，或改用「记住全局 …」。');
      const item = store.remember({
        scope,
        kind: 'fact',
        value: cmd.value,
        source: { type: 'boss', ref: 'boss:command', at },
        confidence: 'confirmed',
        now: at,
      });
      return reply(
        `已记住 #${item.id}（${scope.type === 'global' ? '全局' : `项目 #${(scope as { projectId: number }).projectId}`}）：${item.value}`,
      );
    }
    if (cmd.kind === 'list') {
      const scope = scopeFor(cmd.scope);
      if (!scope) return reply('未设置默认项目——先设置默认项目，或改用「记忆列表 全局」。');
      const items = store.list({ scope, limit: 100 });
      if (items.length === 0) return reply('暂无记忆。');
      const lines = items.map((item) => `#${item.id}${item.pinned ? ' 📌' : ''} · ${item.value}`);
      return reply(`记忆（${items.length}）：\n${lines.join('\n')}`);
    }
    if (cmd.kind === 'search') {
      const scope = scopeFor(cmd.scope);
      if (!scope) return reply('未设置默认项目——先设置默认项目，或改用「搜索记忆 全局 …」。');
      const hits = store.search({ scope, text: cmd.text, limit: 20 });
      if (hits.length === 0) return reply(`没有匹配「${cmd.text}」的记忆。`);
      const lines = hits.map((hit) => `#${hit.item.id} · ${hit.snippet || hit.item.value}`);
      return reply(`记忆搜索（${hits.length}）：\n${lines.join('\n')}`);
    }
    if (cmd.kind === 'forget') {
      const item = store.get(cmd.id);
      if (!item) return reply(`未找到记忆 #${cmd.id}。`);
      if (contextProject != null && item.scope.type === 'project' && item.scope.projectId !== contextProject.id) {
        return reply(`记忆 #${cmd.id} 不属于当前项目——本条未生效。`);
      }
      store.forget(cmd.id, 'archive');
      return reply(`已忘记记忆 #${cmd.id}（软归档；历史保留）。`);
    }
    if (cmd.kind === 'promote') {
      const existing = store.get(cmd.id);
      if (!existing) return reply(`未找到记忆 #${cmd.id}。`);
      if (contextProject != null && existing.scope.type === 'project' && existing.scope.projectId !== contextProject.id) {
        return reply(`记忆 #${cmd.id} 不属于当前项目——本条未生效。`);
      }
      const item = store.promote(cmd.id, { type: 'global' }, { by: 'boss', confirmed: true, at });
      return reply(`已提升记忆 #${item.id} 为全局事实：${item.value}`);
    }
  } catch (error) {
    return reply(`记忆命令未生效：${error instanceof Error ? error.message : String(error)}`);
  }
  return reply('记忆命令未识别——本条未生效');
}

/** 高置信命令直通（不烧模型）。桌面与 IM 共用；命中即返 null。 */
async function runDirectCommand(
  deps: IpcDeps,
  text: string,
  attachments: ReturnType<typeof normalizeAttachments>,
  at: number,
  contextProjectId: number | null = null,
): Promise<ChatSendResult | null> {
  // BRK9（挂载 2）：插话直通先于语义裁定（高置信命令，不烧 token）——命中即返。
  const steerCmd = parseSteerCommand(text);
  if (steerCmd) {
    const steerResult = handleSteerCommand(deps, steerCmd, text, attachments, at);
    if (steerResult) return steerResult;
  }
  // BRK13（挂载 3）：`加预算 T1042 500000` 直通（写预算；超预算暂停的任务同时继续）。
  const budgetCmd = parseBudgetCommand(text);
  if (budgetCmd) {
    const budgetResult = await handleBudgetCommand(deps, budgetCmd, text, attachments, at);
    if (budgetResult) return budgetResult;
  }
  // N5 余账（2026-10-16）：`模型 T1042 provider/model`（或 `模型 T1042 默认`）直通（写任务级模型；白名单拦点在内）。
  const modelCmd = parseModelCommand(text);
  if (modelCmd) {
    const modelResult = await handleModelCommand(deps, modelCmd, text, attachments, at);
    if (modelResult) return modelResult;
  }
  // B6（M3-N-3）：`用技能 <名> T1042` / `取消技能 T1042` 直通（任务级强制加载；不烧模型）。
  const skillCmd = parseSkillCommand(text);
  if (skillCmd) {
    const skillResult = handleSkillCommand(deps, skillCmd, text, attachments, at);
    if (skillResult) return skillResult;
  }
  // T8b/RW-48：显式「建任务：/派任务：」直通（确定性兜底，桌面/IM 同路）。
  // 归属三级：#别名 → 上下文项目（频道范围）→ 默认项目；#别名不存在 → 返 null 走下方既有报错分支。
  const directive = parseCreateTaskDirective(text);
  if (directive) {
    const aliasProject = directive.alias
      ? deps.repo.resolverStore.getProjectByAlias(directive.alias)
      : null;
    if (directive.alias != null && aliasProject == null) {
      // 未知别名：不在此处理（让下方「别名不存在」人话分支接管）。
    } else {
      const projectId =
        aliasProject?.id ??
        contextProjectId ??
        deps.repo.resolverStore.getDefaultProject()?.id ??
        null;
      if (projectId == null) {
        const stored0 = deps.repo.insertMessage({ direction: 'in', taskId: null, content: text, attachments, now: at });
        const msg0 = '还没有默认项目——先接入/新建一个项目，或在建任务时手动选择项目。';
        deps.repo.insertMessage({ direction: 'out', taskId: null, attachments: [], content: msg0, now: at });
        deps.onInboxChanged?.();
        return { ok: true, messageId: stored0.id, resolution: { kind: 'chat' }, reply: msg0 };
      }
      const created = await handleTaskCreate(deps, {
        projectId,
        title: directive.goal.slice(0, 40),
        goal: directive.goal,
        origin: 'boss',
        via: 'directive',
      });
      const stored = deps.repo.insertMessage({ direction: 'in', taskId: created.id, content: text, attachments, now: at });
      const receipt = `已受理 ${created.shortId ?? `#${created.id}`}（目标：${directive.goal.slice(0, 120)}）。任务会按编制推进，进展看任务详情。`;
      deps.repo.insertMessage({ direction: 'out', taskId: created.id, attachments: [], content: receipt, now: at });
      deps.onInboxChanged?.();
      return {
        ok: true,
        messageId: stored.id,
        resolution: {
          kind: 'new_task',
          projectId,
          confidence: 1,
          titleGuess: directive.goal.slice(0, 40),
          via: 'semantic',
        },
        rejected: null,
      };
    }
  }
  // M2 尾（D4）：`依赖 T1042 T1000` / `移除依赖 T1042 T1000` 直通（判环＋审计；拒绝不落库）。
  const depCmd = parseDependencyCommand(text);
  if (depCmd) {
    const depResult = handleDependencyCommand(deps, depCmd, text, attachments, at);
    if (depResult) return depResult;
  }
  // GAP1：定时/事件触发命令（优先当前项目，否则默认项目；风险 L1；不烧模型）。
  const triggerCmd = parseTriggerCommand(text);
  if (triggerCmd) return handleTriggerCommand(deps, triggerCmd, text, attachments, at, contextProjectId);
  // B-6：记忆命令（老板显式写；优先当前项目，否则默认项目/全局；不烧模型）。
  const memoryCmd = parseMemoryCommand(text);
  if (memoryCmd) return handleMemoryCommand(deps, memoryCmd, text, attachments, at, contextProjectId);
  return null;
}

/** 文本是否会被高置信命令直通/标准命令处理（IM 据此决定是否先发“收到”）。 */
export function isDirectCommandText(text: string): boolean {
  return Boolean(
    parseSteerCommand(text) ||
      parseBudgetCommand(text) ||
      parseModelCommand(text) ||
      parseSkillCommand(text) ||
      parseDependencyCommand(text) ||
      parseTriggerCommand(text) ||
      parseMemoryCommand(text) ||
      parseCommand(text),
  );
}

/** 直通命令最后写入的一条 out 消息就是回执文本（IM 要把它发回手机）。 */
function latestOutgoingText(deps: IpcDeps): string | null {
  const row = deps.repo.listMessages({ limit: 1, latest: true })[0];
  return row && row.direction === 'out' ? row.content : null;
}

/** `chat:send`：命令直通与归属裁定都在 `handleInboundChat`（桌面/IM 单一入口）。 */
export async function handleChatSend(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): Promise<ChatSendResult> {
  const input = (raw ?? {}) as { text?: unknown; attachments?: unknown; replyTo?: unknown; projectId?: unknown };
  const text = typeof input.text === 'string' ? input.text : '';
  const attachments = normalizeAttachments(input.attachments);
  const projectId = typeof input.projectId === 'number' && Number.isFinite(input.projectId) ? input.projectId : null;
  const inbound: Inbound = {
    source: 'desktop',
    conversationRef: 'desktop:boss',
    platformMsgId: null,
    replyToMsgId: typeof input.replyTo === 'string' ? input.replyTo : null,
    text,
    receivedAt: at,
  };
  return handleInboundChat(deps, inbound, at, attachments, { awaitAssistant: false, projectId });
}

export interface InboundChatOptions {
  /** IM 需要拿到幕僚长回复文本再发回平台；桌面保持 fire-and-forget（不阻塞 IPC）。 */
  awaitAssistant?: boolean;
  /** D-19：桌面当前选中项目（任务消息仍以任务的 project_id 优先）。 */
  projectId?: number | null;
}

export interface InboundChatResult {
  ok: true;
  messageId: number;
  resolution: Resolution;
  /** `new_task` 实际建出的任务 id；其他裁定为 null。 */
  createdTaskId: number | null;
  /** `awaitAssistant:true` 时的幕僚长回复；否则 null。 */
  reply: string | null;
  /** UG-03：命令被拒绝时的人话原因（回执已落频道；渲染层据此就地显示，不当成功）。 */
  rejected?: string | null;
}

const COMMAND_LABEL: Record<string, string> = {
  list: '列表',
  daily: '日报',
  pause: '暂停',
  resume: '继续',
  archive: '归档',
  finish: '结束',
  renew: '续办',
};

/**
 * 标准命令执行器（`parseCommand` 的 7 条；桌面/IM 同源）。
 * 只在 `resolveInbound` 已把「任务焦点/短号」解析成 `command` 后调用。
 */
async function executeResolvedCommand(
  deps: IpcDeps,
  resolution: Extract<Resolution, { kind: 'command' }>,
  rawText: string,
  attachments: AttachmentMeta[],
  at: number,
): Promise<InboundChatResult> {
  const taskId = resolution.taskId ?? null;
  const stored = deps.repo.insertMessage({ direction: 'in', taskId, content: rawText, attachments, now: at });
  const reply = (content: string, replyTaskId: number | null = taskId): InboundChatResult => {
    deps.repo.insertMessage({ direction: 'out', taskId: replyTaskId, attachments: [], content, now: at });
    deps.onInboxChanged?.();
    return { ok: true, messageId: stored.id, resolution, createdTaskId: null, reply: content };
  };
  const label = COMMAND_LABEL[resolution.name] ?? resolution.name;
  const needTask = (): InboundChatResult => reply(`「${label}」需要任务短号（如：${label} T1042）。`);
  const task = taskId != null ? deps.repo.getTask(taskId) : null;
  const dispatch = async (event: string): Promise<string> => {
    if (!deps.engine) return '引擎未就绪（主进程未装配）——本条未生效';
    try {
      await deps.engine.dispatch({ scope: 'task', id: taskId as number, event, actor: 'boss', payload: { via: 'command' } });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  if (resolution.name === 'list') {
    const rows = deps.repo
      .listReports({ state: 'pending', limit: 50, latest: true })
      .filter((r) => r.kind === 'ask' || r.kind === 'report' || r.kind === 'alert')
      .slice()
      .reverse();
    if (rows.length === 0) return reply('暂无待你处理的事项。');
    const lines = rows.map((r, index) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const title =
        (typeof payload.title === 'string' && payload.title) ||
        (typeof payload.question === 'string' && payload.question) ||
        (typeof payload.summary === 'string' && payload.summary) ||
        '（无标题）';
      const anchor = r.shortId ?? (r.taskId != null ? `#${r.taskId}` : '全局');
      return `${index + 1}. ${anchor} · ${title}`;
    });
    return reply(`待你处理（${rows.length}）：\n${lines.join('\n')}\n去「待我处理」点选处理。`, null);
  }

  if (resolution.name === 'daily') {
    if (!deps.db) return reply('日报不可用：主进程数据库未接线。', null);
    const { content } = emitDailyDigest(deps.db, { now: at });
    return reply(digestText(content), null);
  }

  if (taskId == null || !task) return needTask();

  if (resolution.name === 'pause') {
    if (task.state === 'paused') return reply(`${task.shortId ?? `#${task.id}`} 已经是暂停状态。`);
    const error = await dispatch('pause');
    return reply(error ? `暂停失败：${error}` : `已暂停 ${task.shortId ?? `#${task.id}`}。`);
  }
  if (resolution.name === 'resume') {
    if (task.state !== 'paused') return reply(`${task.shortId ?? `#${task.id}`} 当前不是暂停状态（${task.state}）。`);
    const error = await dispatch('resume');
    return reply(error ? `继续失败：${error}` : `已继续 ${task.shortId ?? `#${task.id}`}。`);
  }
  if (resolution.name === 'archive') {
    if (!['done', 'failed', 'cancelled'].includes(task.state)) {
      return reply(`只有终态任务可归档（当前 ${task.state}）。`);
    }
    const error = await dispatch('archive');
    return reply(error ? `归档失败：${error}` : `已归档 ${task.shortId ?? `#${task.id}`}。`);
  }
  if (resolution.name === 'renew') {
    if (!['done', 'failed', 'cancelled'].includes(task.state)) {
      return reply(`只有终态任务可续办（当前 ${task.state}）。`);
    }
    const error = await dispatch('renew');
    return reply(error ? `续办失败：${error}` : `已为 ${task.shortId ?? `#${task.id}`} 创建续办任务。`);
  }
  if (resolution.name === 'finish') {
    const event =
      task.state === 'executing'
        ? 'finish_manual'
        : task.state === 'paused' || task.state === 'failed'
          ? 'finish'
          : null;
    if (event == null) {
      return reply(
        task.state === 'verifying'
          ? '验证中的任务请先在任务详情完成验收或取消。'
          : `当前状态不支持结束（${task.state}）。`,
      );
    }
    const error = await dispatch(event);
    return reply(error ? `结束失败：${error}` : `已结束 ${task.shortId ?? `#${task.id}`}（完成收尾）。`);
  }
  return needTask();
}

/**
 * 桌面与 IM 共用的入站处理核心（命令 → 归位 → 建任务 → 落消息 → 幕僚长）。
 *
 * IM 只负责把平台消息归一成 `Inbound` 并调用本函数；归属/建任务/审批逻辑不复制第二份。
 * 高置信命令（插话/预算/模型/技能/依赖/触发 + 标准 7 条）也在这里执行——桌面与微信同一条路。
 */
export async function handleInboundChat(
  deps: IpcDeps,
  inbound: Inbound,
  at: number,
  attachments: AttachmentMeta[],
  options: InboundChatOptions = {},
): Promise<InboundChatResult> {
  const text = inbound.text;
  // B2-2（D-30①）：分诊模式开关——assistant（缺省）用零 LLM 的恒 chat 信号（自由文本全交
  // 幕僚长分诊，不再调用语义分诊器）；classifier 保持 v0.2.1 旧链路（可回退面）。
  const triageMode = deps.triageMode ?? readTriageMode(process.env['AICO_TRIAGE']);
  const classify =
    triageMode === 'classifier' ? (deps.classify ?? defaultClassify) : assistantTriageClassify;

  // 高置信命令直通（桌面/IM 同一入口）：命中即执行并返回回执，不做语义裁定。
  if (text.trim().length > 0) {
    const direct = await runDirectCommand(deps, text, attachments, at, options.projectId ?? null);
    if (direct) {
      deps.onInboxChanged?.();
      return {
        ok: true,
        messageId: direct.messageId,
        resolution: direct.resolution,
        createdTaskId: null,
        reply: latestOutgoingText(deps),
        rejected: direct.rejected ?? null,
      };
    }
  }

  // 明确的项目别名但项目不存在 → 直接报错，不落到语义分类（否则可能误建到默认项目）。
  const leadingAlias = /^\s*#([^\s#]+)/.exec(text)?.[1];
  if (leadingAlias) {
    const alias = extractProjectAlias(text);
    if (alias && !deps.repo.resolverStore.getProjectByAlias(alias)) {
      const stored = deps.repo.insertMessage({ direction: 'in', taskId: null, content: text, attachments, now: at });
      const message = `没有找到项目别名「#${alias}」——先建项目/设别名，或去掉开头的 # 按普通消息发。`;
      deps.repo.insertMessage({ direction: 'out', taskId: null, attachments: [], content: message, now: at });
      deps.onInboxChanged?.();
      return { ok: true, messageId: stored.id, resolution: { kind: 'chat' }, createdTaskId: null, reply: message };
    }
  }

  let resolution: Resolution;
  try {
    resolution = await resolveInbound(inbound, deps.repo.resolverStore, classify);
  } catch (error) {
    console.error('[ipc] chat:send: resolveInbound 失败，回退 chat', error);
    resolution = { kind: 'chat' };
  }

  // B2-2（D-30①）：assistant 模式下，自由文本的 new_task 裁定（semantic/address）
  // **不执行建任务**——唯一指挥脑是幕僚长（create_task 工具自行分诊）。确定性路径
  // （命令/#引用/回复链/序号确认/「建任务：」直通）不经此转换、双模式一致。
  if (triageMode === 'assistant' && resolution.kind === 'new_task' && (resolution.via === 'semantic' || resolution.via === 'address')) {
    console.log('[ipc] triage=assistant：自由文本交幕僚长分诊（不再自动建任务/不再调用语义分诊器）');
    // 别名寻址解析出的项目随消息带给幕僚长（老板显式点名了项目；幕僚长 create_task 可直接用）。
    resolution = { kind: 'chat', projectId: resolution.projectId ?? null };
  }

  // 标准 7 条命令（`列表/日报/暂停/继续/归档/结束/续办`）由 resolver 归位后执行。
  if (resolution.kind === 'command') {
    return executeResolvedCommand(deps, resolution, text, attachments, at);
  }

  // BRK17 深件（挂载 3 余）：`confirm` 裁定**落编排器**——登记「只问一次」候选清单（`pending_lists`）
  // ＋问题落 out 消息上屏（编号选项；回序号走 resolver 第 2 步精确解析）。
  // 此前该裁定零执行方：归属拿不准的消息被静默当常规消息处理（「只问一次」的承诺没兑现）。
  if (resolution.kind === 'confirm' && text.trim().length > 0) {
    try {
      deps.repo.resolverStore.setPendingList(inbound.source, inbound.conversationRef ?? '', {
        messageRef: `confirm:${at}`,
        items: resolution.options.map((option) => ({
          index: option.index,
          taskId: option.then.kind === 'task_message' ? option.then.taskId : null,
          reportId: null,
          // 「新建任务」选项把**原话**记进 `titleGuess`：回序号（如「1」）时目标＝原话，不是「1」本身。
          then:
            option.then.kind === 'new_task'
              ? { ...option.then, titleGuess: option.then.titleGuess ?? text.trim().slice(0, 80) }
              : option.then,
        })),
        ttlMs: 15 * 60 * 1000,
      });
    } catch (error) {
      console.error('[ipc] chat:send: 登记待问清单失败（问题仍上屏，不静默）', error);
    }
    const optionsText = resolution.options.map((option) => `${option.index}) ${option.label}`).join('\n');
    deps.repo.insertMessage({
      direction: 'out',
      taskId: null,
      content: `${resolution.question}\n${optionsText}\n回序号即可（只问一次；回别的就当重新说明）。`,
      now: at,
    });
  }

  // BRK17 深件：**回复链打到已归档终态任务** → `reopen_reply`（FLOWS §3.1.1：提议续办，口头一次确认）。
  // 卡文案给现成指令（`续办 T-xxxx`）；只对终态+已归档派发——已在 needs_decision 的既有提议不重复。
  if (resolution.kind === 'task_message' && resolution.via === 'reply' && deps.engine) {
    const target = deps.repo.getTask(resolution.taskId);
    if (target && target.archived === 1 && isTerminal(target.state as TaskState)) {
      try {
        await deps.engine.dispatch({
          scope: 'task',
          id: target.id,
          event: 'reopen_reply',
          actor: 'boss',
          payload: {
            archived: true,
            question: `任务 ${target.shortId ?? `#${target.id}`} 已归档。要续办吗？回复「续办 ${target.shortId ?? target.id}」开一个引用它的新任务；或说「不用」关掉这条。`,
            urgent: false,
            notifyRevision: at,
            via: 'reply',
          },
        });
      } catch (error) {
        console.error('[ipc] chat:send: reopen_reply 派发失败（消息照落，不静默）', error);
      }
    }
  }

  // D0（链路审计）：**执行 `new_task` 裁定**——此前只落消息、裁定没人执行 ⇒「在频道里说一句话不会变成任务」
  // （楔子的入口断在第一环）。现在：建任务（`handleTaskCreate` 内含 D1 自动分诊 → 进 planning）
  // ＋ **本条消息挂到新任务上**（老板原话＝任务的第一个输入）。
  // 建任务失败**不静默**（响亮报错），消息照落（绝不丢用户输入）。
  let createdTaskId: number | null = null;
  let createdTaskShortId: string | null = null;
  let createdTaskGoal = '';
  if (resolution.kind === 'new_task' && text.trim().length > 0) {
    // 序号回执（confirm 选项被回「1」）时目标＝登记时记下的原话（`titleGuess`），不是序号本身。
    const ordinalOnly = /^\s*\d{1,2}\s*[.、]?\s*$/.test(text);
    const goalText = ordinalOnly && resolution.titleGuess ? resolution.titleGuess : text.trim();
    createdTaskGoal = goalText;
    try {
      // 标题去掉开头的 `#项目别名`（goal 保留原话；标题只做人话摘要）。
      const titleGuess = goalText.replace(/^\s*#[^\s#]+\s*/, '').trim().slice(0, 40);
      const task = await handleTaskCreate(deps, {
        goal: goalText,
        ...(titleGuess.length > 0 ? { title: titleGuess } : {}),
        ...(resolution.projectId != null ? { projectId: resolution.projectId } : {}),
      });
      createdTaskId = task.id;
      createdTaskShortId = task.shortId ?? null;
    } catch (error) {
      console.error('[ipc] chat:send: new_task 建任务失败（消息照落，不静默）', error);
    }
  }

  const stored = deps.repo.insertMessage({
    direction: 'in',
    taskId: createdTaskId ?? resolutionTaskId(resolution),
    content: text,
    attachments,
    now: at,
  });
  // IM 入站消息也要实时上屏（evt:inbox → loadChannel）；桌面同样无害。
  deps.onInboxChanged?.();

  // UG-04：建任务消息的附件 → 任务输入资产（复制 + 登记 artifacts.kind='input'）。
  const inputAttachments =
    createdTaskId != null
      ? registerTaskInputArtifacts(deps, createdTaskId, stored.id, attachments, at)
      : { registered: 0, errors: [] as string[] };

  // 建任务消息**不再交给频道幕僚长**：否则同一条消息既建任务又让幕僚长在频道里跑一轮
  // （2026-10-20 真机：幕僚长替任务写文件、IM 队列被几分钟的回合堵住，后续消息看起来失联）。
  // 任务引擎负责规划/执行；这里只给一条受理回执（桌面/IM 同源）。
  if (createdTaskId != null) {
    const label = createdTaskShortId ?? `#${createdTaskId}`;
    const goalPreview = createdTaskGoal.replace(/\s+/g, ' ').trim().slice(0, 120);
    const receipt = `已受理 ${label}${goalPreview.length > 0 ? `（目标：${goalPreview}）` : ''}。任务会按编制推进，进展看任务详情。`;
    const attachmentNote =
      inputAttachments.registered > 0
        ? ` 附件已归档 ${inputAttachments.registered}/${attachments.length} 个。`
        : '';
    const attachmentError =
      inputAttachments.errors.length > 0 ? ` 附件归档未完成：${inputAttachments.errors.join('；')}` : '';
    deps.repo.insertMessage({
      direction: 'out',
      taskId: createdTaskId,
      attachments: [],
      content: `${receipt}${attachmentNote}${attachmentError}`,
      now: at,
    });
    deps.onInboxChanged?.();
    return { ok: true, messageId: stored.id, resolution, createdTaskId, reply: `${receipt}${attachmentNote}${attachmentError}` };
  }

  // 幕僚长真实会话：桌面 **fire-and-forget**（DEV §7.6：长任务不阻塞 IPC）；
  // IM 需要回复文本发回手机，`awaitAssistant:true` 时等这一轮（同一会话已串行，不会乱序）。
  // 缺 key 时 `assistant` 为 null（启动时已明确报错，不 mock）。
  let reply: string | null = null;
  const assistantTaskId = resolutionTaskId(resolution);
  // B2-2：assistant 模式下别名寻址（#记账 …）解析出的项目作为本轮助手范围（老板显式点名）。
  const assistantProjectId =
    options.projectId ?? (resolution.kind === 'chat' ? (resolution.projectId ?? null) : null);
  // P0/F-N02（S13-E 对抗审查）：幕僚长不可用/失败不得只进控制台——写一条频道回执，
  // 让老板知道「没回复是因为缺 Key/模型」，而不是对着转圈干等。
  const reportAssistantFailure = (detail: string): void => {
    try {
      deps.repo.insertMessage({
        direction: 'out',
        taskId: assistantTaskId,
        attachments: [],
        content: `⚠ 幕僚长没有回复：${detail}。请到「设置 → 模型与员工 → 供应商」检查 Key 与模型配置后重发。`,
        now: at,
      });
      deps.onInboxChanged?.();
    } catch {
      /* 回执写入失败不覆盖原始错误 */
    }
  };
  if (deps.assistant && text.length > 0) {
    if (options.awaitAssistant) {
      try {
        const run = await deps.assistant.runTurn({ text, taskId: assistantTaskId, projectId: assistantProjectId });
        reply = typeof run.reply === 'string' ? run.reply : null;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[ipc] 幕僚长 runTurn 失败:', detail);
        reportAssistantFailure(detail);
      }
    } else {
      void deps.assistant
        .runTurn({ text, taskId: assistantTaskId, projectId: assistantProjectId })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error('[ipc] 幕僚长 runTurn 失败:', detail);
          reportAssistantFailure(detail);
        });
    }
  }

  return { ok: true, messageId: stored.id, resolution, createdTaskId, reply };
}

export function handleChatList(deps: IpcDeps, raw: unknown): HumanMessageDTO[] {
  const query = (raw ?? {}) as { taskId?: number; limit?: number; latest?: unknown };
  return deps.repo
    .listMessages({ taskId: query.taskId, limit: query.limit ?? 100, latest: query.latest === true })
    .map(toMessageDTO);
}

export function handleInboxList(deps: IpcDeps, raw: unknown): ReportDTO[] {
  const query = (raw ?? {}) as { limit?: number; state?: string; kind?: string; latest?: unknown };
  return deps.repo
    .listReports({ limit: query.limit ?? 50, state: query.state, kind: query.kind, latest: query.latest === true })
    .map(toReportDTO);
}

/**
 * M2 尾（G-D）：跨项目全局搜索（只读；任务/消息/产物各 ≤6）。
 * 空查询 → 空结果（不主动罗列全库）；D1：只接受关键词，不接受任何路径。
 */
export function handleGlobalSearch(deps: IpcDeps, raw: unknown): ReturnType<ChatRepo['globalSearch']> & { notes?: Array<{ name: string; preview: string; type: string; projectId: number | null; projectName: string | null }> } {
  const input = (raw ?? {}) as { query?: unknown };
  const result = deps.repo.globalSearch(typeof input.query === 'string' ? input.query : '');
  try {
    const query = typeof input.query === 'string' ? input.query : '';
    if (query.trim().length > 0 && deps.db != null) {
      // 必须用静态导入（notesModule，文件底部 import、ESM 提升）：运行时 require 的相对路径在打包后不存在，
      // 会被下面的 catch 吞掉 → 笔记永远进不了全局搜索（G-7 回归锚点）。
      const notesMod = notesModule;
      const rawProjects = (deps.db as NonNullable<IpcDeps['db']>)
        .prepare('SELECT id, name, root_dir FROM projects WHERE archived = 0')
        .all() as Array<{ id: number; name: string; root_dir: string }>;
      const projects = rawProjects.map((pr) => ({ id: pr.id, name: pr.name, rootDir: pr.root_dir }));
      const dbPath = (deps.db as NonNullable<IpcDeps['db']>).name;
      const globalDir = dbPath === ':memory:' ? join(process.cwd(), '.aico-notes') : join(dbPath, '..', 'notes');
      const noteHits = notesMod.searchNotes({ query, projects, globalDir });
      return { ...result, notes: noteHits.map((h) => ({ name: h.name, preview: h.preview, type: h.type, projectId: h.projectId, projectName: h.projectName })) };
    }
  } catch { /* notes 搜索失败不阻塞 */ }
  return result;
}

/**
 * OPT-AI-9：技能库列表（只读；`includeDisabled` 缺省 false）。
 */
export function handleSkillsList(deps: IpcDeps, raw: unknown): ReturnType<ChatRepo['listSkills']> {
  const input = (raw ?? {}) as { includeDisabled?: unknown };
  return deps.repo.listSkills(input.includeDisabled === true);
}

/**
 * OPT-AI-9：注册/更新技能（老板显式给名字与 `SKILL.md` 路径；**文件必须真实存在**，不登记幽灵技能）。
 * 员工勾选走 `employee:update.skills`（id 或名字）；项目默认走 `projects.default_skills`。
 */
export function handleSkillsSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; skill: ReturnType<ChatRepo['upsertSkill']> } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    name?: unknown;
    description?: unknown;
    source?: unknown;
    path?: unknown;
    version?: unknown;
    enabled?: unknown;
  };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (name.length === 0 || path.length === 0) {
    return { ok: false, code: 'bad_request', message: '需要 { name, path }（均非空；path 指向 SKILL.md）' };
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { ok: false, code: 'missing_file', message: `技能文件不存在或不是文件：${path}` };
  }
  const existing = deps.repo.listSkills(true).find((row) => row.name === name);
  if (existing?.source === 'builtin') {
    return { ok: false, code: 'builtin', message: `与内置技能重名：${name}（内置不可覆盖/删除，可停用）` };
  }
  const skill = deps.repo.upsertSkill({
    name,
    path,
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(typeof input.source === 'string' && input.source.trim().length > 0 ? { source: input.source.trim() } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  });
  return { ok: true, skill };
}

/** GAP7：`skills:set` 的安装/启停/删除动作（与旧 `{name,path}` 注册共存；同通道，不新增 IPC）。 */
export function isSkillAction(raw: unknown): boolean {
  const action = (raw as { action?: unknown } | null)?.action;
  return typeof action === 'string' && ['install-local', 'install-url', 'toggle', 'remove'].includes(action);
}

/**
 * GAP7 动作面：
 *  - `install-local`：`{path?}`；无 path → 主进程目录选择器（renderer 不传路径）；
 *  - `install-url`：`{url}`（直接 .md 或 Git 仓库；只允许 http(s)）；
 *  - `toggle`：`{id, enabled}`（内置可停用）；
 *  - `remove`：`{id}`（内置/被引用显式拒；受管目录内文件一并清理）。
 */
export async function handleSkillAction(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): Promise<
  | { ok: true; installed?: unknown[]; errors?: string[]; skill?: unknown; removed?: string }
  | { ok: false; code: string; message: string }
> {
  const input = (raw ?? {}) as {
    action?: unknown;
    path?: unknown;
    url?: unknown;
    id?: unknown;
    enabled?: unknown;
  };
  const action = input.action;
  if (action === 'toggle') {
    if (typeof input.id !== 'number' || !Number.isInteger(input.id) || typeof input.enabled !== 'boolean') {
      return { ok: false, code: 'bad_request', message: 'toggle 需要 { id, enabled }' };
    }
    const skill = deps.repo.setSkillEnabled(input.id, input.enabled);
    if (!skill) return { ok: false, code: 'not_found', message: `技能不存在：#${input.id}` };
    return { ok: true, skill };
  }
  if (action === 'remove') {
    if (typeof input.id !== 'number' || !Number.isInteger(input.id)) {
      return { ok: false, code: 'bad_request', message: 'remove 需要 { id }' };
    }
    const res = deps.repo.removeSkill(input.id);
    if (!res.ok) return res;
    const root = deps.skillsDir?.();
    if (root) {
      try {
        const skillPath = resolve(res.skill.path);
        const managed = resolve(root);
        if (skillPath === managed || skillPath.startsWith(`${managed}${sep}`)) {
          rmSync(dirname(skillPath), { recursive: true, force: true });
        }
      } catch (error) {
        // 文件清理失败不撤销 DB 删除，但必须可见。
        return { ok: false, code: 'file_cleanup_failed', message: `登记已删，但文件清理失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { ok: true, removed: res.skill.name };
  }

  const installRoot = deps.skillsDir?.();
  const skillDb = deps.db;
  if (!installRoot || !skillDb) {
    return { ok: false, code: 'install_unavailable', message: '技能受管目录/数据库未接线（主进程未注入 skillsDir/db）' };
  }
  if (action === 'install-local') {
    let sourcePath = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : null;
    if (sourcePath == null) {
      const pick = deps.pickSkillDirectory ?? deps.pickDirectory;
      if (!pick) return { ok: false, code: 'pick_unavailable', message: '目录选择器未接线' };
      sourcePath = await pick();
      if (sourcePath == null) return { ok: false, code: 'cancelled', message: '已取消' };
    }
    try {
      const res = installSkillsFromDirectory({ db: skillDb, sourceDir: sourcePath, installRoot, now: at });
      return { ok: true, installed: res.installed, errors: res.errors };
    } catch (error) {
      return { ok: false, code: 'install_failed', message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action === 'install-url') {
    if (typeof input.url !== 'string' || input.url.trim().length === 0) {
      return { ok: false, code: 'bad_request', message: 'install-url 需要 { url }' };
    }
    try {
      const res = await installSkillsFromUrl({ db: skillDb, url: input.url.trim(), installRoot, now: at });
      return { ok: true, installed: res.installed, errors: res.errors };
    } catch (error) {
      return { ok: false, code: 'install_failed', message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, code: 'bad_request', message: `未知技能动作：${String(action)}` };
}

/**
 * OPT-AI-10：MCP server 列表（只读；`includeDisabled` 缺省 false）。
 */
export function handleMcpList(deps: IpcDeps, raw: unknown): ReturnType<ChatRepo['listMcpServers']> {
  const input = (raw ?? {}) as { includeDisabled?: unknown };
  return deps.repo.listMcpServers(input.includeDisabled === true);
}

/**
 * OPT-AI-10：注册/更新 MCP server（老板显式给 transport/command|url；凭据在 env，不打印）。
 * stdio 必须有 command；http 必须有 url；enabled 缺省 true。连不上不在注册时判断（调用时如实报错）。
 */
export function handleMcpSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; server: ReturnType<ChatRepo['upsertMcpServer']> } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    name?: unknown;
    transport?: unknown;
    command?: unknown;
    args?: unknown;
    url?: unknown;
    env?: unknown;
    exposure?: unknown;
    hasExternalActions?: unknown;
    enabled?: unknown;
  };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const transport = input.transport === 'http' ? 'http' : input.transport === 'stdio' ? 'stdio' : null;
  if (name.length === 0 || transport == null) {
    return { ok: false, code: 'bad_request', message: '需要 { name, transport: "stdio"|"http" }' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return { ok: false, code: 'bad_request', message: 'name 只允许字母/数字/._-（≤64，首字符非符号）' };
  }
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (transport === 'stdio' && command.length === 0) {
    return { ok: false, code: 'bad_request', message: 'stdio MCP 需要 command' };
  }
  if (transport === 'http') {
    if (url.length === 0) return { ok: false, code: 'bad_request', message: 'http MCP 需要 url' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, code: 'bad_request', message: 'http MCP 的 url 非法' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, code: 'bad_request', message: 'http MCP 只支持 http(s) url' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, code: 'bad_request', message: 'url 不得包含凭据（请放 env）' };
    }
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    return { ok: false, code: 'bad_request', message: 'args 需为字符串数组' };
  }
  if (Array.isArray(input.args) && input.args.some((v) => typeof v !== 'string')) {
    return { ok: false, code: 'bad_request', message: 'args 只能包含字符串' };
  }
  const args = Array.isArray(input.args) ? (input.args as string[]) : [];
  if (input.env !== undefined && (input.env == null || typeof input.env !== 'object' || Array.isArray(input.env))) {
    return { ok: false, code: 'bad_request', message: 'env 需为对象（key→字符串）' };
  }
  const env: Record<string, string> = {};
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) {
        return { ok: false, code: 'bad_request', message: `env 变量名非法：${k}` };
      }
      if (typeof v !== 'string' || v.length > 4096) {
        return { ok: false, code: 'bad_request', message: `env.${k} 需为字符串（≤4096）` };
      }
      env[k] = v;
    }
  }
  if (input.exposure !== undefined) {
    if (!['auto', 'direct', 'deferred', 'codemode'].includes(String(input.exposure))) {
      return { ok: false, code: 'bad_request', message: 'exposure 需为 auto/direct/deferred/codemode' };
    }
  }
  if (input.hasExternalActions !== undefined && typeof input.hasExternalActions !== 'boolean') {
    return { ok: false, code: 'bad_request', message: 'hasExternalActions 需为布尔' };
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { ok: false, code: 'bad_request', message: 'enabled 需为布尔' };
  }
  const server = deps.repo.upsertMcpServer({
    name,
    transport,
    ...(transport === 'stdio' ? { command } : { url }),
    args,
    env,
    ...(input.exposure === 'auto' || input.exposure === 'direct' || input.exposure === 'deferred' || input.exposure === 'codemode'
      ? { exposure: input.exposure }
      : {}),
    ...(typeof input.hasExternalActions === 'boolean' ? { hasExternalActions: input.hasExternalActions } : {}),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  });
  return { ok: true, server };
}

/** GAP6：`mcp:set` 的启停/删除动作（同通道，不新增 IPC）。 */
export function isMcpAction(raw: unknown): boolean {
  const action = (raw as { action?: unknown } | null)?.action;
  return action === 'toggle' || action === 'remove';
}

export function handleMcpAction(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; server: ReturnType<ChatRepo['listMcpServers']>[number]; removed?: string } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { action?: unknown; id?: unknown; enabled?: unknown };
  if (typeof input.id !== 'number' || !Number.isInteger(input.id)) {
    return { ok: false, code: 'bad_request', message: 'mcp 动作需要 { id }' };
  }
  if (input.action === 'toggle') {
    if (typeof input.enabled !== 'boolean') {
      return { ok: false, code: 'bad_request', message: 'toggle 需要 { id, enabled }' };
    }
    const server = deps.repo.setMcpServerEnabled(input.id, input.enabled);
    if (!server) return { ok: false, code: 'not_found', message: `MCP server 不存在：#${input.id}` };
    return { ok: true, server };
  }
  if (input.action === 'remove') {
    const res = deps.repo.removeMcpServer(input.id);
    if (!res.ok) return res;
    return { ok: true, server: res.server, removed: res.server.name };
  }
  return { ok: false, code: 'bad_request', message: `未知 MCP 动作：${String(input.action)}` };
}

/**
 * OPT-M4-1 产品化：接缝矩阵（边界枚举 × 本项目登记行；未登记边界显式列入 `missing`）。
 * 只读；不替项目自动造行（不臆造覆盖证据）。
 */
export function handleSeamsList(deps: IpcDeps, raw: unknown): {
  boundaries: readonly string[];
  rows: ReturnType<ChatRepo['seamRows']>;
  missing: string[];
} {
  const input = (raw ?? {}) as { projectId?: unknown };
  const projectId = typeof input.projectId === 'number' && Number.isInteger(input.projectId) ? input.projectId : undefined;
  const rows = deps.repo.seamRows(projectId);
  return {
    boundaries: SEAM_BOUNDARIES,
    rows,
    missing: SEAM_BOUNDARIES.filter((b) => !rows.some((row) => row.boundary === b)),
  };
}

/**
 * R2-2（G7）`mailbox:list`：**未结的同事提问**（问答面；老板可代答）。
 * 只读投影；空 → `[]`（渲染层显空态，不臆造）。
 */
export function handleMailboxList(deps: IpcDeps): MailboxAskDTO[] {
  return deps.repo.listOpenAsks();
}

/**
 * R2-2（G7）`mailbox:answer`：老板代答一条提问（`via='boss'`——**不把老板的话记到员工名下**）。
 * 入参：`{askDedupeKey, answer}`；答复空/非串 → `bad_request`；找不到待答提问 → `E_ASK_NOT_FOUND`；重复作答幂等（`delivered:false`）。
 */
export async function handleMailboxAnswer(
  deps: IpcDeps,
  raw: unknown,
  now: number,
): Promise<{ ok: true; delivered: boolean } | { ok: false; code: string; message: string }> {
  const input = (raw ?? {}) as { askDedupeKey?: unknown; answer?: unknown };
  if (typeof input.askDedupeKey !== 'string' || input.askDedupeKey.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'askDedupeKey is required' };
  }
  if (typeof input.answer !== 'string' || input.answer.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'answer 必须是非空文本' };
  }
  const askDedupeKey = input.askDedupeKey.trim();
  const ask = deps.repo.listOpenAsks().find((a) => a.askDedupeKey === askDedupeKey);
  try {
    const res = deps.repo.answerAskAsBoss({ askDedupeKey, answer: input.answer.trim(), now });
    // 阻塞式 mailbox（M2 尾）：答复真落地后，把停在 `blocked` 的件放回队列（幂等：重复作答
    // `delivered=false` 不再派发；答复本身已通过未读回灌进下一轮简报）。
    if (res.delivered && ask?.blocking === true && ask.workItemId != null && deps.engine) {
      try {
        await deps.engine.dispatch({
          scope: 'work_item',
          id: ask.workItemId,
          event: 'answer_received',
          actor: 'system',
          payload: { askDedupeKey },
        });
      } catch (error) {
        // 答复已落库（不能因件状态异常丢答复）；件没回队必须可见。
        console.error('[ipc] mailbox:answer 后放回工作项失败（答复已落库，件仍停在 blocked）', error);
      }
    }
    return { ok: true, delivered: res.delivered };
  } catch (error) {
    if (error instanceof MailboxError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * M2 尾：员工招募 / 改档（**写入口**）。
 *
 * 口径：
 *  - 招募/改档是**人**的动作（老板在设置/频道触发），不是员工自主行为；
 *  - **项目白名单拦点**：模型供应商必须落在该员工所属项目（编制默认员工/默认负责人）的
 *    `allowed_providers` 内；招募时可显式给 `projectId` 先行校验；
 *  - 停用前不得有在跑/排队件（DAO 守卫）；幕僚长不可停用；
 *  - 校验不过**拒且不落库**，回执说人话（不静默）。
 */
function parseEmployeeRefs(value: unknown): Array<string | number> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v)))
    .map((v) => (typeof v === 'number' ? v : v.trim()))
    .filter((v) => v !== '');
}

export function handleEmployeeRecruit(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; employee: EmployeeDetailDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    name?: unknown;
    role?: unknown;
    persona?: unknown;
    model?: unknown;
    thinking?: unknown;
    skills?: unknown;
    mcps?: unknown;
    capabilityTier?: unknown;
    projectId?: unknown;
  };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const role = typeof input.role === 'string' ? input.role.trim() : '';
  if (name.length === 0 || role.length === 0) {
    return { ok: false, code: 'bad_request', message: '招募需要 name 与 role（均非空）' };
  }
  const model = typeof input.model === 'string' && input.model.trim().length > 0 ? input.model.trim() : null;
  if (model) {
    const projectId = typeof input.projectId === 'number' && Number.isInteger(input.projectId) ? input.projectId : null;
    const project = projectId != null ? deps.repo.getProject(projectId) : null;
    if (projectId != null && !project) return { ok: false, code: 'not_found', message: `项目不存在：#${projectId}` };
    const error = modelWhitelistError({
      model,
      allowedProviders: project?.allowedProviders ?? [],
      projectLabel: project?.name ?? null,
    });
    if (error) return { ok: false, code: 'whitelist', message: error };
  }
  const thinking = input.thinking === undefined ? undefined : input.thinking == null ? null : String(input.thinking);
  if (thinking != null && !['off', 'low', 'medium', 'high'].includes(thinking)) {
    return { ok: false, code: 'bad_value', message: '思考强度需为 off / low / medium / high 或清空' };
  }
  const capabilityTier = input.capabilityTier === undefined ? undefined : String(input.capabilityTier);
  if (capabilityTier != null && !['sandbox', 'standard', 'trusted'].includes(capabilityTier)) {
    return { ok: false, code: 'bad_value', message: '能力档需为 sandbox / standard / trusted' };
  }
  const employee = deps.repo.recruitEmployee({
    name,
    role,
    ...(typeof input.persona === 'string' ? { persona: input.persona } : {}),
    model,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(input.skills !== undefined ? { skills: parseEmployeeRefs(input.skills) ?? [] } : {}),
    ...(input.mcps !== undefined ? { mcps: parseEmployeeRefs(input.mcps) ?? [] } : {}),
    ...(capabilityTier !== undefined ? { capabilityTier } : {}),
  });
  if (!employee) return { ok: false, code: 'write_failed', message: '招募写入后回读失败' };
  return { ok: true, employee };
}

export function handleEmployeeUpdate(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; employee: EmployeeDetailDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    employeeId?: unknown;
    name?: unknown;
    role?: unknown;
    persona?: unknown;
    model?: unknown;
    thinking?: unknown;
    skills?: unknown;
    mcps?: unknown;
    capabilityTier?: unknown;
    active?: unknown;
  };
  const employeeId = Number(input.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 0) {
    return { ok: false, code: 'bad_request', message: '需要 { employeeId }（非负整数；幕僚长=0）' };
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim().length === 0)) {
    return { ok: false, code: 'bad_value', message: '员工名字不能为空' };
  }
  if (input.role !== undefined && (typeof input.role !== 'string' || input.role.trim().length === 0)) {
    return { ok: false, code: 'bad_value', message: '员工角色不能为空' };
  }
  const model = input.model === undefined ? undefined : typeof input.model === 'string' && input.model.trim().length > 0 ? input.model.trim() : null;
  if (model) {
    const projects = deps.repo.listProjects({ includeArchived: true });
    const error = employeeModelWhitelistError(projects, employeeId, model);
    if (error) return { ok: false, code: 'whitelist', message: error };
  }
  const thinking = input.thinking === undefined ? undefined : input.thinking == null ? null : String(input.thinking);
  if (thinking != null && !['off', 'low', 'medium', 'high'].includes(thinking)) {
    return { ok: false, code: 'bad_value', message: '思考强度需为 off / low / medium / high 或清空' };
  }
  const capabilityTier = input.capabilityTier === undefined ? undefined : String(input.capabilityTier);
  if (capabilityTier != null && !['sandbox', 'standard', 'trusted'].includes(capabilityTier)) {
    return { ok: false, code: 'bad_value', message: '能力档需为 sandbox / standard / trusted' };
  }
  if (input.active !== undefined && typeof input.active !== 'boolean') {
    return { ok: false, code: 'bad_value', message: 'active 需为布尔' };
  }
  const res = deps.repo.updateEmployee({
    employeeId,
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(typeof input.role === 'string' ? { role: input.role } : {}),
    ...(typeof input.persona === 'string' ? { persona: input.persona } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(input.skills !== undefined ? { skills: parseEmployeeRefs(input.skills) ?? [] } : {}),
    ...(input.mcps !== undefined ? { mcps: parseEmployeeRefs(input.mcps) ?? [] } : {}),
    ...(capabilityTier !== undefined ? { capabilityTier } : {}),
    ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
  });
  if (!res.ok) return res;
  if (!res.employee) return { ok: false, code: 'write_failed', message: '更新后回读失败' };
  return { ok: true, employee: res.employee };
}

/**
 * `OPT-EXT-13` 用量可视：`cost:summary`。
 * - 给 `taskId` → **任务级成本**（含 `byModel`，供成本 tab）；
 * - 否则给 `since` → 只算窗口内（今日成本）；
 * **空表 → `costRows:0`，由渲染层显 `—`/「暂无成本」**（**不写假 0**）。
 * **N1 追加**：返回体带 `cacheReadTokens/cacheWriteTokens/cacheHitRate/usdPerHour`（命中率分母 0 ⇒ `null`；速率＝最近 1 小时美元额）。
 */
export function handleCostSummary(
  deps: IpcDeps,
  raw: unknown,
): {
  costRows: number;
  tokens: number;
  usd: number;
  /** N1：缓存计量与速率（分母 0 ⇒ `cacheHitRate=null`，不写假 0）。 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number | null;
  usdPerHour: number;
  /** GAP10（挂载 3）：按员工归因（null=公司级/无归属；"这次为什么贵"）。 */
  byEmployee?: Array<{ employeeId: number | null; name: string | null; usd: number; tokensIn: number; tokensOut: number }>;
  byModel?: Array<{ model: string; tokensIn: number; tokensOut: number; usd: number }>;
} {
  const query = (raw ?? {}) as { since?: number; taskId?: number };
  if (typeof query.taskId === 'number') return deps.repo.taskCosts(query.taskId);
  return deps.repo.costSummary(typeof query.since === 'number' ? query.since : undefined);
}

export function handleInboxAnswer(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): { ok: true; report: ReportDTO | null } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { id?: number };
  if (typeof input.id !== 'number') {
    return { ok: false, code: 'bad_request', message: 'id is required' };
  }
  const report = deps.repo.acknowledgeReport(input.id, at);
  deps.onInboxChanged?.();
  markCardActionRead(deps, input.id, at);
  return { ok: true, report: report ? toReportDTO(report) : null };
}

/**
 * D2（链路审计）：**批准/决策作答 → 引擎事件**的唯一映射点（纯函数，可测；UI/IM 两侧都走它，不许各自猜）。
 *
 * - `awaiting_approval`：`approve` → `plan_approved`；`revise`/`reject` → `revise`（带意见重规划）；
 *   **其它选项 → `null`（不猜、不推状态机；作答已落台账）**。
 * - `needs_decision`：作答 → `decision_made`（payload 带 chosen；回 `resume_state` 继续）；
 *   **`cancel` → 真 `cancel` 事件**（needs_decision+cancel→cancelled 是机器真边——此前一律
 *   decision_made＝想取消的任务又回规划）；**`proceed` → `decision_proceed_latest`**（RW-21 收尾：
 *   最新稿视同批准，不重规划——机器边仅规划期升级有效，验证期由 guard 拦下）。
 * - 其它任务态（如执行中工具权限审批）→ `null`（权限由 `answerApproval` 的授权路径处理，不动任务机）。
 */
export { approvalAnswerEvent } from '../../core/approval-events.js';

export async function handleTaskApprove(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): Promise<{ ok: true; approval: unknown } | { ok: false; code: string; message: string }> {
  const input = (raw ?? {}) as { approvalId?: number; chosen?: string };
  if (typeof input.approvalId !== 'number' || typeof input.chosen !== 'string') {
    return { ok: false, code: 'bad_request', message: 'approvalId + chosen are required' };
  }
  const approval = deps.repo.answerApproval({
    approvalId: input.approvalId,
    chosen: input.chosen,
    decidedBy: 'boss',
    now: at,
  });
  // D2：作答后**推状态机**（此前只写台账/授权 ⇒ 老板点了批准任务也不动）。未知选项 → 不猜（不推）。
  const taskId = (approval as { taskId?: number | null } | null)?.taskId ?? null;
  if (taskId != null && deps.engine) {
    const task = deps.repo.getTask(taskId);
    const mapped = approvalAnswerEvent(task?.state ?? null, input.chosen);
    if (mapped) {
      await deps.engine.dispatch({
        scope: 'task',
        id: taskId,
        event: mapped.event,
        actor: 'boss',
        payload: { via: 'approval', approvalId: input.approvalId, chosen: input.chosen, ...(mapped.payload ?? {}) },
      });
    }
  }
  deps.onInboxChanged?.();
  const reportId = (approval as { reportId?: number | null } | null)?.reportId ?? null;
  markCardActionRead(deps, reportId, at);
  return { ok: true, approval };
}

/**
 * GAP8：**批准前编辑计划**（`awaiting_approval` 专用）。
 *
 * - `plan_edited` 是任务机正式迁移（`awaiting_approval → KEEP`，kind=`plan_edited`）——计划仍是事件投影，
 *   **不是**直接改 `plan_steps` 表；批准/派工链路完全不变，`spawnPlanWorkItems` 读到的是改后计划。
 * - `approve:true` ＝「改计划再批准」：同一入口顺序发 `plan_edited` → `plan_approved`。
 * - 状态不符 / 步数非法 → 显式拒绝（不静默截断、不丢空项）。
 */
export async function handleTaskEditPlan(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): Promise<
  | { ok: true; steps: string[]; approved: boolean }
  | { ok: false; code: string; message: string }
> {
  const input = (raw ?? {}) as { taskId?: unknown; steps?: unknown; approve?: unknown };
  if (typeof input.taskId !== 'number' || !Number.isInteger(input.taskId)) {
    return { ok: false, code: 'bad_request', message: 'taskId is required' };
  }
  const task = deps.repo.getTask(input.taskId);
  if (!task) return { ok: false, code: 'task_not_found', message: '任务不存在' };
  if (task.state !== 'awaiting_approval') {
    return { ok: false, code: 'invalid_state', message: '只有待批准的任务可以改计划' };
  }
  if (!deps.engine) return { ok: false, code: 'engine_unavailable', message: '引擎未就绪' };
  const normalized = normalizePlanSteps(input.steps);
  if (!normalized.ok) return { ok: false, code: normalized.code, message: normalized.message };

  const approve = input.approve === true;
  try {
    await deps.engine.dispatch({
      scope: 'task',
      id: input.taskId,
      event: 'plan_edited',
      actor: 'boss',
      ts: at,
      payload: { steps: normalized.steps, via: 'boss_edit', editedBy: 'boss', approveAfter: approve },
    });
  } catch (error) {
    return {
      ok: false,
      code: 'edit_failed',
      message: `计划未保存：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!approve) return { ok: true, steps: normalized.steps, approved: false };
  try {
    await deps.engine.dispatch({
      scope: 'task',
      id: input.taskId,
      event: 'plan_approved',
      actor: 'boss',
      ts: at,
      payload: { via: 'plan_edit_approve' },
    });
  } catch (error) {
    return {
      ok: false,
      code: 'approve_failed',
      message: `计划已保存，但批准未生效：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, steps: normalized.steps, approved: true };
}

// ── R2-3 三桩第一批：project:list/get ＋ settings:get/set（白名单） ─────────

/** `project:list`：项目列表（**默认过滤归档**；`includeArchived` 可选）。 */
export function handleProjectList(deps: IpcDeps, raw: unknown): ProjectDTO[] {
  const query = (raw ?? {}) as { includeArchived?: boolean };
  return deps.repo.listProjects({ includeArchived: query.includeArchived === true });
}

/**
 * `project:delete`（CR14，2026-10-20）：**只删已归档且无任务的项目行**，文件夹不动。
 * 非空项目显式拒 `not_empty`（当前没有任务级联口径，不冒险删任务/产物/检查点）。
 */
export function handleProjectDelete(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; projectId: number } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  const result = deps.repo.deleteProjectIfEmpty(input.projectId);
  if (result.ok) return { ok: true, projectId: input.projectId };
  if (result.code === 'not_found') return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  if (result.code === 'not_archived') {
    return { ok: false, code: 'not_archived', message: '只能删除已归档的项目；先归档，或仅停用触发/任务' };
  }
  return {
    ok: false,
    code: 'not_empty',
    message: '项目还有任务，不能硬删除（当前不做任务级联）；先归档项目，或逐项处理任务',
  };
}

/**
 * `project:alias-set`（2026-10-19 验收后复查 A）：设置/清空项目别名。
 * 新项目不设别名时 `#别名` 永远不可达；此入口补上写面（项目概览/后续 IM 共用）。
 */
export function handleProjectAliasSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; alias?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  const project = deps.repo.getProject(input.projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  const aliasCheck = normalizeProjectAlias(input.alias);
  if (!aliasCheck.ok) return { ok: false, code: 'bad_request', message: aliasCheck.message };
  if (aliasCheck.alias != null) {
    const owner = deps.repo.projectIdByAlias(aliasCheck.alias);
    if (owner != null && owner !== input.projectId) {
      return { ok: false, code: 'alias_taken', message: `别名已被项目 #${owner} 使用：${aliasCheck.alias}` };
    }
  }
  const updated = deps.repo.projectAliasSet({ projectId: input.projectId, alias: aliasCheck.alias });
  if (!updated) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  return { ok: true, project: updated };
}

/** `project:get`：单项目 DTO（不存在 / 入参非法 → `null`，不抛）。 */
export function handleProjectGet(deps: IpcDeps, raw: unknown): ProjectDTO | null {
  const input = (raw ?? {}) as { projectId?: number };
  if (typeof input.projectId !== 'number') return null;
  const project = deps.repo.getProject(input.projectId);
  if (!project || !deps.db) return project;
  // S13-G / C3：项目级「变更历史」——跨任务聚合变更集（只读；不新增 IPC 通道）。
  const changesets = deps.db
    .prepare(
      `SELECT c.id, c.task_id, t.short_id, c.branch, c.head_sha, c.state, c.files_changed,
              c.insertions, c.deletions, c.summary, c.commit_msg, c.created_at, c.merged_at
         FROM changesets c JOIN tasks t ON t.id = c.task_id
        WHERE t.project_id = ?
        ORDER BY c.created_at DESC LIMIT 50`,
    )
    .all(input.projectId) as Array<{
    id: number;
    task_id: number;
    short_id: string | null;
    branch: string | null;
    head_sha: string | null;
    state: string;
    files_changed: number;
    insertions: number;
    deletions: number;
    summary: string | null;
    commit_msg: string | null;
    created_at: number;
    merged_at: number | null;
  }>;
  return {
    ...project,
    changesets: changesets.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      shortId: row.short_id,
      branch: row.branch,
      headSha: row.head_sha,
      state: row.state,
      filesChanged: row.files_changed,
      insertions: row.insertions,
      deletions: row.deletions,
      summary: row.summary,
      commitMsg: row.commit_msg,
      createdAt: row.created_at,
      mergedAt: row.merged_at,
    })),
  } as ProjectDTO;
}

/** `employee:get`：员工工位页数据（D-5 补位 ①；入参非法/不存在 → `null`，不抛）。 */
export function handleEmployeeGet(deps: IpcDeps, raw: unknown): EmployeeDetailDTO | null {
  const input = (raw ?? {}) as { employeeId?: unknown };
  if (typeof input.employeeId !== 'number' || !Number.isFinite(input.employeeId)) return null;
  return deps.repo.employeeDetail(input.employeeId);
}

/** `project:archive`：软归档（不搬动文件夹；幂等）；不存在 → 错误信封。 */
export function handleProjectArchive(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; archived?: unknown; mode?: unknown };
  if (typeof input.projectId !== 'number') {
    return { ok: false, code: 'bad_request', message: 'projectId is required' };
  }
  // 同通道撤销归档：`{archived:false}`（不新增 IPC 通道，保持冻结计数）。
  if (input.archived === false) {
    const restored = deps.repo.restoreProject(input.projectId);
    if (!restored) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
    return { ok: true, project: restored };
  }
  const project = deps.repo.archiveProject(input.projectId, at);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  if (deps.db) {
    // 归档项目不再“偷偷干活”：停用该项目的触发，并暂停 ready/executing 任务。
    const timers = deps.db
      .prepare("SELECT id, payload FROM timers WHERE fired_at IS NULL AND kind IN ('cron_fire','event_trigger')")
      .all() as Array<{ id: number; payload: string }>;
    for (const row of timers) {
      try {
        const payload = JSON.parse(row.payload) as { projectId?: unknown };
        if (payload.projectId === input.projectId) {
          deps.db.prepare('DELETE FROM timers WHERE id = ?').run(row.id);
        }
      } catch {
        // 坏 payload 不阻塞归档
      }
    }
    // P0/C1（S13-E 对抗审查）：归档前由老板选「全部结束」或「保留暂停」——
    //   finish_all：所有未终态任务发 cancel（明确结束，收尾卡如实）；
    //   keep_paused（缺省，兼容旧调用）：只把 ready/executing 暂停。
    const finishAll = input.mode === 'finish_all';
    const rows = deps.db
      .prepare(
        finishAll
          ? "SELECT id FROM tasks WHERE project_id = ? AND state NOT IN ('done','cancelled','failed')"
          : "SELECT id FROM tasks WHERE project_id = ? AND state IN ('ready','executing')",
      )
      .all(input.projectId) as Array<{ id: number }>;
    for (const task of rows) {
      void deps.engine?.dispatch({
        scope: 'task',
        id: task.id,
        event: finishAll ? 'cancel' : 'pause',
        actor: 'boss',
        payload: { via: 'project_archive' },
      });
    }
  }
  return { ok: true, project };
}

/**
 * `project:docs-check-set`（M3-DOC-4）：项目级文档检查开关。
 * 只影响**新建任务**是否自动挂 `aico:docs-check`；已有任务的该检查在运行时按项目当前开关记 `skip`（未检查）。
 */
export function handleProjectDocsCheckSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; enabled?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  if (typeof input.enabled !== 'boolean') {
    return { ok: false, code: 'bad_request', message: 'enabled 需为 boolean' };
  }
  const project = deps.repo.projectDocsCheckSet({ projectId: input.projectId, enabled: input.enabled });
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  return { ok: true, project };
}

/**
 * `project:skills-set`（B3 · M3-N-3）：项目默认技能集（refs 为技能名/id；必须先全部解析为启用中的技能）。
 * 只影响该项目下新会话装配（员工勾选 ∪ 项目默认），不改员工档案。
 */
export function handleProjectSkillsSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; refs?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  if (!Array.isArray(input.refs) || !input.refs.every((ref) => typeof ref === 'string' || typeof ref === 'number')) {
    return { ok: false, code: 'bad_request', message: 'refs 需为字符串/数字数组' };
  }
  return deps.repo.projectDefaultSkillsSet({
    projectId: input.projectId,
    refs: input.refs.map(String),
  });
}

/**
 * `project:staffing-set`（编制 v1 · 裁决 `D-11`）：写项目三项缺省——默认负责人 / 默认执行员工 / 默认档。
 * 口径：字段**缺省＝不改动**、显式 `null`＝清空（回落未设置——不臆造）；**员工存在且在职**、档位 0/1/2
 * 为硬校验（同判据在 `db/projects.ts#setProjectStaffing`——非法**拒且不落库**）。返回更新后的 `ProjectDTO`
 * （与 `project:get` 同形；读面无新通道）。**只影响之后派发的工作项**（owner/tier 建任务时快照；默认执行员工在派发缺省链②读取）；已派发工作项不回改。
 */
export function handleProjectStaffingSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    projectId?: unknown;
    ownerEmployeeId?: unknown;
    defaultEmployeeId?: unknown;
    defaultRiskTier?: unknown;
  };
  if (typeof input.projectId !== 'number' || !Number.isFinite(input.projectId)) {
    return { ok: false, code: 'bad_request', message: 'projectId is required' };
  }
  const idField = (v: unknown, field: string): { ok: true; value: number | null | undefined } | { ok: false; message: string } => {
    if (v === undefined) return { ok: true, value: undefined };
    if (v === null) return { ok: true, value: null };
    if (typeof v === 'number' && Number.isInteger(v)) return { ok: true, value: v };
    return { ok: false, message: `${field} 需为整数或 null（清空）` };
  };
  const owner = idField(input.ownerEmployeeId, 'ownerEmployeeId');
  if (!owner.ok) return { ok: false, code: 'bad_request', message: owner.message };
  const staff = idField(input.defaultEmployeeId, 'defaultEmployeeId');
  if (!staff.ok) return { ok: false, code: 'bad_request', message: staff.message };
  const tier = input.defaultRiskTier;
  if (tier !== undefined && tier !== null) {
    if (typeof tier !== 'number') return { ok: false, code: 'bad_request', message: 'defaultRiskTier 需为数字或 null（清空）' };
    if (!Number.isInteger(tier) || tier < 0 || tier > 2) {
      return { ok: false, code: 'bad_value', message: 'defaultRiskTier 需为 0/1/2 或 null（清空）' };
    }
  }
  return deps.repo.projectStaffingSet({
    projectId: input.projectId,
    ...(owner.value !== undefined ? { ownerEmployeeId: owner.value } : {}),
    ...(staff.value !== undefined ? { defaultEmployeeId: staff.value } : {}),
    ...(tier !== undefined ? { defaultRiskTier: tier as number | null } : {}),
  });
}

/**
 * `project:model-policy-set`（D-22）：项目模型策略——策略 / 默认模型 / 模型级允许清单整体写。
 * 校验与落库在 `db/projects.ts#setProjectModelPolicy`（非法拒且不落库）；返回更新后的 `ProjectDTO`。
 */
export function handleProjectModelPolicySet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as {
    projectId?: unknown;
    policy?: unknown;
    defaultModel?: unknown;
    allowedModels?: unknown;
  };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  return deps.repo.projectModelPolicySet({
    projectId: input.projectId,
    policy: input.policy,
    defaultModel: input.defaultModel,
    allowedModels: input.allowedModels,
  });
}

/** v19：项目默认任务预算（NULL＝不限；只影响之后新建且未显式给预算的任务）。 */
export function handleProjectDefaultBudgetSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; budgetTokens?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  return deps.repo.projectDefaultBudgetSet({
    projectId: input.projectId,
    budgetTokens: input.budgetTokens === undefined ? null : input.budgetTokens,
  });
}

/**
 * `project:target-branch-set`（S13-G/D-N06）：合并目标分支。
 * 空串/null ⇒ 清空（回到 main/master 口径）；分支名做最小 git 合法性校验，非法拒且不落库。
 */
export function handleProjectTargetBranchSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; branch?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  let branch: string | null = null;
  if (input.branch != null) {
    if (typeof input.branch !== 'string') return { ok: false, code: 'bad_request', message: 'branch 需为字符串' };
    const trimmed = input.branch.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 200) return { ok: false, code: 'bad_request', message: '分支名过长' };
      if (!/^[A-Za-z0-9._/-]+$/.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('-') || trimmed.startsWith('/')) {
        return { ok: false, code: 'bad_branch', message: `分支名不合法：${trimmed}` };
      }
      branch = trimmed;
    }
  }
  return deps.repo.projectTargetBranchSet({ projectId: input.projectId, branch });
}

/**
 * `project:assistant-write-mode-set`（D-19 P1）：项目级频道助手写权限。
 * 只接受 `read-only | confirm | auto`（`full` v1 不做）；写入 `permission_policies` 的
 * `assistantWriteMode`，不改变员工任务会话的 tier/autonomy。项目不存在 → `not_found`。
 */
export function handleProjectAssistantWriteModeSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; project: ProjectDTO } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown; mode?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isFinite(input.projectId)) {
    return { ok: false, code: 'bad_request', message: 'projectId is required' };
  }
  if (!isAssistantWriteMode(input.mode)) {
    return { ok: false, code: 'bad_request', message: 'mode 需为 read-only/confirm/auto' };
  }
  const project = deps.repo.projectAssistantWriteModeSet({ projectId: input.projectId, mode: input.mode });
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${input.projectId}` };
  return { ok: true, project };
}

/**
 * `settings:get`：**secret 名一律掩码**（优先于白名单，防存在性泄露）→ 再白名单 →
 * 未设值 `{value:null}`（不臆造）；未知键 → 错误信封。
 */
export function handleSettingsGet(
  deps: IpcDeps,
  raw: unknown,
): { value: unknown } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { key?: unknown };
  if (typeof input.key !== 'string' || input.key.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'key is required' };
  }
  const key = input.key.trim();
  if (isSecretSettingKey(key)) return { value: SETTING_REDACTED };
  if (!isKnownSettingKey(key)) {
    return { ok: false, code: 'unknown_key', message: `未知设置键：${key}（白名单见 src/main/db/settings.ts）` };
  }
  const value = deps.repo.getSetting(key);
  return { value: value === undefined ? null : value };
}

/** `settings:set`：只许白名单键（防任意写/悬空键）；值必须 JSON 可序列化。 */
export function handleSettingsSet(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { key?: unknown; value?: unknown };
  if (typeof input.key !== 'string' || input.key.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'key is required' };
  }
  const key = input.key.trim();
  if (!isKnownSettingKey(key)) {
    return { ok: false, code: 'unknown_key', message: `未知设置键：${key}（白名单见 src/main/db/settings.ts）` };
  }
  if (JSON.stringify(input.value) === undefined) {
    return { ok: false, code: 'bad_request', message: 'value 必须 JSON 可序列化' };
  }
  // 件 A：值校验（形状/边界；唯一守卫＝`db/settings.ts` 的 `validateSettingValue`）——越界/类型错一律拒，不落库。
  const validation = validateSettingValue(key, input.value);
  if (!validation.ok) {
    return { ok: false, code: 'bad_value', message: `「${key}」${validation.reason}` };
  }
  deps.repo.setSetting({ key, value: input.value });
  // M4-C：主题写入即生效（nativeTheme 由 main 注入；renderer 的 prefers-color-scheme 随之切换）。
  if (key === 'ui.theme' && deps.setTheme) {
    deps.setTheme(input.value as 'light' | 'dark' | 'system');
  }
  // R2-3：`models.default` 有真实读者（装配期档位解析）——**写后立刻生效**（下次装配读新值）
  if (key === 'models.default') {
    setDefaultModel(typeof input.value === 'string' ? input.value : null);
  }
  // N5（`R3-3`）：`models.role_map` 有真实读者（逐会话档位解析）——**写后立刻注入**（下次派发读新值；形状已过写侧守卫）
  if (key === 'models.role_map') {
    setRoleMap(input.value);
  }
  // N5 余账（2026-10-16）：`models.fallback_chain` 有真实读者（运行时降级＋异供应商备选）——写后立刻注入。
  if (key === 'models.fallback_chain') {
    setFallbackChain(input.value);
  }
  return { ok: true, value: input.value };
}

/**
 * `provider:custom`（D-22）：自定义供应商的 list/save/remove。
 * 配置写 Pi 原生 `~/.aico/models.json`（不写 Key）；Key 仍走本机 secrets。
 */
export async function handleProviderCustom(
  deps: IpcDeps,
  raw: unknown,
): Promise<
  | { ok: true; providers: ReturnType<typeof listCustomProviders>; message?: string }
  | { ok: false; code: string; message: string }
> {
  const input = (raw ?? {}) as { action?: unknown; provider?: unknown; id?: unknown; key?: unknown };
  const action = typeof input.action === 'string' ? input.action : 'list';
  try {
    if (action === 'list') return { ok: true, providers: listCustomProviders() };
    if (action === 'test') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      const provider = listCustomProviders().find((p) => p.id === id);
      if (!provider) return { ok: false, code: 'not_found', message: `自定义供应商不存在：${id}` };
      const key = resolveProviderKey(id, providerKeyOptions(deps));
      if (!key) return { ok: false, code: 'no_credential', message: `缺少 ${id} 的本机 Key` };
      const sdk = await import('@earendil-works/pi-coding-agent');
      const runtime = await sdk.ModelRuntime.create({ modelsPath: customModelsPath(), allowModelNetwork: false });
      await runtime.setRuntimeApiKey(id, key.key);
      const model = runtime.getModel(id, provider.models[0]!.id);
      if (!model) return { ok: false, code: 'model_missing', message: `模型不存在：${id}/${provider.models[0]!.id}` };
      const result = (await runtime.completeSimple(
        model,
        { messages: [{ role: 'user', content: '只回复 OK' }] } as never,
        { maxTokens: 32 } as never,
      )) as { content?: Array<{ type?: string; text?: string }> };
      const text = (result.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ')
        .trim();
      return { ok: true, providers: listCustomProviders(), message: `连接成功：${text.slice(0, 80) || '（空回复）'}` };
    }
    if (action === 'remove') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) return { ok: false, code: 'bad_request', message: 'id is required' };
      removeCustomProvider(id);
      try {
        clearProviderKey(id, providerKeyOptions(deps));
      } catch {
        // 文件不存在不阻塞删除
      }
      if (deps.db) deleteProviderKey(deps.db, id);
      // 自定义供应商变更同样要让懒运行时重装（否则旧 ModelRuntime 仍持旧 models.json）。
      deps.onProviderKeyChanged?.();
      return { ok: true, providers: listCustomProviders() };
    }
    if (action !== 'save') return { ok: false, code: 'bad_request', message: `未知 action：${action}` };
    const provider = input.provider;
    const error = customProvidersShapeError([provider]);
    if (error) return { ok: false, code: 'bad_value', message: error };
    upsertCustomProvider(provider as never);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key.length > 0) {
      const id = (provider as { id: string }).id;
      saveProviderKey(id, key, providerKeyOptions(deps));
      if (deps.db) {
        upsertProviderKey(deps.db, { provider: id, secretRef: `${id}_api_key`, now: Date.now() });
      }
    }
    // 设置页口径「下一次会话生效」：下次装配必须重读 models.json（含新增/改 Base URL 的模型）。
    deps.onProviderKeyChanged?.();
    return { ok: true, providers: listCustomProviders() };
  } catch (error) {
    if (error instanceof ProviderKeyError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'save_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

function providerKeyOptions(deps: IpcDeps): { baseDir?: string } {
  return deps.providerSecretsDir ? { baseDir: deps.providerSecretsDir() } : {};
}

/** `provider:list`：只回是否配置/来源/尾号掩码；**绝不回明文**。 */
export function handleProviderList(deps: IpcDeps):
  | { ok: true; providers: ReturnType<typeof providerStatuses> }
  | { ok: false; code: string; message: string } {
  try {
    return { ok: true, providers: providerStatuses(providerKeyOptions(deps)) };
  } catch (error) {
    return { ok: false, code: 'read_failed', message: `读取本机凭据状态失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `provider:set-key`：写 `~/.aico/secrets/<provider>_api_key`（0600）＋ `provider_keys` 台账；不回明文。 */
export function handleProviderSetKey(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; providers: ReturnType<typeof providerStatuses> } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { provider?: unknown; key?: unknown };
  if (typeof input.provider !== 'string' || input.provider.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'provider is required' };
  }
  if (typeof input.key !== 'string') {
    return { ok: false, code: 'bad_request', message: 'key is required' };
  }
  const provider = input.provider.trim();
  try {
    saveProviderKey(provider, input.key, providerKeyOptions(deps));
    if (deps.db) {
      upsertProviderKey(deps.db, {
        provider,
        secretRef: `${provider}_api_key`,
        now: deps.now?.() ?? Date.now(),
      });
    }
    deps.onProviderKeyChanged?.();
    return { ok: true, providers: providerStatuses(providerKeyOptions(deps)) };
  } catch (error) {
    if (error instanceof ProviderKeyError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'write_failed', message: `保存失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * `model:catalog`（D-22 配套）：只读模型目录（chat 模型；已知供应商＋已配置 Key 的供应商）。
 * 不联网刷新；价格是 Pi 目录的 USD/1M tokens。Key 状态只回来源，不回明文。
 */
export async function handleModelCatalog(raw: unknown): Promise<{ models: Awaited<ReturnType<typeof loadModelCatalog>>['models'] }> {
  const input = (raw ?? {}) as { refresh?: unknown };
  return loadModelCatalog({ refresh: input.refresh === true });
}

/** `provider:clear-key`：清本机文件（canonical＋旧文件名）＋台账行；环境变量仍在时状态如实显示 env。 */
export function handleProviderClearKey(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; providers: ReturnType<typeof providerStatuses> } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { provider?: unknown };
  if (typeof input.provider !== 'string' || input.provider.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'provider is required' };
  }
  const provider = input.provider.trim();
  try {
    clearProviderKey(provider, providerKeyOptions(deps));
    if (deps.db) deleteProviderKey(deps.db, provider);
    deps.onProviderKeyChanged?.();
    return { ok: true, providers: providerStatuses(providerKeyOptions(deps)) };
  } catch (error) {
    if (error instanceof ProviderKeyError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'write_failed', message: `清除失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * `notify:test`（2026-10-17 真机反馈）：设置·通知「发送测试通知」——
 * main 注入一次真实 `notify()`（desktop 通道 ⇒ 系统通知＋托盘刷新）；不写日报幂等键（不污染当天日报）。
 */
export function handleNotifyTest(
  deps: IpcDeps,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!deps.notifyTest) {
    return { ok: false, code: 'notify_unavailable', message: '通知通道不可用（非桌面环境）' };
  }
  try {
    deps.notifyTest();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: 'notify_failed',
      message: `发送测试通知失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** `task:rework-merge-conflict`（D-N07）：合并冲突派回原员工修复（建续办任务）。 */
export function handleTaskReworkMergeConflict(deps: IpcDeps, raw: unknown) {
  const input = (raw ?? {}) as { taskId?: unknown; changesetId?: unknown };
  if (typeof input.taskId !== 'number' || !Number.isInteger(input.taskId) || input.taskId <= 0) {
    return { ok: false as const, code: 'bad_request', message: 'taskId 需为正整数' };
  }
  if (typeof input.changesetId !== 'number' || !Number.isInteger(input.changesetId) || input.changesetId <= 0) {
    return { ok: false as const, code: 'bad_request', message: 'changesetId 需为正整数' };
  }
  return deps.repo.reworkMergeConflict(input.taskId, input.changesetId);
}

/** `app:info`（P-N05）：版本号＋数据目录（只读；路径由主进程解析）。 */
export function handleAppInfo(deps: IpcDeps):
  | { ok: true; version: string; userDataDir: string }
  | { ok: false; code: string; message: string } {
  if (!deps.appInfo) return { ok: false, code: 'info_unavailable', message: '应用信息不可用（主进程未注入）' };
  const info = deps.appInfo();
  return { ok: true, version: info.version, userDataDir: info.userDataDir };
}

/** `app:open-data-dir`（P-N05）：在系统文件管理器中打开数据目录。 */
export async function handleAppOpenDataDir(deps: IpcDeps):
  Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (!deps.appInfo) return { ok: false, code: 'info_unavailable', message: '应用信息不可用（主进程未注入）' };
  if (!deps.openPath) return { ok: false, code: 'open_unavailable', message: '系统打开不可用（非桌面环境）' };
  const dir = deps.appInfo().userDataDir;
  const error = await deps.openPath(dir);
  if (error) return { ok: false, code: 'open_failed', message: error };
  return { ok: true };
}

/**
 * `project:open-dir`（2026-10-25）：在系统文件管理器中打开项目根目录。
 * renderer 只传 projectId；路径由主进程从 DB 解析（D1：不接受任意路径）。
 * `openPath` 由 main 注入 electron `shell.openPath`；非桌面/失败如实返回。
 */
export async function handleProjectOpenDir(
  deps: IpcDeps,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const input = (raw ?? {}) as { projectId?: unknown };
  const projectId = Number(input.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { projectId }（正整数）' };
  }
  const project = deps.repo.getProject(projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：#${projectId}` };
  if (!project.rootDir) return { ok: false, code: 'no_project_root', message: '项目没有根目录' };
  // 2026-10-29（错误态真注入）：目录被删/盘符不在时，系统 openPath 只回 "Failed to open path"，
  // 老板看不出是什么问题；先自己判存在性，给人话原因（不猜、不静默）。
  if (!existsSync(project.rootDir)) {
    return { ok: false, code: 'no_dir', message: `项目目录不存在：${project.rootDir}` };
  }
  if (!deps.openPath) return { ok: false, code: 'open_unavailable', message: '系统打开不可用（非桌面环境）' };
  const error = await deps.openPath(project.rootDir);
  if (error) return { ok: false, code: 'open_failed', message: error };
  return { ok: true };
}

/**
 * `project:attach`（R2-4）：**经主进程 dialog 选目录**（renderer 永远拿不到任意路径，D1 铁律）→
 * 接入探测（真事实：`.git`/`package.json`/`pyproject.toml`）→ 建项目行（**只记录路径**）。
 * 取消 → `{ok:false, code:'cancelled'}`（不静默、不建行）。
 */
export async function handleProjectAttach(
  deps: IpcDeps,
  at: number,
): Promise<
  | { ok: true; project: ProjectDTO; probe: ProjectProbe }
  | { ok: false; code: string; message: string }
> {
  if (!deps.pickDirectory) {
    return { ok: false, code: 'dialog_unavailable', message: '目录选择器不可用（非桌面环境）' };
  }
  const rootDir = await deps.pickDirectory();
  if (!rootDir) return { ok: false, code: 'cancelled', message: '已取消（未选目录）' };
  const probe = probeProject(rootDir);
  const name = basename(rootDir) || rootDir;
  const project = deps.repo.createProject({ name, rootDir, accessMode: probe.suggestedAccessMode, now: at });
  // RW-1（M5 真机带回）：接入成功 ⇒ **把接入项目设为默认**——用户特意选的文件夹就是他要的项目，
  // 此前不设指针 ⇒ 建任务默认仍落「默认项目」（其回退根此前还指向不存在的模板路径）＝新手第一个任务必然建错地方。
  // 写失败不阻断接入（指针只是默认值，建任务时仍可手选）。
  if (deps.db != null) {
    try {
      writeSetting(deps.db, 'projects.default_id', project.id);
    } catch { /* 指针写失败不阻断；建任务时仍可手选项目 */ }
  }
  return { ok: true, project, probe };
}

/**
 * `project:create`（2026-10-16，D 批余项；2026-10-18 M3-DOC-1 加文档模板）：**软件代建项目骨架**
 * （PLAN §616「在你指定的父目录下创建 `<项目名>/` 骨架（README）」）——**父目录经主进程 dialog 选**
 * （D1：renderer 只给 `{name, docsTemplate?}`）；**不覆盖同名目录**（已存在 → 显式拒，指引用「接入已有文件夹」）；
 * 建 README 骨架 ＋（默认）`.aico/docs` 文档骨架 ＋ `probeProject` 探测 ＋ 建项目行（`accessMode` 取探测建议）。
 * `docsTemplate:false` ⇒ 只建 README（用户不要文档树）；模板对已存在文件逐个跳过，绝不覆盖。
 * 取消 → `{ok:false, code:'cancelled'}`（不静默、不建行）。
 */
/**
 * 2026-10-19 验收后复查 A：项目别名归一/校验。
 * 空串/null ⇒ 清空；允许字母（含中文）/数字/下划线/连字符，长度 ≤32；不允许空白/`#`/路径分隔符。
 * 唯一性由调用方查库（含归档项目）。
 */
export function normalizeProjectAlias(
  raw: unknown,
): { ok: true; alias: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, alias: null };
  if (typeof raw !== 'string') return { ok: false, message: 'alias 需为字符串或 null' };
  const alias = raw.trim();
  if (alias.length === 0) return { ok: true, alias: null };
  if (alias.length > 32) return { ok: false, message: '别名过长（≤32 字符）' };
  if (!/^[\p{L}\p{N}_-]+$/u.test(alias)) {
    return { ok: false, message: '别名只能含字母/数字/中文/下划线/连字符（不能有空格或 #）' };
  }
  return { ok: true, alias };
}

export async function handleProjectCreate(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): Promise<
  | {
      ok: true;
      project: ProjectDTO;
      probe: ProjectProbe;
      createdDir: string;
      gitInitialized: boolean;
      gitError?: string;
      docsTemplate?: DocsTemplateResult;
    }
  | { ok: false; code: string; message: string }
> {
  const input = (raw ?? {}) as { name?: unknown; docsTemplate?: unknown; alias?: unknown };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return { ok: false, code: 'bad_request', message: '需要 { name }（项目名，非空）' };
  const aliasCheck = normalizeProjectAlias(input.alias);
  if (!aliasCheck.ok) return { ok: false, code: 'bad_request', message: aliasCheck.message };
  if (aliasCheck.alias != null) {
    const owner = deps.repo.projectIdByAlias(aliasCheck.alias);
    if (owner != null) return { ok: false, code: 'alias_taken', message: `别名已被项目 #${owner} 使用：${aliasCheck.alias}` };
  }
  if (name.length > 80) return { ok: false, code: 'bad_request', message: '项目名过长（≤80 字符）' };
  if (/[/\\:*?"<>|]/.test(name) || name === '.' || name === '..') {
    return { ok: false, code: 'bad_request', message: `项目名不能含路径分隔符/保留字符：${name}` };
  }
  const withDocsTemplate = input.docsTemplate !== false;
  if (!deps.pickDirectory) {
    return { ok: false, code: 'dialog_unavailable', message: '目录选择器不可用（非桌面环境）' };
  }
  const parent = await deps.pickDirectory();
  if (!parent) return { ok: false, code: 'cancelled', message: '已取消（未选父目录）' };
  const target = join(parent, name);
  // RW-7（M5 真机带回）：新项目根与现有项目根**互相包含**都拒——嵌套项目破坏隔离边界
  // （工作区/检索/记忆互相可见；真机案例：父目录选到现有项目根里，建出了「项目里的项目」）。
  if (deps.db != null) {
    const roots = (deps.db.prepare('SELECT id, name, root_dir FROM projects WHERE archived = 0').all() as Array<{ id: number; name: string; root_dir: string }>).filter((p) => p.root_dir);
    const contains = (a: string, b: string): boolean => {
      const rel = relative(a, b);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    for (const p of roots) {
      if (contains(p.root_dir, target)) {
        return { ok: false, code: 'parent_inside_project', message: `父目录在现有项目「${p.name}」（${p.root_dir}）之内——项目不能互相嵌套（隔离边界）。请选一个不在任何现有项目里的父目录。` };
      }
      if (contains(target, p.root_dir)) {
        return { ok: false, code: 'parent_inside_project', message: `新项目目录将包住现有项目「${p.name}」（${p.root_dir}）——项目不能互相嵌套（隔离边界）。请换一个父目录或项目名。` };
      }
    }
  }
  if (existsSync(target)) {
    return { ok: false, code: 'already_exists', message: `同名目录已存在：${name}——不覆盖（换个名字，或改用「接入已有文件夹」）` };
  }
  try {
    // 不用 recursive：目标目录必须由本函数新建；若竞态下已出现，EEXIST 明确拒（绝不写别人的目录）。
    mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, code: 'already_exists', message: `同名目录已存在：${name}——不覆盖（换个名字，或改用「接入已有文件夹」）` };
    }
    return {
      ok: false,
      code: 'create_failed',
      message: `建目录失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let docsTemplate: DocsTemplateResult | undefined;
  try {
    writeFileSync(join(target, 'README.md'), `# ${name}\n\n（由 ai-company 代建；把需求说给幕僚长即可开工）\n`, 'utf8');
    if (withDocsTemplate) docsTemplate = applyDocsTemplate(target, name);
  } catch (error) {
    // 目标目录是本函数刚建的（mkdir 非 recursive 已确保）；失败不留下半成品。
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    return {
      ok: false,
      code: 'create_failed',
      message: `建目录/骨架失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // D-15：代建项目默认 staging。staging 的检查点/回滚/合并依赖 `git worktree`，
  // 而软件新建的目录没有仓库——先初始化仓库并落初始提交，再建项目行。
  // git 不可用/初始化失败 ⇒ 如实回落 inplace（不假装 staging），并返回原因。
  const probe = probeProject(target);
  const gitInit = initGitRepo(target);
  const accessMode = gitInit.ok ? 'staging' : 'inplace';
  const effectiveProbe: ProjectProbe = gitInit.ok
    ? { ...probe, hasGit: true, suggestedAccessMode: 'staging' }
    : { ...probe, suggestedAccessMode: 'inplace' };
  const project = deps.repo.createProject({
    name,
    rootDir: target,
    accessMode,
    ...(aliasCheck.alias != null ? { alias: aliasCheck.alias } : {}),
    now: at,
  });
  return {
    ok: true,
    project,
    probe: effectiveProbe,
    createdDir: target,
    gitInitialized: gitInit.ok,
    ...(gitInit.ok ? {} : { gitError: gitInit.detail }),
    ...(docsTemplate ? { docsTemplate } : {}),
  };
}

/**
 * `docs:check`（**M2 §7 序 4 · 文档管理最小版**）：对本项目的文档树跑一次结构检查（**只读**，不改任何文件）。
 *
 * 口径（`work/plan-doc-and-cost-product.md` §A.2/§A.3）：
 *  - 文档根＝`<项目根>/.aico/docs`；**不存在 ⇒ `hasDocsTree:false` ＋ 零计数**（检查不代建；
 *    新建项目时的模板由 M3-DOC-1 的 `project:create` 负责）；
 *  - 判据＝`src/main/docs/check.ts`（policy 驱动；默认策略只查通用纪律：入口/头注三行/区索引/悬空引用/
 *    目录链接/体量；仓库私有的命名规则等 M3 模板落地再开）；
 *  - 安全：只读项目根内；跳过依赖/产物目录（`node_modules`/`.git`/`dist`/`out` 等）与**符号链接**（防环）；
 *    文件数与单文件体量有上限，**超出如实标注**（`truncated`）。
 */
export function handleDocsCheck(
  deps: IpcDeps,
  raw: unknown,
): { ok: true; docRoot: string; hasDocsTree: boolean; counts: DocCounts; issues: DocIssue[]; truncated: boolean } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown };
  const projectId = Number(input.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { projectId }（正整数）' };
  }
  const project = deps.repo.getProject(projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：#${projectId}` };
  if (!project.rootDir) return { ok: false, code: 'no_project_root', message: '项目没有根目录（无法定位文档树）' };
  const docRootAbs = resolve(project.rootDir, '.aico', 'docs');
  if (!existsSync(docRootAbs)) {
    return {
      ok: true,
      docRoot: '.aico/docs',
      hasDocsTree: false,
      counts: { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 },
      issues: [],
      truncated: false,
    };
  }
  const walk = walkDocsTree(docRootAbs);
  const io = {
    listFiles: () => walk.files,
    read: (p: string) => readDocText(join(docRootAbs, ...p.split('/'))),
    exists: (p: string) => existsSync(join(docRootAbs, ...p.split('/'))),
  };
  const result = checkDocs(defaultDocsPolicy(), io);
  return {
    ok: true,
    docRoot: '.aico/docs',
    hasDocsTree: true,
    counts: result.counts,
    issues: result.issues,
    truncated: result.truncated || walk.truncated,
  };
}

/**
 * `docs:organize-preview`（M3-DOC-3）——只读预览：只补区索引（README 追加/新建），
 * 返回 changes（before/after/added）＋ token＋检查读数；不写任何文件。
 */
export function handleDocsOrganizePreview(
  deps: IpcDeps,
  raw: unknown,
):
  | {
      ok: true;
      docRoot: string;
      hasDocsTree: boolean;
      changes: DocsIndexChange[];
      token: string | null;
      counts: DocCounts;
      issues: DocIssue[];
      truncated: boolean;
    }
  | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { projectId?: unknown };
  const projectId = Number(input.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { projectId }（正整数）' };
  }
  const project = deps.repo.getProject(projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：#${projectId}` };
  if (!project.rootDir) return { ok: false, code: 'no_project_root', message: '项目没有根目录（无法定位文档树）' };
  const docRootAbs = resolve(project.rootDir, '.aico', 'docs');
  if (!existsSync(docRootAbs)) {
    return {
      ok: true,
      docRoot: '.aico/docs',
      hasDocsTree: false,
      changes: [],
      token: null,
      counts: { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 },
      issues: [],
      truncated: false,
    };
  }
  const walk = walkDocsTree(docRootAbs);
  const read = (p: string): string | null => readDocText(join(docRootAbs, ...p.split('/')));
  const changes = buildDocsIndexPlan(walk.files, read);
  const result = checkDocs(defaultDocsPolicy(), {
    listFiles: () => walk.files,
    read,
    exists: (p: string) => existsSync(join(docRootAbs, ...p.split('/'))),
  });
  return {
    ok: true,
    docRoot: '.aico/docs',
    hasDocsTree: true,
    changes,
    token: docsOrganizeToken(projectId, changes),
    counts: result.counts,
    issues: result.issues,
    truncated: result.truncated || walk.truncated,
  };
}

/**
 * `docs:organize-apply`（M3-DOC-3）——应用预览计划：
 * 重算计划并核对 token（预览后改了文件 ⇒ `stale_plan`）；只写区索引 README；
 * 任一路径越界/符号链接/写入失败 → 拒绝或按备份回滚（`rolled_back` 如实）。
 */
export function handleDocsOrganizeApply(
  deps: IpcDeps,
  raw: unknown,
):
  | { ok: true; applied: string[]; counts: DocCounts; issues: DocIssue[]; truncated: boolean }
  | { ok: false; code: string; message: string; rolledBack?: boolean } {
  const input = (raw ?? {}) as { projectId?: unknown; token?: unknown };
  const projectId = Number(input.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { projectId }（正整数）' };
  }
  if (typeof input.token !== 'string' || input.token.length === 0) {
    return { ok: false, code: 'bad_request', message: '需要 { token }（预览返回的令牌）' };
  }
  const project = deps.repo.getProject(projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：#${projectId}` };
  if (!project.rootDir) return { ok: false, code: 'no_project_root', message: '项目没有根目录（无法定位文档树）' };
  const docRootAbs = resolve(project.rootDir, '.aico', 'docs');
  if (!existsSync(docRootAbs)) return { ok: false, code: 'no_docs_tree', message: '没有 .aico/docs 文档树（先初始化或新建项目）' };
  const walk = walkDocsTree(docRootAbs);
  const read = (p: string): string | null => readDocText(join(docRootAbs, ...p.split('/')));
  const changes = buildDocsIndexPlan(walk.files, read);
  if (docsOrganizeToken(projectId, changes) !== input.token) {
    return { ok: false, code: 'stale_plan', message: '预览已过期（文件在预览后变化）——请重新预览再应用' };
  }
  const applied = applyDocsIndexChanges(docRootAbs, changes, createDocsOrganizeIo());
  if (!applied.ok) {
    return {
      ok: false,
      code: applied.code,
      message: applied.message,
      rolledBack: applied.rolledBack,
    };
  }
  const result = checkDocs(defaultDocsPolicy(), {
    listFiles: () => walkDocsTree(docRootAbs).files,
    read,
    exists: (p: string) => existsSync(join(docRootAbs, ...p.split('/'))),
  });
  return {
    ok: true,
    applied: applied.applied,
    counts: result.counts,
    issues: result.issues,
    truncated: result.truncated,
  };
}

/**
 * `task:reference-artifact`（**G-A/G-B/C，M2 §7 序 3**）：把某任务的产物**引用到目标任务**——
 * 老板显式发起的 `copy`（快照 ＋ sha256；`copy` 是已裁的 v1 口径，`link` 后议不实现）。
 *
 * 硬规则（`work/plan-doc-and-cost-product.md` §4.1，落地为代码约束）：
 *  ① **AI 不得自主跨项目读**：本通道只由 UI（老板动作）调用；**AI 侧无任何对应工具/通道**（不存在即隔离），
 *    且源路径必须落在**源项目根内**（绝对路径/`..` 越界/URL 伪装一律拒）；
 *  ② **引用带来源标记**：新产物行记 `origin_artifact_id`/`origin_project_id`（007 列），sha256 按**实读字节**
 *    重算（与源记录不一致 → 照实入库 ＋ note 显式标注，**不臆造**）；动作记 `task_events.artifact_referenced`。
 * 幂等：同一源产物重复引用 → 同一目标路径命中（`duplicated=true`，不重复落卡）。
 * 量级守卫：单文件 > 32 MiB 拒绝（`too_large`）——避免静默复制巨型产物；需要更大再走显式件。
 */
export function handleArtifactReference(
  deps: IpcDeps,
  raw: unknown,
  at: number,
):
  | { ok: true; artifactId: number; path: string; sha256: string | null; duplicated: boolean }
  | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { artifactId?: unknown; targetTaskId?: unknown; mode?: unknown };
  const artifactId = Number(input.artifactId);
  const targetTaskId = Number(input.targetTaskId);
  const mode = input.mode === 'link' ? 'link' : 'copy';
  if (!Number.isInteger(artifactId) || artifactId <= 0 || !Number.isInteger(targetTaskId) || targetTaskId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { artifactId, targetTaskId }（正整数）' };
  }
  const artifact = deps.repo.getArtifact(artifactId);
  if (!artifact) return { ok: false, code: 'not_found', message: `产物不存在：#${artifactId}` };
  const target = deps.repo.getTask(targetTaskId);
  if (!target) return { ok: false, code: 'not_found', message: `目标任务不存在：#${targetTaskId}` };
  const sourceTask = deps.repo.getTask(artifact.taskId);
  if (!sourceTask) return { ok: false, code: 'not_found', message: `源产物所属任务不存在：#${artifact.taskId}` };
  const sourceProject = deps.repo.getProject(sourceTask.projectId);
  const targetProject = deps.repo.getProject(target.projectId);
  if (!sourceProject?.rootDir || !targetProject?.rootDir) {
    return { ok: false, code: 'no_project_root', message: '源或目标项目没有根目录（无法定位文件）' };
  }
  const originLabel = `${sourceTask.shortId ?? `#${sourceTask.id}`}（项目 ${sourceProject.name}）`;

  // ① URL 类产物：不抓取网络内容（不越权），登记一条带来源的 url 行。
  if (artifact.kind === 'url') {
    if (mode === 'link') {
      return { ok: false, code: 'link_not_applicable', message: 'URL 产物没有本地文件，不能 link（请用 copy 引用）' };
    }
    const rec = deps.repo.recordArtifactReference({
      targetTaskId,
      path: artifact.path,
      kind: 'url',
      note: `引用自 ${originLabel}（URL，未抓取内容）`,
      sha256: artifact.sha256 ?? null,
      originArtifactId: artifact.id,
      originProjectId: sourceProject.id,
      originTaskId: artifact.taskId,
      mode: 'copy',
      now: at,
    });
    return { ok: true, artifactId: rec.artifactId, path: artifact.path, sha256: artifact.sha256 ?? null, duplicated: !rec.created };
  }

  // ② 文件类产物：相对路径 ＋ 源根包含性校验（D1：renderer/文件系统不得越界）。
  const rel = artifact.path ?? '';
  if (rel.length === 0 || isAbsolute(rel) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rel)) {
    return { ok: false, code: 'bad_request', message: `产物路径不可引用（需项目内相对路径）：${rel || '（空）'}` };
  }
  const sourceRoot = resolve(sourceProject.rootDir);
  const sourceAbs = resolve(sourceRoot, rel);
  if (sourceAbs !== sourceRoot && !sourceAbs.startsWith(sourceRoot + sep)) {
    return { ok: false, code: 'path_escape', message: `产物路径越出源项目根：${rel}` };
  }
  let stat: { isFile(): boolean; size: number };
  try {
    stat = statSync(sourceAbs);
  } catch {
    return { ok: false, code: 'missing_file', message: `源文件不在盘上：${rel}（快照不存在，拒绝臆造内容）` };
  }
  if (!stat.isFile()) return { ok: false, code: 'not_a_file', message: `源路径不是文件：${rel}` };
  if (stat.size > 32 * 1024 * 1024) {
    return { ok: false, code: 'too_large', message: `文件过大（${Math.round(stat.size / 1024 / 1024)} MiB > 32 MiB）——显式件再议` };
  }
  const bytes = readFileSync(sourceAbs);
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  const mismatch = artifact.sha256 != null && artifact.sha256 !== actualSha;
  const mismatchNote = mismatch
    ? `｜⚠️ 源记录指纹不一致（记录 ${String(artifact.sha256).slice(0, 12)}… ≠ 实读）`
    : '';

  // M2 尾：link 模式——**不复制**（源随动）；读时按源项目根解析（`source='link:<projectId>'`）。
  if (mode === 'link') {
    const source = `link:${sourceProject.id}`;
    const rec = deps.repo.recordArtifactReference({
      targetTaskId,
      path: rel,
      kind: artifact.kind || 'file',
      note: `引用自 ${originLabel}（link 模式：不复制；读时按源项目根解析；sha256 为链接时快照 ${actualSha.slice(0, 12)}…）${mismatchNote}`,
      sha256: actualSha,
      originArtifactId: artifact.id,
      originProjectId: sourceProject.id,
      originTaskId: artifact.taskId,
      mode: 'link',
      source,
      now: at,
    });
    return { ok: true, artifactId: rec.artifactId, path: rel, sha256: actualSha, duplicated: !rec.created };
  }

  const safeBase = (basename(rel).replace(/[^\w.\-]+/g, '_') || 'file').slice(0, 120);
  const relTarget = `refs/${sourceTask.shortId ?? `T${sourceTask.id}`}-a${artifact.id}-${safeBase}`;
  const targetRoot = resolve(targetProject.rootDir);
  const targetAbs = resolve(targetRoot, relTarget);
  if (targetAbs !== targetRoot && !targetAbs.startsWith(targetRoot + sep)) {
    return { ok: false, code: 'path_escape', message: `目标路径越出目标项目根：${relTarget}` };
  }
  try {
    mkdirSync(dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, bytes);
  } catch (error) {
    return {
      ok: false,
      code: 'write_failed',
      message: `写目标副本失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const note =
    `引用自 ${originLabel}（copy 快照；实读 sha256 ${actualSha.slice(0, 12)}…）` + mismatchNote;
  const rec = deps.repo.recordArtifactReference({
    targetTaskId,
    path: relTarget,
    kind: artifact.kind || 'file',
    note,
    sha256: actualSha,
    originArtifactId: artifact.id,
    originProjectId: sourceProject.id,
    originTaskId: artifact.taskId,
    mode: 'copy',
    source: null,
    now: at,
  });
  return { ok: true, artifactId: rec.artifactId, path: relTarget, sha256: actualSha, duplicated: !rec.created };
}

/**
 * `task:read-artifact`（**BRK16-a，挂载 3**）：产物**读预览 / 系统打开 / 在文件夹中显示**。
 *
 * 口径：
 *  - **D1 铁律**：renderer 只给 `artifactId`（**不接受任何路径**）；读取的绝对路径由主进程按
 *    「产物行 → 所属任务 → 项目根」推导，并做**项目根包含性校验**（越界显式拒，不静默）；
 *  - `mode='read'`（缺省）：文本预览——**二进制显式拒**（NUL 探测；不臆造乱码）、超 256 KiB
 *    **截断并如实标注** `truncated`；附**实读 sha256**（与记录不一致显式 `sha256Mismatch`）；
 *  - `mode='open'/'reveal'`：经注入的 `openPath`/`revealPath`（electron `shell`）——handler 不直接碰 electron；
 *  - URL 类产物没有本地文件（显式说明）。
 */
export const ARTIFACT_READ_CAP = 256 * 1024;

export type ArtifactReadResult =
  | {
      ok: true;
      mode: 'read';
      name: string;
      path: string;
      size: number;
      sha256: string;
      sha256Mismatch: boolean;
      /**
       * 2026-11-05（老板真机：同路径两行、一行 ⚠️ 看着像故障）：同任务同路径存在**更晚产出**时
       * 给出指向。旧行的 sha 记录的是它当时的版本，文件后来被后续工作项改过 ⇒ `sha256Mismatch`
       * 是事实而非异常；渲染层据此显示「旧版本（已被 #N 后续产出覆盖）」而不报警。
       */
      supersededBy?: { artifactId: number; createdAt: number } | null;
      text: string;
      truncated: boolean;
      /** UG-05：图片/PDF 走受控协议预览（与聊天附件同一个 `aico-file://` 短票）。 */
      previewKind?: 'image' | 'pdf';
      previewUrl?: string;
    }
  | { ok: true; mode: 'open' | 'reveal'; name: string; path: string }
  | { ok: false; code: string; message: string };

/** 同任务同路径的**更晚**产出（先比 created_at 再比 id；无则 null）。 */
function newerArtifactOf(
  db: import('../db/open.js').SqliteDb | undefined,
  artifact: { id: number; taskId: number; path: string },
): { artifactId: number; createdAt: number } | null {
  if (!db) return null;
  const mine = db.prepare('SELECT created_at FROM artifacts WHERE id = ?').get(artifact.id) as
    | { created_at: number }
    | undefined;
  const row = db
    .prepare(
      'SELECT id, created_at FROM artifacts WHERE task_id = ? AND path = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(artifact.taskId, artifact.path, artifact.id) as { id: number; created_at: number } | undefined;
  if (!row) return null;
  const mineAt = mine?.created_at ?? 0;
  if (row.created_at > mineAt || (row.created_at === mineAt && row.id > artifact.id)) {
    return { artifactId: row.id, createdAt: row.created_at };
  }
  return null;
}

export async function handleReadArtifact(deps: IpcDeps, raw: unknown): Promise<ArtifactReadResult> {
  const input = (raw ?? {}) as { artifactId?: unknown; mode?: unknown };
  const artifactId = Number(input.artifactId);
  const mode = input.mode === 'open' || input.mode === 'reveal' ? input.mode : 'read';
  if (!Number.isInteger(artifactId) || artifactId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { artifactId }（正整数）' };
  }
  const artifact = deps.repo.getArtifact(artifactId);
  if (!artifact) return { ok: false, code: 'not_found', message: `产物不存在：#${artifactId}` };
  if ((artifact.kind ?? '') === 'url') {
    return { ok: false, code: 'url_artifact', message: 'URL 类产物没有本地文件（请在浏览器中打开）' };
  }
  const task = deps.repo.getTask(artifact.taskId);
  if (!task) return { ok: false, code: 'not_found', message: `产物所属任务不存在：#${artifact.taskId}` };
  const project = deps.repo.getProject(task.projectId);
  if (!project || !project.rootDir) {
    return { ok: false, code: 'no_project_root', message: '项目没有根目录（无法定位产物文件）' };
  }
  // M2 尾（G-A link）：链接产物**不复制**，读时按源项目根解析（来源列 `source='link:<projectId>'`）。
  const linked = typeof artifact.source === 'string' && artifact.source.startsWith('link:');
  const rootProject = linked
    ? artifact.originProjectId != null
      ? deps.repo.getProject(artifact.originProjectId)
      : null
    : project;
  if (!rootProject?.rootDir) {
    return { ok: false, code: 'link_origin_missing', message: '链接产物的源项目不在了（无法解析源文件）——请重新引用' };
  }
  const rel = artifact.path ?? '';
  if (rel.length === 0 || isAbsolute(rel) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rel)) {
    return { ok: false, code: 'bad_request', message: `产物路径不可读（需项目内相对路径）：${rel || '（空）'}` };
  }
  const root = resolve(rootProject.rootDir);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, code: 'path_escape', message: `产物路径越出项目根：${rel}` };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, code: 'missing_file', message: `文件不在盘上：${rel}` };
  }
  if (!stat.isFile()) return { ok: false, code: 'not_a_file', message: `产物路径不是文件：${rel}` };
  const name = basename(rel) || rel;

  if (mode === 'open' || mode === 'reveal') {
    if (mode === 'open') {
      if (!deps.openPath) return { ok: false, code: 'open_unavailable', message: '系统打开不可用（非桌面环境）' };
      const err = await deps.openPath(abs);
      if (err) return { ok: false, code: 'open_failed', message: `系统打开失败：${err}` };
    } else {
      if (!deps.revealPath) {
        return { ok: false, code: 'reveal_unavailable', message: '在文件夹中显示不可用（非桌面环境）' };
      }
      deps.revealPath(abs);
    }
    return { ok: true, mode, name, path: rel };
  }

  const type = inferType(name, '');
  const previewKind = kindFor(name, type);
  // UG-05：图片/PDF 走与聊天附件相同的受控短票预览（renderer 仍拿不到路径）。
  if ((previewKind === 'image' || previewKind === 'pdf') && stat.size <= 50 * 1024 * 1024) {
    const bytes = readFileSync(abs);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const token = createPreviewToken({ path: abs, name, type });
    return {
      ok: true,
      mode: 'read',
      name,
      path: rel,
      size: stat.size,
      sha256,
      sha256Mismatch: artifact.sha256 != null && artifact.sha256 !== sha256,
      supersededBy: newerArtifactOf(deps.db, artifact),
      text: '',
      truncated: false,
      previewKind,
      previewUrl: `aico-file://preview/${token}`,
    };
  }

  const bytes = readFileSync(abs);
  if (bytes.subarray(0, 8192).includes(0)) {
    return { ok: false, code: 'binary_file', message: `二进制文件（${rel}）——请用「打开」查看` };
  }
  const truncated = bytes.length > ARTIFACT_READ_CAP;
  const slice = truncated ? bytes.subarray(0, ARTIFACT_READ_CAP) : bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    ok: true,
    mode: 'read',
    name,
    path: rel,
    size: bytes.length,
    sha256,
    sha256Mismatch: artifact.sha256 != null && artifact.sha256 !== sha256,
    supersededBy: newerArtifactOf(deps.db, artifact),
    text: slice.toString('utf8'),
    truncated,
  };
}

/** UG-06：单文件只读 diff（变更集 base..head；renderer 只拿 diff 文本，不拿路径）。 */
export const CHANGESET_DIFF_CAP = 256 * 1024;

export type ChangesetDiffResult =
  | {
      ok: true;
      path: string;
      diff: string;
      truncated: boolean;
      baseSha: string;
      headSha: string;
    }
  | { ok: false; code: string; message: string };

/**
 * `task:diff`：读一个变更集文件的只读 diff（`git diff base..head -- path`）。
 * 只接受变更集里**已登记**的 path；不允许绝对路径/`..`；不返回仓库绝对路径。
 */
export function handleReadChangesetDiff(deps: IpcDeps, raw: unknown): ChangesetDiffResult {
  if (!deps.db) return { ok: false, code: 'not_ready', message: '数据库未装配' };
  const input = (raw ?? {}) as { taskId?: unknown; changesetId?: unknown; path?: unknown };
  const taskId = Number(input.taskId);
  const changesetId = Number(input.changesetId);
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(changesetId) || changesetId <= 0 || path.length === 0) {
    return { ok: false, code: 'bad_request', message: '需要 { taskId, changesetId, path }' };
  }
  if (isAbsolute(path) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path) || path.split(/[\\/]/).includes('..')) {
    return { ok: false, code: 'bad_request', message: 'diff path 必须是变更集内的相对路径' };
  }
  const detail = deps.repo.getTaskDetail(taskId);
  if (!detail) return { ok: false, code: 'not_found', message: `任务不存在：#${taskId}` };
  const changeset = (detail.changesets ?? []).find((item) => item.id === changesetId);
  if (!changeset) return { ok: false, code: 'not_found', message: `变更集不存在：#${changesetId}` };
  if (!changeset.files.some((file) => file.path === path)) {
    return { ok: false, code: 'not_found', message: `变更集里没有这个文件：${path}` };
  }
  if (!changeset.baseSha || !changeset.headSha) {
    return { ok: false, code: 'base_unknown', message: '变更集基准未知（base/head 缺失）——不展示猜测的 diff' };
  }
  const task = deps.repo.getTask(taskId);
  const project = task ? deps.repo.getProject(task.projectId) : null;
  if (!project?.rootDir) return { ok: false, code: 'no_project_root', message: '项目没有根目录' };
  const git = deps.git ?? createGitRunner();
  const res = git.run(['diff', '--no-color', '--unified=3', changeset.baseSha, changeset.headSha, '--', path], project.rootDir);
  if (res.status !== 0) {
    console.warn('[changeset-diff] git diff 失败', res.stderr.slice(0, 500));
    return { ok: false, code: 'git_failed', message: 'git diff 失败（仓库不可读或提交不存在）' };
  }
  const truncated = Buffer.byteLength(res.stdout, 'utf8') > CHANGESET_DIFF_CAP;
  return {
    ok: true,
    path,
    diff: truncated ? Buffer.from(res.stdout, 'utf8').subarray(0, CHANGESET_DIFF_CAP).toString('utf8') : res.stdout,
    truncated,
    baseSha: changeset.baseSha,
    headSha: changeset.headSha,
  };
}

/** GAP11（审计导出）＋BRK16-a：任务档案单一文件包（schema 标记；**同名覆盖**＝同一任务始终一个档案文件）。 */
export const TASK_EXPORT_SCHEMA = 'aico.task-export/v1';

export type TaskExportResult =
  | { ok: true; path: string; bytes: number; schema: string; openError?: string }
  | { ok: false; code: string; message: string };

/**
 * `task:export`（**GAP11 审计导出**）：把「任务 + 事件时间线 + 产物 + 成本」打成**单一 JSON 文件**
 * （落在 main 注入的 `exportDir`，默认 `userData/exports`；renderer 不参与路径）。
 * `openAction='open'/'reveal'`（可选）在写出后调 `openPath`/`revealPath`；**打开失败不回滚导出**
 * （导出已成功是事实，`openError` 如实附带）。
 */
export async function handleExportTask(deps: IpcDeps, raw: unknown, at: number): Promise<TaskExportResult> {
  const input = (raw ?? {}) as { taskId?: unknown; openAction?: unknown };
  const taskId = Number(input.taskId);
  const openAction = input.openAction === 'open' || input.openAction === 'reveal' ? input.openAction : null;
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return { ok: false, code: 'bad_request', message: '需要 { taskId }（正整数）' };
  }
  const detail = deps.repo.getTaskDetail(taskId);
  if (!detail) return { ok: false, code: 'not_found', message: `任务不存在：#${taskId}` };
  if (!deps.exportDir) return { ok: false, code: 'export_unavailable', message: '导出目录不可用（非桌面环境）' };

  let dir: string;
  try {
    dir = deps.exportDir();
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'export_failed', message: `创建导出目录失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const shortId = detail.task.shortId ?? `T${detail.task.id}`;
  const file = join(dir, `task-${shortId.replace(/[^\w.\-]+/g, '_')}.json`);
  const bundle = {
    schema: TASK_EXPORT_SCHEMA,
    exportedAt: at,
    task: detail.task,
    progress: detail.progress,
    planSteps: detail.planSteps,
    events: detail.timeline,
    artifacts: detail.artifacts,
    changesets: detail.changesets,
    checkpoints: deps.db ? listCheckpointsByTask(deps.db, taskId) : [],
    approvals: deps.db
      ? deps.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY id').all(taskId)
      : [],
    workItemIds: deps.repo.listWorkItemIds(taskId),
    reports: deps.repo.listReports({ taskId }),
    costs: deps.repo.taskCosts(taskId),
  };
  let bytes: number;
  try {
    writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
    bytes = statSync(file).size;
  } catch (error) {
    return { ok: false, code: 'export_failed', message: `写导出文件失败：${error instanceof Error ? error.message : String(error)}` };
  }

  let openError: string | undefined;
  if (openAction === 'open') {
    if (!deps.openPath) openError = '系统打开不可用（非桌面环境）';
    else {
      // UG-10：打开/定位失败**不回滚导出**——异常也转 openError，不炸整条 IPC。
      try {
        const err = await deps.openPath(file);
        if (err) openError = `系统打开失败：${err}`;
      } catch (error) {
        openError = `系统打开失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } else if (openAction === 'reveal') {
    if (!deps.revealPath) openError = '在文件夹中显示不可用（非桌面环境）';
    else {
      try {
        deps.revealPath(file);
      } catch (error) {
        openError = `在文件夹中显示失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return { ok: true, path: file, bytes, schema: TASK_EXPORT_SCHEMA, ...(openError ? { openError } : {}) };
}


// ── T0.6：手工建任务 + 状态机逐步推进 ─────────────────────────────────

/** `task:create`：建单（落 `inbox`，短号与 INSERT 同流程），返回 `TaskDTO`。 */
/**
 * `task:create`：建单（落 `inbox`，短号与 INSERT 同流程）＋ **D1：建任务即分诊**。
 *
 * D1（链路审计）：左栏「＋建任务」＝**老板明确要建** ⇒ 建完直接 `triage` 进 `planning`
 * （不再停在 `inbox` 等人推——此前**无人发 `triage`**，任务永远不动）。
 * 无引擎（旧测试/未装配）→ 保持 `inbox` 并如实返回（不假装已分诊）。
 */
export async function handleTaskCreate(deps: IpcDeps, raw: unknown): Promise<TaskDTO> {
  // D-22 assistant 需要模型目录；D-2 已把启动预热延后到首帧后 10s，这里在首次建任务时
  // 再补一次（loadModelCatalog 有缓存，通常已就绪）——保证第一单的幕僚长选型不因启动延后而退化。
  await Promise.race([
    loadModelCatalog().catch((error: unknown) => {
      console.warn(`[model-catalog] 建任务前加载失败（assistant 选型会回落）：${error instanceof Error ? error.message : String(error)}`);
    }),
    // 目录加载异常时不能把建任务无限挂住；2s 后照常建单（assistant 选型回落规则）。
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  const input = (raw ?? {}) as {
    projectId?: number;
    title?: unknown;
    goal?: unknown;
    acceptance?: unknown;
    riskLevel?: unknown;
    ownerId?: unknown;
    budgetTokens?: unknown;
    model?: unknown;
    deadline?: unknown;
    dependsOn?: unknown;
    /** GAP1：来源（`boss`/`trigger:cron`/`trigger:event`/`renew`…）；触发建任务必须显式传。 */
    origin?: unknown;
    /** 分诊 payload 的来源标记（缺省 `manual_create`）。 */
    via?: unknown;
  };
  const origin = typeof input.origin === 'string' && input.origin.trim().length > 0 ? input.origin.trim() : undefined;
  const via = typeof input.via === 'string' && input.via.trim().length > 0 ? input.via.trim() : 'manual_create';
  const goal = typeof input.goal === 'string' ? input.goal : '';
  const title =
    typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : goal.trim().slice(0, 40) || '未命名任务';
  // 归属项目解析（显式 > 默认项目；未设置 → null＝由 repo 的 NOT NULL 锚兜底）——编制缺省与模型白名单共用。
  const resolvedProjectId =
    typeof input.projectId === 'number' ? input.projectId : (deps.repo.resolverStore.getDefaultProject()?.id ?? null);
  if (resolvedProjectId != null) {
    const targetProject = deps.repo.getProject(resolvedProjectId);
    if (targetProject?.archived === 1) {
      throw new Error(`[task:create] 项目 #${resolvedProjectId} 已归档——不能新建任务（先恢复项目）`);
    }
  }
  // 编制 v1（D-11）：建任务缺省——**显式入参优先**；未显式 ⇒ 编制值（员工已过在职校验）；未设置 ⇒ 不写（回落）。
  const explicitOwnerId = typeof input.ownerId === 'number' && Number.isInteger(input.ownerId) ? input.ownerId : undefined;
  const staffing = resolvedProjectId != null ? deps.repo.projectStaffing(resolvedProjectId) : null;
  const ownerId = explicitOwnerId ?? staffing?.ownerEmployeeId ?? undefined;
  // R3-1：档位显式可选（仅接受整数 0/1/2；非法/缺省 → 不透传，db 缺省 1＝L1 审计划）。
  // D-11：显式档缺省时用编制·默认档预填（任务级仍可改——UI 下拉直选）。
  const explicitRiskLevel =
    typeof input.riskLevel === 'number' && Number.isInteger(input.riskLevel) && input.riskLevel >= 0 && input.riskLevel <= 2
      ? input.riskLevel
      : undefined;
  const riskLevel = explicitRiskLevel ?? staffing?.defaultRiskTier ?? undefined;
  // BRK13（挂载 3）：预算显式可选（正整数 token；非法/缺省 → 不透传 ⇒ 未设预算，不臆造）。
  const explicitBudgetTokens =
    typeof input.budgetTokens === 'number' && Number.isInteger(input.budgetTokens) && input.budgetTokens > 0
      ? input.budgetTokens
      : undefined;
  if (input.budgetTokens !== undefined && explicitBudgetTokens === undefined) {
    throw new Error('[task:create] budgetTokens 需为正整数 token（省略＝继承项目默认/不限）');
  }
  // v19：未显式给预算 → 用项目默认任务预算（仍只是本次任务的 token 预算，不是新的日 USD 闸门）。
  const projectDefaultBudget =
    explicitBudgetTokens === undefined && resolvedProjectId != null
      ? (deps.repo.getProject(resolvedProjectId)?.defaultBudgetTokens ?? null)
      : null;
  const budgetTokens = explicitBudgetTokens ?? projectDefaultBudget ?? undefined;
  // M2 尾：截止时刻（正整数 epoch ms；显式给非法值 → 响亮拒，不静默丢）。
  const deadline =
    typeof input.deadline === 'number' && Number.isFinite(input.deadline) && input.deadline > 0
      ? Math.trunc(input.deadline)
      : undefined;
  if (input.deadline !== undefined && deadline === undefined) {
    throw new Error('[task:create] deadline 需为正整数 epoch ms');
  }
  // M2 尾（D4）：依赖任务 id 数组（正整数；去重；非法 → 响亮拒）。
  const dependsOnRaw = Array.isArray(input.dependsOn) ? input.dependsOn : [];
  const dependsOn = [
    ...new Set(
      dependsOnRaw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0),
    ),
  ];
  if (input.dependsOn !== undefined && dependsOn.length !== dependsOnRaw.length) {
    throw new Error('[task:create] dependsOn 需为正整数数组');
  }
  // 009（N5 余账）：任务级模型显式可选（**项目白名单拦点**——EMPLOYEES §10.3；违例响亮拒，不静默落库）。
  const model = typeof input.model === 'string' && input.model.trim().length > 0 ? input.model.trim() : undefined;
  if (model) {
    const project = resolvedProjectId != null ? deps.repo.getProject(resolvedProjectId) : null;
    const error = modelWhitelistError({
      model,
      allowedProviders: project?.allowedProviders ?? [],
      projectLabel: project?.name ?? null,
    });
    if (error) throw new Error(`[task:create] ${error}`);
    // D-22：项目模型级允许清单在建任务时前置拒绝（运行时也会拒；这里不让坏配置先落库）。
    const allowedModels = project?.allowedModels ?? [];
    if (allowedModels.length > 0 && !allowedModels.includes(model)) {
      throw new Error(
        `[task:create] 任务模型「${model}」不在项目允许清单内（允许：${allowedModels.join(' / ')}）`,
      );
    }
  }
  // BRK17 深件（挂载 3 余）：**归属拿不准 → 问一次归属**（PLAN §「任务必须归属一个项目…无法判断时
  // 落默认项目或问你一次」；`db/projects.ts`「空 = 未设置 → null，由 resolver 走'模糊时问你一次'」）。
  // 判据（先于建行取数）：未显式给项目 && 默认项目未设置 && 已有多个项目可选 ⇒ 不猜。
  const ambiguousOwnership =
    typeof input.projectId !== 'number' &&
    deps.repo.resolverStore.getDefaultProject() == null &&
    deps.repo.listProjects().length > 1;
  const task = deps.repo.createTask({
    projectId: typeof input.projectId === 'number' ? input.projectId : undefined,
    title,
    goal,
    acceptance: Array.isArray(input.acceptance) ? input.acceptance : [],
    ...(ownerId !== undefined ? { ownerId } : {}),
    ...(riskLevel !== undefined ? { riskLevel } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(origin !== undefined ? { origin } : {}),
  });
  // C4：公司日预算已用尽 → 任务照建（不丢用户输入），但不分诊/不烧规划；留可见痕迹。
  const budgetHold = deps.engine?.companyDailyBudgetHold?.();
  if (budgetHold) {
    if (deps.db) {
      insertTaskEvent(deps.db, {
        taskId: task.id,
        ts: Date.now(),
        kind: 'action_failed',
        actor: 'system',
        payload: { action: 'triage', reason: budgetHold },
      });
    }
    return toTaskDTO(deps.repo.getTask(task.id) ?? task);
  }
  // F-05（2026-10-24）：建任务只负责“落行＋回执”，**不 await 规划/critic**。
  // 规划会话可能跑几分钟；同步 await 会让建任务对话框一直卡“创建中”。
  // dispatch 本身会先同步应用 triage/ask_owner，状态迁移仍立即可见；后续失败落 action_failed。
  const reportCreateDispatchFailure = (action: 'ask_owner' | 'triage', error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[task:create] ${action} 后台派发失败（任务已建，状态可见）`, error);
    if (!deps.db) return;
    try {
      insertTaskEvent(deps.db, {
        taskId: task.id,
        ts: Date.now(),
        kind: 'action_failed',
        actor: 'system',
        payload: { action, reason, via },
      });
    } catch (writeError) {
      console.error('[task:create] 后台派发失败留痕写入失败', writeError);
    }
  };
  if (deps.engine && ambiguousOwnership) {
    void deps.engine
      .dispatch({
        scope: 'task',
        id: task.id,
        event: 'ask_owner',
        actor: origin && origin !== 'boss' ? 'system' : 'boss',
        payload: {
          question:
            `新任务 ${task.shortId ?? `#${task.id}`} 暂挂「默认项目」（未设默认项目、现有多个项目）。` +
            `要归到别的项目：回复「#项目别名 目标」重新说明；否则到左栏「待分诊」点「确认为任务」即按「默认项目」开工。`,
          urgent: false,
          notifyRevision: Date.now(),
          via,
        },
      })
      .catch((error: unknown) => reportCreateDispatchFailure('ask_owner', error));
  } else if (deps.engine) {
    void deps.engine
      .dispatch({
        scope: 'task',
        id: task.id,
        event: 'triage',
        actor: origin && origin !== 'boss' ? 'system' : 'boss',
        payload: { via },
      })
      .catch((error: unknown) => reportCreateDispatchFailure('triage', error));
  }
  return toTaskDTO(deps.repo.getTask(task.id) ?? task);
}

/** `task:list`：左栏分组用（可选 state / projectId 过滤）。 */
export function handleTaskList(deps: IpcDeps, raw: unknown): TaskDTO[] {
  const query = (raw ?? {}) as {
    state?: string;
    projectId?: number;
    includeArchived?: boolean;
    since?: number;
    limit?: number;
  };
  return deps.repo
    .listTasks({
      state: query.state,
      projectId: query.projectId,
      includeArchived: query.includeArchived,
      since: query.since,
      limit: query.limit,
    })
    .map((task) => ({
      ...toTaskDTO(task),
      waits: computeWaits(deps, task.id),
    }));
}

/** `task:get`：单任务详情（T0.7 三 tab 用）。返回 `null` 表示任务不存在 / 入参非法。 */
export function handleTaskGet(deps: IpcDeps, raw: unknown): TaskDetailDTO | null {
  const input = (raw ?? {}) as { taskId?: number };
  if (typeof input.taskId !== 'number') return null;
  const detail = deps.repo.getTaskDetail(input.taskId);
  if (!detail) return null;

  const acceptance = normalizeAcceptance(detail.task.acceptance);
  const planSteps = detail.planSteps;
  const timeline = detail.timeline;
  const behaviorLog = timeline
    .filter((event) => event.kind === 'tool_call')
    .map((event) => ({
      id: event.id,
      ts: event.ts,
      actor: event.actor,
      workItemId: event.workItemId,
      payload: event.payload,
    }));

  return {
    task: {
      ...toTaskDTO(detail.task),
      goal: detail.task.goal,
      updatedAt: detail.task.updatedAt,
      acceptance,
    },
    owner: detail.owner,
    dependsOn: detail.dependsOn,
    modelResolution: detail.modelResolution,
    progress: detail.progress,
    planSteps,
    reviews: detail.reviews,
    verificationWorkItemId: detail.verificationWorkItemId,
    timeline,
    behaviorLog,
    waits: computeWaits(deps, input.taskId),
    artifacts: detail.artifacts,
    rawConversation: detail.rawConversation,
    changesets: detail.changesets,
    deviations: summarizeDeviations(timeline),
    workItemCounts: detail.workItemCounts,
    contextMetrics: detail.contextMetrics,
    // counts 与上方数组**同源**，保证「DOM 条数 == 查询返回条数」可直接比对（不靠肉眼）。
    counts: {
      planSteps: planSteps.length,
      timeline: timeline.length,
      behaviorLog: behaviorLog.length,
      acceptance: acceptance.length,
    },
  };
}

/**
 * `chat:card-action`：GenUI 卡片意图（M1，`UI §4.7`）。
 * **卡片只发意图**：`{schemaId,componentId,action,payload}`；本入口校验 action 白名单后交给 repo（落库 + 路由）。
 * （危险动作的 `permissionGate` 统一入口在后续里程碑接入；本层**不接受任何直接执行语义**。）
 */
const CARD_ACTIONS: ReadonlySet<string> = new Set(['select', 'submit', 'ack', 'open-artifact', 'approve', 'reject']);

export function handleCardAction(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): { ok: true; result: CardIntentResult } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { schemaId?: unknown; componentId?: unknown; action?: unknown; payload?: unknown };
  const schemaId = typeof input.schemaId === 'string' ? input.schemaId : '';
  const componentId = typeof input.componentId === 'string' ? input.componentId : '';
  const action = typeof input.action === 'string' ? input.action : '';
  if (schemaId.length === 0 || componentId.length === 0 || action.length === 0) {
    return { ok: false, code: 'bad_request', message: 'schemaId / componentId / action are required' };
  }
  if (!CARD_ACTIONS.has(action)) {
    return { ok: false, code: 'action_not_allowed', message: `action '${action}' 不在白名单（UI §4.7）` };
  }
  const payload =
    input.payload && typeof input.payload === 'object' ? (input.payload as Record<string, unknown>) : {};
  const result = deps.repo.recordCardIntent({ schemaId, componentId, action, payload, now: at });
  return { ok: true, result };
}

/**
 * `task:transition`：手工推进（T0.6）。入队即返，结果走 `evt:batch`（不阻塞）。
 * 事件形状 = 引擎 `EngineEvent`（`{scope:'task', id, event, actor, payload}`）。
 */
export async function handleTaskTransition(
  deps: IpcDeps,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const input = (raw ?? {}) as { taskId?: number; event?: unknown; payload?: unknown };
  if (typeof input.taskId !== 'number' || typeof input.event !== 'string') {
    return { ok: false, code: 'bad_request', message: 'taskId + event are required' };
  }
  if (!deps.engine) {
    return { ok: false, code: 'engine_unavailable', message: 'engine is not ready' };
  }
  let payload =
    input.payload && typeof input.payload === 'object'
      ? (input.payload as Record<string, unknown>)
      : undefined;
  // GAP12：手动打回（老板在详情点 [打回]）必须带批注；服务端补「最近 submitted 件」。
  // 批注只在 UI 必填是不够的——IM/直接 IPC 也不能无批注打回或落到“无返工件 executing”。
  if (input.event === 'verification_completed' && payload != null && (payload.verdict ?? 'pass') !== 'pass') {
    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
    if (notes.length === 0) {
      return { ok: false, code: 'bad_request', message: '打回必须填写批注（notes）' };
    }
    if (typeof payload.workItemId !== 'number') {
      const detail = deps.repo.getTaskDetail(input.taskId);
      if (detail?.verificationWorkItemId == null) {
        return { ok: false, code: 'no_work_item', message: '没有可返工的 submitted 工作项——先恢复/重派再打回' };
      }
      payload = {
        ...payload,
        workItemId: detail.verificationWorkItemId,
        via: typeof payload.via === 'string' ? payload.via : 'boss_reject',
      };
    }
  }
  try {
    await deps.engine.dispatch({ scope: 'task', id: input.taskId, event: input.event, actor: 'boss', payload });
    // GAP3：详情操作条直接推进（批准/打回/取消）时，把该任务待决审批卡一并作答。
    // 否则卡一直 pending → 「待我处理」与托盘橙点悬挂（与 `task:approve` 入口不一致）。
    const decision =
      input.event === 'plan_approved' ? 'approve' : input.event === 'revise' ? 'revise' : input.event === 'cancel' ? 'cancel' : null;
    if (decision != null) deps.repo.resolvePendingApprovalForTask(input.taskId, decision, Date.now());
    deps.onInboxChanged?.();
  } catch (error) {
    // 挂载 3（BRK17）：引擎拒绝（未知迁移/守卫不过，如「撤销结束」超 7 天窗口/已归档）→ **人话回执**，
    // 不再让异常一路抛到 renderer 变成静默 reject（此前点这类按钮失败会「什么都没有发生」）。
    return {
      ok: false,
      code: 'transition_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true };
}

/**
 * M3-P-4 / BRK16-b：`task:merge {taskId, changesetId}`。
 * 真值表/幂等/冲突可见由 `src/main/git/merge.ts` 承担；本层只做入参校验。
 */
export function handleTaskMerge(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): ReturnType<ChatRepo['mergeTaskChangeset']> {
  const input = (raw ?? {}) as { taskId?: unknown; changesetId?: unknown };
  if (typeof input.taskId !== 'number' || typeof input.changesetId !== 'number') {
    return { ok: false, code: 'bad_request', message: 'taskId + changesetId are required' };
  }
  return deps.repo.mergeTaskChangeset(input.taskId, input.changesetId, at);
}

/**
 * M3-N-2 / GAP4：`task:rollback {taskId, changesetId, scope?}`。
 * v1 只回代码（`scope='code'` 缺省）；检查点/分支/脏路径/后续提交守卫在 `git/checkpoint.ts`。
 */
export function handleTaskRollback(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): ReturnType<ChatRepo['rollbackTaskChangeset']> {
  const input = (raw ?? {}) as { taskId?: unknown; changesetId?: unknown; scope?: unknown };
  if (typeof input.taskId !== 'number' || typeof input.changesetId !== 'number') {
    return { ok: false, code: 'bad_request', message: 'taskId + changesetId are required' };
  }
  if (input.scope !== undefined && typeof input.scope !== 'string') {
    return { ok: false, code: 'bad_request', message: 'scope must be a string' };
  }
  return deps.repo.rollbackTaskChangeset(input.taskId, input.changesetId, input.scope, at);
}

/**
 * B-2（M4）：`task:discard {taskId, changesetId}`。
 * 只把变更集标记为 `discarded`（不跑 git；主分支/其他工作项不动）；二次调用幂等。
 */
export function handleTaskDiscard(
  deps: IpcDeps,
  raw: unknown,
  at: number,
): ReturnType<ChatRepo['discardTaskChangeset']> {
  const input = (raw ?? {}) as { taskId?: unknown; changesetId?: unknown };
  if (typeof input.taskId !== 'number' || typeof input.changesetId !== 'number') {
    return { ok: false, code: 'bad_request', message: 'taskId + changesetId are required' };
  }
  return deps.repo.discardTaskChangeset(input.taskId, input.changesetId, at);
}

// ── 注册 ────────────────────────────────────────────────────────────────

/**
 * M0 未实现的契约通道（`DEV §7.3`）的显式回执：`{ok:false, code:'not_implemented', channel}`。
 * 目的：避免 `invoke` **静默 reject**（隐藏分叉）；preload 继续暴露，M1 逐个补齐。
 * 注：逐条用**字面量** channel 注册，便于静态契约守卫（`test/ipc-contract.test.ts` AU1）解析。
 */
const notImplemented =
  (channel: string) =>
  (): { ok: false; code: 'not_implemented'; channel: string; message: string } => ({
    ok: false,
    code: 'not_implemented',
    channel,
    message: `${channel} 属 M1/M2，M0 未实现`,
  });

/**
 * `im:bind` / `im:unbind`（复用两个既有通道，不新增冻结通道）：
 *  - `{action:'status'}`（缺省）：读状态；
 *  - `{action:'login'|'bind'}`：开始扫码（后台跑，二维码经后续 status 轮询拿到）；
 *  - `{action:'login', verifyCode}`：平台要求数字验证码时提交；
 *  - `{action:'logout'|'unbind'}`：停轮询并清本地凭证。
 * 未装配 → 明确 `im_unavailable`（不静默 reject）。
 */
export async function handleImBind(
  deps: IpcDeps,
  raw: unknown,
  forced?: 'bind' | 'unbind',
): Promise<{ ok: true; status: ImStatus } | { ok: false; code: string; message: string }> {
  const payload =
    raw && typeof raw === 'object'
      ? (raw as { action?: unknown; verifyCode?: unknown })
      : undefined;
  const action = forced ?? payload?.action;
  const verifyCode =
    typeof payload?.verifyCode === 'string' && payload.verifyCode.trim().length > 0
      ? payload.verifyCode.trim()
      : undefined;
  if (!deps.im) {
    return { ok: false, code: 'im_unavailable', message: 'IM 通道未装配（主进程未启动微信通道）' };
  }
  try {
    if (action === 'login' || action === 'bind' || verifyCode) {
      return { ok: true, status: await deps.im.bind(verifyCode ? { verifyCode } : undefined) };
    }
    if (action === 'logout' || action === 'unbind') {
      return { ok: true, status: await deps.im.unbind() };
    }
    return { ok: true, status: deps.im.status() };
  } catch (error) {
    return {
      ok: false,
      code: 'im_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerAppIpc(ipcMain: IpcMain, deps: IpcDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  // 2026-11-03（逐页错误注入）：仅非打包态 + 显式 env 才生效；命中通道直接抛错（模拟 IPC 失败），
  // 用来验证每个页面的错误态是否可见、可恢复。生产环境 allowFaultInjection=false，绝不生效。
  const faultChannels = new Set(
    (deps.allowFaultInjection === true ? (process.env.AICO_FAULT_CHANNELS ?? '') : '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  );
  if (faultChannels.size > 0) {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ipcMain as any).handle = (channel: string, listener: (...args: any[]) => any) =>
      originalHandle(channel, async (...args: any[]) => {
        if (faultChannels.has(channel)) {
          console.warn(`[fault] injected failure: ${channel}`);
          throw new Error(`注入故障：${channel}`);
        }
        return listener(...args);
      });
  }

  ipcMain.handle('chat:send', async (_event, raw) => handleChatSend(deps, raw, now()));
  ipcMain.handle('chat:list', async (_event, raw) => handleChatList(deps, raw));
  ipcMain.handle('chat:card-action', async (_event, raw) => handleCardAction(deps, raw, now()));
  ipcMain.handle('inbox:list', async (_event, raw) => handleInboxList(deps, raw));
  ipcMain.handle('inbox:answer', async (_event, raw) => handleInboxAnswer(deps, raw, now()));
  ipcMain.handle('inbox:read-state', async (_event, raw) => handleReadState(deps, raw));
  ipcMain.handle('inbox:read-mark', async (_event, raw) => handleReadMark(deps, raw, now()));
  ipcMain.handle('mailbox:list', async () => handleMailboxList(deps));
  ipcMain.handle('mailbox:answer', async (_event, raw) => handleMailboxAnswer(deps, raw, now()));
  ipcMain.handle('task:approve', async (_event, raw) => handleTaskApprove(deps, raw, now()));
  ipcMain.handle('task:edit-plan', async (_event, raw) => handleTaskEditPlan(deps, raw, now()));
  ipcMain.handle('task:create', async (_event, raw) => handleTaskCreate(deps, raw));
  ipcMain.handle('task:list', async (_event, raw) => handleTaskList(deps, raw));
  ipcMain.handle('task:get', async (_event, raw) => handleTaskGet(deps, raw));
  ipcMain.handle('task:transition', async (_event, raw) => handleTaskTransition(deps, raw));

  // M3-P-4 / BRK16-b：真合并（合并真值表/幂等/冲突可见）。
  ipcMain.handle('task:merge', async (_event, raw) => handleTaskMerge(deps, raw, now()));
  // M3-N-2 / GAP4：工作项级回滚（只动该次提交改过的文件；检查点/守卫见 git/checkpoint.ts）。
  ipcMain.handle('task:rollback', async (_event, raw) => handleTaskRollback(deps, raw, now()));
  ipcMain.handle('task:discard', async (_event, raw) => handleTaskDiscard(deps, raw, now()));
  // BRK16-a（挂载 3）：产物读/打开/文件夹 + GAP11 审计导出 —— 由 NI 转真处理器（通道名不变，冻结计数不动）。
  ipcMain.handle('task:read-artifact', async (_event, raw) => handleReadArtifact(deps, raw));
  // UG-06：变更集单文件只读 diff（base..head；不返回仓库绝对路径）。
  ipcMain.handle('task:diff', async (_event, raw) => handleReadChangesetDiff(deps, raw));
  // M4-D-1（P2）：按 ref 受控读取归档的工具大输出（时间线「展开输出」）。
  ipcMain.handle('task:read-tool-output', async (_event, raw) => handleReadToolOutput(deps, raw));
  ipcMain.handle('task:export', async (_event, raw) => handleExportTask(deps, raw, now()));
  ipcMain.handle('chat:resolve-attachment', async (_event, raw) =>
    handleResolveAttachment({ db: deps.db, stagedFilesDir: deps.stagedFilesDir }, raw),
  );
  // UG-11：`{includeDisabled:true}` → 花名册含已停用（设置页重新启用入口）；缺省＝大厅口径（仅在职）。
  ipcMain.handle('employee:list', async (_event, raw) => {
    const input = (raw ?? {}) as { includeDisabled?: unknown };
    return input.includeDisabled === true ? deps.repo.listRosterEmployees() : deps.repo.listEmployees();
  });
  ipcMain.handle('employee:get', async (_event, raw) => handleEmployeeGet(deps, raw));
  ipcMain.handle('employee:recruit', async (_event, raw) => handleEmployeeRecruit(deps, raw));
  ipcMain.handle('employee:update', async (_event, raw) => handleEmployeeUpdate(deps, raw));
  ipcMain.handle('search:global', async (_event, raw) => handleGlobalSearch(deps, raw));
  ipcMain.handle('skills:list', async (_event, raw) => handleSkillsList(deps, raw));
  // GAP7：同通道分派——旧 `{name,path}` 注册 / 新安装·启停·删除动作（不新增 IPC）。
  ipcMain.handle('skills:set', async (_event, raw) =>
    isSkillAction(raw) ? handleSkillAction(deps, raw, now()) : handleSkillsSet(deps, raw),
  );
  ipcMain.handle('mcp:list', async (_event, raw) => handleMcpList(deps, raw));
  // GAP6：同通道分派——注册 `{name,transport,…}` / 启停·删除 `{action,…}`（不新增 IPC）。
  ipcMain.handle('mcp:set', async (_event, raw) => (isMcpAction(raw) ? handleMcpAction(deps, raw) : handleMcpSet(deps, raw)));
  ipcMain.handle('seams:list', async (_event, raw) => handleSeamsList(deps, raw));
  ipcMain.handle('hall:subscribe', notImplemented('hall:subscribe'));
  ipcMain.handle('hall:state', async () => deps.repo.hallState());
  ipcMain.handle('project:list', async (_event, raw) => handleProjectList(deps, raw));
  ipcMain.handle('project:get', async (_event, raw) => handleProjectGet(deps, raw));
  ipcMain.handle('project:archive', async (_event, raw) => handleProjectArchive(deps, raw, now()));
  ipcMain.handle('project:attach', async () => handleProjectAttach(deps, now()));
  // 2026-10-25：在系统文件管理器中打开项目根（renderer 只传 projectId）。
  ipcMain.handle('project:open-dir', async (_event, raw) => handleProjectOpenDir(deps, raw));
  // 2026-10-29 P2（P-N05）：应用信息与数据目录。
  ipcMain.handle('app:info', async () => handleAppInfo(deps));
  ipcMain.handle('app:open-data-dir', async () => handleAppOpenDataDir(deps));
  ipcMain.handle('task:rework-merge-conflict', async (_event, raw) => handleTaskReworkMergeConflict(deps, raw));

  // ── K1 知识库 IPC（笔记 CRUD＋搜索＋升级）──
  ipcMain.handle('notes:list', async (_event, raw) => handleNotesList(deps, raw));
  ipcMain.handle('notes:read', async (_event, raw) => handleNotesRead(deps, raw));
  // Phase B：媒体/附件预览（受控短票/文本上限；Office 只给系统打开）。
  ipcMain.handle('notes:preview', async (_event, raw) => handleNotesPreview(deps, raw));
  ipcMain.handle('notes:write', async (_event, raw) => handleNotesWrite(deps, raw));
  ipcMain.handle('notes:delete', async (_event, raw) => handleNotesDelete(deps, raw));
  ipcMain.handle('notes:search', async (_event, raw) => handleNotesSearch(deps, raw));
  ipcMain.handle('notes:promote', async (_event, raw) => handleNotesPromote(deps, raw));
  // 2026-10-16（D 批余项）：软件代建项目骨架（父目录 dialog 选；不覆盖同名目录）。
  ipcMain.handle('project:create', async (_event, raw) => handleProjectCreate(deps, raw, now()));
  // 验收后复查 A：项目别名写面（新项目/既有项目都能被 `#别名` 寻址）。
  ipcMain.handle('project:alias-set', async (_event, raw) => handleProjectAliasSet(deps, raw));
  // CR14：删除空归档项目（文件夹不动；非空拒）。
  ipcMain.handle('project:delete', async (_event, raw) => handleProjectDelete(deps, raw));
  // B-3：项目档案导出（删除前的备份面；单文件 JSON，renderer 不传路径）。
  ipcMain.handle('project:export', async (_event, raw) => handleExportProject(deps, raw, now()));
  // 编制 v1（D-11）：项目三项缺省（默认负责人/默认执行员工/默认档）——写校验在 db 层，非法拒且不落库。
  ipcMain.handle('project:staffing-set', async (_event, raw) => handleProjectStaffingSet(deps, raw));
  // D-22：项目模型策略（fixed / employee_first；assistant 待模型目录）——写校验在 core/db，非法拒且不落库。
  ipcMain.handle('project:model-policy-set', async (_event, raw) => handleProjectModelPolicySet(deps, raw));
  // v19：项目默认任务预算（NULL＝不限）。
  ipcMain.handle('project:default-budget-set', async (_event, raw) => handleProjectDefaultBudgetSet(deps, raw));
  ipcMain.handle('project:target-branch-set', async (_event, raw) => handleProjectTargetBranchSet(deps, raw));
  // D-19 P1：项目级频道助手写权限（read-only/confirm/auto；full v1 不做）。
  ipcMain.handle('project:assistant-write-mode-set', async (_event, raw) =>
    handleProjectAssistantWriteModeSet(deps, raw),
  );
  // B-1（M4）：触发管理 UI（列表/创建 cron/创建事件/取消；与频道命令同源 TriggerService）。
  ipcMain.handle('project:trigger-manage', async (_event, raw) => handleProjectTriggerManage(deps, raw, now()));
  // B-6（M4）：记忆 P1b 写入口（老板显式 list/remember/update/pin/forget/promote/search/audit）。
  ipcMain.handle('memory:manage', async (_event, raw) => handleMemoryManage(deps, raw, now()));
  // B3-5/D-31：抽取提议卡确认（老板在记忆页点「确认」→ provisional→confirmed→进 brief）
  ipcMain.handle('memory:confirm', async (_event, raw) => handleMemoryConfirm(deps, raw));
  // B3-7/D-31⑤：git push P0（显式按钮触发；永不自动）＋产物导出（md/html）。
  ipcMain.handle('git:remotes', async (_event, raw) => {
    const input = (raw ?? {}) as { projectRoot?: unknown };
    const root = typeof input.projectRoot === 'string' ? input.projectRoot : null;
    if (!root) return { ok: false, code: 'bad_request', message: 'projectRoot is required' };
    const { listRemotes } = await import('../git/push-export.js');
    return { ok: true, remotes: listRemotes(root) };
  });
  ipcMain.handle('git:push', async (_event, raw) => {
    const input = (raw ?? {}) as { projectRoot?: unknown; remote?: unknown; branch?: unknown };
    const root = typeof input.projectRoot === 'string' ? input.projectRoot : null;
    const remote = typeof input.remote === 'string' ? input.remote : 'origin';
    const branch = typeof input.branch === 'string' ? input.branch : null;
    if (!root || !branch) return { ok: false, code: 'bad_request', message: 'projectRoot + branch are required' };
    // D-31⑤：永不自动 push——只有显式调用才走到这里。
    const { pushBranch } = await import('../git/push-export.js');
    return pushBranch(root, remote, branch);
  });
  ipcMain.handle('artifact:export', async (_event, raw) => {
    const input = (raw ?? {}) as { sourcePath?: unknown; outputDir?: unknown; format?: unknown };
    const srcPath = typeof input.sourcePath === 'string' ? input.sourcePath : null;
    const outputDir = typeof input.outputDir === 'string' ? input.outputDir : null;
    const format = input.format === 'html' ? 'html' as const : 'md' as const;
    if (!srcPath || !outputDir) return { ok: false, code: 'bad_request', message: 'sourcePath + outputDir are required' };
    const { exportArtifact } = await import('../git/push-export.js');
    return exportArtifact(srcPath, outputDir, format);
  });
  // M3-DOC-4：项目级文档检查开关（只影响新任务是否挂检查；已有任务按当前开关记未检查）。
  ipcMain.handle('project:docs-check-set', async (_event, raw) => handleProjectDocsCheckSet(deps, raw));
  // B3（M3-N-3）：项目默认技能集（只影响该项目新会话装配）。
  ipcMain.handle('project:skills-set', async (_event, raw) => handleProjectSkillsSet(deps, raw));
  // GAP9（M3-N-5）：公司配置版本化（项目根 `.aico/company.json`；export/preview/apply/rollback）。
  ipcMain.handle('project:company-config', async (_event, raw) => handleCompanyConfig(deps, raw, now()));
  // G-A/G-B/C（M2 §7 序 3）：产物引用（老板显式发起；copy 快照＋sha256＋来源两列＋审计事件）。
  ipcMain.handle('task:reference-artifact', async (_event, raw) => handleArtifactReference(deps, raw, now()));
  // M2 §7 序 4（文档管理最小版）：文档结构检查（只读；结果上屏＝项目概览一行读数）。
  ipcMain.handle('docs:check', async (_event, raw) => handleDocsCheck(deps, raw));
  // M3-DOC-3：一键整理（只补区索引；预览→应用，失败回滚）。
  ipcMain.handle('docs:organize-preview', async (_event, raw) => handleDocsOrganizePreview(deps, raw));
  ipcMain.handle('docs:organize-apply', async (_event, raw) => handleDocsOrganizeApply(deps, raw));
  ipcMain.handle('cost:summary', async (_event, raw) => handleCostSummary(deps, raw));
  ipcMain.handle('scheduler:slots', async () => handleSchedulerSlots(deps));
  ipcMain.handle('settings:get', async (_event, raw) => handleSettingsGet(deps, raw));
  ipcMain.handle('settings:set', async (_event, raw) => handleSettingsSet(deps, raw));
  // B-4：数据保留/清理（preview 只数不删；run 只清四张临时表）。
  ipcMain.handle('settings:maintenance', async (_event, raw) => handleSettingsMaintenance(deps, raw, now()));
  // UG-09：权限页只读审计 + 撤销（撤销只删 scope 策略；审批历史只读）。
  ipcMain.handle('settings:permission-list', async () =>
    deps.db
      ? { ok: true, ...listPermissionOverview(deps.db) }
      : { ok: false, code: 'not_ready', message: '数据库未装配' },
  );
  ipcMain.handle('settings:permission-revoke', async (_event, raw) =>
    deps.db ? revokePermissionPolicy(deps.db, raw) : { ok: false, code: 'not_ready', message: '数据库未装配' },
  );
  ipcMain.handle('provider:list', async () => handleProviderList(deps));
  // D-22 配套：只读模型目录（chat；已知供应商＋已配置 Key；不联网刷新）。
  ipcMain.handle('model:catalog', async (_event, raw) => handleModelCatalog(raw));
  ipcMain.handle('provider:custom', async (_event, raw) => handleProviderCustom(deps, raw));
  ipcMain.handle('provider:set-key', async (_event, raw) => handleProviderSetKey(deps, raw));
  ipcMain.handle('provider:clear-key', async (_event, raw) => handleProviderClearKey(deps, raw));
  ipcMain.handle('notify:test', async () => handleNotifyTest(deps));
  ipcMain.handle('im:bind', async (_event, raw) => handleImBind(deps, raw));
  ipcMain.handle('im:unbind', async (_event, raw) => handleImBind(deps, raw, 'unbind'));
}

import * as notesModule from '../agent/notes.js';

// ── K1 知识库 IPC 处理器 ────────────────────────────────────────────

interface ProjectRef { id: number; name: string; rootDir: string }

function projectsFromDb(db: NonNullable<IpcDeps['db']>): ProjectRef[] {
  return (db.prepare('SELECT id, name, root_dir FROM projects WHERE archived = 0').all() as Array<{ id: number; name: string; root_dir: string }>)
    .map((p) => ({ id: p.id, name: p.name, rootDir: p.root_dir }));
}

import { globalNotesDirForDb } from '../db/retrieval.js';

/**
 * B3-5/D-31：`memory:confirm`——老板确认抽取的提议卡（confidence provisional→confirmed）。
 * 确认后该条进 brief（08-记忆设计 §7 闸门的确认侧）。
 */
export function handleMemoryConfirm(deps: IpcDeps, raw: unknown): { ok: true; id: number } | { ok: false; code: string; message: string } {
  const input = (raw ?? {}) as { id?: unknown };
  if (typeof input.id !== 'number') {
    return { ok: false, code: 'bad_request', message: 'id is required' };
  }
  if (!deps.db) return { ok: false, code: 'no_db', message: 'db not ready' };
  const info = deps.db
    .prepare('UPDATE memory_items SET confidence = ?, updated_at = ? WHERE id = ? AND confidence = ?')
    .run('confirmed', Date.now(), input.id, 'provisional');
  if (Number(info.changes) === 0) {
    return { ok: false, code: 'not_provisional', message: `条目 #${input.id} 不存在或不是待确认（provisional）` };
  }
  deps.onInboxChanged?.();
  return { ok: true, id: input.id };
}

function globalNotesDir(deps: IpcDeps): string {
  // B3-5/D-31：口径抽公共件（retrieval.ts 同源；员工检索与 UI 列表不再两套）
  return globalNotesDirForDb(deps.db?.name ?? ':memory:');
}

export function handleNotesList(deps: IpcDeps, raw: unknown) {
  const { listNotes } = notesModule;
  // P2-7：searchText 只服务主进程搜索，不随列表下发（避免把正文塞进 renderer/IPC）。
  return listNotes({ projects: deps.db ? projectsFromDb(deps.db) : [], globalDir: globalNotesDir(deps) }).map(
    ({ searchText: _searchText, ...item }) => item,
  );
}

export function handleNotesRead(deps: IpcDeps, raw: unknown) {
  const { readNote } = notesModule;
  const input = (raw ?? {}) as { projectId?: unknown; name?: unknown };
  const project = typeof input.projectId === 'number' ? (deps.db ? projectsFromDb(deps.db) : []).find((p) => p.id === input.projectId) : undefined;
  // P2-3：给了 projectId 却找不到项目时不得静默回退全局（会读/写到同名全局笔记）。
  if (typeof input.projectId === 'number' && project == null) return { ok: false, error: '笔记所属项目不存在（可能已归档或删除）' };
  return readNote({ projectDir: project?.rootDir ?? null, globalDir: globalNotesDir(deps), name: String(input.name ?? '') });
}

export function handleNotesWrite(deps: IpcDeps, raw: unknown) {
  const { writeNote } = notesModule;
  const input = (raw ?? {}) as { projectId?: unknown; name?: unknown; content?: unknown };
  const project = typeof input.projectId === 'number' ? (deps.db ? projectsFromDb(deps.db) : []).find((p) => p.id === input.projectId) : undefined;
  if (typeof input.projectId === 'number' && project == null) return { ok: false, error: '笔记所属项目不存在（可能已归档或删除）' };
  return writeNote({ projectDir: project?.rootDir ?? null, globalDir: globalNotesDir(deps), name: String(input.name ?? ''), content: String(input.content ?? '') });
}

export function handleNotesDelete(deps: IpcDeps, raw: unknown) {
  const { deleteNote } = notesModule;
  const input = (raw ?? {}) as { projectId?: unknown; name?: unknown };
  const project = typeof input.projectId === 'number' ? (deps.db ? projectsFromDb(deps.db) : []).find((p) => p.id === input.projectId) : undefined;
  if (typeof input.projectId === 'number' && project == null) return { ok: false, error: '笔记所属项目不存在（可能已归档或删除）' };
  return deleteNote({ projectDir: project?.rootDir ?? null, globalDir: globalNotesDir(deps), name: String(input.name ?? '') });
}

export function handleNotesSearch(deps: IpcDeps, raw: unknown) {
  const { searchNotes } = notesModule;
  const input = (raw ?? {}) as { query?: unknown };
  return searchNotes({ query: String(input.query ?? ''), projects: deps.db ? projectsFromDb(deps.db) : [], globalDir: globalNotesDir(deps) });
}

export function handleNotesPromote(deps: IpcDeps, raw: unknown) {
  const { promoteNote } = notesModule;
  const input = (raw ?? {}) as { projectId?: unknown; name?: unknown };
  const project = typeof input.projectId === 'number' ? (deps.db ? projectsFromDb(deps.db) : []).find((p) => p.id === input.projectId) : undefined;
  if (project == null) return { ok: false, error: '升级需要指定项目' };
  return promoteNote({ projectDir: project.rootDir, name: String(input.name ?? '') });
}

/**
 * 笔记 Phase B（2026-11-03）：媒体/附件预览。
 *
 * 口径：
 *  - renderer 传列表里拿到的绝对路径 + projectId；主进程校验**必须落在该项目根**（全局笔记落在
 *    `<userData>/notes`），越界/系统目录显式拒（不静默）；
 *  - 图片/PDF/视频/音频/HTML 走与聊天附件同一个 `aico-file://preview/<短票>`（renderer 拿不到可复用路径）；
 *  - 文本（含代码/CSV/JSON）读前 256KB，截断如实标注；二进制显式拒；
 *  - Office 不内嵌，返回 `office` 让 UI 显示「系统打开/在文件夹中显示」。
 */
export const NOTES_PREVIEW_CAP = 20 * 1024 * 1024;
export const NOTES_TEXT_CAP = 256 * 1024;

const NOTES_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const HTML_EXT = new Set(['.html', '.htm']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']);
const TEXT_EXT = new Set([
  '.md', '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.html.md', '.py', '.ps1', '.sh', '.bat', '.cmd',
  '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.lua', '.env.example',
]);

export type NotesPreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'html' | 'text' | 'office' | 'too_large';

export type NotesPreviewResult =
  | { ok: true; mode: 'open' | 'reveal'; name: string; path: string }
  | {
      ok: true;
      mode: 'read';
      kind: NotesPreviewKind;
      name: string;
      path: string;
      ext: string;
      size: number;
      url?: string;
      text?: string;
      truncated?: boolean;
      message?: string;
    }
  | { ok: false; code: string; message: string };

/**
 * 笔记预览允许的形状（相对允许根的路径）：
 *  - 根目录下的直接文件（列表只扫浅层）；
 *  - `.aico/notes/<file>` 或 `.aico/docs/<file>`（同样只有一层）。
 * 这挡住 `.aico/company.json`、`src/**`、`node_modules/**` 等未进列表的路径。
 */
export function notesPreviewPathAllowed(rel: string): boolean {
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 1) return !segments[0]!.startsWith('.');
  if (segments.length !== 3) return false;
  return (
    segments[0]!.toLowerCase() === '.aico' &&
    (segments[1]!.toLowerCase() === 'notes' || segments[1]!.toLowerCase() === 'docs')
  );
}

export async function handleNotesPreview(deps: IpcDeps, raw: unknown): Promise<NotesPreviewResult> {
  const input = (raw ?? {}) as { path?: unknown; projectId?: unknown; mode?: unknown };
  const mode = input.mode === 'open' || input.mode === 'reveal' ? input.mode : 'read';
  const given = typeof input.path === 'string' ? input.path : '';
  if (given.length === 0 || !isAbsolute(given)) {
    return { ok: false, code: 'bad_request', message: '需要文件绝对路径（来自笔记列表）' };
  }
  const projects = deps.db ? projectsFromDb(deps.db) : [];
  const project =
    typeof input.projectId === 'number' ? projects.find((p) => p.id === input.projectId) : undefined;
  if (typeof input.projectId === 'number' && project == null) {
    return { ok: false, code: 'no_project', message: '笔记所属项目不存在（无法校验路径）' };
  }
  const root = resolve(project?.rootDir ?? globalNotesDir(deps));
  const abs = resolve(given);
  // P1-1：解析真实路径（symlink/junction 指向根外 → 拒），再按列表允许的形状校验。
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, code: 'missing_file', message: `笔记根目录不存在：${root}` };
  }
  try {
    targetReal = realpathSync(abs);
  } catch {
    return { ok: false, code: 'missing_file', message: `文件不在盘上：${given}` };
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    return { ok: false, code: 'path_escape', message: `文件不在允许的目录内：${given}` };
  }
  const rel = relative(rootReal, targetReal).replace(/\\/g, '/');
  if (!notesPreviewPathAllowed(rel)) {
    return { ok: false, code: 'bad_request', message: `只预览笔记/文档/项目根目录下的文件：${rel}` };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(targetReal);
  } catch {
    return { ok: false, code: 'missing_file', message: `文件不在盘上：${rel}` };
  }
  if (!stat.isFile()) return { ok: false, code: 'not_a_file', message: `不是文件：${rel}` };
  const name = basename(targetReal);
  const ext = extname(name).toLowerCase();
  const absRead = targetReal;

  if (mode === 'open' || mode === 'reveal') {
    if (mode === 'open') {
      if (!deps.openPath) return { ok: false, code: 'open_unavailable', message: '系统打开不可用（非桌面环境）' };
      const error = await deps.openPath(absRead);
      if (error) return { ok: false, code: 'open_failed', message: `系统打开失败：${error}` };
    } else {
      if (!deps.revealPath) return { ok: false, code: 'reveal_unavailable', message: '在文件夹中显示不可用（非桌面环境）' };
      deps.revealPath(absRead);
    }
    return { ok: true, mode, name, path: rel };
  }

  const base = { ok: true as const, mode: 'read' as const, name, path: rel, ext, size: stat.size };
  if (OFFICE_EXT.has(ext)) {
    return { ...base, kind: 'office', message: 'Office 文件不内嵌预览；请用「系统打开」或「在文件夹中显示」' };
  }
  if (stat.size > NOTES_PREVIEW_CAP) {
    return { ...base, kind: 'too_large', message: `文件 ${Math.round(stat.size / 1024 / 1024)} MB，超过 20 MB 预览上限；请系统打开` };
  }
  const kind: NotesPreviewKind | null = IMAGE_EXT.has(ext)
    ? 'image'
    : ext === '.pdf'
      ? 'pdf'
      : VIDEO_EXT.has(ext)
        ? 'video'
        : AUDIO_EXT.has(ext)
          ? 'audio'
          : HTML_EXT.has(ext)
            ? 'html'
            : null;
  if (kind != null) {
    const type = NOTES_MIME[ext] ?? 'application/octet-stream';
    const token = createPreviewToken({ path: absRead, name, type });
    return { ...base, kind, url: `aico-file://preview/${token}` };
  }
  // 其余按文本处理（常见代码/配置/数据文件）；只读前 256KB，二进制显式拒。
  let bytes: Buffer;
  const readLen = Math.min(stat.size, NOTES_TEXT_CAP);
  try {
    const fd = openSync(absRead, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const n = readSync(fd, buf, 0, readLen, 0);
      bytes = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { ok: false, code: 'read_failed', message: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    return { ok: false, code: 'binary_file', message: `二进制文件（${name}）——请用「系统打开」查看` };
  }
  const truncated = stat.size > NOTES_TEXT_CAP;
  return { ...base, kind: 'text', text: bytes.toString('utf8'), truncated };
}


