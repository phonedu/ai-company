#!/usr/bin/env node
/**
 * 公开面闸门（2026-11-10 加严）：对外可见的东西里不得出现内部流程用语、编号与跨仓关系词。
 * 扫描范围：**所有被 git 跟踪的文本文件**——文档（.md）整篇扫；代码只扫注释行
 * （`//`、`/*`、`*`、`--`、`#` 形态），避免误伤代码字符串与正则。
 *
 * 为什么加严：此前只扫 README/docs，代码注释里的内部编号/流程词会随开源发布流出去；
 * 2026-11-10 已把这些存量注释清了一遍，本闸门负责「不再回来」。
 * 说明：不扫提交历史（历史无法重写）；新提交请自觉遵守同一口径。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const P = (...parts) => parts.join('');
const rules = [
  { re: /internal\//, why: '内部路径' },
  { re: /history\/records/, why: '内部路径' },
  { re: new RegExp(`\\b${P('D', '-\\d{2}')}\\b`), why: '决策编号' },
  { re: new RegExp(`\\b${P('RW', '-\\d+')}\\b`), why: '缺陷编号' },
  { re: new RegExp(`\\b${P('F', '-?\\d{2}')}\\b`), why: '缺陷编号' },
  { re: new RegExp(`\\b${P('BRK', '\\d+')}\\b`), why: '缺陷编号' },
  { re: new RegExp(`\\b${P('OPT', '-[A-Z]+-\\d+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('UG', '-\\d+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('S', '\\d{1,2}[a-z]?-[A-Z0-9]+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('M', '\\d-[A-Z0-9-]+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('MP1', '-F\\d+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('GAP', '\\d+')}\\b`), why: '缺陷编号' },
  { re: new RegExp(`\\b${P('T', '\\d+\\.\\d+')}\\b`), why: '内部任务编号' },
  { re: new RegExp(`\\b${P('UI', '-\\d+')}\\b`), why: '路线图编号' },
  { re: new RegExp(`\\b${P('B', '\\d[a-z]?-\\d+')}\\b`), why: '批次编号' },
  { re: new RegExp(`\\b${P('B', '\\d[a-z]?')}(?=[：:）)、，,\\s]|$)`), why: '批次编号' },
  { re: new RegExp(`\\b${P('(?:M|S)', '\\d+[a-z]?')}(?=[：:）)、，,\\s]|$)`), why: '批次编号' },
  { re: new RegExp(`${P('公', '开仓')}|${P('私', '仓')}|${P('私', '有仓')}`), why: '跨仓用语' },
  { re: new RegExp(P('mi', 'mosa'), 'i'), why: '内部工具名' },
  {
    re: new RegExp(
      [
        P('老', '板令'),
        P('老', '板拍板'),
        P('老', '板裁定'),
        P('老', '板裁', '决'),
        P('老', '板批(?!准)'),
        P('老', '板\\s*20\\d{2}-'),
        P('老', '板签收'),
        P('待', '老', '板'),
        P('上', '报', '老', '板'),
        P('终', '验员'),
        P('复', '核员'),
        P('复', '核\\s*P\\d'),
        P('实', '抓'),
        P('挂', '账'),
        P('台', '账'),
        P('本', '批'),
        P('该', '批'),
        P('上', '一', '批'),
        P('下', '批'),
        P('裁', '决'),
        P('内', '部裁决'),
      ].join('|'),
    ),
    why: '内部流程用语',
  },
];

const TS_LIKE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css']);
const HASH_LIKE = new Set(['.yml', '.yaml', '.toml', '.ps1', '.sh']);
const SCANNABLE = new Set(['.md', '.sql', '.html', ...TS_LIKE, ...HASH_LIKE]);

/** 取一行的注释部分（整行/行尾/块内）；非注释行返回 null。CSS 的 `*::` 不是注释。 */
function commentPart(line, ext, state) {
  const t = line.trimStart();
  if (ext === '.md') return line;
  if (TS_LIKE.has(ext)) {
    if (state.inBlock) {
      if (line.includes('*/')) state.inBlock = false;
      return line;
    }
    if (t.startsWith('//')) return t;
    const b = line.indexOf('/*');
    if (b >= 0) {
      // 引号内的 `/*`（glob/模板串）不是注释：要求它之前的引号配对。
      const before = line.slice(0, b);
      let sq0 = 0;
      let dq0 = 0;
      for (let k = 0; k < before.length; k += 1) {
        if (before[k] === "'" && before[k - 1] !== '\\') sq0 += 1;
        if (before[k] === '"' && before[k - 1] !== '\\') dq0 += 1;
      }
      if (sq0 % 2 === 1 || dq0 % 2 === 1) return null;
      if (!line.includes('*/', b + 2)) state.inBlock = true;
      return line.slice(b);
    }
    if (t.startsWith('*')) return null;
  } else if (ext === '.sql') {
    if (t.startsWith('--')) return t;
  } else if (HASH_LIKE.has(ext)) {
    if (t.startsWith('#')) return t;
  }
  const marker = ext === '.sql' ? '--' : TS_LIKE.has(ext) ? '//' : HASH_LIKE.has(ext) ? '#' : null;
  if (marker == null) return null;
  for (let i = 1; i < line.length; i += 1) {
    if (!line.startsWith(marker, i)) continue;
    if (!/\s/.test(line[i - 1] ?? '')) continue;
    let sq = 0;
    let dq = 0;
    for (let k = 0; k < i; k += 1) {
      if (line[k] === "'" && line[k - 1] !== '\\') sq += 1;
      if (line[k] === '"' && line[k - 1] !== '\\') dq += 1;
    }
    if (sq % 2 === 1 || dq % 2 === 1) continue;
    return line.slice(i);
  }
  return null;
}

let files;
try {
  files = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (error) {
  console.error(`[public-face] FAIL — 需要 git 仓库（git ls-files 不可用：${error instanceof Error ? error.message.slice(0, 200) : String(error)}）`);
  process.exit(1);
}

const hits = [];
let scanned = 0;
for (const file of files) {
  const ext = file.match(/(\.[A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
  if (!SCANNABLE.has(ext)) continue;
  // 冻结迁移（含历史注释）逐字参与校验和：改一个字节，已有用户库会拒绝启动。
  // 因此这些文件不参与「注释去内部化」——校验和完整性优先于注释洁癖。
  if (file.startsWith('src/main/db/migrations/')) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  scanned += 1;
  const lines = text.split(/\r?\n/);
  const state = { inBlock: false };
  for (let i = 0; i < lines.length; i += 1) {
    const comment = commentPart(lines[i], ext, state);
    if (comment == null) continue;
    for (const rule of rules) {
      if (rule.re.test(comment)) hits.push(`${file}:${i + 1}: 命中「${rule.why}」`);
    }
  }
}

if (hits.length > 0) {
  console.error(`[public-face] FAIL — ${hits.length} 处内部用语/编号（扫描 ${scanned} 个文件）`);
  for (const h of hits.slice(0, 80)) console.error(`  - ${h}`);
  if (hits.length > 80) console.error(`  … 其余 ${hits.length - 80} 处省略`);
  process.exit(1);
}
console.log(`[public-face] ok — ${scanned} 个文件（文档整篇 + 代码注释）无内部用语`);
