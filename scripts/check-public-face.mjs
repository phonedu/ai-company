#!/usr/bin/env node
/**
 * 公开面闸门：README/docs 里不得出现内部流程用语与编号（代码注释的存量编号不扫）。
 * 新增文档必须写给用户/外部开发者看；不写裁决过程、内部台账、排期承诺。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const forbidden = [
  { re: /internal\//, why: '内部台账路径' },
  { re: /history\/records/, why: '内部证据路径' },
  { re: /\bD-\d{2}\b/, why: '内部决策编号' },
  { re: /\bRW-\d+\b/, why: '内部缺陷编号' },
  { re: /\bF-\d{2}\b/, why: '内部缺陷编号' },
  { re: /老板签收|验收台账|内部裁决|待老板|上报老板/, why: '内部流程用语' },
  // 2026-11-10：对外文档不该出现「公开仓/私仓」这类跨仓关系词（读者不需要知道代码怎么分仓维护）。
  { re: /公开仓|私仓|私有仓/, why: '跨仓用语' },
];
const docs = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'];
if (existsSync('docs')) {
  for (const f of readdirSync('docs')) if (f.endsWith('.md')) docs.push(join('docs', f));
}
const hits = [];
for (const file of docs) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of forbidden) {
      if (rule.re.test(lines[i])) hits.push(`${file}:${i + 1}: 命中「${rule.why}」`);
    }
  }
}
if (hits.length > 0) {
  console.error(`[public-face] FAIL — ${hits.length} 处内部用语/编号`);
  for (const h of hits.slice(0, 50)) console.error(`  - ${h}`);
  process.exit(1);
}
console.log(`[public-face] ok — ${docs.length} 份公开文档无内部用语`);
