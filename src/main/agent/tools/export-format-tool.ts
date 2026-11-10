/**
 * / · 导出适配器——Markdown→平台格式转换（公众号 HTML/通用 MD/纯文本）。
 *
 * 口径：多数中文平台无发布 API ⇒ 导出排版后内容＋导出文件，你手动贴到平台。不做 API 自动发布。
 * 导出文件与源**同目录同主名＋平台后缀**（`exportPathFor`）——工具只收一个源路径参数，
 * 门禁路径层只检这一个路径，输出路径由它派生，不另开未受检的写路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export type ExportFormat = 'wechat_html' | 'markdown' | 'plain_text';

const PLATFORM_LABELS: Record<ExportFormat, string> = {
  wechat_html: '公众号 HTML 排版（粘贴到公众号编辑器）',
  markdown: '通用 Markdown（直接粘贴到支持 MD 的平台）',
  plain_text: '纯文本（适合微博/朋友圈等字数受限平台）',
};

const OUTPUT_SUFFIX: Record<ExportFormat, string> = {
  wechat_html: '.wechat.html',
  markdown: '.export.md',
  plain_text: '.plain.txt',
};

/** 可导出的源文件类型（成稿是 Markdown/纯文本；不拿它把任意项目文件另存成 HTML）。 */
const SOURCE_EXTS = new Set(['.md', '.markdown', '.txt']);

export function exportFormatLabels(): Array<{ format: ExportFormat; label: string }> {
  return Object.entries(PLATFORM_LABELS).map(([format, label]) => ({
    format: format as ExportFormat,
    label,
  }));
}

/** HTML 转义（含引号：链接文本/地址进属性值，漏转 `"` 即可注入属性）。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 只放行 http(s)/mailto 链接；其余（javascript: 等）按纯文本输出。 */
function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

/** Markdown→公众号 HTML（内联样式：公众号编辑器不支持外部 CSS）。 */
function mdToWechatHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      out.push(inCode ? '</code></pre>' : '<pre style="background:#f6f6f6;padding:12px;border-radius:4px;overflow-x:auto;"><code style="font-family:monospace;">');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    const h = /^(#{1,6})\s+(.+)/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const sizes = ['28px', '24px', '20px', '18px', '16px', '14px'];
      const size = sizes[level - 1] ?? '16px';
      out.push(`<h${level} style="font-size:${size};font-weight:700;color:#1a1a1a;margin:24px 0 12px;">${escapeHtml(h[2]!)}</h${level}>`);
      continue;
    }
    if (line.trim() === '') { out.push('<br>'); continue; }
    // 链接/图片先在原文上切出来（转义前），地址校验后再分别转义——不在已转义文本上做属性拼接。
    const parts: string[] = [];
    let last = 0;
    for (const m of line.matchAll(/(!?)\[([^\]]+)\]\(([^)]+)\)/g)) {
      parts.push(inline(line.slice(last, m.index)));
      const [, bang, text, href] = m;
      const safe = isSafeHref(href!.trim());
      const src = escapeHtml(href!.trim());
      const label = inline(text!);
      parts.push(
        bang === '!'
          ? safe
            ? `<img src="${src}" alt="${label}" style="max-width:100%;" />`
            : label // 不安全协议的图片 → 只留 alt 文本
          : safe
            ? `<a href="${src}" style="color:#576b95;">${label}</a>`
            : label,
      );
      last = m.index! + m[0].length;
    }
    parts.push(inline(line.slice(last)));
    out.push(`<p style="font-size:15px;line-height:1.8;color:#333;margin:12px 0;">${parts.join('')}</p>`);
  }
  if (inCode) out.push('</code></pre>'); // 未闭合的代码块收尾，不留半截标签
  return out.join('\n');
}

/** 行内：转义后再套粗体（图片/链接已在行级切出）。 */
function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#1a1a1a;">$1</strong>');
}

/** 导出格式转换（主入口）。 */
export function convertFormat(md: string, format: ExportFormat): string {
  switch (format) {
    case 'wechat_html': return mdToWechatHtml(md);
    case 'markdown': return md;
    case 'plain_text': return md.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '');
  }
}

/** 导出文件路径：与源同目录、同主名＋平台后缀。 */
export function exportPathFor(sourcePath: string, format: ExportFormat): string {
  const base = basename(sourcePath, extname(sourcePath));
  return join(dirname(sourcePath), `${base}${OUTPUT_SUFFIX[format]}`);
}

/** 从文件读取 Markdown 并转换（只读，不落盘）。 */
export function exportFromFile(sourcePath: string, format: ExportFormat): { ok: true; content: string } | { ok: false; error: string } {
  try {
    if (!SOURCE_EXTS.has(extname(sourcePath).toLowerCase())) {
      return { ok: false, error: `只导出 Markdown/纯文本成稿（.md/.markdown/.txt）：${basename(sourcePath)}` };
    }
    if (!existsSync(sourcePath)) return { ok: false, error: `文件不存在：${sourcePath}` };
    const md = readFileSync(sourcePath, 'utf8');
    return { ok: true, content: convertFormat(md, format) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 转换并落盘到 `exportPathFor` 派生路径（员工工具 export_format 的执行体）。 */
export function exportToFile(
  sourcePath: string,
  format: ExportFormat,
): { ok: true; content: string; outputPath: string } | { ok: false; error: string } {
  const outputPath = exportPathFor(sourcePath, format);
  //  安全审查 （2026-11-09）：导出目标已存在 → 拒绝（不静默覆盖）。
  // 「导出」语义是新增产物；要重导先删旧文件。write 类工具/bash 本可覆盖项目内文件，
  // 但那是在收了明确写指令时；这里的输出路径是**派生**的，覆盖不能默认。
  if (existsSync(outputPath)) {
    return { ok: false, error: `导出目标已存在（不覆盖）：${outputPath}。要重新导出请先删除旧文件或改源文件名。` };
  }
  const converted = exportFromFile(sourcePath, format);
  if (!converted.ok) return converted;
  try {
    writeFileSync(outputPath, converted.content, 'utf8');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, content: converted.content, outputPath };
}
