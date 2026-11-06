/**
 * 2026-11-03 笔记 Phase C：正文搜索（前 8KB）与多选批量。
 * 判据：首行之后、前 8KB 内的正文能被搜到并带 path；超出上限不假装命中；
 * 列表提供选择框与批量条，批量删除必须先确认且只处理笔记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { searchNotes, writeNote, SEARCH_TEXT_MAX_CHARS } from '../src/main/agent/notes.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aico-notes-search-'));
  const globalDir = join(root, 'global');
  const projDir = join(root, 'proj');
  return { root, globalDir, projDir };
}

test('Phase C 正文搜索：命中首行之后（前 8KB），返回文件路径', () => {
  const { root, globalDir, projDir } = setup();
  try {
    const filler = '背景'.repeat(400); // 800 字符，远超旧 500 字符首段
    writeNote({ projectDir: projDir, globalDir, name: 'deep-body', content: `# 标题\n\n${filler}\n\n蓝鲸计划代号\n` });
    const hits = searchNotes({
      query: '蓝鲸计划',
      projects: [{ id: 1, name: '项目', rootDir: projDir }],
      globalDir,
    });
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0]!.name, 'deep-body');
    assert.ok(hits[0]!.path.endsWith('deep-body.md'), '命中必须带路径供列表对齐');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Phase C 正文搜索：超过 8KB 的内容不整篇读，不假装命中', () => {
  const { root, globalDir, projDir } = setup();
  try {
    const beyond = `${'a'.repeat(SEARCH_TEXT_MAX_CHARS + 50)}\n深水区关键词\n`;
    writeNote({ projectDir: projDir, globalDir, name: 'too-deep', content: beyond });
    const hits = searchNotes({
      query: '深水区关键词',
      projects: [{ id: 1, name: '项目', rootDir: projDir }],
      globalDir,
    });
    assert.equal(hits.length, 0, '超出搜索窗口不得命中');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Phase C 列表守卫：选择框、批量条、删除确认、正文搜索接线在场', () => {
  const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  assert.match(page, /'data-testid': 'knowledge-item-select'/, '每行要有选择框');
  assert.match(page, /'data-testid': 'knowledge-bulk'/, '批量条');
  assert.match(page, /'data-testid': 'knowledge-bulk-delete'/, '批量删除入口');
  assert.match(page, /if \(!confirm\(`确定删除选中的 \$\{notes\.length\} 篇笔记/, '批量删除必须先确认且只数笔记');
  assert.match(page, /window\.api\?\.notes\?\.search\(\{ query: q \}\)/, '正文搜索要接主进程');
  assert.match(page, /bodyHitPaths\.has\(item\.path\)/, '正文命中按 path 并回列表');
  assert.match(page, /const notes = selectedItems\.filter\(\(item\) => item\.type === 'note'\)/, '批量删除必须先按类型过滤');
  assert.match(page, /文档\/产物\/媒体请在文件管理器处理/, '非笔记不假装可批量删');
});
