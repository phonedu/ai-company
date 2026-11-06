/**
 * GAP7 · 技能安装/解析（M3-N-3）。
 *
 * 口径（EMPLOYEES §4）：
 *  - 技能＝一个目录里的 `SKILL.md`（Agent Skills 便携形态）；frontmatter 至少 name/description；
 *  - **安装＝复制**到软件数据目录（`<userData>/skills/<kind>/<name>`），不引用用户原目录
 *    （原目录删了技能仍可用；更新走重新安装）；
 *  - 本地安装：从文件夹（可含子目录多个 SKILL.md）；URL 安装：直接 `.md` 或 Git 仓库（浅克隆）；
 *  - 内置技能由 `builtin-skills.ts` 写同一目录结构，**不可删**（可停用）；
 *  - 不扫描全盘：只装老板显式选的目录/URL；坏 frontmatter/重名/读不到 → 显式错误，不编内容。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { getSkillByName, upsertSkill, type SkillRow } from '../db/skills.js';
import type { SqliteDb } from '../db/open.js';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_MD_MAX_BYTES = 2 * 1024 * 1024;

export interface ParsedSkill {
  name: string;
  description: string;
  /** 去掉 frontmatter 的正文（全量）。 */
  body: string;
  /** 原始全文（装盘用）。 */
  content: string;
}

/** 极简 frontmatter 解析（只取 name/description；不引 YAML 依赖，坏输入显式拒）。 */
export function parseSkillMarkdown(content: string): ParsedSkill {
  const text = content.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('缺少 frontmatter（首行 --- … ---）');
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = (kv[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1] as string] = value;
  }
  const name = (meta.name ?? '').trim();
  const description = (meta.description ?? '').trim();
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
    throw new Error(`name 非法：${JSON.stringify(name)}（小写字母/数字/连字符，≤${SKILL_NAME_MAX}）`);
  }
  if (description.length === 0) throw new Error('description 不能为空（模型按它决定何时加载）');
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new Error(`description 超长（${description.length} > ${SKILL_DESCRIPTION_MAX}）`);
  }
  return { name, description, body: (m[2] ?? '').trim(), content: text };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.aico', '__pycache__', '.venv']);

function isSkillDir(dir: string): boolean {
  const p = join(dir, 'SKILL.md');
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 递归找技能目录（含 root 自身；≤4 层；跳过依赖/产物/隐藏大目录；不跟符号链接）。 */
export function collectSkillDirs(root: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  if (isSkillDir(root)) out.push(resolve(root));
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    out.push(...collectSkillDirs(join(root, entry.name), depth + 1));
  }
  return out;
}

export interface InstallResult {
  installed: SkillRow[];
  /** 逐目录错误（部分成功时仍返回已装列表；全部失败时 installed=[]）。 */
  errors: string[];
}

function kindOfSource(source: string): 'builtin' | 'url' | 'local' {
  if (source === 'builtin') return 'builtin';
  if (source.startsWith('url:')) return 'url';
  return 'local';
}

/** 目标目录清理：Windows 旧 `.git` 只读对象可能让 rmSync 失败；移到 trash 后继续，不阻断安装。 */
function clearTarget(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    const trash = `${dir}.trash-${Date.now()}`;
    try {
      renameSync(dir, trash);
      console.warn(`[skills] 旧目标目录移到 ${trash}（清理失败不影响安装）：${error instanceof Error ? error.message : String(error)}`);
    } catch {
      throw error;
    }
  }
}

function installOne(input: {
  db: SqliteDb;
  skill: ParsedSkill;
  sourceDir: string;
  installRoot: string;
  source: string;
  version: string | null;
  now: number;
}): SkillRow {
  const existing = getSkillByName(input.db, input.skill.name);
  if (existing?.source === 'builtin') {
    throw new Error(`与内置技能重名：${input.skill.name}（内置不可覆盖）`);
  }
  const kind = kindOfSource(input.source);
  const targetDir = join(input.installRoot, kind, input.skill.name);
  const same = resolve(input.sourceDir).toLowerCase() === resolve(targetDir).toLowerCase();
  if (!same) {
    mkdirSync(join(input.installRoot, kind), { recursive: true });
    clearTarget(targetDir);
    cpSync(input.sourceDir, targetDir, {
      recursive: true,
      force: true,
      // `.git` 不是技能内容；复制进去还会在 Windows 留下只读对象，导致下次清理 EPERM。
      filter: (src) => basename(src) !== '.git',
    });
  }
  const target = join(targetDir, 'SKILL.md');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, input.skill.content, 'utf8');
  return upsertSkill(input.db, {
    name: input.skill.name,
    description: input.skill.description,
    source: input.source,
    path: target,
    version: input.version,
    enabled: existing ? existing.enabled === 1 : true,
    now: input.now,
  });
}

/** 从本地目录安装（一个或多个 SKILL.md）。 */
export function installSkillsFromDirectory(input: {
  db: SqliteDb;
  sourceDir: string;
  installRoot: string;
  source?: string;
  version?: string | null;
  now?: number;
}): InstallResult {
  if (!existsSync(input.sourceDir) || !statSync(input.sourceDir).isDirectory()) {
    throw new Error(`目录不存在或不是文件夹：${input.sourceDir}`);
  }
  const dirs = collectSkillDirs(input.sourceDir);
  if (dirs.length === 0) throw new Error('目录里没有 SKILL.md（技能必须是一个含 SKILL.md 的文件夹）');
  const installed: SkillRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    try {
      const content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      if (Buffer.byteLength(content, 'utf8') > SKILL_MD_MAX_BYTES) throw new Error('SKILL.md 超过 2 MiB');
      const skill = parseSkillMarkdown(content);
      if (seen.has(skill.name)) throw new Error(`同一批里重名：${skill.name}`);
      seen.add(skill.name);
      installed.push(
        installOne({
          db: input.db,
          skill,
          sourceDir: dir,
          installRoot: input.installRoot,
          source: input.source ?? 'local',
          version: input.version ?? null,
          now: input.now ?? Date.now(),
        }),
      );
    } catch (error) {
      errors.push(`${basename(dir)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (installed.length === 0) throw new Error(`没有可安装的技能：${errors.join('；')}`);
  return { installed, errors };
}

function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL 非法');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支持 http(s) URL');
  if (url.username || url.password) throw new Error('URL 不得包含凭据');
  return url;
}

async function fetchSkillMarkdown(url: URL): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > SKILL_MD_MAX_BYTES) throw new Error('SKILL.md 超过 2 MiB');
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > SKILL_MD_MAX_BYTES) throw new Error('SKILL.md 超过 2 MiB');
  return text;
}

/**
 * 从 URL 安装：
 *  - 直接以 `.md` 结尾（或 raw.githubusercontent.com）→ 当单个 SKILL.md 下载；
 *  - 其他 http(s) URL → `git clone --depth 1` 浅克隆，收集其中全部 SKILL.md。
 * 只允许 http(s)，不把 URL 当命令行注入（execFile 参数数组）。
 */
/** Windows 上 `.git` 只读对象可能让 rmSync 抛 EPERM；清理失败不得把已成功的安装判失败。 */
function cleanupTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`[skills] 临时目录清理失败（不影响安装）：${dir}：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function installSkillsFromUrl(input: {
  db: SqliteDb;
  url: string;
  installRoot: string;
  now?: number;
}): Promise<InstallResult> {
  const url = assertHttpUrl(input.url.trim());
  const source = `url:${url.toString()}`;
  if (/\.md$/i.test(url.pathname) || url.hostname === 'raw.githubusercontent.com') {
    const content = await fetchSkillMarkdown(url);
    const skill = parseSkillMarkdown(content);
    const temp = mkdtempSync(join(tmpdir(), 'aico-skill-md-'));
    try {
      const row = installOne({
        db: input.db,
        skill,
        sourceDir: temp,
        installRoot: input.installRoot,
        source,
        version: null,
        now: input.now ?? Date.now(),
      });
      return { installed: [row], errors: [] };
    } finally {
      cleanupTemp(temp);
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'aico-skill-git-'));
  try {
    try {
      execFileSync('git', ['clone', '--depth', '1', '--', url.toString(), tmp], {
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const detail = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(`git clone 失败：${String(detail ?? (error instanceof Error ? error.message : error)).slice(0, 500)}`);
    }
    let version: string | null = null;
    try {
      version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim() || null;
    } catch {
      version = null;
    }
    return installSkillsFromDirectory({
      db: input.db,
      sourceDir: tmp,
      installRoot: input.installRoot,
      source,
      version,
      now: input.now,
    });
  } finally {
    cleanupTemp(tmp);
  }
}
