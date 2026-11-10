/**
 * B3-7/D-31⑤ · 交付出口——git push P0 最小形态＋产物导出（md/html）。
 *
 * push 口径（research-git-remote-backup §2.3 P0）：识别现有 remote；显式〔推送〕按钮触发；
 * 直接复用系统 git 凭据（不存/不传密码）；失败给人话原因；**永不自动 push**。
 * export 口径：md 原样＋html 最小模板（无依赖）；产物取 artifacts 表登记的真实落盘文件。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDb } from '../db/open.js';

// ── git push P0 ──────────────────────────────────────────────────────────

export interface PushResult {
  ok: boolean;
  remote: string | null;
  branch: string;
  output: string;
}

/** 列项目现有 remote（origin 优先；无 → null）。 */
export function listRemotes(projectRoot: string): Array<{ name: string; url: string }> {
  try {
    const out = execFileSync('git', ['remote', '-v'], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (m) seen.set(m[1]!, m[2]!);
    }
    return [...seen.entries()].map(([name, url]) => ({ name, url }));
  } catch {
    return [];
  }
}

/** 当前分支名。 */
export function currentBranch(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'HEAD';
  }
}

/**
 * 显式推送（P0）：push 当前分支到指定 remote。复用系统凭据；永不自动调用。
 * 返回人话 output（成功或失败原因）。
 */
export function pushBranch(projectRoot: string, remoteName: string, branch: string): PushResult {
  const remotes = listRemotes(projectRoot);
  if (!remotes.some((r) => r.name === remoteName)) {
    return { ok: false, remote: remoteName, branch, output: `remote '${remoteName}' 不存在（可用：${remotes.map((r) => r.name).join(', ') || '无'}）。` };
  }
  // MIMOSA-1（2026-11-10 消解静态扫描时发现的真缺陷）：branch 原样进 argv 第三位，
  // `--all`/`--force` 这类以 - 开头的值会被 git 当选项（等价于对全部分支强推）。
  // 形状白名单＋禁前导 -；remote 已由 listRemotes 名单精确校验。
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
    return { ok: false, remote: remoteName, branch, output: `分支名不合法（只允许字母/数字/./_/- 且不以 - 开头）：${branch}` };
  }
  try {
    const out = execFileSync('git', ['push', remoteName, branch], { cwd: projectRoot, encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
    const combined = `${out}${''}`;
    return { ok: true, remote: remoteName, branch, output: combined.slice(-500) || 'push 成功。' };
  } catch (error: unknown) {
    const execError = error as { stderr?: string; stdout?: string; message?: string };
    const detail = execError.stderr?.slice(-300) ?? execError.message?.slice(-300) ?? '未知错误';
    return { ok: false, remote: remoteName, branch, output: `push 失败：${detail}` };
  }
}

// ── 产物导出（md/html） ─────────────────────────────────────────────────

/** 简易 md→html（标题/代码块/粗体/链接四规则；无依赖）。 */
export function markdownToHtml(md: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escape(line)); continue; }
    const h = /^(#{1,6})\s+(.+)/.exec(line);
    if (h) { const level = h[1]!.length; out.push(`<h${level}>${escape(h[2]!)}</h${level}>`); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    let html = escape(line);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    out.push(`<p>${html}</p>`);
  }
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Export</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2em auto;padding:0 1em;line-height:1.6}',
    'pre{background:#f4f4f4;padding:1em;overflow-x:auto}code{font-family:monospace}</style>',
    '</head><body>',
    ...out,
    '</body></html>',
  ].join('\n');
}

/** 导出产物：读源文件→写目标格式到 outputDir。返回写入路径或错误。 */
export function exportArtifact(sourceAbsPath: string, outputDir: string, format: 'md' | 'html'): { ok: true; path: string } | { ok: false; error: string } {
  try {
    if (!existsSync(sourceAbsPath)) return { ok: false, error: `源文件不存在：${sourceAbsPath}` };
    const content = readFileSync(sourceAbsPath, 'utf8');
    mkdirSync(outputDir, { recursive: true });
    const base = sourceAbsPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.\w+$/, '') ?? 'export';
    if (format === 'md') {
      const dest = join(outputDir, `${base}.md`);
      writeFileSync(dest, content, 'utf8');
      return { ok: true, path: dest };
    }
    const dest = join(outputDir, `${base}.html`);
    writeFileSync(dest, markdownToHtml(content), 'utf8');
    return { ok: true, path: dest };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
