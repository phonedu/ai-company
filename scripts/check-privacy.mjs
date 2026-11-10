#!/usr/bin/env node
/**
 * 隐私闸门（无自豁免）：扫描 git 追踪文件的内容与路径、以及提交历史。
 *
 * 精确私人词表不内置：用环境变量 AICO_PRIVACY_EXTRA 注入 JSON（[{"re":"...","why":"..."}]）。
 * 本文件自身的模式用字符串拼接，避免扫描自身。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const P = (...parts) => parts.join('');
const RULES = [
  { re: new RegExp(P('C:', '\\', 'Users', '\\', 'dev'), 'i'), why: '本机用户目录' },
  { re: new RegExp(P('C:', '/', 'Users', '/', 'dev'), 'i'), why: '本机用户目录' },
  { re: new RegExp(P('D:', '\\', 'ai-company-projects'), 'i'), why: '本机项目根' },
  { re: new RegExp(P('D:', '/', 'ai-company-projects'), 'i'), why: '本机项目根' },
  { re: new RegExp(P('C:', '\\', 'Project', '\\', 'ai-company'), 'i'), why: '本机私有目录' },
  { re: new RegExp(P('inter', 'nal/(?:\d|next)'), 'i'), why: '内部台账路径' },
  { re: new RegExp(P('history', '/records'), 'i'), why: '内部证据路径' },
  { re: /history\/archive\//i, why: '内部归档路径' },
  { re: new RegExp(P('Pixel', 'Editor'), 'i'), why: '真实项目名' },
  { re: new RegExp(P('验收', '2026'), 'i'), why: '真实项目名' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, why: 'GitHub token' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, why: 'API key 形似值' },
  { re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, why: '私钥' },
];
const extraRaw = process.env.AICO_PRIVACY_EXTRA;
if (extraRaw) {
  try {
    for (const item of JSON.parse(extraRaw)) RULES.push({ re: new RegExp(item.re, 'i'), why: item.why ?? '外部词表' });
  } catch (error) {
    console.error(`[privacy] AICO_PRIVACY_EXTRA 不是合法 JSON：${String(error)}`);
    process.exit(2);
  }
}

function listFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer' });
  if (r.status === 0) return r.stdout.toString('utf8').split('\0').filter(Boolean);
  // 尚未 git init：walk（跳过依赖/产物）
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'out', 'dist'].includes(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p.replace(/^\.\//, ''));
    }
  };
  walk('.');
  return out;
}

const files = listFiles();
const hits = [];
for (const file of files) {
  const lower = file.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|ico|sqlite|woff2?|ttf)$/i.test(file)) continue;
  for (const rule of RULES) {
    if (rule.re.test(file)) hits.push(`${file}: 路径命中「${rule.why}」`);
  }
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('TESTONLY')) continue;
    for (const rule of RULES) {
      if (rule.re.test(lines[i])) hits.push(`${file}:${i + 1}: 命中「${rule.why}」`);
    }
  }
}

// 历史内容（首次提交前没有历史；CI 上 fetch-depth:0）
const log = spawnSync('git', ['log', '-p', '--all', '--format=%H'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (log.status === 0 && log.stdout) {
  let sha = '';
  for (const line of log.stdout.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) { sha = line; continue; }
    if (line.includes('TESTONLY')) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push(`history ${sha.slice(0, 12)}: 命中「${rule.why}」`);
    }
  }
}

if (hits.length > 0) {
  console.error(`[privacy] FAIL — ${hits.length} 处命中（公开面禁止）`);
  for (const h of hits.slice(0, 50)) console.error(`  - ${h}`);
  if (hits.length > 50) console.error(`  ... 其余 ${hits.length - 50} 处`);
  process.exit(1);
}
console.log(`[privacy] ok — ${files.length} 个文件 + 历史，无命中`);
