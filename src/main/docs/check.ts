/**
 * 文档管理最小版（§7 序 4）· **检查器**（纯逻辑）——判据**移植自** `test/docs-gate.test.ts`，
 * 去掉仓库特有豁免、改为 **policy 驱动**（`plan-doc-and-cost-product.md` §A.2/§A.3）。
 *
 * 产品口径（为什么是这几条）：用户的项目会重演我们踩过的坑（文档散成一摊、同一口径多处写、越写越乱）。
 * 本检查器让"乱"**在产生当天被看见**：入口在不在 · 头注三行有没有（状态/规范的家/关闭时处置）·
 * 区索引覆盖没覆盖 · 相对引用有没有悬空 · 目录链接指向的目录在不在 · 体量有没有超线 · （可选）命名合不合语法。
 *
 * **纯函数**：IO 全部注入（`DocsIo`）——单测用内存树，生产用 fs 实现（在 `ipc.ts` 的 handler 里）。
 * **只读**：本模块不写任何文件、不改文档（"整理"是后续件，且要要求）。
 * **边界**：不替用户决定文档体系（只报事实）；不做渲染器/编辑器；不做跨仓（一个项目一棵文档树）。
 */

export type DocIssueKind = 'entry' | 'header' | 'index' | 'ref' | 'dirlink' | 'size' | 'naming';

export interface DocIssue {
  kind: DocIssueKind;
  /** 相对文档根的路径（报告用；绝对路径不上屏）。 */
  path: string;
  /** 人话（直接可读，给老板看的）。 */
  message: string;
}

export interface DocsPolicy {
  /** 必须存在的入口文件（相对文档根）与其必要锚点（正则）。 */
  entryDocs: Array<{ path: string; anchors: RegExp[] }>;
  /** 头注三行要求生效的前缀（相对文档根）；空 ⇒ 全树生效。 */
  headerZones: string[];
  /** 体量上限（行）与豁免（相对文档根 → 上限）。 */
  sizeLimit: number;
  sizeExemptions: Record<string, number>;
  /** 命名语法（对 basename）；`null` ⇒ 本策略不查命名（等模板落地后再开）。 */
  namingGrammar: RegExp | null;
  /** 命名豁免（相对路径前缀或 basename）。 */
  namingExempt: string[];
  /** 归档区前缀：其内文件**不进**引用/目录链接检查，也不计入「活文档」数。 */
  archiveZones: string[];
  /** 单次最多报多少个 issue（防爆量；超出标 `truncated`）。 */
  maxIssues: number;
}

/** 默认产品策略（：只查"通用文档纪律"；骨架模板由的 `template.ts` 提供）。 */
export function defaultDocsPolicy(): DocsPolicy {
  return {
    entryDocs: [{ path: 'README.md', anchors: [/\S/] }],
    headerZones: [],
    sizeLimit: 600,
    sizeExemptions: {},
    namingGrammar: null,
    namingExempt: [],
    archiveZones: ['history/'],
    maxIssues: 50,
  };
}

export interface DocCounts {
  /** 活文档（`*.md`，不含归档区）。 */
  live: number;
  /** 归档（`*.md`，归档区内）。 */
  archive: number;
  /** 悬空（引用 ＋ 目录链接）。 */
  dangling: number;
  /** 超线（体量）。 */
  oversized: number;
  /** 报告出的 issue 总数（截断前）。 */
  issues: number;
}

export interface DocsCheckResult {
  issues: DocIssue[];
  counts: DocCounts;
  /** issue 超出 `maxIssues` 被截断（如实标注，不静默）。 */
  truncated: boolean;
}

/** 注入 IO（纯函数边界）：`listFiles` 返回**相对文档根**的全部文件（换 `/` 分隔）；`read` 读文本；`exists` 判存在。 */
export interface DocsIo {
  listFiles(): string[];
  read(path: string): string | null;
  exists(path: string): boolean;
}

const HEADER_RE = /\*\*头注\*\*.*状态：[\s\S]{0,400}?规范的家：[\s\S]{0,400}?关闭时处置：/;
const MD_LINK_RE = /\]\(((?:\.{1,2}\/)?[^\s)#|<>]+?)\)/g;

/** 相对路径归一（相对**文档根**）：`./a/b.md`、`../x.md`、`a/b.md`；`..` 越出根 ⇒ `null`（越界不计悬空，报 `ref`）。 */
export function normalizeDocRef(refPath: string, fromFile: string): string | null {
  let p = refPath.replace(/\\/g, '/').trim();
  if (p.length === 0 || p.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return null; // 锚点/外链不算
  const fromDir = fromFile.split('/').slice(0, -1);
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('../')) {
    if (fromDir.length === 0) return null; // 越出文档根
    fromDir.pop();
    p = p.slice(3);
  }
  const joined = [...fromDir, p].join('/');
  return joined.length > 0 ? joined : null;
}

function inZone(path: string, zones: readonly string[]): boolean {
  return zones.some((z) => path.startsWith(z));
}

/** 跑一次检查（纯函数；不抛——IO 异常由调用方兜底）。 */
export function checkDocs(policy: DocsPolicy, io: DocsIo): DocsCheckResult {
  const issues: DocIssue[] = [];
  const push = (kind: DocIssueKind, path: string, message: string): void => {
    issues.push({ kind, path, message });
  };
  const files = io.listFiles().map((f) => f.replace(/\\/g, '/'));
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const live = mdFiles.filter((f) => !inZone(f, policy.archiveZones));

  // ① 入口在场 ＋ 锚点
  for (const entry of policy.entryDocs) {
    if (!files.includes(entry.path)) {
      push('entry', entry.path, `缺入口文档：${entry.path}`);
      continue;
    }
    const text = io.read(entry.path) ?? '';
    for (const anchor of entry.anchors) {
      if (!anchor.test(text)) push('entry', entry.path, `入口缺少必要锚点：${anchor.source}`);
    }
  }

  // ② 头注三行（README 免检，与仓库门同口径）
  for (const f of live) {
    if (f.endsWith('README.md')) continue;
    if (policy.headerZones.length > 0 && !inZone(f, policy.headerZones)) continue;
    const text = io.read(f) ?? '';
    if (!HEADER_RE.test(text)) push('header', f, '缺头注三行（状态 / 规范的家 / 关闭时处置）');
  }

  // ③ 区索引覆盖：每个含 ≥2 个 md 的目录必须有 README.md，且逐个点名（通配 `前缀-*` 也算）
  const byDir = new Map<string, string[]>();
  for (const f of live) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }
  for (const [dir, list] of byDir) {
    if (list.length < 2) continue;
    const indexPath = dir.length > 0 ? `${dir}/README.md` : 'README.md';
    if (!files.includes(indexPath)) {
      push('index', indexPath, `缺区索引：${dir || '根'} 有 ${list.length} 份文档但没有 README.md`);
      continue;
    }
    const readme = io.read(indexPath) ?? '';
    for (const f of list) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      if (base === 'README.md') continue;
      const glob = base.replace(/[^\\/\w\u4e00-\u9fa5-]+/g, '*');
      const globRe = new RegExp(glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^\\s`)\\]]*'));
      if (!readme.includes(base) && !globRe.test(readme)) {
        push('index', indexPath, `未索引：${f}（在本区 README.md 索引里点名或写 \`${glob}\`）`);
      }
    }
  }

  // ④ 引用悬空（含目录链接；归档区不进）
  const seen = new Set<string>();
  for (const f of live) {
    const text = io.read(f) ?? '';
    for (const m of text.matchAll(MD_LINK_RE)) {
      const raw = m[1] as string;
      if (raw.includes('*')) continue;
      const target = normalizeDocRef(raw, f);
      if (target === null) continue;
      const isDir = raw.endsWith('/');
      const probe = isDir ? target.replace(/\/$/, '') : target;
      const key = `${f}\u0000${probe}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 两种写法兼容（防误报）：markdown 标准＝相对本文件；多数文档库的既有习惯＝**文档根相对**。
      // 先按本文件解析，查不到再按文档根解析；两者都不在 → 才报悬空。
      const bare = raw.replace(/\/$/, '').replace(/^\.\//, '');
      if (!io.exists(probe) && !io.exists(bare)) {
        push(isDir ? 'dirlink' : 'ref', f, `${isDir ? '目录链接悬空' : '悬空引用'} ${raw}`);
      }
    }
  }

  // ⑤ 体量超线
  for (const f of live) {
    const limit = policy.sizeExemptions[f] ?? policy.sizeLimit;
    const text = io.read(f);
    if (text === null) continue;
    const lines = text.split('\n').length;
    if (lines > limit) push('size', f, `超线：${lines} 行 > ${limit}`);
  }

  // ⑥ 命名（策略开了才查）
  if (policy.namingGrammar) {
    for (const f of live) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      if (base === 'README.md' || policy.namingExempt.some((x) => f.startsWith(x) || base === x)) continue;
      if (!policy.namingGrammar.test(base)) push('naming', f, `命名不合语法：${base}`);
    }
  }

  const counts: DocCounts = {
    live: live.length,
    archive: mdFiles.length - live.length,
    dangling: issues.filter((i) => i.kind === 'ref' || i.kind === 'dirlink').length,
    oversized: issues.filter((i) => i.kind === 'size').length,
    issues: issues.length,
  };
  const truncated = issues.length > policy.maxIssues;
  return { issues: issues.slice(0, policy.maxIssues), counts, truncated };
}
