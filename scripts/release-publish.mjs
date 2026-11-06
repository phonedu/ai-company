#!/usr/bin/env node
/**
 * 发布到 GitHub Releases（2026-11-06 D5 后老板裁：GitHub 自动更新）。
 *
 * 前提：公开的 releases 仓库（默认 phonedu/ai-company-releases；源码库保持 private）。
 * 产物：安装器 + blockmap + latest.yml + portable（手动下载用）。latest.yml 由 electron-builder
 * 按 electron-builder.yml 的 publish(generic) 生成；electron-updater 从
 * `https://github.com/<owner>/<repo>/releases/latest/download/latest.yml` 读取。
 *
 * 用法：node scripts/release-publish.mjs [--version=0.1.0] [--repo=phonedu/ai-company-releases] [--dry-run]
 * 需要：gh 已登录（repo 作用域）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(`--${n}=`.length) : d;
};
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);
const repo = arg('repo', 'phonedu/ai-company');
const dryRun = process.argv.includes('--dry-run');
const tag = `v${version}`;

const setup = join(REPO, 'dist', `AICompany-${version}-x64-setup.exe`);
const blockmap = `${setup}.blockmap`;
const latest = join(REPO, 'dist', 'latest.yml');
const portable = join(REPO, 'dist', `AICompany ${version}.exe`);
const required = [setup, blockmap, latest];
const missing = required.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`[release] 缺少产物：\n- ${missing.join('\n- ')}`);
  console.error('[release] 先跑 `pnpm dist`（electron-builder.yml 已配 publish/generic）。');
  process.exit(1);
}
const yml = readFileSync(latest, 'utf8');
if (!new RegExp(`^version:\\s*${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(yml)) {
  console.error(`[release] latest.yml 版本不是 ${version}：\n${yml.slice(0, 300)}`);
  process.exit(1);
}

function gh(args, opts = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

const visibility = gh(['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility']);
if (visibility !== 'PUBLIC') {
  console.error(`[release] ${repo} 可见性=${visibility}；自动更新要求 PUBLIC（私有 release 外部下载不到）。`);
  process.exit(1);
}
const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName', '--jq', '.tagName'], { encoding: 'utf8' });
if (existing.status === 0 && !dryRun) {
  console.error(`[release] release ${tag} 已存在；不覆盖（要重发请先在 GitHub 删除该 release/tag）。`);
  process.exit(1);
}

const assets = [setup, blockmap, latest, ...(existsSync(portable) ? [portable] : [])];
console.log(`[release] repo=${repo} tag=${tag} assets=`);
for (const a of assets) console.log(`  - ${a}`);

if (dryRun) {
  console.log('[release] --dry-run：只校验，不上传。');
  process.exit(0);
}

const notesFile = join(REPO, 'CHANGELOG.md');
if (!existsSync(notesFile)) {
  console.error('[release] 缺 CHANGELOG.md（release notes 来源）');
  process.exit(1);
}
const notes = `AI 一人公司 ${tag}（自动更新源：${repo}）\n\n${readFileSync(notesFile, 'utf8')}`;
const tmpNotes = join(process.env.TEMP ?? REPO, `aico-release-notes-${version}.md`);
writeFileSync(tmpNotes, notes, 'utf8');

gh(['release', 'create', tag, '--repo', repo, '--title', `AI 一人公司 ${tag}`, '--notes-file', tmpNotes, ...assets]);
console.log(`[release] 已上传 ${assets.length} 个资产`);

// 真读更新源：GitHub latest/download 必须能拿到 latest.yml 且版本一致。
const feed = `https://github.com/${repo}/releases/latest/download/latest.yml`;
let ok = false;
for (let i = 0; i < 20; i += 1) {
  try {
    const res = await fetch(feed, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (res.ok && text.includes(`version: ${version}`)) { ok = true; break; }
    console.error(`[release] 更新源尚未就绪（HTTP ${res.status}），重试…`);
  } catch (error) {
    console.error(`[release] 读取更新源失败（${error instanceof Error ? error.message : String(error)}），重试…`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!ok) {
  console.error(`[release] FAIL：${feed} 未返回 version: ${version}`);
  process.exit(1);
}
console.log(`[release] PASS：更新源可用 ${feed}`);
