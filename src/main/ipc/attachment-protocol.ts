/**
 * `aico-file://preview/<短票>` 协议处理器（只读、短票、无路径）。
 *
 * 注册顺序：main 入口在 app ready 前 `protocol.registerSchemesAsPrivileged`，
 * ready 后调用本函数挂 handler。渲染层只拿到短票 URL，拿不到文件路径。
 */
import { protocol } from 'electron';
import { readFileSync } from 'node:fs';

import { resolvePreviewToken } from './attachment-preview.js';

export function registerAicoFileProtocol(): void {
  protocol.handle('aico-file', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (url.hostname !== 'preview') return new Response('Not Found', { status: 404 });
    const token = url.pathname.replace(/^\/+/, '');
    const entry = resolvePreviewToken(token);
    if (!entry) return new Response('Not Found', { status: 404 });
    try {
      const data = readFileSync(entry.path);
      const headers: Record<string, string> = {
        'Content-Type': entry.type || 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      // P2-1（D4 2026-11-03）：HTML 预览禁止任何外部子资源——沙箱挡脚本/同源，
      // CSP 再挡外链图片/样式/字体，避免本地 HTML 把预览变成对外请求。
      if (entry.type.toLowerCase().startsWith('text/html')) {
        headers['Content-Security-Policy'] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
      }
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
