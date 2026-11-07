/**
 * B0-1（ADV-1 G1）：repo map 只扫 `.rs/.toml/.md` 且 symbolOf 不认 TS 的回归测试。
 *
 * 审查结论：对本 TS/Electron 项目开了 repo map 也扫不出任何 .ts ⇒ 员工/规划者对代码库全靠盲探。
 * 用途已从「检索找路」改为「员工代码上下文」（RET-1 原裁决是检索不产品化，默认开关维持实验位，
 * A/B 重新评估归 B1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRepoMap, renderRepoMap } from '../src/main/agent/repo-map.js';

test('B0-1：TS/JS/JSON 文件进图，TS 符号可解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-repomap-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'alpha.ts'),
      [
        'export function loadAlpha(id: number) {',
        '  return id;',
        '}',
        'export const renderAlpha = (x: string) => x;',
        'export interface AlphaOptions { flag: boolean }',
        'export class AlphaStore {}',
        'const internal = async () => 1;',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'src', 'beta.tsx'), 'export default function Beta() {\n  return null;\n}\n');
    writeFileSync(join(dir, 'src', 'gamma.js'), 'function gamma() {}\nmodule.exports = { gamma };\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    writeFileSync(join(dir, 'README.md'), '# 标题\n\n正文\n');

    const map = buildRepoMap(dir);
    const paths = map.fileList.map((f) => f.path);
    for (const p of ['src/alpha.ts', 'src/beta.tsx', 'src/gamma.js', 'package.json', 'README.md']) {
      assert.ok(paths.includes(p), `${p} 必须在文件索引里（旧实现只认 .rs/.toml/.md）`);
    }
    const alpha = map.entries.filter((e) => e.path === 'src/alpha.ts').map((e) => `${e.kind}:${e.name}`);
    assert.ok(alpha.includes('fn:loadAlpha'), `TS 函数必须解析出符号（实际 ${JSON.stringify(alpha)}）`);
    assert.ok(alpha.includes('fn:renderAlpha'), '箭头函数 const 必须解析');
    assert.ok(alpha.includes('interface:AlphaOptions'), 'interface 必须解析');
    assert.ok(alpha.includes('class:AlphaStore'), 'class 必须解析');
    assert.ok(alpha.includes('fn:internal'), '非导出箭头函数也必须解析');
    const beta = map.entries.filter((e) => e.path === 'src/beta.tsx').map((e) => `${e.kind}:${e.name}`);
    assert.ok(beta.includes('fn:Beta'), 'export default function 必须解析');
    const gamma = map.entries.filter((e) => e.path === 'src/gamma.js').map((e) => `${e.kind}:${e.name}`);
    assert.ok(gamma.includes('fn:gamma'), 'JS 函数必须解析');

    const hit = renderRepoMap(map, { query: 'AlphaStore' });
    assert.match(hit.text, /AlphaStore/, '按符号查询必须命中 TS 文件');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('B0-1：构建目录/依赖目录仍跳过（不把 node_modules 扫进图）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-repomap-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export const leaked = 1;\n');
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1;\n');
    const map = buildRepoMap(dir);
    assert.ok(map.fileList.some((f) => f.path === 'app.ts'));
    assert.ok(!map.fileList.some((f) => f.path.includes('node_modules')), 'node_modules 必须跳过');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
