/**
 * B4-1+B4-2/D-29 · Web 工具＋截图工具——员工可用的网络/屏幕能力。
 *
 * 口径：
 *  - `web_fetch`：HTTP GET 读网页正文（external 类——每次弹卡批准）；
 *  - `screenshot`：全屏截图（external 类——每次弹卡批准）；
 *  两个工具走 permissionGate external 类自动弹卡；不需要手动接线审批。
 */
import { mkdirSync } from 'node:fs';

import { captureScreenshot } from './screenshot-tool.js';
import { webFetch } from './web-fetch-tool.js';

export async function createWebFetchTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'HTTP GET 读取网页正文（HTML→纯文本）。走 external 审批（每次弹卡批准）。' +
      'URL 必须以 http:// 或 https:// 开头；超时 15 秒；截断 8KB。',
    parameters: Type.Object({
      url: Type.String({ description: '要读取的网页 URL' }),
    }),
    execute: async (_toolCallId, params) => {
      const result = await webFetch(String(params.url ?? ''));
      const details: { outcome: string; url: string; status: number | null } = { outcome: result.ok ? 'ok' : 'error', url: result.url, status: result.status ?? null };
      const text = result.ok ? result.text ?? '（空）' : `WebFetch 失败：${result.error ?? '未知错误'}`;
      return { content: [{ type: 'text' as const, text }], details };
    },
  });
}

export async function createScreenshotTool(outputDir: string) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  mkdirSync(outputDir, { recursive: true });
  return defineTool({
    name: 'screenshot',
    label: 'Screenshot',
    description:
      '全屏截图（PNG），截图落盘并返回文件路径。走 external 审批（每次弹卡批准）。' +
      '截图可用于视觉验证（给 vision 模型分析）或记录当前状态。',
    parameters: Type.Object({}),
    execute: async () => {
      const result = captureScreenshot(outputDir);
      const details: { outcome: string; path: string | null } = result.ok
        ? { outcome: 'ok', path: result.path ?? null }
        : { outcome: 'error', path: null };
      const text = result.ok ? `截图已保存：${result.path}` : `截图失败：${result.error ?? '未知错误'}`;
      return { content: [{ type: 'text' as const, text }], details };
    },
  });
}
