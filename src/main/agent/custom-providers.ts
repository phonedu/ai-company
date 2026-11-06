/**
 * 自定义供应商：复用 Pi 原生 `models.json`（`ModelRuntime.create({ modelsPath })`）。
 * 文件只存 provider 配置（名称/Base URL/API/模型元数据），**不存 Key**；Key 仍走本机 secrets。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  customProvidersShapeError,
  sanitizeCustomProviders,
  type CustomProviderDef,
} from '../../core/custom-provider.js';

export function customModelsPath(): string {
  return process.env.AICO_MODELS_PATH?.trim() || join(homedir(), '.aico', 'models.json');
}

function readFile(): Record<string, unknown> {
  const path = customModelsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读 Pi models.json 里的 provider（只投影本应用认识的字段；坏项丢弃）。 */
export function listCustomProviders(): CustomProviderDef[] {
  const raw = readFile();
  const providers = raw.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  const list: CustomProviderDef[] = [];
  for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const p = value as Record<string, unknown>;
    const models = Array.isArray(p.models)
      ? p.models.map((m) => {
          const mm = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
          const cost = (mm.cost && typeof mm.cost === 'object' ? mm.cost : {}) as Record<string, unknown>;
          return {
            id: typeof mm.id === 'string' ? mm.id : '',
            name: typeof mm.name === 'string' ? mm.name : (typeof mm.id === 'string' ? mm.id : ''),
            contextWindow: typeof mm.contextWindow === 'number' ? mm.contextWindow : 0,
            maxTokens: typeof mm.maxTokens === 'number' ? mm.maxTokens : 0,
            input: Array.isArray(mm.input) ? (mm.input as Array<'text' | 'image'>) : (['text'] as Array<'text' | 'image'>),
            reasoning: mm.reasoning === true,
            cost: {
              input: typeof cost.input === 'number' ? cost.input : 0,
              output: typeof cost.output === 'number' ? cost.output : 0,
              cacheRead: typeof cost.cacheRead === 'number' ? cost.cacheRead : 0,
              cacheWrite: typeof cost.cacheWrite === 'number' ? cost.cacheWrite : 0,
            },
          };
        })
      : [];
    const def: CustomProviderDef = {
      id,
      label: typeof p.name === 'string' && p.name.trim().length > 0 ? p.name : id,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      api: typeof p.api === 'string' ? (p.api as CustomProviderDef['api']) : 'openai-completions',
      models,
    };
    if (customProvidersShapeError([def]) === null) list.push(def);
  }
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

/** 覆盖写 providers（保留 models.json 其它顶层字段）。非法形状抛错，不写半截。 */
export function writeCustomProviders(list: readonly CustomProviderDef[]): void {
  const error = customProvidersShapeError(list);
  if (error) throw new Error(`[custom-providers] ${error}`);
  const current = readFile();
  const providers: Record<string, unknown> = {};
  for (const p of list) {
    providers[p.id] = {
      name: p.label,
      baseUrl: p.baseUrl,
      api: p.api,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.input,
        reasoning: m.reasoning,
        cost: m.cost,
      })),
    };
  }
  const path = customModelsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`, 'utf8');
}

export function upsertCustomProvider(def: CustomProviderDef): CustomProviderDef[] {
  const list = listCustomProviders().filter((p) => p.id !== def.id);
  list.push(def);
  list.sort((a, b) => a.id.localeCompare(b.id));
  writeCustomProviders(list);
  return list;
}

export function removeCustomProvider(id: string): CustomProviderDef[] {
  const list = listCustomProviders().filter((p) => p.id !== id);
  writeCustomProviders(list);
  return list;
}

/** 读边界（启动/目录）防御：坏项丢弃并给理由。 */
export function sanitizedCustomProviders(): CustomProviderDef[] {
  return sanitizeCustomProviders(listCustomProviders()).list;
}
