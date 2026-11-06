/**
 * RET-1 P3 · 确定性 repo map（零 LLM、零原生依赖）：文件/符号索引 + 小查询。
 *
 * 口径（检索设计口径 §5/§7）：
 *  - 只做**确定性**文本扫描（Rust `.rs`/`Cargo.toml`/Markdown 标题），不引 tree-sitter/图数据库/向量库；
 *  - 输出**小而排过序**的答案，不把整张图塞进上下文（否则又是一次大工具输出）；
 *  - 查询为空时只给文件索引（路径＋条目数）；带 `query` 时按路径/符号匹配，最多 `maxChars`。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface RepoMapEntry {
  path: string;
  line: number;
  kind: string;
  name: string;
}

export interface RepoMap {
  root: string;
  files: number;
  entries: RepoMapEntry[];
  fileList: Array<{ path: string; symbols: number; lines: number }>;
  truncated: boolean;
}

const SKIP_DIRS = new Set(['.git', 'target', 'node_modules', 'out', 'tmp', '.idea', '.vscode', 'dist', 'build']);
const SCAN_EXT = new Set(['.rs', '.toml', '.md']);
const MAX_FILES = 2000;
const MAX_ENTRIES = 8000;
const MAX_ENTRIES_PER_FILE = 120;

/** `AICO_REPO_MAP=on|1|true` 开启 repo_map 工具＋system 提示（A/B 用；默认关）。 */
export function isRepoMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AICO_REPO_MAP ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true';
}

function symbolOf(line: string): { kind: string; name: string } | null {
  const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
  if (fn) return { kind: 'fn', name: fn[1] as string };
  const ty = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
  if (ty) return { kind: ty[1] as string, name: ty[2] as string };
  const impl = /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
  if (impl) return { kind: 'impl', name: impl[1] as string };
  const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
  if (heading) return { kind: `h${(heading[1] as string).length}`, name: (heading[2] as string).trim() };
  return null;
}

/** 扫项目根（跳过 vcs/构建目录），返回文件/符号索引。纯同步、可缓存。 */
export function buildRepoMap(root: string): RepoMap {
  const entries: RepoMapEntry[] = [];
  const fileList: RepoMap['fileList'] = [];
  let files = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (files >= MAX_FILES) {
      truncated = true;
      return;
    }
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list) {
      if (files >= MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(abs);
        continue;
      }
      const dot = item.name.lastIndexOf('.');
      const ext = dot >= 0 ? item.name.slice(dot) : '';
      if (!SCAN_EXT.has(ext)) continue;
      let text: string;
      try {
        const st = statSync(abs);
        if (st.size > 2_000_000) continue; // 超大文件不进图（避免一次性读爆）
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      files += 1;
      const rel = relative(root, abs).split(sep).join('/');
      let count = 0;
      let lineNo = 0;
      for (const line of text.split(String.fromCharCode(10))) {
        lineNo += 1;
        if (count >= MAX_ENTRIES_PER_FILE) {
          truncated = true;
          break;
        }
        const sym = symbolOf(line);
        if (sym == null) continue;
        entries.push({ path: rel, line: lineNo, kind: sym.kind, name: sym.name });
        count += 1;
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }
      fileList.push({ path: rel, symbols: count, lines: lineNo });
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
    }
  };
  walk(root);
  fileList.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, entries, fileList, truncated };
}

export interface RepoMapQuery {
  query?: string;
  pathPrefix?: string;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4000;

/** 查询：空查询给文件索引；有查询按路径/符号匹配并分组（小答案）。 */
export function renderRepoMap(map: RepoMap, input: RepoMapQuery = {}): { text: string; hits: number; truncated: boolean } {
  const maxChars = Math.max(200, Math.min(input.maxChars ?? DEFAULT_MAX_CHARS, 8000));
  const query = (input.query ?? '').trim().toLowerCase();
  const prefix = (input.pathPrefix ?? '').trim().replace(/\\/g, '/');
  const inPrefix = (p: string): boolean => prefix.length === 0 || p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(prefix);

  if (query.length === 0) {
    const lines = ['【repo_map · 文件索引】（需要具体符号时带 query 再查）'];
    for (const f of map.fileList) {
      if (!inPrefix(f.path)) continue;
      lines.push(`${f.path}（${f.symbols} 个符号 / ${f.lines} 行）`);
    }
    let text = lines.join('\n');
    let truncated = map.truncated;
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars - 40)}\n…（文件索引已截断；用 pathPrefix 收窄）`;
      truncated = true;
    }
    return { text, hits: lines.length - 1, truncated };
  }

  const matched = map.entries.filter((e) => {
    if (!inPrefix(e.path)) return false;
    return e.path.toLowerCase().includes(query) || e.name.toLowerCase().includes(query);
  });
  const shown = matched.slice(0, 80);
  const byPath = new Map<string, RepoMapEntry[]>();
  for (const e of shown) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }
  const lines = [`【repo_map · query=${input.query}】匹配 ${matched.length} 条${matched.length > shown.length ? `（显示前 ${shown.length}）` : ''}`];
  for (const [path, list] of byPath) {
    lines.push(path);
    for (const e of list) lines.push(`  ${e.line}: ${e.kind} ${e.name}`);
  }
  let text = lines.join('\n');
  let truncated = map.truncated || matched.length > shown.length;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 40)}\n…（结果已截断；用 pathPrefix/更具体的 query）`;
    truncated = true;
  }
  return { text, hits: matched.length, truncated };
}
