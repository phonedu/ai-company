/**
 * 模型目录（配套，2026-10-23）——**只读**：把 Pi SDK 的静态模型目录投影给设置页。
 *
 * 口径：
 *  - 只列 **chat** 模型；图片/分类模型不进选择器（不冒充可对话）。
 *  - 默认只露**已登记供应商**（`provider-keys.ts` 的 4 家）＋**已配置 Key 的其它供应商**；
 *    未配置的陌生供应商不铺屏（目录有几十家，铺开就是噪音）。
 *  - Key 状态只回「是否配置 / 来源」，**绝不回明文**。
 *  - 价格是 Pi 目录的 **USD / 1M tokens**，原样展示，不做汇率/倍率换算。
 */
import { PROVIDERS, resolveProviderKey } from './provider-keys.js';
import { customModelsPath } from './custom-providers.js';

export interface CatalogModelInput {
  provider: string;
  id: string;
  name: string;
  type?: string;
  contextWindow: number;
  maxTokens: number;
  input: readonly string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelCatalogEntry {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  /** contextWindow / maxTokens 原样（token 数）。 */
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoning: boolean;
  /** USD / 1M tokens（Pi 目录口径）。 */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  keyConfigured: boolean;
  keySource: 'env' | 'file' | null;
}

export interface CatalogBuildOptions {
  /** 即使未配置 Key 也列出的供应商（内置 4 家）。 */
  knownProviders: readonly string[];
  /** 供应商显示名（缺省用 id）。 */
  providerLabels?: Readonly<Record<string, string>>;
  /** Key 状态查询（调用方注入；测试不读真实 secrets）。 */
  keyInfo: (provider: string) => { configured: boolean; source: 'env' | 'file' | null };
}

/** 供应商目录（添加供应商弹窗用）：SDK 里**有 chat 模型**的供应商都列出，含未配置。 */
export interface ProviderCatalogEntry {
  provider: string;
  providerLabel: string;
  modelCount: number;
  keyConfigured: boolean;
  keySource: 'env' | 'file' | null;
}

/** 纯投影：按 chat 模型供应商聚合；已配置优先，再按名称。 */
export function buildProviderCatalog(
  models: readonly CatalogModelInput[],
  options: Pick<CatalogBuildOptions, 'providerLabels' | 'keyInfo'>,
): ProviderCatalogEntry[] {
  const counts = new Map<string, number>();
  for (const model of models) {
    if ((model.type ?? 'chat') !== 'chat') continue;
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  const out: ProviderCatalogEntry[] = [];
  for (const [provider, modelCount] of counts) {
    const key = options.keyInfo(provider);
    out.push({
      provider,
      providerLabel: options.providerLabels?.[provider] ?? provider,
      modelCount,
      keyConfigured: key.configured,
      keySource: key.source,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.keyConfigured) - Number(a.keyConfigured) ||
      a.providerLabel.localeCompare(b.providerLabel) ||
      a.provider.localeCompare(b.provider),
  );
  return out;
}

/** 纯投影（可单测）：过滤、去重、排序；是否展示某供应商由 allowed 判定。 */
export function buildModelCatalog(
  models: readonly CatalogModelInput[],
  options: CatalogBuildOptions,
): ModelCatalogEntry[] {
  const known = new Set(options.knownProviders);
  const seen = new Set<string>();
  const out: ModelCatalogEntry[] = [];
  for (const model of models) {
    if ((model.type ?? 'chat') !== 'chat') continue;
    const key = options.keyInfo(model.provider);
    if (!known.has(model.provider) && !key.configured) continue;
    const dedupe = `${model.provider}/${model.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      provider: model.provider,
      providerLabel: options.providerLabels?.[model.provider] ?? model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      reasoning: model.reasoning,
      cost: { ...model.cost },
      keyConfigured: key.configured,
      keySource: key.source,
    });
  }
  out.sort(
    (a, b) =>
      // 已配置 Key 的供应商排前（先能用的），再按供应商/名称。
      Number(b.keyConfigured) - Number(a.keyConfigured) ||
      a.providerLabel.localeCompare(b.providerLabel) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return out;
}

let catalogPromise: Promise<{ models: ModelCatalogEntry[]; providers: ProviderCatalogEntry[] }> | null = null;
let cachedModels: ModelCatalogEntry[] = [];

/** 同步读取上次目录结果（assistant 选型用；未加载过 → 空数组，调用方回落并说明）。 */
export function getCachedCatalogModels(): readonly ModelCatalogEntry[] {
  return cachedModels;
}

/**
 * CTX1-2：按模型引用取上下文窗口（`provider/id` 或裸 id）。
 * 目录未加载/无此项/窗口非正 → **null**（调用方显 `—`，不写假数）。
 */
export function contextWindowForModel(model: string): number | null {
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  const hit = cachedModels.find((m) => `${m.provider}/${m.id}` === trimmed || m.id === trimmed);
  return hit != null && hit.contextWindow > 0 ? hit.contextWindow : null;
}

/**
 * 读 Pi 静态目录（懒加载 SDK；进程内缓存）。**不联网刷新**：只列随包目录，
 * 避免设置页打开就卡在网络目录刷新上；自定义供应商/刷新按钮后续件再接。
 */
export function loadModelCatalog(
  options: { refresh?: boolean } = {},
): Promise<{ models: ModelCatalogEntry[]; providers: ProviderCatalogEntry[] }> {
  if (options.refresh) catalogPromise = null;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const runtime = await sdk.ModelRuntime.create({ modelsPath: customModelsPath(), allowModelNetwork: false });
      const labels: Record<string, string> = {};
      for (const provider of runtime.getProviders()) {
        const name = (provider as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim().length > 0) labels[provider.id] = name.trim();
      }
      const raw: CatalogModelInput[] = runtime.getModels().map((model) => ({
        provider: String(model.provider),
        id: model.id,
        name: model.name,
        type: (model as { type?: string }).type,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        },
      }));
      // 内置 4 家的显示名以 `provider-keys.ts` 为准（与设置页 Key 行一致）。
      for (const provider of PROVIDERS) labels[provider.id] = provider.label;
      const keyInfo = (provider: string): { configured: boolean; source: 'env' | 'file' | null } => {
        const cred = resolveProviderKey(provider);
        return { configured: cred !== null, source: cred?.source ?? null };
      };
      const models = buildModelCatalog(raw, {
        knownProviders: PROVIDERS.map((p) => p.id),
        providerLabels: labels,
        keyInfo,
      });
      cachedModels = models;
      return {
        models,
        providers: buildProviderCatalog(raw, { providerLabels: labels, keyInfo }),
      };
    })().catch((error: unknown) => {
      catalogPromise = null; // 失败允许下次重试，不把错误缓存成永久空目录
      throw error;
    });
  }
  return catalogPromise;
}
