/**
 * M3-DOC-3 · 一键整理（只补区索引，预览先行、失败回滚）。
 *
 * 范围（保守）：
 *  - 只处理 `<root>/.aico/docs` 下**含 ≥2 个 md 的子目录**；根目录不代建（入口由模板/用户负责）；
 *  - 只**追加**缺失文件名到该目录 `README.md`（已有内容一字不改；缺 README 才新建一份索引）；
 *  - 不删除、不重命名、不改正文；归档区（`history/`）不碰。
 *
 * 安全：路径只由本模块生成；apply 前复核 before 内容（防预览后用户改文件）、拒绝符号链接、
 * 越界拒绝；任一写入失败 → 已写文件按备份回滚（新建的删除），并如实回报是否回滚成功。
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { defaultDocsPolicy } from './check.js';

export const DOCS_INDEX_MARKER = '## 索引补全（ai-company 整理）';

export interface DocsIndexChange {
  /** 相对文档根的 README 路径（如 `guide/README.md`）。 */
  path: string;
  /** 预览时读到原文；`null`＝文件不存在（将新建）。 */
  before: string | null;
  /** 应用后的完整内容。 */
  after: string;
  /** 本次补进索引的文件名（basename）。 */
  added: string[];
}

/**
 * 计算索引补全计划（纯函数）。
 * `files` 为相对文档根的全量文件；`read` 读文本（不存在/读失败 ⇒ null）。
 */
export function buildDocsIndexPlan(
  files: readonly string[],
  read: (path: string) => string | null,
): DocsIndexChange[] {
  const archiveZones = defaultDocsPolicy().archiveZones;
  const byDir = new Map<string, string[]>();
  for (const raw of files) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.md')) continue;
    if (archiveZones.some((z) => f.startsWith(z))) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    if (dir.length === 0) continue; // 根 README 不在本工具代建范围（检查器会报 entry）
    const list = byDir.get(dir) ?? [];
    list.push(f.slice(f.lastIndexOf('/') + 1));
    byDir.set(dir, list);
  }

  const changes: DocsIndexChange[] = [];
  for (const [dir, names] of byDir) {
    // 只有含 ≥2 个 md 的目录才需要区索引（与检查器同口径；README 计入总数）。
    if (names.length < 2) continue;
    const entries = names.filter((name) => name !== 'README.md').sort();
    if (entries.length === 0) continue;
    const indexPath = `${dir}/README.md`;
    const before = read(indexPath);
    const missing = entries.filter((name) => before === null || !before.includes(name));
    if (missing.length === 0) continue;
    const list = missing.map((name) => `- \`${name}\``).join('\n');
    let after: string;
    if (before === null) {
      after = `# ${dir} 目录\n\n> 由 ai-company 整理生成；可改可删。\n\n${DOCS_INDEX_MARKER}\n\n${list}\n`;
    } else {
      const base = before.endsWith('\n') ? before : `${before}\n`;
      const marker = before.includes(DOCS_INDEX_MARKER) ? '' : `\n${DOCS_INDEX_MARKER}\n`;
      after = `${base}${marker}\n${list}\n`;
    }
    changes.push({ path: indexPath, before, after, added: missing });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** 预览令牌：项目 + 完整 changes 的哈希；apply 前重算，防“预览后文件变了仍照写”。 */
export function docsOrganizeToken(projectId: number, changes: readonly DocsIndexChange[]): string {
  return createHash('sha256')
    .update(`${projectId}\u0000${JSON.stringify(changes.map((c) => ({ path: c.path, before: c.before, after: c.after })))}`)
    .digest('hex');
}

export interface OrganizeIo {
  /** 存在性与是否符号链接（不跟随）。 */
  stat(abs: string): { exists: boolean; symlink: boolean };
  read(abs: string): string | null;
  write(abs: string, content: string): void;
  remove(abs: string): void;
}

export type ApplyOrganizeResult =
  | { ok: true; applied: string[] }
  | { ok: false; code: 'unsafe' | 'stale' | 'write_failed'; message: string; rolledBack: boolean; applied: string[] };

/**
 * 应用计划（IO 注入，便于单测回滚）。
 * 先全量校验（越界/符号链接/before 一致）再写；写失败按备份逆序回滚。
 */
export function applyDocsIndexChanges(
  docRootAbs: string,
  changes: readonly DocsIndexChange[],
  io: OrganizeIo,
): ApplyOrganizeResult {
  const root = resolve(docRootAbs);
  const targets = changes.map((change) => ({
    change,
    abs: resolve(join(root, ...change.path.split('/'))),
  }));
  for (const target of targets) {
    if (target.abs !== root && !target.abs.startsWith(`${root}${sep}`)) {
      return { ok: false, code: 'unsafe', message: `路径越界：${target.change.path}`, rolledBack: true, applied: [] };
    }
    const stat = io.stat(target.abs);
    if (stat.symlink) {
      return { ok: false, code: 'unsafe', message: `拒绝符号链接：${target.change.path}`, rolledBack: true, applied: [] };
    }
    const current = io.read(target.abs);
    if (target.change.before === null) {
      if (stat.exists) {
        return { ok: false, code: 'stale', message: `预览后文件已出现：${target.change.path}`, rolledBack: true, applied: [] };
      }
    } else if (!stat.exists || current !== target.change.before) {
      return { ok: false, code: 'stale', message: `预览后文件已变化：${target.change.path}`, rolledBack: true, applied: [] };
    }
  }

  const applied: string[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const { change, abs } = targets[i] as { change: DocsIndexChange; abs: string };
    try {
      io.write(abs, change.after);
      applied.push(change.path);
    } catch (error) {
      let rolledBack = true;
      for (const backup of targets.slice(0, i + 1).reverse()) {
        try {
          if (backup.change.before === null) io.remove(backup.abs);
          else io.write(backup.abs, backup.change.before);
        } catch {
          rolledBack = false;
        }
      }
      return {
        ok: false,
        code: 'write_failed',
        message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        rolledBack,
        applied,
      };
    }
  }
  return { ok: true, applied };
}

/** 生产 IO（真文件系统；不跟随符号链接的检查在 apply 内做）。 */
export function createDocsOrganizeIo(): OrganizeIo {
  return {
    stat(abs) {
      try {
        const stat = lstatSync(abs);
        return { exists: true, symlink: stat.isSymbolicLink() };
      } catch {
        return { exists: false, symlink: false };
      }
    },
    read(abs) {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
    write(abs, content) {
      writeFileSync(abs, content, 'utf8');
    },
    remove(abs) {
      rmSync(abs, { force: true });
    },
  };
}
