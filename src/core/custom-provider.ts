/**
 * 自定义供应商（D-22 余账）：设置项 `models.custom_providers` 的形状/安全边界。
 * 纯逻辑；运行时注册在 `main/agent/custom-providers.ts`。
 */
export const CUSTOM_PROVIDER_APIS = ['openai-completions', 'anthropic-messages', 'google-generative-ai'] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export interface CustomProviderModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: readonly ('text' | 'image')[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CustomProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  api: CustomProviderApi;
  models: readonly CustomProviderModelDef[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** 写侧唯一判据：返回人话 reason 或 null。 */
export function customProvidersShapeError(value: unknown): string | null {
  if (!Array.isArray(value)) return '需为数组（每个元素是一个自定义供应商）';
  if (value.length > 20) return `最多 20 个自定义供应商（收到 ${value.length} 个）`;
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const label = `第 ${index + 1} 项`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return `${label}需为对象`;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) {
      return `${label} id 需为小写字母/数字/_/-（≤32 字符）`;
    }
    if (ids.has(p.id)) return `供应商 id 重复：${p.id}`;
    ids.add(p.id);
    if (typeof p.label !== 'string' || p.label.trim().length === 0 || p.label.length > 80) {
      return `${label} 显示名需为 1–80 字符`;
    }
    if (typeof p.baseUrl !== 'string' || !isHttpUrl(p.baseUrl.trim())) {
      return `${label} Base URL 需为 http(s) 且不含账号密码`;
    }
    if (!(CUSTOM_PROVIDER_APIS as readonly string[]).includes(String(p.api))) {
      return `${label} API 需为 ${CUSTOM_PROVIDER_APIS.join(' / ')}`;
    }
    if (!Array.isArray(p.models) || p.models.length === 0 || p.models.length > 20) {
      return `${label} models 需为 1–20 个模型`;
    }
    const modelIds = new Set<string>();
    for (const [mi, raw] of p.models.entries()) {
      const mLabel = `${label} 模型 ${mi + 1}`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${mLabel} 需为对象`;
      const m = raw as Record<string, unknown>;
      if (typeof m.id !== 'string' || m.id.trim().length === 0 || m.id.length > 200) return `${mLabel} id 需为 1–200 字符`;
      if (modelIds.has(m.id)) return `${mLabel} id 重复：${m.id}`;
      modelIds.add(m.id);
      if (typeof m.name !== 'string' || m.name.trim().length === 0 || m.name.length > 200) return `${mLabel} 名称需为 1–200 字符`;
      if (typeof m.contextWindow !== 'number' || !Number.isInteger(m.contextWindow) || m.contextWindow <= 0) {
        return `${mLabel} contextWindow 需为正整数`;
      }
      if (typeof m.maxTokens !== 'number' || !Number.isInteger(m.maxTokens) || m.maxTokens <= 0) {
        return `${mLabel} maxTokens 需为正整数`;
      }
      if (!Array.isArray(m.input) || m.input.length === 0 || !m.input.every((x) => x === 'text' || x === 'image')) {
        return `${mLabel} input 需为非空 text/image 数组`;
      }
      if (typeof m.reasoning !== 'boolean') return `${mLabel} reasoning 需为布尔`;
      if (typeof m.cost !== 'object' || m.cost === null || Array.isArray(m.cost)) return `${mLabel} cost 需为对象`;
      const cost = m.cost as Record<string, unknown>;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const rate = cost[key];
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 10_000) {
          return `${mLabel} cost.${key} 需为 0–10000（USD/1M）`;
        }
      }
    }
  }
  return null;
}

/** 读侧消毒（坏项逐条丢弃；不抛）。 */
export function sanitizeCustomProviders(value: unknown): { list: CustomProviderDef[]; dropped: string[] } {
  if (value == null) return { list: [], dropped: [] };
  if (customProvidersShapeError(value) === null) return { list: value as CustomProviderDef[], dropped: [] };
  if (!Array.isArray(value)) return { list: [], dropped: ['整体不是数组'] };
  const list: CustomProviderDef[] = [];
  const dropped: string[] = [];
  for (const [index, item] of value.entries()) {
    if (customProvidersShapeError([item]) === null) list.push(item as CustomProviderDef);
    else dropped.push(`第 ${index + 1} 项：${customProvidersShapeError([item]) ?? '非法'}`);
  }
  return { list, dropped };
}
