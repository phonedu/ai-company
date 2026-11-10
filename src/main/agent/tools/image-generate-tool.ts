/**
 * / · 图像生成工具——双通道（Qwen 兼容模式／OpenAI DALL-E）＋spend 闸。
 *
 * 口径（决定 5，2026-11-09 要求走 qwen 并提供 endpoint）：
 *  - **Qwen 通道**（优先）：OpenAI 兼容模式 `POST https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations`，
 *    模型 `qwen-image-3.0-pro`，Key 走 `resolveProviderKey('dashscope')`（DASHSCOPE_API_KEY 或设置页
 *    「阿里云百炼（Qwen 出图）」密文）；响应兼容 `data[0].url` 与 `data[0].b64_json` 两种形状。
 *  - **DALL-E 通道**（回落）：`POST https://api.openai.com/v1/images/generations`（dall-e-3），Key 走 openai。
 *  - 两通道 endpoint 都是**源码常量**（不收运行时参数 ⇒ 无 SSRF 面）；唯一的二级请求是下载 API 回的图片
 *    URL——先过 `isSafeDownloadUrl`（仅 https＋IP 字面量拒环回/私网/保留段），再过 `isSafeDownloadTarget`
 *    （域名解析结果也必须全是公网地址，防 DNS 指向内网）。
 *  - Key 只读；错误回文过 `redactKeyFragments`；落盘 `<cwd>/assets/images/`（**不收路径参数**——spend 类
 *    不经路径层，收了就是未受检的写路径）；工具归 `spend` 类（花钱＋对外）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { join } from 'node:path';

import { resolveProviderKey, type ProviderKeyOptions } from '../provider-keys.js';

/** 通道解析用的 Key 注入（测试传 env/baseDir，不碰真 secrets）。 */
export type ImageChannelKeyOptions = ProviderKeyOptions;

export interface ImageGenerateResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** 生成图的宿主固定目录（相对工作目录；返回给员工的路径可原样填进 artifacts）。 */
export const IMAGE_OUTPUT_SUBDIR = 'assets/images';

/** 错误回文里的 Key 片段脱敏（401 会回显掩码后的 Key 尾巴，回给模型即进转写）。 */
export function redactKeyFragments(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***');
}

/**
 * 出图通道（按已配置的 Key 选；**执行期**解析——Key 可能是应用开着时才填的）。
 * `keyOptions` 测试注入（不碰真 secrets）；生产按已配置 Key 选：qwen 优先、DALL-E 回落。
 */
export function resolveImageChannel(keyOptions: ImageChannelKeyOptions = {}): 'qwen' | 'dalle' | null {
  if (resolveProviderKey('dashscope', keyOptions) != null) return 'qwen';
  if (resolveProviderKey('openai', keyOptions) != null) return 'dalle';
  return null;
}

// ───────────────────────── 下载目标安全检查（仅 https＋拒内网/保留地址） ─────────────────────────

/** IPv4 点分地址是否落在环回/私网/链路本地/CGNAT/保留/组播段；格式不合法一律当危险。 */
function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 链路本地／云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true; // 192.168/16、192.0.0/24＋192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播＋保留
  return false;
}

/** IPv6 地址是否本地/私有/组播（含 IPv4 映射地址按 IPv4 判）。 */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('::ffff:')) return isPrivateOrReservedIPv4(h.slice(7));
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10
  if (h.startsWith('ff')) return true; // 组播
  return false;
}

/** 任意 IP 字符串（v4/v6）是否不可作为下载目标。 */
export function isPrivateOrReservedAddress(addr: string): boolean {
  return addr.includes(':') ? isPrivateOrReservedIPv6(addr) : isPrivateOrReservedIPv4(addr);
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** 同步层：仅 https；拒本地域名；IP 字面量按段判。 */
export function isSafeDownloadUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // SEC-E（2026-11-10，对抗测试发现）：URL 内嵌凭据（`https://user:pass@host/x`）此前放行——
  // 凭据会进日志/错误文案，且是钓鱼 URL 的常见形态；下载地址不需要凭据，一律拒。
  if (u.username.length > 0 || u.password.length > 0) return false;
  const host = hostOf(u);
  if (host.length === 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':')) return !isPrivateOrReservedIPv6(host);
  if (IPV4_LITERAL.test(host)) return !isPrivateOrReservedIPv4(host);
  return true;
}

/** 主机名 → 解析出的全部地址（可注入，测试不碰真 DNS）。 */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolveHost: HostResolver = async (host) =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

/** 异步层：同步层通过后，域名的**全部**解析结果都须是公网地址（防公网域名指向内网）。 */
export async function isSafeDownloadTarget(rawUrl: string, resolveHost: HostResolver = defaultResolveHost): Promise<boolean> {
  if (!isSafeDownloadUrl(rawUrl)) return false;
  const host = hostOf(new URL(rawUrl));
  if (host.includes(':') || IPV4_LITERAL.test(host)) return true; // 字面量已在同步层判过
  try {
    const addrs = await resolveHost(host);
    return addrs.length > 0 && addrs.every((a) => !isPrivateOrReservedAddress(a));
  } catch {
    return false; // 解析失败 → 不下载（fail-closed）
  }
}

// ───────────────────────────────────────── 通道实现 ─────────────────────────────────────────

interface ImageApiData {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/** 通用取图：兼容 b64_json 与 url 两种响应形状；url 先过两层安全检查再下载。 */
async function fetchImageBytes(
  data: ImageApiData,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  label: string,
  resolveHost: HostResolver,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const item = data.data?.[0];
  const b64 = item?.b64_json;
  if (b64 != null && b64.length > 0) return { ok: true, bytes: Buffer.from(b64, 'base64') };
  const url = item?.url;
  if (url == null || url.length === 0) return { ok: false, error: `${label} 未返回图片数据` };
  if (!(await isSafeDownloadTarget(url, resolveHost))) {
    return { ok: false, error: `${label} 返回的图片地址不安全（仅允许 https 公网地址），拒绝下载` };
  }
  const imgResp = await fetchImpl(url, { signal, redirect: 'error' });
  if (!imgResp.ok) return { ok: false, error: `${label} 图片下载失败（${imgResp.status}）` };
  return { ok: true, bytes: Buffer.from(await imgResp.arrayBuffer()) };
}

/** Qwen 通道模型（2026-11-09 指定）。 */
export const QWEN_IMAGE_MODEL = 'qwen-image-3.0-pro';
/** Qwen 通道 endpoint（OpenAI 兼容模式；2026-11-09 提供 base `https://maas.qianwenaiapi.com/compatible-mode/v1`）。 */
export const QWEN_IMAGE_ENDPOINT = 'https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations';

export async function qwenImageGenerate(opts: {
  prompt: string;
  /** 尺寸（2026-11-09 真调实测：兼容模式**认** size，返回 1792×1024 与请求一致）。 */
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  outputDir: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  resolveHost?: HostResolver;
  timeoutMs?: number;
}): Promise<ImageGenerateResult> {
  const key = opts.apiKey ?? resolveProviderKey('dashscope')?.key?.trim() ?? '';
  if (!key) return { ok: false, error: '阿里云百炼 Key 未配置（设置 → 供应商与模型 → 阿里云百炼（Qwen 出图））' };
  const prompt = opts.prompt.trim();
  if (!prompt) return { ok: false, error: 'prompt 必填' };
  const timeout = opts.timeoutMs ?? 120_000; // 生图比对话慢，给足 2 分钟

  const outputPath = join(opts.outputDir, `image-${Date.now()}.png`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    mkdirSync(opts.outputDir, { recursive: true });
    const fetchImpl = opts.fetchImpl ?? fetch;
    const resp = await fetchImpl(QWEN_IMAGE_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // 兼容模式不带 size（用模型默认）；带不认识的参数反而可能 400。
      // 2026-11-09 实测：兼容模式认 `size`（1792x1024 原样返回）⇒ 横版可**直出**，不必再本地裁。
      body: JSON.stringify({ model: QWEN_IMAGE_MODEL, prompt, n: 1, ...(opts.size != null ? { size: opts.size } : {}) }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: redactKeyFragments(`Qwen 生图 API 失败（${resp.status}）：${body.slice(0, 300)}`) };
    }
    const data = (await resp.json()) as ImageApiData;
    const got = await fetchImageBytes(data, fetchImpl, ctrl.signal, 'Qwen 生图 API', opts.resolveHost ?? defaultResolveHost);
    if (!got.ok) return { ok: false, error: got.error };
    writeFileSync(outputPath, got.bytes);
    if (!existsSync(outputPath)) return { ok: false, error: '图片写盘失败' };
    return { ok: true, path: outputPath };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: redactKeyFragments(msg.includes('abort') ? `请求超时（${timeout}ms）` : msg) };
  } finally {
    clearTimeout(timer);
  }
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

  const outputPath = join(opts.outputDir, `image-${Date.now()}.png`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    //  安全审查：目录创建进 try——失败给模型人话错误而非裸异常（含绝对路径）。
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
    const data = (await resp.json()) as ImageApiData;
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
