/**
 * B4-4/D-29 · 图像生成工具——OpenAI DALL-E API＋spend 闸。
 *
 * 口径：POST https://api.openai.com/v1/images/generations（DALL-E 3）；
 * API Key 走 `resolveProviderKey('openai')`（环境变量 OPENAI_API_KEY 优先，回落 secrets 密文；只读）；
 * 生成结果 base64 落盘到宿主固定目录 `<cwd>/assets/images/`（**不收路径参数**——spend 类
 * 不经路径层，收了就是未受检的写路径）；工具归 `spend` 类（花钱＋对外：external grant 不得放行）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProviderKey } from '../provider-keys.js';

export interface ImageGenerateResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** 生成图的宿主固定目录（相对工作目录；返回给员工的路径可原样填进 artifacts）。 */
export const IMAGE_OUTPUT_SUBDIR = 'assets/images';

/** 错误回文里的 Key 片段脱敏（OpenAI 401 会回显掩码后的 Key 尾巴，回给模型即进转写）。 */
export function redactKeyFragments(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***');
}

export async function imageGenerate(opts: {
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  outputDir: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ImageGenerateResult> {
  const key = opts.apiKey ?? resolveProviderKey('openai')?.key?.trim() ?? '';
  if (!key) return { ok: false, error: 'OpenAI API Key 未配置（环境变量 OPENAI_API_KEY 或设置页填 OpenAI Key）' };
  const prompt = opts.prompt.trim();
  if (!prompt) return { ok: false, error: 'prompt 必填' };
  const size = opts.size ?? '1024x1024';
  const timeout = opts.timeoutMs ?? 60_000;

  const fileName = `image-${Date.now()}.png`;
  const outputPath = join(opts.outputDir, fileName);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    // B4b 安全审查 F10：目录创建进 try——失败给模型人话错误而非裸异常（含绝对路径）。
    mkdirSync(opts.outputDir, { recursive: true });
    const fetchImpl = opts.fetchImpl ?? fetch;
    const resp = await fetchImpl('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, size, n: 1, response_format: 'b64_json' }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: redactKeyFragments(`DALL-E API 失败（${resp.status}）：${body.slice(0, 300)}`) };
    }
    const data = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: 'DALL-E API 未返回图片数据' };
    writeFileSync(outputPath, Buffer.from(b64, 'base64'));
    if (!existsSync(outputPath)) return { ok: false, error: '图片写盘失败' };
    return { ok: true, path: outputPath };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: redactKeyFragments(msg.includes('abort') ? `请求超时（${timeout}ms）` : msg) };
  } finally {
    clearTimeout(timer);
  }
}
