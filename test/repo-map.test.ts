/**
 * RET-1 P3 · 确定性 repo map（纯函数）：文件/符号索引、查询小答案、跳过构建目录、开关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRepoMap, isRepoMapEnabled, renderRepoMap } from '../src/main/agent/repo-map.js';

test('RET-1 repo_map: 扫 .rs/.md，跳过 target，索引 fn/struct/impl/标题与行号', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-repomap-'));
  try {
    mkdirSync(join(root, 'crates', 'a'), { recursive: true });
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'crates', 'a', 'lib.rs'), 'pub struct Foo;\nimpl Foo {\n  pub fn bar() {}\n}\n', 'utf8');
    writeFileSync(join(root, 'README.md'), '# 标题\n正文\n## 子标题\n', 'utf8');
    writeFileSync(join(root, 'target', 'skip.rs'), 'pub fn nope() {}\n', 'utf8');
    const map = buildRepoMap(root);
    assert.ok(map.fileList.some((f) => f.path === 'crates/a/lib.rs'));
    assert.ok(map.fileList.some((f) => f.path === 'README.md'));
    assert.equal(map.fileList.some((f) => f.path.startsWith('target/')), false, '构建目录必须跳过');
    const names = map.entries.map((e) => `${e.kind}:${e.name}@${e.line}`);
    assert.ok(names.includes('struct:Foo@1'));
    assert.ok(names.includes('impl:Foo@2'));
    assert.ok(names.includes('fn:bar@3'));
    assert.ok(names.includes('h1:标题@1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RET-1 repo_map: 查询只返回小答案；空查询只给文件索引；超长显式截断', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-repomap-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const many = ['pub fn tools_list() {}', 'pub struct ToolSpec;'];
    for (let i = 0; i < 40; i += 1) many.push(`pub fn alpha_${i}() {}`);
    writeFileSync(join(root, 'src', 'schema.rs'), many.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    writeFileSync(join(root, 'src', 'server.rs'), 'pub fn serve_stdio() {}\n', 'utf8');
    const map = buildRepoMap(root);
    const hit = renderRepoMap(map, { query: 'tools' });
    assert.match(hit.text, /src\/schema\.rs/);
    assert.match(hit.text, /fn tools_list/);
    assert.equal(hit.text.includes('serve_stdio'), false, '不匹配的符号不返回');
    const index = renderRepoMap(map, {});
    assert.match(index.text, /文件索引/);
    assert.match(index.text, /src\/schema\.rs/);
    const clipped = renderRepoMap(map, { query: 'alpha', maxChars: 200 });
    assert.ok(clipped.text.length <= 260);
    assert.match(clipped.text, /截断/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RET-1 repo_map: 开关只认 on/1/true（默认关）', () => {
  assert.equal(isRepoMapEnabled({}), false);
  assert.equal(isRepoMapEnabled({ AICO_REPO_MAP: 'off' }), false);
  assert.equal(isRepoMapEnabled({ AICO_REPO_MAP: 'on' }), true);
  assert.equal(isRepoMapEnabled({ AICO_REPO_MAP: '1' }), true);
});
