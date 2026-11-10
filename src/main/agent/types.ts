/**
 * `agent` 层接口 —— 会话运行时（EmployeeRuntime / Assistant）与 Pi SDK 之间的接缝。
 *
 * 设计目标：运行时做成**接口**，单测用 **fake** 跑通；真实 Pi 实现
 * （`pi-runtime.ts`，import `@earendil-works/pi-coding-agent`）只在产品装配时接上。
 * 这样引擎/会话逻辑不依赖 Pi，也不在单测里花真金。
 */
import type { Principal } from '../memory/index.js';
import type { ContextTelemetry } from './context-telemetry.js';

/** 归一化后的会话事件（Pi 事件 → 本形状，见事件映射）。 */
export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | {
      type: 'tool_call_end';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      /** P2：大输出归档后的摘要/不透明引用/原始字节数（小输出不带这些字段）。 */
      outputSummary?: string;
      outputRef?: string;
      outputBytes?: number;
    };

/**
 * 本会话可加载的技能（员工勾选 ∪ 项目默认 ∪ 任务强制）。
 * 只传**名字/描述/路径**，不传全文——全文由模型按需调 `load_skill` 读取。
 */
export interface SkillRef {
  name: string;
  description: string;
  path: string;
}

export interface AgentRunInput {
  /** 会话键：同一键复用会话（员工×任务 / boss-channel），保留上下文。 */
  sessionKey: string;
  /** 本轮注入的简报/用户话（任务层）。 */
  prompt: string;
  /** 系统提示词（员工五层拼装结果；缺省用运行时默认）。 */
  systemPrompt?: string;
  /** 工作目录（项目根 / 任务工作目录）。 */
  cwd?: string;
  /**
   * N5：本轮模型（`providerId/modelId` 或裸 modelId；缺省＝会话缺省）。运行时**逐轮**应用
   *（`setModel`，session-only）；模型不存在 ⇒ **响亮抛错**（不静默回落）。
   */
  model?: string;
  /** N5：本轮思考强度（缺省＝不动会话当前档——不臆造）。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  /** 本会话技能白名单（`load_skill` 只能读这里列出的技能）。 */
  skills?: readonly SkillRef[];
  /** 本会话 MCP server 白名单（`mcp_list`/`mcp_call`/`tool_search` 只认这些名字）。 */
  mcps?: readonly string[];
}

export interface AgentToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  /** P2：大输出归档（小输出缺省）。 */
  outputSummary?: string;
  outputRef?: string;
  outputBytes?: number;
}

export interface AgentUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 底座 `getSessionStats().tokens.cacheRead/cacheWrite`（缓存命中/写入输入）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 底座 `getSessionStats().cost`（USD 总额，已含缓存计价）。 */
  costUsd?: number;
  /**
   * 本次用量是**会话累计**（Pi `getSessionStats()` 语义）还是**单轮**（fake/单轮运行）。
   * 累计值必须由记账户做差值（同会话多轮/nudge/重试），否则重复入账。
   */
  cumulativeSessionStats?: boolean;
}

export interface AgentRunResult {
  text: string;
  toolCalls: AgentToolCallRecord[];
  usage?: AgentUsage;
  /** G5：思考文本（仅 fake/可选回传；真实运行时经 `thinking_delta` 事件流）。 */
  thinking?: string;
  /** G6：会话是否已落盘（上游惰性 flush；`undefined` = 上游未提供该信息）。 */
  persisted?: boolean;
}

/** 会话运行时：一次 `run` 会调用 `onEvent` 流式回调，并返回最终结果。 */
export interface AgentRuntime {
  run(input: AgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult>;
  /** 打断/转向进行中的会话（steer 通道）。返回是否已投递。 */
  steer(sessionKey: string, text: string): boolean;
  /**
   * （挂载 3 余·取消小步）：**真中止**某会话（默认实现在 `pi-runtime`，透传 `AgentSession.abort()`）。
   * 返回是否找到该会话（未找到 ⇒ false，如实）。可选：fake/旧运行时可不实现。
   */
  abortSession?(sessionKey: string): boolean;
  /**
   * CTX-1 用手动压缩入口（Pi `AgentSession.compact()`）：触发一次压缩并等完成。
   * 返回是否找到会话；未实现/无法压缩 → false（如实，不假装压缩过）。
   */
  compactSession?(sessionKey: string): Promise<boolean>;
  /**
   * G1/G2：返回该会话在运行时实际使用的 Pi session id（含 cwd 分区）。
   * 工具闸门必须用同一个 id 登记，否则会按 `unmanaged_session` 放行。
   * 缺省（fake/旧运行时）回落到 sessionKey 归一化。
   */
  sessionIdFor?(input: { sessionKey: string; cwd?: string }): string;
  dispose(): void;
}

// ─────────────：员工真会话上下文（接口定义；实现在 `agent/context.ts`） ─────────────

/** 上下文组装输入（只读 db；纯函数）。 */
export interface EmployeeContextInput {
  employeeId: number;
  taskId: number;
  workItemId?: number | null;
  /** 老板原话（若有）。 */
  bossText?: string | null;
  /** R2-2（G7 回灌）：发给本员工、**尚未消费**的同事答复（执行器 pre-run 查、post-run 标读）。 */
  mailboxAnswers?: ReadonlyArray<{ from: number; answer: string }>;
  /** 点名问本员工的未结提问（可调 `answer_colleague` 作答）。 */
  mailboxAsks?: ReadonlyArray<{ askDedupeKey: string; from: number; question: string; blocking: boolean }>;
  /** L2/L3 事实层的可见角色；`null`＝不注入事实（verifier）；缺省＝按 employee 本人。 */
  memoryPrincipal?: Principal | null;
  /** 评审会话不读员工 L1 摘要/历史检索（critic/verifier 默认 true）。 */
  skipEmployeeMemory?: boolean;
  /**
   * CTX1-6：是否在 user 段追加「当前计划复述」（计划步骤/验收摘要/剩余预算/最近失败）。
   * 缺省 true；评审上下文传 false（评审材料已含计划，避免双份噪音）。
   */
  includePlanRecitation?: boolean;
}

/** 组装结果：**简版分层**拆成可辨识分段（2285①：不得压成一段拼字符串）。 */
export interface EmployeeContext {
  /** 系统提示词 = ①平台底座 + ②角色规则 + ③`employees.persona` + 记忆层（G11）+ ④任务基线（N4：进 system 段，压缩不丢）。 */
  systemPrompt: string;
  /** 首条 user prompt = 老板原话 + ⑤项目上下文（受压缩影响）。 */
  userPrompt: string;
  /** 可测试的元数据（每段是否非空、来源）。 */
  meta: {
    layers: {
      platform: boolean;
      role: boolean;
      persona: boolean;
      memory: boolean;
      /** N5 尾项：项目记忆短简报（最近任务索引）有真实内容。 */
      memoryBrief: boolean;
      /** L2/L3 事实层有真实内容注入。 */
      facts?: boolean;
      /** 有真实技能内容注入。 */
      skills: boolean;
      /** 有检索命中。 */
      retrieval: boolean;
      /** few-shot 是否注入。 */
      fewShot: boolean;
      baseline: boolean;
      /** CTX1-6：user 段是否带计划复述。 */
      planRecitation?: boolean;
      project: boolean;
      task: boolean;
    };
    projectRoot: string;
    cwd: string;
    /** 本会话技能白名单（仅员工勾选 ∪ 项目默认 ∪ 任务强制；不泄他人技能）。 */
    skillRefs?: readonly SkillRef[];
    /** 任务级强制技能名（null/缺省＝无）。 */
    forcedSkill?: string | null;
    /** 本会话可用的 MCP server 名（员工分配∩启用；不含未分配）。 */
    mcpRefs?: readonly string[];
    /** CTX1-2：分层遥测（纯投影；contextWindow 未知 → utilization=null，渲染层显 `—`）。 */
    telemetry?: ContextTelemetry;
  };
}

/** 上下文组装器（在 `agent/context.ts` 实现；执行器只调它）。 */
export type BuildEmployeeContext = (db: unknown, input: EmployeeContextInput) => EmployeeContext;
