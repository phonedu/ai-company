/**
 * B3-8（57 P1-10；D-31）· 只读 `read_doc` 工具＋文档索引层。
 *
 * 口径：员工/幕僚长可读**项目根内**的 .md/.txt（相对路径解析；穿越/绝对路径/白名单外
 * 扩展名一律拒）；单文件 8KB 截断（头 6KB＋尾 1KB＋显式标记——与 bash 输出裁剪同哲学，
 * 「read 的文件内容一律不遮」仅指 read 工具；read_doc 面向文档，遵循回读纪律）。
 * 索引层：根级 *.md/*.txt ＋ `.aico/docs` 树（2 层）成清单进上下文；无文档不注入空段。
 * 纯白名单实现（无 IO 的路径判定可单测；读取在工具 execute 内）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';


/** 白名单扩展名（只读文档类）。 */
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);

/** 单文件读取上限（字节；超出截断头 6KB＋尾 1KB）。 */
const READ_DOC_MAX_BYTES = 8 * 1024;

/**
 * 路径判定（纯函数）：相对项目根解析；穿越/绝对/白名单外扩展名 → null。
 * 返回**绝对路径**（工具层再读）。
 */
export function extractReadDocPath(rawPath: string, projectRoot: string): string | null {
  const raw = (rawPath ?? '').trim();
  if (raw.length === 0) return null;
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) return null;
  const abs = resolve(projectRoot, raw);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // 穿越（解析后出根）
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
  if (!abs.includes('.') || !DOC_EXTENSIONS.has(ext)) return null;
  return abs;
}

/** 读取（截断口径）；不存在/读取失败 → null（工具层明说）。 */
function readDocFile(abs: string): string | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const buf = readFileSync(abs);
    if (buf.length <= READ_DOC_MAX_BYTES) return buf.toString('utf8');
    const head = buf.subarray(0, 6 * 1024).toString('utf8');
    const tail = buf.subarray(buf.length - 1024).toString('utf8');
    return `${head}\n…【read_doc 已截断（${buf.length}→${READ_DOC_MAX_BYTES} 字节）；完整内容用 read 工具按需读】\n${tail}`;
  } catch {
    return null;
  }
}

/** 幕僚长/员工通用的 `read_doc` 工具工厂（`projectRoot` 由装配层按项目解析注入）。 */
export async function createReadDocTool(projectRoot: string) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'read_doc',
    label: 'Read Doc',
    description:
      '只读项目文档：相对路径（项目根内 .md/.txt），如 AGENTS.md / .aico/docs/api.md。' +
      '索引见【项目文档】分节；穿越/绝对路径/白名单外扩展名会被拒绝。单文件超 8KB 截断。',
    parameters: Type.Object({
      path: Type.String({ description: '文档相对路径（项目根内；.md/.txt）' }),
    }),
    async execute(_toolCallId, params) {
      const abs = extractReadDocPath(String(params.path ?? ''), projectRoot);
      if (abs == null) {
        return {
          content: [
            {
              type: 'text',
              text: `read_doc 被拒：${String(params.path ?? '')} 不在白名单（项目根内 .md/.txt 相对路径）。`,
            },
          ],
          details: { outcome: 'denied', path: '' },
        };
      }
      const text = readDocFile(abs);
      if (text == null) {
        return {
          content: [{ type: 'text', text: `文档不存在：${String(params.path ?? '')}（用【项目文档】索引核对路径）。` }],
          details: { outcome: 'not_found', path: '' },
        };
      }
      return { content: [{ type: 'text', text }], details: { outcome: 'ok', path: String(params.path) } };
    },
  });
}

/** 索引收集（2 层：根级白名单文件＋.aico/docs 树）；无 → 空（不注入空段）。 */
export function docsIndexLayer(projectRoot: string): string {
  const lines: string[] = [];
  const push = (rel: string): void => {
    lines.push(`- ${rel}`);
  };
  try {
    if (existsSync(projectRoot)) {
      for (const name of readdirSorted(projectRoot)) {
        if (DOC_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()) && name.includes('.')) push(name);
      }
      const aicoDocs = join(projectRoot, '.aico', 'docs');
      if (existsSync(aicoDocs)) {
        for (const name of readdirSorted(aicoDocs)) {
          const p = join(aicoDocs, name);
          try {
            if (statSync(p).isFile()) push(`.aico/docs/${name}`);
          } catch {
            /* 忽略不可 stat 项 */
          }
        }
      }
    }
  } catch {
    return '';
  }
  if (lines.length === 0) return '';
  return ['[项目文档]（只读；用 read_doc(相对路径) 读取全文）', ...lines].join('\n');
}

function readdirSorted(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a: string, b: string) => a.localeCompare(b));
  } catch {
    return [];
  }
}


