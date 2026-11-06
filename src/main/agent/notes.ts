/**
 * K1 知识库 · 笔记数据面（纯函数，不依赖 Electron IPC）。
 *
 * 笔记＝Markdown 文件；项目级在 `<项目根>/.aico/notes/`，全局在 `<userData>/notes/`。
 * 本模块提供 CRUD＋搜索＋升级（笔记→文档）＋路径安全，供 IPC 层调用。
 * 不引入数据库——文件即真相。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// ── 类型 ─────────────────────────────────────────

export interface NoteItem {
  /** 文件名（不含 .md） */
  name: string;
  /** note=笔记 / doc=项目文档·文档文件 / artifact=根目录产物 / media=图·视·音 / text=纯文本数据 / file=其他 */
  type: 'note' | 'doc' | 'artifact' | 'media' | 'text' | 'file';
  /** 媒体/附件的扩展名（小写，含点；md 为空） */
  ext?: string;
  /** 媒体/附件字节数（md 未填） */
  size?: number;
  /** 文件绝对路径 */
  path: string;
  /** 行数 */
  lines: number;
  /** 更新时间 */
  updatedAt: number;
  /** 首行摘要（≤80 字符） */
  preview: string;
  /** 搜索用正文（前 8KB；不暴露给 UI） */
  searchText?: string;
  /** 所属项目名（全局笔记为 null） */
  projectName: string | null;
  /** 所属项目 id（全局为 null） */
  projectId: number | null;
}

/** Phase C：正文搜索只取文件前 8KB，大文件不整篇扫。 */
export const SEARCH_TEXT_MAX_CHARS = 8 * 1024;
/** 列表/搜索读取上限（字节）：24KB 足够覆盖 8K 中文字符，任何 md 都不会整读。 */
export const LIST_READ_MAX_BYTES = 24 * 1024;

// D3 老板抽查（2026-11-03）类型重划：媒体只收图/视频/音频；可读文本归 text；
// pdf/office/html 归 doc；其余归 file。md 仍按目录定 note/doc/artifact。
const LIST_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);
const LIST_VIDEO_EXT = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v']);
const LIST_AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const LIST_DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.html', '.htm']);
const LIST_TEXT_EXT = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.less',
  '.py', '.ps1', '.psm1', '.sh', '.bat', '.cmd', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.lua',
]);

/** 非 md 文件的列表类型（D3-3 类型重划）。 */
export function classifyListFile(ext: string): 'media' | 'doc' | 'text' | 'file' {
  const e = ext.toLowerCase();
  if (LIST_IMAGE_EXT.has(e) || LIST_VIDEO_EXT.has(e) || LIST_AUDIO_EXT.has(e)) return 'media';
  if (LIST_DOC_EXT.has(e)) return 'doc';
  if (LIST_TEXT_EXT.has(e)) return 'text';
  return 'file';
}

/** 只读文件前缀（不整文件进内存）。 */
function readPrefix(path: string, maxBytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export interface SearchHit {
  name: string;
  /** 文件绝对路径（列表按 path 对齐；UI 只用来做键，不显示） */
  path: string;
  preview: string;
  type: NoteItem['type'];
  projectId: number | null;
  projectName: string | null;
  /** 命中词数（排序用） */
  score: number;
}

// ── 路径安全 ────────────────────────────────────

/**
 * 文件名安全校验：只允许 [a-zA-Z0-9\\-_\\u4e00-\\u9fff]，不含路径分隔符/点开头。
 * 返回 null＝不安全（调用方应拒绝）。
 */
export function safeNoteName(name: string): string | null {
  if (name.length === 0 || name.length > 128) return null;
  if (name.startsWith('.') || name.startsWith('-')) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (!/^[a-zA-Z0-9\-_\u4e00-\u9fff.]+$/.test(name)) return null;
  return name;
}

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 笔记目录路径 */
export function notesDirFor(opts: { projectDir?: string | null; globalDir: string }): string {
  return opts.projectDir != null ? join(opts.projectDir, '.aico', 'notes') : join(opts.globalDir, 'notes');
}

// ── CRUD ────────────────────────────────────────

export function writeNote(opts: { projectDir?: string | null; globalDir: string; name: string; content: string }): { ok: true; path: string } | { ok: false; error: string } {
  const safe = safeNoteName(opts.name);
  if (safe == null) return { ok: false, error: `文件名不安全：${opts.name}` };
  const dir = notesDirFor(opts);
  ensureDir(dir);
  const path = join(dir, `${safe}.md`);
  writeFileSync(path, opts.content, 'utf8');
  return { ok: true, path };
}

export function readNote(opts: { projectDir?: string | null; globalDir: string; name: string }): { ok: true; content: string; updatedAt: number } | { ok: false; error: string } {
  const safe = safeNoteName(opts.name);
  if (safe == null) return { ok: false, error: `文件名不安全：${opts.name}` };
  const path = join(notesDirFor(opts), `${safe}.md`);
  if (!existsSync(path)) return { ok: false, error: `笔记不存在：${safe}` };
  return { ok: true, content: readFileSync(path, 'utf8'), updatedAt: statSync(path).mtimeMs };
}

export function deleteNote(opts: { projectDir?: string | null; globalDir: string; name: string }): { ok: true } | { ok: false; error: string } {
  const safe = safeNoteName(opts.name);
  if (safe == null) return { ok: false, error: `文件名不安全：${opts.name}` };
  const path = join(notesDirFor(opts), `${safe}.md`);
  if (!existsSync(path)) return { ok: false, error: `笔记不存在：${safe}` };
  rmSync(path);
  return { ok: true };
}

// ── 升级（笔记→文档） ────────────────────────────

export function promoteNote(opts: { projectDir: string; name: string }): { ok: true; newPath: string } | { ok: false; error: string } {
  const safe = safeNoteName(opts.name);
  if (safe == null) return { ok: false, error: `文件名不安全：${opts.name}` };
  const oldPath = join(opts.projectDir, '.aico', 'notes', `${safe}.md`);
  if (!existsSync(oldPath)) return { ok: false, error: `笔记不存在：${safe}` };
  const docsDir = join(opts.projectDir, '.aico', 'docs');
  ensureDir(docsDir);
  const newPath = join(docsDir, `${safe}.md`);
  if (existsSync(newPath)) return { ok: false, error: `目标已有同名文档：${safe}.md` };
  renameSync(oldPath, newPath);
  return { ok: true, newPath };
}

// ── 列表 ────────────────────────────────────────

/**
 * 扫描目录下的常规文件，返回 NoteItem。
 * 2026-11-03（笔记页 Phase A）：不再只扫 .md——图片/视频/音频/HTML/PDF/代码等作为「媒体/附件」
 * 进列表（type=media），只做 stat 不读内容；文件删了下次扫描自然消失（不做缺失行）。
 */
function scanDir(dir: string, type: NoteItem['type'], projectId: number | null, projectName: string | null, opts: { recursive?: boolean } = {}): NoteItem[] {
  if (!existsSync(dir)) return [];
  const out: NoteItem[] = [];
  walk(dir, 0);
  return out;

  // RW-49（2026-11-05 老板点题「能否很快找到」）：docs/ 限深递归——产物常落 docs/reference/、
  // docs/guides/ 等子目录，浅扫会让人在知识页永远找不到。深度 ≤3、跳过隐藏与依赖目录、
  // 单树封顶 400 条（防异常大仓拖垮列表）。
  function walk(dir: string, depth: number): void {
  for (const f of readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    const path = join(dir, f);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        if (opts.recursive === true && depth < 3 && f !== 'node_modules' && f !== '.git') {
          walk(join(dir, f), depth + 1);
        }
        continue;
      }
      const ext = extname(f).toLowerCase();
      const isMd = ext === '.md';
      if (!isMd) {
        out.push({
          name: f,
          type: classifyListFile(ext),
          ext,
          size: stat.size,
          path,
          lines: 0,
          updatedAt: stat.mtimeMs,
          preview: `${ext.replace('.', '').toUpperCase() || 'FILE'} · ${Math.max(1, Math.round(stat.size / 1024))} KB`,
          projectId,
          projectName,
        });
        continue;
      }
      const content = readPrefix(path, LIST_READ_MAX_BYTES);
      const lines = content.split('\n').length;
      const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
      const preview = firstLine.replace(/^#+\s*/, '').slice(0, 80);
      const searchText = content.slice(0, SEARCH_TEXT_MAX_CHARS);
      out.push({ name: f.slice(0, f.length - ext.length), type, ext, path, lines, updatedAt: stat.mtimeMs, preview, projectId, projectName, searchText });
    } catch { /* 读不了就跳过 */ }
  }
  }
  if (out.length >= 400) out.length = 400;
}

/**
 * 列出所有知识项：项目笔记＋项目文档＋任务产物＋全局笔记＋媒体/附件。
 * 项目根只扫浅层常规文件（不递归；跳过隐藏文件/目录）。
 */
export function listNotes(opts: { projects: Array<{ id: number; name: string; rootDir: string }>; globalDir: string }): NoteItem[] {
  const items: NoteItem[] = [];
  for (const p of opts.projects) {
    items.push(...scanDir(join(p.rootDir, '.aico', 'notes'), 'note', p.id, p.name));
    // RW-49：docs 限深递归（产物常落子目录）；项目根与 notes/ 保持浅层。
    items.push(...scanDir(join(p.rootDir, '.aico', 'docs'), 'doc', p.id, p.name, { recursive: true }));
    items.push(...scanDir(p.rootDir, 'artifact', p.id, p.name));
    // RW-49 补（真机 T8b）：员工产物常落项目根 docs/（如 docs/reference/）与中文项目
    // 的「文档/」（如中文项目）——这两个约定目录同样限深递归，否则知识页永远找不到。
    items.push(...scanDir(join(p.rootDir, 'docs'), 'artifact', p.id, p.name, { recursive: true }));
    items.push(...scanDir(join(p.rootDir, '文档'), 'artifact', p.id, p.name, { recursive: true }));
  }
  items.push(...scanDir(join(opts.globalDir, 'notes'), 'note', null, null));
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── 搜索 ────────────────────────────────────────

/**
 * 统一搜索：跨项目＋全局，LIKE 匹配文件名＋内容首行。
 * 与 searchRelated 的词项提取共用逻辑（retrievalTerms），但简化为子串匹配。
 */
export function searchNotes(opts: { query: string; projects: Array<{ id: number; name: string; rootDir: string }>; globalDir: string }): SearchHit[] {
  const query = opts.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const items = listNotes(opts);
  const hits: SearchHit[] = [];
  for (const item of items) {
    let score = 0;
    if (item.name.toLowerCase().includes(query)) score += 2;
    if (item.preview.toLowerCase().includes(query)) score += 1;
    if ((item.searchText ?? '').toLowerCase().includes(query)) score += 1;
    if (score > 0) {
      hits.push({ name: item.name, path: item.path, preview: item.preview, type: item.type, projectId: item.projectId, projectName: item.projectName, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20);
}
