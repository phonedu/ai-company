/**
 * 幕僚长真实会话的装配：`db` + 真实 Pi 运行时 + `report_progress` 工具 → `AssistantRuntime`。
 *
 * 只被产品装配（`main/index.ts`）按需调用：本文件静态 import Pi SDK，
 * **不要从 `agent/index.ts` 桶导出**（避免单测/启动加载 SDK）。
 *
 * M0 系统提示词：仅实做底座层①+角色层②的**最小可信版**；完整五层拼装（EMPLOYEES §2）
 * 与 persona/技能注入属 M1。
 */
import type { SqliteDb } from '../db/open.js';
import { readSetting } from '../db/settings.js';
import { AssistantRuntime } from './assistant.js';
import { createPiAgentRuntime, registerToolActivationGuard, type PiAgentRuntimeOptions } from './pi-runtime.js';
import { createReportProgressTool } from './report-progress-tool.js';
import { createRequestReviewTool } from './request-review-tool.js';
import { createTaskStatusTool } from './task-status-tool.js';
import { createNoteWriteTool, createNoteSearchTool } from './note-tools.js';
import { createMemorySearchTool } from './memory-search-tool.js';
import { createBossCardTools } from './boss-card-tools.js';
import { createAssistantCommandTools, type AssistantEnginePort } from './assistant-command-tools.js';
import { createReadDocTool } from './read-doc-tool.js';
import type { EngineEvent } from '../engine/types.js';
import {
  SessionToolGate,
  persistChannelGateDecision,
  persistSessionGateDecision,
  recordChannelAllowAudit,
} from './session-tool-gate.js';

/** M0 幕僚长系统提示词（底座纪律 + 角色规则；EMPLOYEES §2 ①② 的最小版）。 */
export const ASSISTANT_SYSTEM_PROMPT_M0 = [
  '你是这家 AI 一人公司的「幕僚长」（0 号员工），只对老板负责。',
  '',
  '## 职责',
  '- 理解老板需求、拆解与规划、分派给员工、汇总汇报；**你不亲自执行具体生产工作**。',
  '- **不验收、不代签**：验收由独立 verifier（≠实现者）与老板完成；你只汇总证据、推进流程，不替 verifier 下结论，也不替老板批准/签收。',
  '- 汇报要结构化、给结论、附证据；不清楚就先问，不替老板猜。',
  '',
  '## 纪律',
  '- 结论必须附证据（命令输出 / 数据来源 / 计算过程）；「我觉得」不算证据。',
  '- 不自我扩权：不读写工作目录之外的路径；对外动作与花钱一律先问。',
  '- 预算意识：接近预算先交还进展，说清还差什么。',
  '',
  '## 工具',
  '- 有清晰计划步骤时，用 `report_progress`（`{stepIdx, state}`）上报每一步进度，让老板看到进度条。',
  '- 老板问任何任务的状态/进展时，先用 `task_status`（`{task: "T-xxxx"}`）查真库快照，再据实回答；查不到就说查不到，不凭记忆猜。',
  '- B2-1 建任务：老板说「建个任务/让员工做 X」时，用 `create_task`（`goal` 必填；acceptance/riskLevel/budgetTokens 可选）——它与「＋建任务」走完全相同的门（预算预检/模型白名单/归属确认）。归属拿不准就先问一句，不自作主张；建完把短号告诉老板。',
  '- B2-1 推动调度：任务停在等待时，先用 `list_holds` 查等待原因并向老板如实解释，再用 `dispatch`（`{task, action: "schedule"|"retry"}`）触发调度或对失败件发起重试；「为什么不动」不许凭记忆答。',
  '- B2-1 插话纠偏：老板要在跑任务改方向时，用 `steer`（`{task, message}`）把话递给在跑员工（下一个工具调用前生效）；任务不在跑会明说并记入任务上下文——不要假装送达。',
  '- RW-51：老板可能用**自然话**让你处理待办（如「把那张决策卡按推荐方案处理了」「待办都有什么」）——先用 `boss_inbox` 看卡面，再用 `boss_card_resolve` 执行；选项 key 必须来自卡面，老板的话模糊就先复述你的理解再确认，不自作主张。',
  '- 老板问「之前记过/说过什么、某项目的约定」时，先用 `memory_search`（`{query}`，1–4 个词）跨范围搜记忆库（全局＋全部项目），再据实回答；查不到就明说，不凭记忆猜。',
  '- B2-8 头脑风暴：老板要「头脑风暴/发散聊聊/出出主意」时，这是**一等对话**——直接发散，不建任务、不催规划、不说「这个该走流程」；发散收敛时主动提议二选一：把结论存成纪要（`note_write`，正文=结论/分歧/待定项/下一步）或转成任务（`create_task`）。老板说「存纪要/记下来」→ `note_write`；说「落地/开工」→ 先复述你理解的结论再 `create_task`。',
].join('\n');

export interface CreatePiAssistantOptions {
  db: SqliteDb;
  provider?: PiAgentRuntimeOptions['provider'];
  model?: PiAgentRuntimeOptions['model'];
  thinkingLevel?: PiAgentRuntimeOptions['thinkingLevel'];
  cwd?: string;
  agentDir?: string;
  systemPrompt?: string;
  /** N4：会话落盘目录（缺省不落盘 = 每次启动幕僚长失忆；接线处传 `defaultSessionDir(userData)`）。 */
  persistDir?: string;
  /** P2：工具大输出归档根（缺省不归档）。 */
  toolOutputDir?: string;
  /** RW-51：引擎（卡片作答推状态机用；缺省＝只落台账不推，与 task:approve 无引擎同口径）。
   *  B2-1 起 index 传引擎实例——`tick`/`listDispatchHolds`/`schedulerSlots` 供 dispatch/list_holds 工具用（缺方法如实降级）。 */
  engine?: AssistantEnginePort | null;
  /** RW-51：待办读数变化（托盘/待办刷新）。 */
  onInboxChanged?: (() => void) | null;
  /** RW-51：权限批准联动（批准→grant；index 注入与 deps 同源）。 */
  onGrant?: ((approvalId: number, chosen: string) => void) | null;
  /**
   * B2-1：建任务回调（index 注入＝`handleTaskCreate(deps, input)`——工具层不做第二套门）。
   * 缺省未接线 → create_task 工具如实说「未接线」，不臆造任务。
   */
  createTask?: (input: Record<string, unknown>) => Promise<{ id: number; shortId?: string | null; title?: string | null; state?: string }>;
  /** B2-1：老板插话 → 在跑员工会话（index 注入＝`LazyEmployeeRuntime.steer`，与 `#短号` 同通路）。 */
  steerEmployee?: ((sessionKey: string, text: string) => boolean) | null;
  clock?: () => number;
  onTextDelta?: (delta: string) => void;
}

export interface PiAssistant {
  assistant: AssistantRuntime;
  credentialSource: 'env' | 'file';
  credentialDescriptor: { source: string; length: number; skPrefix: boolean };
  modelRef: string;
}

export async function createPiAssistantRuntime(options: CreatePiAssistantOptions): Promise<PiAssistant> {
  const systemPrompt = options.systemPrompt ?? ASSISTANT_SYSTEM_PROMPT_M0;
  const reportProgress = await createReportProgressTool();
  const requestReview = await createRequestReviewTool();
  const taskStatus = await createTaskStatusTool(options.db);
  // RW-51：待办卡工具——老板自然话处理待办的地基（「把那张决策卡按推荐方案处理了」）。
  const cardTools = await createBossCardTools({
    db: options.db,
    engine: options.engine ?? null,
    onInboxChanged: options.onInboxChanged ?? null,
    onGrant: options.onGrant ?? null,
  });
  // RW-14（M5 真机带回）：note_write 落点跟随**频道范围**——渲染层 setChannelScope 把
  // channel.scope_project_id 写进 settings（0/缺省＝公司全局），这里每调用实时读。
  // 旧实现硬编码 `() => null`（占位从未接线）⇒ 选了项目也落全局目录（真机 RW-14）。
  const noteScopeProjectId = (): number | null => {
    const v = readSetting(options.db, 'channel.scope_project_id');
    return typeof v === 'number' && v > 0 ? v : null;
  };
  const noteWrite = await createNoteWriteTool(options.db, noteScopeProjectId);
  const noteSearch = await createNoteSearchTool(options.db, noteScopeProjectId);
  // 老板 2026-11-05 裁「1 和 2 都做」②：幕僚长只读跨范围记忆检索（全局＋全部活跃项目）。
  const memorySearch = await createMemorySearchTool(options.db);
  // B2-1（D-30）：幕僚长指挥四工具——create_task/dispatch/steer/list_holds。
  // 回调（createTask/steerEmployee）与引擎读数由 index.ts 注入；工具层不做第二套门。
  // B3-8/D-31：幕僚长只读项目文档（跟随频道范围项目根；无项目时 cwd 只读根）。
  const assistantReadDoc = await createReadDocTool(options.cwd ?? process.cwd());
  const commandTools = await createAssistantCommandTools({
    db: options.db,
    engine: options.engine ?? null,
    steerEmployee: options.steerEmployee ?? null,
    createTask: options.createTask ?? null,
    scopeProjectId: noteScopeProjectId,
  });

  // D-19 P0：频道助手与员工会话走同一 `permissionGate`；项目根/只读上下文由每轮 `AssistantRuntime` 登记。
  const toolGate = new SessionToolGate({
    db: options.db,
    onDecision: (info) => {
      if (info.decision === 'allow') return;
      if (info.run?.taskId != null) {
        persistSessionGateDecision(options.db, info, options.clock?.() ?? Date.now());
        return;
      }
      // D-19 P1：无任务的频道对话也能出确认卡（approvals.task_id 允许为空）；
      // 批准后 grant 落到项目/会话，下一次调用即放行。
      persistChannelGateDecision(options.db, info, options.clock?.() ?? Date.now());
    },
    // D-19 P1：频道助手实际放行的写/命令/外发落审计（任务会话不接）。
    onAllow: (info) => {
      if (info.run?.taskId == null) {
        recordChannelAllowAudit(options.db, info, options.clock?.() ?? Date.now());
      }
    },
  });

  // RW-52（2026-11-05）：注册与守卫共用**同一名单**（名单取自工具对象本身，单一真值）。
  // 守卫修的是：持久化会话 resume 时 Pi 用转录 toolsAdded 快照整体替换活动工具集，
  // 快照之后注册的新工具（boss_inbox / boss_card_resolve）永不声明给模型（详见
  // `registerToolActivationGuard` 头注与 `test/pi-tool-activation.test.ts`）。
  const assistantTools = [
    reportProgress,
    requestReview,
    taskStatus,
    cardTools.inboxTool,
    cardTools.resolveTool,
    noteWrite,
    noteSearch,
    memorySearch,
    assistantReadDoc,
    // B2-1：指挥四工具（与 RW-52 激活守卫同一名单——守卫自动覆盖新工具）。
    commandTools.createTaskTool,
    commandTools.dispatchTool,
    commandTools.steerTool,
    commandTools.listHoldsTool,
  ];
  const runtime = await createPiAgentRuntime({
    provider: options.provider,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    cwd: options.cwd,
    agentDir: options.agentDir,
    systemPrompt,
    persistDir: options.persistDir,
    toolOutputDir: options.toolOutputDir,
    extensionFactories: [
      (pi) => {
        const api = pi as { registerTool(tool: unknown): void };
        for (const tool of assistantTools) api.registerTool(tool);
        registerToolActivationGuard(pi, assistantTools.map((tool) => (tool as { name: string }).name));
        toolGate.register(pi as never);
      },
    ],
  });

  const assistant = new AssistantRuntime({
    db: options.db,
    runtime,
    systemPrompt,
    cwd: options.cwd,
    toolGate,
    clock: options.clock,
    onTextDelta: options.onTextDelta,
  });

  return { assistant, credentialSource: runtime.credentialSource, credentialDescriptor: runtime.credentialDescriptor, modelRef: runtime.modelRef };
}

// ───────────────────────── 幕僚长生命周期（冷启预热 + 就绪可见） ─────────────────────────
// 背景（1351）：Pi 冷启可能 >45s。若在就绪前 `chat:send`，不能"发了没回、也没提示"（静默）。
// 本模块提供：预热（不阻塞窗口）+ 就绪状态 + 「等待时先推一条状态、就绪后补真回复」。

export type AssistantStatus = 'idle' | 'starting' | 'ready' | 'unavailable';
export type PiAssistantFactory = (options: CreatePiAssistantOptions) => Promise<PiAssistant>;

let runtimeStatus: AssistantStatus = 'idle';
let runtimeAssistant: AssistantRuntime | null = null;
let runtimeError: string | null = null;
let startPromise: Promise<void> | null = null;

/** 当前幕僚长状态（供接线处判断；不触发装配）。 */
export function assistantStatus(): AssistantStatus {
  return runtimeStatus;
}
export function isAssistantReady(): boolean {
  return runtimeStatus === 'ready';
}

/** 装配失败原因（如缺 key），未失败为 null。 */
export function assistantError(): string | null {
  return runtimeError;
}

/** 测试用：重置单例状态（不影响生产）。 */
export function __resetAssistantStateForTests(): void {
  runtimeStatus = 'idle';
  runtimeAssistant = null;
  runtimeError = null;
  startPromise = null;
}

/** 后台预热：触发装配但不阻塞调用方（失败只记状态，不抛）。 */
export function preloadPiAssistant(options: CreatePiAssistantOptions, factory: PiAssistantFactory = createPiAssistantRuntime): void {
  void startAssistant(options, factory).catch(() => undefined);
}

function startAssistant(options: CreatePiAssistantOptions, factory: PiAssistantFactory): Promise<void> {
  if (startPromise) return startPromise;
  runtimeStatus = 'starting';
  startPromise = (async () => {
    try {
      const created = await factory(options);
      runtimeAssistant = created.assistant;
      runtimeStatus = 'ready';
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
      runtimeStatus = 'unavailable';
    }
  })();
  return startPromise;
}

/** RM-5：卡片落库时中止同任务幕僚长会话；未装配/不是当前任务 → false。 */
export function abortAssistantForTask(taskId: number | null): boolean {
  return runtimeAssistant?.abortForTask(taskId) ?? false;
}

/**
 * 取幕僚长：已就绪直接返回；未就绪则启动/等待，**等待期间调用 `onWaiting()` 一次**（供接线处推 `assistant_starting`）；
 * 装配失败返回 null（不抛、不 mock）。
 */
export async function ensureAssistant(
  options: CreatePiAssistantOptions,
  onWaiting?: () => void,
  factory: PiAssistantFactory = createPiAssistantRuntime,
): Promise<AssistantRuntime | null> {
  if (runtimeStatus === 'ready') return runtimeAssistant;
  if (runtimeStatus === 'unavailable') return null;
  onWaiting?.();
  await startAssistant(options, factory);
  return assistantStatus() === 'ready' ? runtimeAssistant : null;
}
