/**
 * 真实 Pi 会话运行时（`AgentRuntime` 的 `@earendil-works/pi-coding-agent` 实现）。
 *
 * 要点：
 *  - **懒加载**：SDK 用动态 `import()`（首次 import 冷启动可达分钟级、热≈2.5s），
 *    放在本文件里、由产品装配按需调用；`agent/index.ts` 桶**不导出**本文件，避免污染启动/单测。
 *  - **凭据自解析**（1158）：`env DEEPSEEK_API_KEY` → `~/.aico/secrets/<provider>_api_key`；
 *    只读、绝不打印明文/写库；缺则**明确报错**（不静默 mock）。
 *  - 会话池：`sessionKey → AgentSession`（`SessionManager.inMemory()`），同键串行复用（员工×任务隔离）。
 *  - 事件映射见 DEV §6.2（`message_update` / `tool_execution_start|end` / `agent_settled`）。
 */
import { mkdirSync } from 'node:fs';

import { describeCompaction, deriveCompactionOverrides, isCompactionTuningEnabled, observeBeforeCompact, observeCompacted, type CompactionObservation } from './compaction-policy.js';
import { isContextMaskingEnabled, maskNewToolOutput, maskOldToolResults, messageText, recordNewMasked, recordOldMasked, TOOL_OUTPUT_MASK_THRESHOLD_CHARS } from './context-mask.js';
import { isCtxEnabled } from './context-flags.js';
import { resolveProviderKey } from './provider-keys.js';
import { customModelsPath } from './custom-providers.js';
import { setSessionSkillRefs } from './skill-tool.js';
import { setSessionMcpServers } from './mcp-tool.js';
import { archiveToolOutput, summarizeToolOutput, TOOL_OUTPUT_THRESHOLD_CHARS, toolResultText } from './tool-output-archive.js';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentRuntime,
  AgentToolCallRecord,
} from './types.js';

export interface PiCredential {
  provider: string;
  key: string;
  source: 'env' | 'file';
  /** 命中的文件路径（source='file' 时）；仅用于诊断，不打印 key。 */
  path?: string;
}

/**
 * 依候选顺序解析凭据（**只读**；调用方不得打印 `key`）：
 *   1. `env <PROVIDER>_API_KEY`
 *   2. `~/.aico/secrets/<provider>_api_key`（canonical）
 *   3. `~/.aico/secrets/<provider>-api-key.txt`（当前老板放置的实际文件名）
 */
export function resolveProviderCredential(provider: string): PiCredential | null {
  const cred = resolveProviderKey(provider);
  if (!cred) return null;
  return {
    provider: cred.provider,
    key: cred.key,
    source: cred.source,
    ...(cred.path ? { path: cred.path } : {}),
  };
}

/** 凭据的**无明文**描述（仅用于日志：来源 / 长度 / 是否 sk- 前缀）。 */
export function describeCredential(cred: PiCredential): { source: string; length: number; skPrefix: boolean } {
  return { source: cred.source, length: cred.key.length, skPrefix: cred.key.startsWith('sk-') };
}

export interface EnsureProviderKeyDeps {
  /** 已注入过 Key 的供应商（进程/运行时级；避免每轮重复注入）。 */
  keyed: Set<string>;
  /** 凭据解析（生产＝`resolveProviderCredential`；测试注入，绝不读真实 secrets）。 */
  resolve: (provider: string) => Pick<PiCredential, 'key'> | null;
  /** 注入到 Pi 运行时；失败必须抛出，且不得记为已注入。 */
  inject: (provider: string, key: string) => Promise<void>;
}

/**
 * C4（M2）· 逐会话切换供应商前确保该供应商的 Key 已注入。
 * 抽成可注入依赖的纯逻辑，补 M2 §2 遗留的隔离单测（`ensureProviderKey` 此前只有真机证据）。
 */
export async function ensureProviderKeyFor(provider: string, deps: EnsureProviderKeyDeps): Promise<void> {
  if (deps.keyed.has(provider)) return;
  const next = deps.resolve(provider);
  if (!next) {
    throw new Error(
      `[agent] 缺少 ${provider} 凭据：未找到 env ${provider.toUpperCase()}_API_KEY 或 ~/.aico/secrets/${provider}_api_key；` +
        `任务已切换到该供应商模型，但无法启动真实会话（不降级为 mock）。`,
    );
  }
  await deps.inject(provider, next.key);
  deps.keyed.add(provider);
}

/** G2：会话缓存键（`sessionKey@cwd`）——**同一会话键在不同 cwd 下分区**，不串上下文。 */
export function sessionCacheKey(sessionKey: string, cwd: string): string {
  return `${sessionKey}@${cwd}`;
}

/**
 * GAP7：Pi 会话 id 与缓存键同一归一化规则（`load_skill` 按会话 id 查白名单）。
 *
 * 2026-10-19 staging 真机：缓存键含项目 cwd（`...\\M3 Staging 验收`）时，原实现只把非法字符换成
 * `_`，归一化后**以 `_` 结尾**；Pi 要求会话 id 首尾必须是字母数字 → `dispatch_planning` 直接失败。
 * 这里额外裁掉首尾非字母数字，保证任何 cwd 都能生成合法 id。
 */
export function sessionIdForCacheKey(cacheKey: string): string {
  const normalized = cacheKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const trimmed = normalized.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
  return trimmed.length > 0 ? trimmed : 'session';
}

/**
 * G6：检查会话是否已落盘（上游惰性 flush：`create()` 仅内存，首次 flush 才写 `<ts>_<id>.jsonl`）。
 * - `isPersisted` 不可用 → 返回 `undefined`（**不臆造**）；
 * - 首次 false → **有界复查一次**（固定短延时，**最坏多花 ~50ms**；不阻塞、不循环）；仍 false → **`console.error`**
 */
export async function checkPersisted(
  session: unknown,
  options: { sessionKey?: string; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean | undefined> {
  const sm = (session as { sessionManager?: { isPersisted?: () => boolean } }).sessionManager;
  if (typeof sm?.isPersisted !== 'function') return undefined;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ok = sm.isPersisted();
  if (!ok) {
    await sleep(options.retryDelayMs ?? 50);
    ok = sm.isPersisted();
  }
  if (!ok) {
    console.error(
      `[agent] 会话未能落盘（惰性 flush 未发生）：sessionKey=${options.sessionKey ?? '(unknown)'} —— 会话历史将丢失（重启不可续）`,
    );
  }
  return ok;
}

export interface PiAgentRuntimeOptions {
  /** 供应商（默认 deepseek）。 */
  provider?: string;
  /** 模型 id（默认 deepseek-flash；本机 Pi 版本 deepseek 可用：deepseek-flash / deepseek-v4-pro）。 */
  model?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  cwd?: string;
  agentDir?: string;
  /** 系统提示词（五层拼装结果）。 */
  systemPrompt: string;
  /** customTool 等扩展工厂（如 `pi => pi.registerTool(createReportProgressTool())`）。 */
  extensionFactories?: Array<(pi: unknown) => void>;
  /**
   * OPT-AI-1（RC-4）：会话**落盘目录**（用户数据目录，如 `<userData>/sessions`）。
   * 提供后按 `sessionKey` 派生稳定会话 id：已存在则 `SessionManager.open`（**重启继续**），否则 `create`；
   * 缺省仍用 `SessionManager.inMemory`（不落盘）。
   */
  persistDir?: string;
  /** P2：工具大输出归档根（缺省不归档；小输出不受影响）。 */
  toolOutputDir?: string;
  /**
   * CTX1-3：压缩成功后的**确定性交接块**提供者（按会话键从真库重建）。
   * 返回 null → 不注入；提供者内部负责落 `compaction_handoff` 审计事件。
   */
  buildCompactionHandoff?: (sessionKey: string) => string | null;
}

export interface PiAgentRuntime extends AgentRuntime {
  /** 凭据来源（env/file），仅用于日志（不含明文）。 */
  readonly credentialSource: 'env' | 'file';
  /** 无明文的凭据描述（来源/长度/是否 sk- 前缀）。 */
  readonly credentialDescriptor: { source: string; length: number; skPrefix: boolean };
  readonly modelRef: string;
}

/**
 * N4：把压缩观测钩子注册进扩展工厂（**观测，不改变压缩行为**）——
 * `session_before_compact` 记录原因/阈值并**响亮留痕**；`session_compact` 计数。
 * CTX1-2：`sessionKey` 由 loader 闭包传入 ⇒ 压缩次数能按会话落到 `context_metrics`（不再只有进程总数）。
 * 独立导出，便于用 fake pi 单测（不需要凭据/真会话）。
 */
export function registerCompactionObserver(pi: unknown, sessionKey?: string): void {
  const api = pi as { on?: (event: string, handler: (ev: unknown) => unknown) => unknown };
  if (typeof api.on !== 'function') return;
  api.on('session_before_compact', (ev) => {
    const e = (ev ?? {}) as {
      reason?: string;
      willRetry?: boolean;
      preparation?: { tokensBefore?: number; previousSummary?: string };
    };
    const o: CompactionObservation = {
      reason: e.reason ?? 'unknown',
      tokensBefore: e.preparation?.tokensBefore ?? 0,
      willRetry: e.willRetry === true,
      hadPreviousSummary: typeof e.preparation?.previousSummary === 'string' && e.preparation.previousSummary.length > 0,
    };
    observeBeforeCompact(o, sessionKey);
    console.error('[session] 即将压缩：' + describeCompaction(o)); // 留痕可见（P6），不改行为（返回 undefined ⇒ 底座照常压缩）
    return undefined;
  });
  api.on('session_compact', () => {
    const s = observeCompacted(sessionKey);
    console.error('[session] 压缩完成（累计 ' + s.count + ' 次）');
    return undefined;
  });
}

/**
 * CTX1-1：工具输出在**模型边界**裁剪（新大输出写入时＋旧输出每轮清理）。
 *
 * - `tool_result`：≥ 8000 字符且非错误 → 归档原始内容，把 content 换为头＋尾＋显式标记（带 ref）；
 *   `structuredContent` 一并替换（Pi 文档：只换 content 会丢结构化结果）。
 * - `context`：最近 K 条/错误/短输出不动；更早的大输出替换为一行摘要标记，**不删消息**（配对不断）。
 * 归档结果回填 `archived`（按 toolCallId），供 `tool_execution_end` 复用，避免同一输出落两份文件。
 */
export function registerContextMasking(
  pi: unknown,
  options: {
    sessionKey: string;
    toolOutputDir?: string;
    archived?: Map<string, { ref: string; bytes: number; summary: string }>;
  },
): void {
  const api = pi as { on?: (event: string, handler: (ev: unknown) => unknown) => unknown };
  if (typeof api.on !== 'function') return;
  if (!isContextMaskingEnabled()) return;

  api.on('tool_result', (ev) => {
    const e = (ev ?? {}) as {
      toolCallId?: string;
      toolName?: string;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    if (e.isError === true) return undefined; // 错误留在上下文里（Manus 口径）
    const text = messageText(e.content);
    if (text.length < TOOL_OUTPUT_MASK_THRESHOLD_CHARS) return undefined;
    const toolCallId = typeof e.toolCallId === 'string' ? e.toolCallId : '';
    const toolName = typeof e.toolName === 'string' && e.toolName.length > 0 ? e.toolName : 'tool';
    // 没有归档根 / 归档失败 ⇒ **不裁**：裁了就没有可展开的原文（不拿信息换 token）。
    if (!options.toolOutputDir || toolCallId.length === 0) return undefined;
    let ref: string;
    let bytes: number;
    try {
      const archived = archiveToolOutput({
        root: options.toolOutputDir,
        sessionKey: options.sessionKey,
        toolCallId,
        toolName,
        text,
      });
      ref = archived.ref;
      bytes = archived.bytes;
      options.archived?.set(toolCallId, archived);
    } catch (error) {
      console.error(`[ctx-mask] 工具输出归档失败（${toolName}）——本次不裁剪（保留原文）：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const masked = maskNewToolOutput({ text, toolName, ref, bytes });
    if (!masked.masked) return undefined;
    recordNewMasked(text.length);
    console.error(`[ctx-mask] 裁剪新输出：${toolName} ${text.length} 字符（ref=${ref}）`);
    const images = Array.isArray(e.content) ? e.content.filter((item) => item?.type !== 'text') : [];
    return {
      content: [{ type: 'text', text: masked.text }, ...images],
      structuredContent: { masked: true, toolName, originalChars: text.length, ref },
    };
  });

  api.on('context', (ev) => {
    const messages = (ev as { messages?: unknown[] } | undefined)?.messages;
    if (!Array.isArray(messages)) return undefined;
    const result = maskOldToolResults(messages);
    if (result.maskedCount === 0) return undefined;
    recordOldMasked(result);
    console.error(`[ctx-mask] 清理旧输出：${result.maskedCount} 条，省 ${result.savedChars} 字符`);
    return { messages: result.messages };
  });
}

/**
 * CTX1-3：压缩成功后注入**确定性交接块**（custom message，下一轮生效）。
 *
 * 不替换 Pi 摘要、不额外调 LLM：Pi 正常压缩后，我们从真库重建任务状态（目标/验收/计划/产物/
 * 最近失败/下一步）并作为 custom message 交给会话；`display:true` 才能在会话里看到。
 */
export function registerCompactionHandoff(
  pi: unknown,
  options: { sessionKey: string; build: (sessionKey: string) => string | null },
): void {
  const api = pi as {
    on?: (event: string, handler: (ev: unknown) => unknown) => unknown;
    sendMessage?: (message: unknown, options?: unknown) => void;
  };
  if (typeof api.on !== 'function') return;
  api.on('session_compact', () => {
    let text: string | null = null;
    try {
      text = options.build(options.sessionKey);
    } catch (error) {
      console.error(`[ctx-handoff] 交接块构建异常（${options.sessionKey}）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!text) return undefined;
    if (typeof api.sendMessage !== 'function') {
      console.error('[ctx-handoff] 底座未提供 sendMessage——交接块未注入（不假装成功）');
      return undefined;
    }
    try {
      api.sendMessage(
        { customType: 'compaction_handoff', content: [{ type: 'text', text }], display: true },
        { deliverAs: 'nextTurn' },
      );
      console.error(`[ctx-handoff] 已注入交接块（${options.sessionKey}，${text.length} 字符）`);
    } catch (error) {
      console.error(`[ctx-handoff] 交接块注入失败（${options.sessionKey}）：${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  });
}

/**
 * 五层提示词**逐轮注入**（2026-10-14 真机暴露的修复；独立导出，便于 fake pi 单测）。
 *
 * 背景：`DefaultResourceLoader.systemPromptOverride` 只在 `loader.reload()` 时求值一次，而会话是长生命周期
 * 对象 ⇒ 逐次 `run({ systemPrompt })` 传进来的五层真值**到不了模型**（真机现场：员工拿不到岗位说明/题目/工作项，
 * 只能探索文件系统猜任务，最终升级"入参为空"，整条链停在 needs_decision）。
 *
 * 修法走官方扩展口：`before_agent_start` 的返回值 `systemPrompt` 是
 * "Replace the complete system prompt for this turn"；同时改写 `systemPromptOptions.customPrompt`，
 * 让底座渲染的 `sections.preamble` 与会话记录**如实**（否则取证时看到的是构造期占位符，误导排查）。
 * 返回 `undefined` ⇒ 不改（保持底座现状）。
 */
export function registerSystemPromptInjection(pi: unknown, getPrompt: () => string | undefined): void {
  const api = pi as { on?: (event: string, handler: (ev: unknown) => unknown) => unknown };
  if (typeof api.on !== 'function') return;
  api.on('before_agent_start', (ev) => {
    const prompt = getPrompt();
    if (!prompt) return undefined;
    const options = (ev as { systemPromptOptions?: Record<string, unknown> } | undefined)?.systemPromptOptions;
    if (options) options.customPrompt = prompt;
    return { systemPrompt: prompt };
  });
}

/**
 * RW-52（2026-11-05 真机定位）· 持久化会话恢复**丢新工具**的守卫。
 *
 * SDK 实证（pi-coding-agent 1.3.0 `agent-session.js`）：持久化会话 resume 时
 * `_restoreToolsFromTranscript()` 把活动工具集**整体替换**为转录 system 消息的
 * `toolsAdded` 快照——快照之后才注册的工具（如 RW-51 的 `boss_inbox`）「已注册但
 * 永不激活」＝不声明给模型；旧工具照常；全新会话正常；重启/重构建无效（快照在
 * 会话文件里）。之后每轮 `declareToolChanges` 以该集为准算 delta ⇒ 差值恒空。
 *
 * 修法走官方扩展口：`before_agent_start`（每轮先于 loadout 定稿触发）**幂等补齐**
 * `toolNames` 中缺失的工具 ⇒ 同一请求里 `declareToolChanges` 把它们作为 `toolsAdded`
 * delta 声明给模型。挂 `before_agent_start` 而非 `session_start`：后者的发射在
 * `bindExtensions`（CLI 模式专属），SDK 的 `createAgentSession` 路径不发它。
 * 独立导出，便于 fake pi 单测（`test/pi-tool-activation.test.ts`）。
 */
export function registerToolActivationGuard(pi: unknown, toolNames: readonly string[]): void {
  if (toolNames.length === 0) return;
  const api = pi as {
    on?: (event: string, handler: (ev: unknown) => unknown) => unknown;
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
  };
  if (typeof api.on !== 'function') return;
  api.on('before_agent_start', () => {
    if (typeof api.getActiveTools !== 'function' || typeof api.setActiveTools !== 'function') return undefined;
    const active = api.getActiveTools();
    const missing = toolNames.filter((name) => !active.includes(name));
    if (missing.length > 0) {
      api.setActiveTools([...active, ...missing]);
      console.error(`[agent] 持久化会话快照缺新工具，已补齐声明：${missing.join(', ')}`);
    }
    return undefined;
  });
}

/**
 * 计费用的**模型名**（N5 后续，2026-10-14 评测实跑暴露）：逐轮 `setModel` 之后，会话实际跑的模型可能与
 * 构造期默认不同——若仍按构造期默认记账，`costs.model` 会把贵档记成便宜档（**成本按模型归因失真**：
 * 评测里 v4-pro 的行被记成 flash，金额对、名字错）。
 * 口径：**本会话已应用的模型优先**（`appliedModels`），否则回落构造期默认 `provider/modelId`；
 * 应用值不带 `provider/` 前缀时按构造期 provider 补全（与 `run()` 里 `setModel` 的解析同口径）。
 */
export function usageModelName(applied: string | undefined, fallbackRef: string): string {
  if (typeof applied !== 'string' || applied.trim().length === 0) return fallbackRef;
  const value = applied.trim();
  if (value.includes('/')) return value;
  const provider = fallbackRef.includes('/') ? fallbackRef.slice(0, fallbackRef.indexOf('/')) : fallbackRef;
  return `${provider}/${value}`;
}

/**
 * OPT-AI-7 省回合一环：提交工具（`submit_work_item` / `submit_plan` / `submit_review`）已调用后，
 * 同一轮再出现的工具调用一律 `block + terminate` —— 省掉"提交后模型还要再跑一轮工具"的往返。
 *
 * SDK 能力（实测 d.ts）：`ToolCallEventResult.terminate` 的语义是**当前批次被 block 时**提示 agent 停止；
 * 因此这里拦的是"提交后的下一个工具调用"，而不是提交本身。`agent_start` 重置（每轮独立）。
 */
export const SUBMIT_TOOL_NAMES = ['submit_work_item', 'submit_plan', 'submit_review'] as const;

export function registerSubmitTerminate(pi: unknown): void {
  const api = pi as { on?: (event: string, handler: (ev: unknown) => unknown) => unknown };
  if (typeof api.on !== 'function') return;
  let submitted = false;
  api.on('agent_start', () => {
    submitted = false;
    return undefined;
  });
  api.on('tool_call', (ev) => {
    const name = (ev as { toolName?: unknown } | undefined)?.toolName;
    if (submitted) {
      return {
        block: true,
        terminate: true,
        reason: '本轮已提交（submit_*），终止后续工具调用以省一次模型往返',
      };
    }
    if (typeof name === 'string' && (SUBMIT_TOOL_NAMES as readonly string[]).includes(name)) submitted = true;
    return undefined;
  });
}

export async function createPiAgentRuntime(options: PiAgentRuntimeOptions): Promise<PiAgentRuntime> {
  const provider = options.provider ?? 'deepseek';
  const modelId = options.model ?? 'deepseek-flash';

  const credential = resolveProviderCredential(provider);
  if (!credential) {
    throw new Error(
      `[agent] 缺少 ${provider} 凭据：未找到 env ${provider.toUpperCase()}_API_KEY 或 ~/.aico/secrets/${provider}_api_key；` +
        `真实会话无法启动（不降级为 mock）。`,
    );
  }

  const sdk = await import('@earendil-works/pi-coding-agent');

  // 自定义供应商走 Pi 原生 models.json（`~/.aico/models.json`；可用 AICO_MODELS_PATH 隔离）。
  const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: customModelsPath(), allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey(provider, credential.key);
  const keyedProviders = new Set<string>([provider]);
  /** C4（2026-10-18）：逐会话切换供应商时，必须先为该供应商注入各自 Key；只在装配期设默认供应商会报
   *  `No API key for xiaomi/...`。缺 Key 时抛人话，不静默回落。 */
  const ensureProviderKey = async (nextProvider: string): Promise<void> => {
    await ensureProviderKeyFor(nextProvider, {
      keyed: keyedProviders,
      resolve: resolveProviderCredential,
      inject: async (target, key) => {
        await modelRuntime.setRuntimeApiKey(target, key);
      },
    });
  };

  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    throw new Error(`[agent] 模型不存在：${provider}/${modelId}（用 ModelRuntime.getAvailable() 查看可用模型）`);
  }

  // CTX1-5：按模型窗口推导压缩阈值（Pi 原生 compaction.modelOverrides；AICO_CTX_COMPACTION=off 可关）。
  // S11 边界批结论：真机压缩未触发（deepseek 窗口 1M，压不到阈值）；触发条件与阈值推导由
  // `test/s11-compaction-sim.test.ts` 用 Pi 官方 `shouldCompact` 做代码级模拟验证。
  const compactionOverrides = isCompactionTuningEnabled()
    ? deriveCompactionOverrides(
        modelRuntime.getModels().map((m) => ({
          provider: String(m.provider),
          id: String(m.id),
          contextWindow: m.contextWindow,
        })),
      )
    : {};
  if (Object.keys(compactionOverrides).length > 0) {
    console.error(`[ctx-compaction] 按窗口注入 ${Object.keys(compactionOverrides).length} 个模型的 reserve/keepRecent 档`);
  }
  /** CTX1-1：tool_result 已在模型边界归档的输出（tool_execution_end 复用，避免落两份）。 */
  const archivedToolOutputs = new Map<string, { ref: string; bytes: number; summary: string }>();

  const defaultCwd = options.cwd ?? process.cwd();
  // G2：按 `sessionKey@cwd` 缓存 resource loader（worktree/staging 的任务级 cwd 各自一份）。
  // 修（2026-10-14 真机暴露）：缓存键由**纯 cwd** 细化为**会话**——系统提示词是每会话的，共享 loader 会串。
  const loaderPromises = new Map<string, Promise<unknown>>();
  /** 每会话的**逐轮**系统提示词权威值（`before_agent_start` 每次读它；见 `registerSystemPromptInjection`）。 */
  const sessionSystemPrompts = new Map<string, string>();
  /** N5：每会话**当前已应用**的模型名（变了才 `setModel`；见 `run`）。 */
  const appliedModels = new Map<string, string>();
  const getLoader = (cacheKey: string, c: string, sessionKey: string): Promise<unknown> => {
    let p = loaderPromises.get(cacheKey);
    if (!p) {
      const loader = new sdk.DefaultResourceLoader({
        cwd: c,
        agentDir: options.agentDir ?? sdk.getAgentDir(),
        systemPromptOverride: () => sessionSystemPrompts.get(cacheKey) ?? options.systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          // CTX1-2：按会话记压缩次数（不是进程总数）——闭包给本 loader 所属 sessionKey。
          (api: unknown) => registerCompactionObserver(api, sessionKey),
          // CTX1-1：工具输出在模型边界裁剪（大输出写入时＋旧输出每轮清理）。
          (api: unknown) =>
            registerContextMasking(api, {
              sessionKey,
              ...(options.toolOutputDir ? { toolOutputDir: options.toolOutputDir } : {}),
              archived: archivedToolOutputs,
            }),
          registerSubmitTerminate,
          ...(options.buildCompactionHandoff && isCtxEnabled()
            ? [
                (api: unknown) =>
                  registerCompactionHandoff(api, {
                    sessionKey,
                    build: options.buildCompactionHandoff as (sessionKey: string) => string | null,
                  }),
              ]
            : []),
          (api: unknown) => registerSystemPromptInjection(api, () => sessionSystemPrompts.get(cacheKey)),
          ...(options.extensionFactories ?? []),
        ] as never,
      });
      p = loader.reload().then(() => loader);
      loaderPromises.set(cacheKey, p);
    }
    return p;
  };

  const sessionPromises = new Map<string, Promise<unknown>>();
  const chains = new Map<string, Promise<unknown>>();
  /** G2：记录每个 sessionKey 最近一次的 cwd（`steer` 无 cwd 参数时用）。 */
  const lastCwdBySessionKey = new Map<string, string>();

  /** G2：会话缓存键 = `sessionKey@cwd`（同一会话键在不同 cwd 下**分区**，不串上下文）。 */
  const getSession = (sessionKey: string, c: string): Promise<unknown> => {
    lastCwdBySessionKey.set(sessionKey, c);
    const cacheKey = sessionCacheKey(sessionKey, c);
    let promise = sessionPromises.get(cacheKey);
    if (!promise) {
      let sessionManager: unknown;
      let settingsManager: unknown;
      if (Object.keys(compactionOverrides).length > 0) {
        // 在用户/Pi 既有设置之上叠加我们的按窗档（deepMerge；不覆盖其它设置项）。
        const sm = sdk.SettingsManager.create(c, options.agentDir ?? sdk.getAgentDir());
        sm.applyOverrides({ compaction: { modelOverrides: compactionOverrides } } as never);
        settingsManager = sm;
      }
      if (options.persistDir) {
        mkdirSync(options.persistDir, { recursive: true });
        const id = sessionIdForCacheKey(cacheKey);
        // G2 兼容：旧版会话 id 不带 cwd 后缀（`sessionKey` 归一化）——默认 cwd 下若新 id 找不到，
        // 回退查旧 id，**复用既有会话文件**（不丢历史上下文；不重命名、不改旧文件）。
        const legacyId = sessionIdForCacheKey(sessionKey);
        const existing =
          sdk.SessionManager.findById(c, id, options.persistDir) ??
          (c === defaultCwd ? sdk.SessionManager.findById(c, legacyId, options.persistDir) : undefined);
        sessionManager = existing
          ? sdk.SessionManager.open(existing, options.persistDir, c)
          : sdk.SessionManager.create(c, options.persistDir, { id });
      } else {
        sessionManager = sdk.SessionManager.inMemory(c);
      }
      promise = getLoader(cacheKey, c, sessionKey).then((loader) =>
        sdk
          .createAgentSession({
            model,
            modelRuntime,
            thinkingLevel: options.thinkingLevel ?? 'medium',
            resourceLoader: loader as never,
            sessionManager: sessionManager as never,
            ...(settingsManager ? { settingsManager: settingsManager as never } : {}),
            cwd: c,
          })
          .then((result) => result.session),
      );
      sessionPromises.set(cacheKey, promise);
    }
    return promise;
  };

  /** 同键串行：避免同一会话并发 prompt。 */
  const serialize = <T>(sessionKey: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    chains.set(
      sessionKey,
      next.catch(() => undefined),
    );
    return next;
  };

  return {
    credentialSource: credential.source,
    credentialDescriptor: describeCredential(credential),
    modelRef: `${provider}/${modelId}`,

    run(input: AgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult> {
      return serialize(`${input.sessionKey}@${input.cwd ?? defaultCwd}`, async () => {
        const runCwd = input.cwd ?? defaultCwd;
        const runCacheKey = sessionCacheKey(input.sessionKey, runCwd);
        // GAP7：本轮技能白名单（load_skill 只读本会话名单；无 → 清空，防上一轮泄漏）。
        // 兼容 G2 旧会话 id（无 cwd 后缀）：默认 cwd 下两套 id 都登记。
        setSessionSkillRefs(sessionIdForCacheKey(runCacheKey), input.skills);
        setSessionMcpServers(sessionIdForCacheKey(runCacheKey), input.mcps);
        if (runCwd === defaultCwd) {
          setSessionSkillRefs(sessionIdForCacheKey(input.sessionKey), input.skills);
          setSessionMcpServers(sessionIdForCacheKey(input.sessionKey), input.mcps);
        }
        // 修（2026-10-14 真机暴露）：先登记本会话的逐轮系统提示词（loader 首次创建即读它；
        // 之后由 `before_agent_start` 每轮读取）——否则会话沿用的是构造期占位符。
        if (input.systemPrompt) {
          sessionSystemPrompts.set(runCacheKey, input.systemPrompt);
        }
        const session = (await getSession(input.sessionKey, input.cwd ?? defaultCwd)) as {
          subscribe(listener: (event: unknown) => void): () => void;
          prompt(text: string): Promise<unknown>;
          getLastAssistantText?(): string | undefined;
          getSessionStats?(): {
            tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
            cost?: number;
          };
          setModel?(model: unknown, options?: { persist?: boolean }): Promise<void>;
          setThinkingLevel?(level: string): void;
        };

        // N5（`R3-3`）：逐轮档位——**模型变了才调** `setModel`（session-only；避免每次 run 都往会话记录灌 model_change）。
        // 档位由执行器按角色/风险解析（`resolveSessionModel`）；此层只如实应用，模型不存在 → **响亮抛错**（不静默回落）。
        const cacheKey = sessionCacheKey(input.sessionKey, input.cwd ?? defaultCwd);
        if (input.model && input.model.trim().length > 0) {
          const desired = input.model.trim();
          if (appliedModels.get(cacheKey) !== desired) {
            const slash = desired.indexOf('/');
            const modelProvider = slash > 0 ? desired.slice(0, slash) : provider;
            const modelId = slash > 0 ? desired.slice(slash + 1) : desired;
            await ensureProviderKey(modelProvider);
            const target = modelRuntime.getModel(modelProvider, modelId);
            if (!target) {
              throw new Error(`[agent] 模型不存在：${modelProvider}/${modelId}（档位解析给的模型不可用——不静默回落）`);
            }
            if (typeof session.setModel === 'function') await session.setModel(target, { persist: false });
            appliedModels.set(cacheKey, desired);
          }
        }
        if (input.thinkingLevel && typeof session.setThinkingLevel === 'function') {
          session.setThinkingLevel(input.thinkingLevel);
        }

        let text = '';
        const toolCalls: AgentToolCallRecord[] = [];
        const started = new Map<string, Record<string, unknown>>();
        // 底座在 `stopReason:'error'` 时 `prompt()` 仍可能 resolve，但 assistant message 带 errorMessage。
        // 必须把它转成宿主可见的失败，否则规划/员工会把 401 当成“没有产出”（C2 真机缺陷）。
        let assistantError: string | null = null;

        const unsubscribe = session.subscribe((raw) => {
          const event = raw as {
            type: string;
            assistantMessageEvent?: { type?: string; delta?: string; errorMessage?: unknown };
            message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
            toolCallId?: string;
            toolName?: string;
            args?: unknown;
            isError?: boolean;
          };
          const messageError =
            typeof event.message?.errorMessage === 'string' ? event.message.errorMessage.trim() : '';
          if (
            event.message?.role === 'assistant' &&
            event.message.stopReason === 'error' &&
            messageError.length > 0
          ) {
            assistantError = messageError;
          } else if (typeof event.assistantMessageEvent?.errorMessage === 'string') {
            const deltaError = event.assistantMessageEvent.errorMessage.trim();
            if (deltaError.length > 0) assistantError = deltaError;
          }
          if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
            const delta = event.assistantMessageEvent.delta ?? '';
            text += delta;
            onEvent({ type: 'text_delta', delta });
          } else if (event.type === 'message_update' && (event.assistantMessageEvent as { type?: string } | undefined)?.type === 'thinking_delta') {
            // G5：思考流（上游 `thinking_delta`）→ 归一化事件（宿主落 `agent_thinking`，脱敏后）。
            const delta = String((event.assistantMessageEvent as { delta?: unknown }).delta ?? '');
            if (delta) onEvent({ type: 'thinking_delta', delta });
          } else if (event.type === 'tool_execution_start') {
            const args = (event.args ?? {}) as Record<string, unknown>;
            started.set(event.toolCallId ?? '', args);
            onEvent({
              type: 'tool_call_start',
              toolCallId: event.toolCallId ?? '',
              toolName: event.toolName ?? '',
              input: args,
            });
          } else if (event.type === 'tool_execution_end') {
            const args = started.get(event.toolCallId ?? '') ?? {};
            const toolCallId = event.toolCallId ?? '';
            const toolName = event.toolName ?? '';
            const resultText = toolResultText((event as { result?: unknown }).result);
            const large = resultText.length >= TOOL_OUTPUT_THRESHOLD_CHARS;
            let archived: { ref: string; bytes: number; summary: string } | null = null;
            // CTX1-1：tool_result 裁剪时已归档同一输出 ⇒ 复用（不重复落盘）。
            if (large && archivedToolOutputs.has(toolCallId)) {
              archived = archivedToolOutputs.get(toolCallId) ?? null;
              archivedToolOutputs.delete(toolCallId);
            } else if (large && options.toolOutputDir) {
              try {
                archived = archiveToolOutput({
                  root: options.toolOutputDir,
                  sessionKey: input.sessionKey,
                  toolCallId,
                  toolName,
                  text: resultText,
                });
              } catch (error) {
                // 归档失败不阻断会话；摘要仍可见（不把失败静默成“没有输出”）。
                console.error(`[agent] 工具输出归档失败（${toolName}）：${error instanceof Error ? error.message : String(error)}`);
              }
            }
            const outputFields = large
              ? {
                  outputSummary: archived?.summary ?? summarizeToolOutput(resultText),
                  ...(archived ? { outputRef: archived.ref, outputBytes: archived.bytes } : { outputBytes: resultText.length }),
                }
              : {};
            toolCalls.push({
              id: toolCallId,
              name: toolName,
              input: args,
              isError: event.isError === true,
              ...outputFields,
            });
            onEvent({
              type: 'tool_call_end',
              toolCallId,
              toolName,
              isError: event.isError === true,
              ...outputFields,
            });
          }
        });

        try {
          await session.prompt(input.prompt);
          if (assistantError) throw new Error(assistantError);
          const finalText = text || (session.getLastAssistantText?.() ?? '');
          const stats = session.getSessionStats?.();
          // OPT-AI-8：底座已算好 cost（含缓存计价）与 cacheRead/cacheWrite —— 直落，不再丢。
          const usageModel = usageModelName(appliedModels.get(cacheKey), `${provider}/${modelId}`);
          const usage = stats?.tokens
            ? {
                model: usageModel,
                inputTokens: stats.tokens.input,
                outputTokens: stats.tokens.output,
                cacheReadTokens: stats.tokens.cacheRead ?? 0,
                cacheWriteTokens: stats.tokens.cacheWrite ?? 0,
                ...(typeof stats.cost === 'number' ? { costUsd: stats.cost } : {}),
              }
            : { model: usageModel };
          // G6：会话结束主动查“是否已落盘”（上游惰性 flush）；不落盘就**响亮报错**，不静默。
          const persisted = await checkPersisted(session, { sessionKey: input.sessionKey });
          return { text: finalText, toolCalls, usage, persisted };
        } finally {
          unsubscribe();
        }
      });
    },

    sessionIdFor(input: { sessionKey: string; cwd?: string }): string {
      return sessionIdForCacheKey(sessionCacheKey(input.sessionKey, input.cwd ?? defaultCwd));
    },

    steer(sessionKey: string, text: string): boolean {
      const c = lastCwdBySessionKey.get(sessionKey) ?? defaultCwd;
      const session = sessionPromises.get(`${sessionKey}@${c}`);
      if (!session) return false;
      void session
        .then((s) => (s as { steer?(t: string): unknown }).steer?.(text))
        .catch(() => undefined);
      return true;
    },

    /** CTX-1 D3：手动压缩一次（Pi `AgentSession.compact()`；未找到 → false，不假装压过）。 */
    async compactSession(sessionKey: string): Promise<boolean> {
      const c = lastCwdBySessionKey.get(sessionKey) ?? defaultCwd;
      const session = (await getSession(sessionKey, c)) as { compact?: () => Promise<unknown> } | null;
      if (!session || typeof session.compact !== 'function') return false;
      await session.compact();
      return true;
    },

    /**
     * BRK17（挂载 3 余·取消小步）：**真中止**该会话键下的所有实例（`AgentSession.abort()`；
     * 键为 `${sessionKey}@${cwd}` 前缀匹配——取消时不需要知道当时 cwd）。未找到 ⇒ false（如实）。
     */
    abortSession(sessionKey: string): boolean {
      let found = false;
      for (const [key, promise] of sessionPromises) {
        if (key !== sessionKey && !key.startsWith(`${sessionKey}@`)) continue;
        found = true;
        void promise
          .then((s) => (s as { abort?(): Promise<void> | void }).abort?.())
          .catch(() => undefined);
      }
      return found;
    },

    dispose(): void {
      for (const promise of sessionPromises.values()) {
        void promise.then((s) => (s as { dispose?(): void }).dispose?.()).catch(() => undefined);
      }
      sessionPromises.clear();
      chains.clear();
    },
  };
}
