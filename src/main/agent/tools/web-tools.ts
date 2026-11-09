/**
 * B4-1+B4-2/D-29 · Web 工具＋截图工具——员工可用的网络/屏幕能力。
 *
 * 口径：
 *  - `web_fetch`：HTTP GET 读网页正文（external 类——每次弹卡批准）；
 *  - `screenshot`：全屏截图（external 类——每次弹卡批准）；
 *  两个工具走 permissionGate external 类自动弹卡；不需要手动接线审批。
 *  截图目录按**会话 cwd** 解析（`<会话 cwd>/.aico/screenshots`）——装配期 cwd 在生产是应用进程目录。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { captureScreenshot } from './screenshot-tool.js';
import { sessionCwd } from './session-cwd.js';
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

/** 截图落盘子目录（相对会话 cwd）。 */
export const SCREENSHOT_SUBDIR = join('.aico', 'screenshots');

export async function createScreenshotTool(fallbackCwd: string, deps: { capture?: typeof captureScreenshot } = {}) {
  const capture = deps.capture ?? captureScreenshot;
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'screenshot',
    label: 'Screenshot',
    description:
      '全屏截图（PNG），截图落盘并返回文件路径。走 external 审批（每次弹卡批准）。' +
      '截图可用于视觉验证（给 vision 模型分析）或记录当前状态。',
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const outputDir = join(sessionCwd(ctx, fallbackCwd), SCREENSHOT_SUBDIR);
      mkdirSync(outputDir, { recursive: true });
      const result = capture(outputDir);
      const details: { outcome: string; path: string | null } = result.ok
        ? { outcome: 'ok', path: result.path ?? null }
        : { outcome: 'error', path: null };
      const text = result.ok ? `截图已保存：${result.path}` : `截图失败：${result.error ?? '未知错误'}`;
      return { content: [{ type: 'text' as const, text }], details };
    },
  });
}
