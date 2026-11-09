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
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { exportToFile, type ExportFormat } from './export-format-tool.js';
import { IMAGE_OUTPUT_SUBDIR, imageGenerate, qwenImageGenerate, resolveImageChannel } from './image-generate-tool.js';
import { sessionCwd } from './session-cwd.js';

/** 导出结果回给模型的预览长度（全文在导出文件里，不整篇灌进上下文）。 */
const EXPORT_PREVIEW_CHARS = 400;

function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).replace(/\\/g, '/');
}

export async function createImageGenerateTool(
  fallbackCwd: string,
  deps: {
    generate?: typeof imageGenerate;
    generateQwen?: typeof qwenImageGenerate;
    /** 覆盖通道解析（测试用；缺省按已配置 Key 执行期选：qwen 优先、DALL-E 回落）。 */
    channel?: 'qwen' | 'dalle' | null;
    /** 通道解析的 Key 注入（测试不碰真 secrets；缺省 process.env＋~/.aico/secrets）。 */
    keyOptions?: import('./image-generate-tool.js').ImageChannelKeyOptions;
  } = {},
) {
  const generateDalle = deps.generate ?? imageGenerate;
  const generateQwen = deps.generateQwen ?? qwenImageGenerate;
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'image_generate',
    label: 'Image Generate',
    description:
      '生成一张图片（封面/插图），落盘到 assets/images/ 并返回相对路径——交付时把该路径填进 ' +
      'submit_work_item 的 artifacts。走已配置的出图供应商（阿里云百炼 Qwen 优先，OpenAI DALL-E 回落）。' +
      '花钱动作：每次调用都要老板批准；先把文案定稿再生成，不要反复试图。',
    parameters: Type.Object({
      prompt: Type.String({ description: '图片描述（主体、风格、构图、配色；中英文皆可）' }),
      size: Type.Optional(
        Type.Union([Type.Literal('1024x1024'), Type.Literal('1792x1024'), Type.Literal('1024x1792')], {
          description: '尺寸（Qwen 通道用模型默认，此参数仅对 OpenAI DALL-E 生效）',
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const cwd = sessionCwd(ctx, fallbackCwd);
      const channel = deps.channel ?? resolveImageChannel(deps.keyOptions ?? {});
      if (channel == null) {
        const details: { outcome: string; path: string | null } = { outcome: 'error', path: null };
        return {
          content: [{ type: 'text' as const, text: '图片生成失败：出图 Key 未配置（设置 → 供应商与模型 → 阿里云百炼（Qwen 出图）或 OpenAI）' }],
          details,
        };
      }
      const result =
        channel === 'qwen'
          ? await generateQwen({ prompt: String(params.prompt ?? ''), outputDir: join(cwd, IMAGE_OUTPUT_SUBDIR) })
          : await generateDalle({
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
      // B4b 安全审查 F4（2026-11-09）：符号链接/junction 解析——项目内链接指向项目外/敏感文件时拒。
      // 门禁路径层是词面判定（看 `path` 原文），链接绕过只能在工具层堵（与 read-doc-tool 同款）。
      // 同时补敏感目标检查（gate 的 SENSITIVE 词面只看参数原文，看不到链接指向的真身）。
      let target = abs;
      if (existsSync(abs)) {
        try {
          target = realpathSync(abs);
        } catch {
          /* 解析失败保持词法路径 */
        }
      }
      const rel = relative(cwd, target);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        const details: { outcome: string; path: string | null } = { outcome: 'error', path: null };
        return {
          content: [{ type: 'text' as const, text: '导出被拒：路径解析后越出项目目录（可能经过符号链接/junction）。' }],
          details,
        };
      }
      const low = target.toLowerCase().replace(/\\/g, '/');
      if (low.includes('.aico/secrets') || low.includes('id_rsa') || low.includes('.env')) {
        const details: { outcome: string; path: string | null } = { outcome: 'error', path: null };
        return {
          content: [{ type: 'text' as const, text: '导出被拒：敏感文件（密钥/环境配置）不导出。' }],
          details,
        };
      }
      const result = exportToFile(target, params.format as ExportFormat);
      if (!result.ok) {
        const details: { outcome: string; path: string | null } = { outcome: 'error', path: null };
        return { content: [{ type: 'text' as const, text: `导出失败：${result.error}` }], details };
      }
      const outRel = toRel(cwd, result.outputPath);
      const preview = result.content.length > EXPORT_PREVIEW_CHARS
        ? `${result.content.slice(0, EXPORT_PREVIEW_CHARS)}…（共 ${result.content.length} 字符，全文见导出文件）`
        : result.content;
      const details: { outcome: string; path: string | null } = { outcome: 'ok', path: outRel };
      return {
        content: [{ type: 'text' as const, text: `已导出：${outRel}（交付时填进 artifacts）\n预览：\n${preview}` }],
        details,
      };
    },
  });
}
