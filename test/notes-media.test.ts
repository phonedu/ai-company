/**
 * 2026-11-03 笔记页 Phase A：列表不再只扫 .md。
 * 判据：notes/docs 目录与项目根浅层的常规文件都进列表（带 ext/size）；
 * D3-3 类型重划（2026-11-03）：媒体只收图/视频/音频，pdf/office/html 归 doc，
 * txt/csv 等可读文本归 text，其余归 file；md 仍按目录定 note/doc/artifact；
 * 文件删除后下次扫描不再出现（不做缺失行）；隐藏文件跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { listNotes } from '../src/main/agent/notes.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aico-notes-media-'));
  const globalDir = join(root, 'global');
  const projectRoot = join(root, 'proj');
  mkdirSync(join(projectRoot, '.aico', 'notes'), { recursive: true });
  mkdirSync(join(projectRoot, '.aico', 'docs'), { recursive: true });
  mkdirSync(join(globalDir, 'notes'), { recursive: true });
  writeFileSync(join(projectRoot, '.aico', 'notes', 'n.md'), '# note\n');
  writeFileSync(join(projectRoot, '.aico', 'docs', 'guide.md'), '# guide\n');
  writeFileSync(join(projectRoot, '.aico', 'docs', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(projectRoot, 'index.html'), '<html></html>');
  writeFileSync(join(projectRoot, 'notes.txt'), 'plain text');
  writeFileSync(join(projectRoot, 'data.csv'), 'a,b');
  writeFileSync(join(projectRoot, 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  writeFileSync(join(projectRoot, '.hidden'), 'x');
  writeFileSync(join(globalDir, 'notes', 'g.md'), '# global\n');
  return { root, globalDir, projectRoot };
}

test('D3-3 扫描：md 按目录定类型；图/视/音=媒体，pdf/html=文档，txt/csv=文本，其余=文件；隐藏跳过', () => {
  const { root, globalDir, projectRoot } = setup();
  try {
    const items = listNotes({ projects: [{ id: 1, name: 'P', rootDir: projectRoot }], globalDir });
    const byName = new Map(items.map((item) => [item.name, item]));
    assert.equal(byName.get('n')?.type, 'note');
    assert.equal(byName.get('guide')?.type, 'doc');
    assert.equal(byName.get('shot.png')?.type, 'media', '图片=媒体');
    assert.equal(byName.get('shot.png')?.ext, '.png');
    assert.ok((byName.get('shot.png')?.size ?? 0) > 0);
    assert.equal(byName.get('index.html')?.type, 'doc', 'html=文档（不再是媒体）');
    assert.equal(byName.get('notes.txt')?.type, 'text', 'txt=文本（老板指出的错分）');
    assert.equal(byName.get('data.csv')?.type, 'text');
    assert.equal(byName.get('bundle.zip')?.type, 'file', '未知类型=文件');
    assert.equal(byName.get('g')?.type, 'note');
    assert.equal(byName.has('.hidden'), false, '隐藏文件不进列表');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Phase A 删除即消失：删掉媒体文件后重新扫描不再出现（不做幽灵行）', () => {
  const { root, globalDir, projectRoot } = setup();
  try {
    const file = join(projectRoot, '.aico', 'docs', 'shot.png');
    const first = listNotes({ projects: [{ id: 1, name: 'P', rootDir: projectRoot }], globalDir });
    assert.ok(first.some((item) => item.name === 'shot.png'));
    rmSync(file);
    const second = listNotes({ projects: [{ id: 1, name: 'P', rootDir: projectRoot }], globalDir });
    assert.equal(second.some((item) => item.name === 'shot.png'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('笔记页 Phase A：范围选择、项目分组、媒体筛选与媒体信息面板接线', () => {
  const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  assert.match(page, /data-testid": "knowledge-scope"|'data-testid': 'knowledge-scope'/);
  assert.match(page, /data-testid': 'knowledge-group'/);
  assert.match(page, /FILTERS = \['全部', '笔记', '文档', '产物', '媒体', '文本', '文件'\]/);
  assert.match(page, /data-testid': 'knowledge-media-info'/);
  assert.ok(
    page.includes("selected.type !== 'note' && !/\\.md$/i.test(selected.path)"),
    '预览面板=非笔记且非 md（md 文档走只读渲染）',
  );
  assert.match(page, /item\.projectId === scopeProjectId/);
});

// RW-49（2026-11-05 老板点题「能否很快找到」）：docs 子目录限深递归——产物落
// docs/reference/、docs/guides/ 等子目录时知识页必须可见（浅扫会永远找不到）。
test('RW-49 docs 子目录递归：子目录 md/图片进列表；隐藏与深层(>3)不扫；封顶 400', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-notes-rw49-'));
  try {
    const projDir = join(root, 'proj');
    const mk = (p: string): void => {
      mkdirSync(p, { recursive: true });
    };
    mk(join(projDir, '.aico', 'docs', 'reference'));
    mk(join(projDir, '.aico', 'docs', 'guides', 'deep', 'deeper', 'deepest'));
    writeFileSync(join(projDir, '.aico', 'docs', 'reference', 'pixel-asset-naming.md'), '# 命名速查\n');
    writeFileSync(join(projDir, '.aico', 'docs', 'guides', '上手指南.md'), '# 上手\n');
    writeFileSync(join(projDir, '.aico', 'docs', 'reference', 'diagram.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(projDir, '.aico', 'docs', 'guides', 'deep', 'deeper', 'deepest', 'too-deep.md'), '# 深层\n');
    writeFileSync(join(projDir, '.aico', 'docs', '.hidden.md'), '# 隐藏\n');
    const items = listNotes({ projects: [{ id: 1, name: 'P', rootDir: projDir }], globalDir: join(root, 'global') });
    const names = items.map((i) => i.name);
    assert.ok(names.some((n) => n.includes('pixel-asset-naming')), '子目录 md 可见（RW-49 核心）');
    assert.ok(names.some((n) => n.includes('上手指南')), '二级子目录 md 可见');
    assert.ok(names.some((n) => n.includes('diagram')), '子目录图片=媒体可见');
    assert.ok(!names.some((n) => n.includes('too-deep')), '超深层级不扫（限深 3）');
    assert.ok(!items.some((i) => i.path.includes('.hidden.md')), '隐藏不扫');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// RW-49 补（T8b 真机）：员工产物常落项目根 docs/ 与「文档/」——同样限深递归可见。
test('RW-49 根下 docs/ 与 文档/ 目录递归可见', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-notes-rw49b-'));
  try {
    const projDir = join(root, 'proj');
    const mk = (p: string): void => {
      mkdirSync(p, { recursive: true });
    };
    mk(join(projDir, 'docs', 'reference'));
    mk(join(projDir, '文档', '参考'));
    writeFileSync(join(projDir, 'docs', 'reference', 'naming.md'), '# 速查\n');
    writeFileSync(join(projDir, '文档', '参考', '导航索引.md'), '# 索引\n');
    const items = listNotes({ projects: [{ id: 1, name: 'P', rootDir: projDir }], globalDir: join(root, 'global') });
    const names = items.map((i) => i.name);
    assert.ok(names.some((n) => n.includes('naming')), '根 docs/ 子树可见');
    assert.ok(names.some((n) => n.includes('导航索引')), '中文 文档/ 子树可见');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
