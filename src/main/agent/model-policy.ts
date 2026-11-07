/**
 * N2 预算档（P21 第①级：**降档**）—— 装配期模型档位的**唯一来源**。
 *
 * 口径：
 *  - **档位在装配期生效**（`createLazyEmployeeRuntime` 里解析后传给 `assemble`）：超阈后**新装配**的会话走省钱档，
 *    **在跑会话不打断**（不丢上下文/缓存）；
 *  - **普通档** ＝ `settings['models.default']`（R2-3：设置页可改；**启动时注入**、写入即生效于**下次装配**）
 *    ?? `AICO_MODEL`（缺省 `deepseek-flash`）；**省钱档** ＝ `AICO_ECONOMY_MODEL`
 *    （缺省＝普通档，即"未配置省钱档时降档为 no-op"——**不假装省了**）；
 *  - 档位开关由引擎在每轮派发规划时按速率切换（`setEconomyMode`）。
 *
 * N5（`R3-3`）追加（与上并列，不改上语义）：
 *  - `models.role_map`（设置项 JSON，**不动表**）→ `setRoleMap`；逐会话档位解析 `resolveSessionModel`
 *    （**员工显式 > role_map > L0 经济档 > 普通档**；纯逻辑在 `src/core/model-tiers.ts`）。
 */

import {
  providerOf,
  resolveModelTier,
  sanitizeFallbackChain,
  sanitizeRoleMap,
  type AssistantCandidate,
  type ModelTierInput,
  type ModelTierResolution,
  type RoleMap,
} from '../../core/model-tiers.js';
import { getCachedCatalogModels } from './model-catalog.js';
import { resolveProviderKey } from './provider-keys.js';

export interface AssembleModel {
  provider?: string;
  model: string;
}

let economy = false;
let defaultModelOverride: string | null = null;

/** R2-3：设置页「默认模型」写入（`settings['models.default']`）。`null`/空串 = 未设置（回落到 env）。 */
export function setDefaultModel(model: string | null): void {
  defaultModelOverride = typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
}

export function getDefaultModelOverride(): string | null {
  return defaultModelOverride;
}

/** 引擎在费率超"降档线"时调用；回落到线下时复位（**不粘滞**）。 */
export function setEconomyMode(on: boolean): void {
  economy = on;
}

export function isEconomyMode(): boolean {
  return economy;
}

/** 模型串拆 provider/model（与 `core/model-tiers`/`pi-runtime` 的 `provider/model` 口径一致）。 */
function splitModelRef(ref: string): { provider?: string; model: string } {
  const value = ref.trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return { model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** 装配期档位解析（读注入口径；**每次装配都重新读**，便于测试与运行期改 env）。 */
export function resolveAssembleModel(): AssembleModel {
  const envProvider = process.env.AICO_PROVIDER || undefined;
  const normalRef = normalModelName();
  const economyRef = process.env.AICO_ECONOMY_MODEL ?? normalRef;
  const parsed = splitModelRef(economy ? economyRef : normalRef);
  // `models.default` 允许 `provider/model`（如 `xiaomi/mimo-v2.6-flash`）：provider 从串里解析，
  // 否则底座会按缺省 deepseek 去查模型（MiMo/其它 provider 装配必失败）。env `AICO_PROVIDER` 仍最优先。
  return { provider: envProvider ?? parsed.provider, model: parsed.model };
}

// ───────── N5（`R3-3`）· 逐会话档位（`role_map` ＋ L0 经济档） ─────────

/**
 * 普通档名（唯一来源）：settings `models.default`（R2-3 设置页，启动注入/写入即生效）优先；
 * `AICO_MODEL` 次之；兼容 DEV §11 已文档化的 `AICO_PI_MODEL`；兜底 `deepseek-flash`。
 */
export function normalModelName(): string {
  return defaultModelOverride ?? process.env.AICO_MODEL ?? process.env.AICO_PI_MODEL ?? 'deepseek-flash';
}

let roleMap: RoleMap = {};

/** 注入 `models.role_map`（启动读设置 ＋ 写入即生效）。非法项**逐条留痕丢弃**（不静默）；`null`＝清空。 */
export function setRoleMap(map: unknown): void {
  const { map: clean, dropped } = sanitizeRoleMap(map);
  for (const reason of dropped) console.warn(`[model-policy] role_map 项被拒：${reason}`);
  roleMap = clean;
}

export function getRoleMap(): RoleMap {
  return roleMap;
}

let fallbackChain: string[] = [];

/** 注入 `models.fallback_chain`（启动读设置 ＋ 写入即生效）——运行时降级与异供应商备选的**唯一来源**。 */
export function setFallbackChain(raw: unknown): void {
  const { chain, dropped } = sanitizeFallbackChain(raw);
  for (const reason of dropped) console.warn(`[model-policy] fallback_chain 项被拒：${reason}`);
  fallbackChain = chain;
}

export function getFallbackChain(): readonly string[] {
  return fallbackChain;
}

/**
 * B0-11：链内降级的指数退避（500ms 起、翻倍、8s 封顶）。`AICO_LLM_BACKOFF_MS` 配基值（0=关）。
 * 目的：单供应商限流/5xx 时不要「立刻打满整链」——先等一拍，仍失败再换模型。
 */
export function providerBackoffMs(hop: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AICO_LLM_BACKOFF_MS ?? '').trim();
  const parsed = raw.length > 0 ? Number(raw) : Number.NaN;
  const base = Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
  if (base === 0) return 0;
  const exp = Math.max(0, Math.trunc(hop));
  return Math.min(base * 2 ** exp, 8000);
}

/** 裸模型名 → 供应商（deepseek-flash→deepseek，mimo-*→xiaomi；带 `/` 时按前缀）。 */
function providerIdOf(model: string): string {
  const provider = providerOf(model);
  if (model.includes('/')) return provider;
  if (provider.startsWith('deepseek')) return 'deepseek';
  if (provider.startsWith('mimo') || provider.startsWith('xiaomi')) return 'xiaomi';
  return provider;
}

/**
 * D-22 selection-time key hard gate: only asks whether the model's provider has a key; never reads plaintext.
 * Same lookup as `resolveProviderKey` (env first, then local secrets file).
 */
export function providerForModel(
  model: string,
  catalog: readonly { provider: string; id: string }[],
  envProvider?: string | null,
): string {
  const trimmed = model.trim();
  // 与运行期一致：带前缀按前缀；裸名优先 AICO_PROVIDER（装配期 provider），再查目录，最后前缀规则。
  if (trimmed.includes('/')) return providerIdOf(trimmed);
  if (typeof envProvider === 'string' && envProvider.trim().length > 0) return envProvider.trim();
  const hit = catalog.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
  if (hit) return hit.provider;
  return providerIdOf(trimmed);
}

export function isModelKeyAvailable(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed.length === 0) return false;
  // 与运行期一致：带前缀按前缀；裸名先 AICO_PROVIDER，再查目录，最后前缀规则（避免把模型名当供应商）。
  return resolveProviderKey(providerForModel(trimmed, getCachedCatalogModels(), process.env.AICO_PROVIDER)) !== null;
}

/** 规范化模型引用（裸名与 provider/model 同键）：运行时兜底链去重与异供应商比较共用。 */
export function modelRefKey(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  const id = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  return `${providerIdOf(trimmed)}/${id}`;
}

/**
 * 逐会话档位解析（唯一序：**任务级 > 员工显式 > role_map > L0 经济档 > 普通档**＋**异供应商叠加**）——
 * 四处会话点（员工/规划/critic/verifier）在 `runtime.run` 前调用并把结果带进入参；纯逻辑在
 * `src/core/model-tiers.ts`（本函数只做真值注入与「critic/verifier 异供应商」叠加）。
 */
export interface SessionModelInput extends ModelTierInput {
  /** critic/verifier 的**实现者供应商**（§10.3 异供应商判据）；缺省/空 = 不尝试叠加。 */
  peerProvider?: string | null;
}

export function resolveSessionModel(
  input: SessionModelInput,
  options: { keyAvailable?: (model: string) => boolean } = {},
): ModelTierResolution {
  const keyAvailable = options.keyAvailable ?? isModelKeyAvailable;
  // D-22 assistant：主进程启动时会预热目录；未加载 → 空候选（解析器回落并说明，不静默选错）。
  const assistantCandidates: AssistantCandidate[] = getCachedCatalogModels()
    .filter((m) => m.keyConfigured)
    .map((m) => ({
    model: `${m.provider}/${m.id}`,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
    inputCost: m.cost.input,
    outputCost: m.cost.output,
  }));
  const base = resolveModelTier(
    { ...input, assistantCandidates },
    {
      normalModel: normalModelName(),
      economyModel: process.env.AICO_ECONOMY_MODEL ?? null,
      roleMap,
    },
  );
  // D-22：硬约束拒绝优先于一切（assistant 未启用 / 任务模型越界）；调用方负责响亮失败。
  if (base.rejected) return base;
  // 异供应商（EMPLOYEES §10.3：「critic/verifier 建议用不同供应商——视角差异」）：
  // **仅对非显式指派的结果尝试**（明派＝task/employee 压一切；只有 role_map/项目默认/公司默认才做视角差异），
  // 备选取自 `models.fallback_chain` 且必须落在项目允许清单内；找不到第二供应商 ⇒ 保持原模型并**如实标 `diversified:false`**（调用方留痕）。
  if (
    (input.role === 'critic' || input.role === 'verifier') &&
    (base.source === 'assistant' ||
      base.source === 'role_map' ||
      base.source === 'project_default' ||
      base.source === 'default')
  ) {
    const peer = typeof input.peerProvider === 'string' ? providerIdOf(input.peerProvider.trim()) : '';
    if (peer.length > 0 && providerIdOf(base.model) === peer) {
      const allowed = input.project?.allowedModels ?? [];
      // 备选也必须可用：缺 Key 的模型不能顶替（否则 Key 硬门会把整次评审拒掉）。
      const alt = fallbackChain.find(
        (m) =>
          m !== base.model &&
          providerIdOf(m) !== peer &&
          (allowed.length === 0 || allowed.includes(m)) &&
          keyAvailable(m),
      );
      if (alt) {
        return {
          ...base,
          model: alt,
          diversified: true,
          ...(base.reason ? { reason: `${base.reason}；异供应商评审改用 ${alt}` } : {}),
        };
      }
      return { ...base, diversified: false };
    }
  }
  return base;
}

/**
 * N5 余账：**运行时兜底链的错误分类**（文本启发式——宁可少判：误判会把真错误吞成"降级"）。
 * 命中＝供应商侧不可用（鉴权 401/403、限流 429、5xx、模型不存在/不可用、连接层失败）。
 */
export function isProviderUnavailableError(message: string): boolean {
  return (
    /\b(401|403|429|5\d\d)\b/.test(message) ||
    /unauthorized|invalid[\s_-]?(api[\s_-]?key|credential|token)|overloaded|rate[\s_-]?limit/i.test(message) ||
    /model[\s\S]{0,40}(not[\s_-]?found|unavailable|unknown|deprecated)/i.test(message) ||
    // 装配/档位解析的中文报错（如 `[agent] 模型不存在：…`）——C1 真机暴露：此前不命中分类，
    // 装配期直接判 no_credential，兜底链永远不启动。
    /模型不存在|模型不可用|模型已下线|凭据不可用|密钥无效|鉴权失败/.test(message) ||
    /\bECONN(REFUSED|RESET|ABORTED)\b|ETIMEDOUT|fetch failed|socket hang up/i.test(message) ||
    // 2026-10-24 真机：Pi SDK 对拒连只回 `Connection error.`（无 errno）；不识别会让规划动作
    // 失败但任务永停 planning（F-2 ⑦ 卡死）。只收明确的连接层人话，不收泛化 "error"。
    /\b(connection|network)\s*(error|refused|reset|closed|lost|timed?\s*out)\b/i.test(message) ||
    // 2026-10-29 系统级断网实测：装配超时（网络不可用）此前落到 no_credential 决策卡（误导）。
    /连接超时|网络不可用|服务不可达|装配超时/.test(message)
  );
}
