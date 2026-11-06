/**
 * M3-DOC-3 · 文档树 IO 共用件（检查器与一键整理同源）。
 *
 * 口径：只读遍历项目内 `<root>/.aico/docs`；跳过依赖/产物目录与符号链接；上限 2000 文件。
 * 不跟随符号链接（防环/防越界）；读失败/超大文件返回 `null`，由调用方如实处理。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 相对文档根的文件列表（`/` 分隔）；超上限 ⇒ `truncated`。 */
export function walkDocsTree(rootAbs: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (dirAbs: string, prefix: string): void => {
    if (truncated) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // 读不到就当空（只读检查；不让一个坏目录把整次检查弄炸）
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue; // 防环/防越出
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  visit(rootAbs, '');
  return { files, truncated };
}

/** 读一个文档（> 2 MiB 或读失败 ⇒ `null`，由调用方按"读不到"处理——不抛）。 */
export function readDocText(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
