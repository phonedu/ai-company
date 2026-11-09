/**
 * B4-4+B4-6/D-29 · 内容工具——员工可调的图像生成与导出适配器。
 *
 * 口径：
 *  - `image_generate`：spend 类（花钱＋对外；每次弹卡批准，external grant 不放行）；
 *    输出目录宿主固定 `assets/images/`（不收路径参数），返回相对路径供员工填进 artifacts；
 *  - `export_format`：write 类（走门禁路径层：参数名就叫 `path`——`pathArg` 首个检查的键；
 *    源须在项目根/工作目录内），导出文件与源同目录派生，不另收输出路径。
 * 两者都按**会话 cwd**（`sessionCwd(ctx)`）解析——与门禁 `run.cwd` 同源；装配期 cwd 只作兜底。
 */
import { isAbsolute, join, relative, resolve } from 'node:path';

import { exportToFile, type ExportFormat } from './export-format-tool.js';
import { IMAGE_OUTPUT_SUBDIR, imageGenerate } from './image-generate-tool.js';
import { sessionCwd } from './session-cwd.js';

/** 导出结果回给模型的预览长度（全文在导出文件里，不整篇灌进上下文）。 */
const EXPORT_PREVIEW_CHARS = 400;

function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).replace(/\\/g, '/');
}

export async function createImageGenerateTool(fallbackCwd: string, deps: { generate?: typeof imageGenerate } = {}) {
  const generate = deps.generate ?? imageGenerate;
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'image_generate',
    label: 'Image Generate',
    description:
      '调 OpenAI DALL-E 3 生成一张图片（封面/插图），落盘到 assets/images/ 并返回相对路径——' +
      '交付时把该路径填进 submit_work_item 的 artifacts。花钱动作：每次调用都要老板批准；' +
      '先把文案定稿再生成，不要反复试图。',
    parameters: Type.Object({
      prompt: Type.String({ description: '图片描述（主体、风格、构图、配色；英文描述效果更稳）' }),
      size: Type.Optional(
        Type.Union([Type.Literal('1024x1024'), Type.Literal('1792x1024'), Type.Literal('1024x1792')], {
          description: '尺寸：方图 1024x1024（默认）；横版封面 1792x1024；竖版 1024x1792',
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const cwd = sessionCwd(ctx, fallbackCwd);
      const result = await generate({
        prompt: String(params.prompt ?? ''),
        size: params.size,
        outputDir: join(cwd, IMAGE_OUTPUT_SUBDIR),
      });
      const rel = result.ok && result.path ? toRel(cwd, result.path) : null;
      const details: { outcome: string; path: string | null } = { outcome: result.ok ? 'ok' : 'error', path: rel };
      const text = result.ok
        ? `图片已生成：${rel}（交付时把这个路径填进 submit_work_item 的 artifacts）`
        : `图片生成失败：${result.error ?? '未知错误'}`;
      return { content: [{ type: 'text' as const, text }], details };
    },
  });
}

export async function createExportFormatTool(fallbackCwd: string) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'export_format',
    label: 'Export Format',
    description:
      '把 Markdown 成稿转成目标平台格式并导出文件（与源同目录：<名>.wechat.html / <名>.export.md / <名>.plain.txt）。' +
      '不发布：导出后由老板手动贴到平台。wechat_html＝公众号编辑器可粘贴的内联样式 HTML；' +
      'markdown＝通用 MD；plain_text＝去标记纯文本（微博/朋友圈）。',
    parameters: Type.Object({
      path: Type.String({ description: '成稿路径（.md/.markdown/.txt；相对工作目录）' }),
      format: Type.Union([Type.Literal('wechat_html'), Type.Literal('markdown'), Type.Literal('plain_text')], {
        description: '目标格式：wechat_html | markdown | plain_text',
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const cwd = sessionCwd(ctx, fallbackCwd);
      const raw = String(params.path ?? '');
      const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
      const result = exportToFile(abs, params.format as ExportFormat);
      if (!result.ok) {
        const details: { outcome: string; path: string | null } = { outcome: 'error', path: null };
        return { content: [{ type: 'text' as const, text: `导出失败：${result.error}` }], details };
      }
      const rel = toRel(cwd, result.outputPath);
      const preview = result.content.length > EXPORT_PREVIEW_CHARS
        ? `${result.content.slice(0, EXPORT_PREVIEW_CHARS)}…（共 ${result.content.length} 字符，全文见导出文件）`
        : result.content;
      const details: { outcome: string; path: string | null } = { outcome: 'ok', path: rel };
      return {
        content: [{ type: 'text' as const, text: `已导出：${rel}（交付时填进 artifacts）\n预览：\n${preview}` }],
        details,
      };
    },
  });
}
