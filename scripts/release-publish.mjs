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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(`--${n}=`.length) : d;
};
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const version = arg('version', pkg.version).replace(/^v/, '');
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
function releaseInfo() {
  const r = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets,databaseId'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function tryUpload(file) {
  // 串行上传：gh release upload 一次一个资产；失败重试 6 次（弱网/代理抖动）。
  const name = file.split(/[\/]/).pop();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const r = spawnSync('gh', ['release', 'upload', tag, file, '--repo', repo, '--clobber'], { encoding: 'utf8' });
    if (r.status === 0) return true;
    console.error(`[release] 上传 ${name} 第 ${attempt}/6 次失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 3000);
  }
  return false;
}

const assets = [setup, blockmap, latest, ...(existsSync(portable) ? [portable] : [])];
console.log(`[release] repo=${repo} tag=${tag} assets=`);
for (const a of assets) console.log(`  - ${a}`);
if (dryRun) { console.log('[release] --dry-run：只校验，不上传。'); process.exit(0); }

const notesFile = join(REPO, 'CHANGELOG.md');
if (!existsSync(notesFile)) { console.error('[release] 缺 CHANGELOG.md（release notes 来源）'); process.exit(1); }
const notes = `AI 一人公司 ${tag}（自动更新源：${repo}）

${readFileSync(notesFile, 'utf8')}`;
const tmpNotes = join(process.env.TEMP ?? REPO, `aico-release-notes-${version}.md`);
writeFileSync(tmpNotes, notes, 'utf8');

let info = releaseInfo();
if (info != null) {
  if (info.isDraft !== true) {
    console.error(`[release] release ${tag} 已发布；不覆盖（要重发请先删除 release/tag）。`);
    process.exit(1);
  }
  console.log('[release] 复用已存在的 draft（断点续传）');
} else {
  gh(['release', 'create', tag, '--repo', repo, '--title', `AI 一人公司 ${tag}`, '--notes-file', tmpNotes, '--draft']);
  console.log('[release] 已建 draft（不并发传资产）');
  info = releaseInfo();
}
if (info == null) { console.error('[release] 无法读取 draft release'); process.exit(1); }

const uploaded = new Map((info.assets ?? []).map((a) => [a.name, Number(a.size ?? -1)]));
for (const file of assets) {
  const name = file.split(/[\/]/).pop();
  const size = statSync(file).size;
  if (uploaded.get(name) === size) { console.log(`[release] 已在上传列表，跳过：${name}`); continue; }
  console.log(`[release] 上传 ${name}（${size} B）…`);
  if (!tryUpload(file)) {
    console.error(`[release] 失败：${name}。draft 保留，可重跑本脚本断点续传。`);
    process.exit(1);
  }
}
console.log('[release] 全部资产到齐，发布 draft…');
gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
console.log('[release] 已发布');
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
