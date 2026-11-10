/**
 * / · WebFetch——HTTP GET 读取网页正文（走 external ask 闸门）。
 *
 * 口径：`fetch` API GET 请求；HTML 提取正文（去 script/style/tag 留文本）；
 * 截断 8KB（与 read_doc 同哲学）；走 permissionGate external 类（每次弹卡批准）。
 */

/** HTML→纯文本（去 script/style/tag，保留换行与实体解码）。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 截断 8KB（头 6KB＋尾 1KB＋显式标记）。 */
export function truncateContent(text: string, maxBytes: number = 8 * 1024): string {
  if (text.length <= maxBytes) return text;
  const head = text.slice(0, 6 * 1024);
  const tail = text.slice(-1024);
  return `${head}\n…【WebFetch 已截断（${text.length}→${maxBytes} 字符）】\n${tail}`;
}

export interface WebFetchResult {
  ok: boolean;
  url: string;
  status?: number;
  text?: string;
  error?: string;
}

/** WebFetch 核心逻辑（纯 async 函数；fetch 可注入测试）。 */
export async function webFetch(url: string, fetchImpl?: typeof fetch, timeoutMs?: number): Promise<WebFetchResult> {
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return { ok: false, url: trimmed, error: 'URL 必须以 http:// 或 https:// 开头' };
  }
  const fetchFn = fetchImpl ?? fetch;
  const timeout = timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetchFn(trimmed, { signal: ctrl.signal, redirect: 'follow' });
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('html')) {
      return { ok: false, url: trimmed, error: `不支持的 content-type：${contentType}（仅支持 text/html/json）` };
    }
    const body = await resp.text();
    const text = contentType.includes('html') ? htmlToText(body) : body;
    return { ok: resp.ok, url: trimmed, status: resp.status, text: truncateContent(text) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, url: trimmed, error: msg.includes('abort') ? `请求超时（${timeout}ms）` : msg };
  } finally {
    clearTimeout(timer);
  }
}
