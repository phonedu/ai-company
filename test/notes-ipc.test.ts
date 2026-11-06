/**
 * K1 知识库 · 主进程 IPC 数据面测试（CRUD＋搜索＋升级＋路径安全）。
 *
 * 判据：
 * ① CRUD：创建/读/写/删 Markdown 文件；文件名只允许安全字符；
 * ② 搜索：FTS5/LIKE 混合，跨项目＋全局统一搜，标注来源；
 * ③ 升级：笔记→文档（文件从 .aico/notes/ 移到 .aico/docs/）；
 * ④ 路径安全：路径穿越/非法文件名拒绝；
 * ⑤ 列表：type=note/doc/artifact 三种来源，标注项目名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listNotes,
  readNote,
  writeNote,
  deleteNote,
  searchNotes,
  promoteNote,
  notesDirFor,
  safeNoteName,
} from '../src/main/agent/notes.js';

const root = mkdtempSync(join(tmpdir(), 'aico-k1-'));
const p1Dir = join(root, 'proj-a');
const p2Dir = join(root, 'proj-b');
const globalDir = join(root, 'global-notes');
mkdirSync(p1Dir, { recursive: true });
mkdirSync(p2Dir, { recursive: true });
mkdirSync(globalDir, { recursive: true });

function cleanup(): void {
  rmSync(root, { recursive: true, force: true });
}

test('K1-① CRUD：创建→读→写→删', () => {
  try {
    // 创建
    const w = writeNote({ projectDir: null, globalDir, name: 'deploy-runbook', content: '# 部署\n步骤一：停旧进程' });
    assert.ok(w.ok, `创建应成功：${JSON.stringify(w)}`);
    assert.ok(existsSync(join(globalDir, 'notes', 'deploy-runbook.md')));

    // 读
    const r = readNote({ projectDir: null, globalDir, name: 'deploy-runbook' });
    assert.ok(r.ok);
    assert.ok(r.ok && r.content.includes('停旧进程'));

    // 写（覆盖）
    writeNote({ projectDir: null, globalDir, name: 'deploy-runbook', content: '# 部署 v2\n新内容' });
    const r2 = readNote({ projectDir: null, globalDir, name: 'deploy-runbook' });
    assert.ok(r2.ok && r2.content.includes('v2'));

    // 删
    const d = deleteNote({ projectDir: null, globalDir, name: 'deploy-runbook' });
    assert.ok(d.ok);
    assert.ok(!existsSync(join(globalDir, 'notes', 'deploy-runbook.md')));
  } finally { cleanup(); }
});

test('K1-① 文件名校验：只允许 [a-zA-Z0-9\\-_\\u4e00-\\u9fff]，拒绝路径穿越/特殊字符', () => {
  assert.ok(safeNoteName('deploy-runbook'));
  assert.ok(safeNoteName('部署手册'));
  assert.ok(safeNoteName('api_v2.config'));
  assert.equal(safeNoteName('../etc/passwd'), null);
  assert.equal(safeNoteName('foo/bar'), null);
  assert.equal(safeNoteName('foo\\bar'), null);
  assert.equal(safeNoteName(''), null);
  assert.equal(safeNoteName('.hidden'), null);
});

test('K1-② 搜索：跨项目＋全局统一搜', () => {
  try {
    // 项目A笔记
    mkdirSync(join(p1Dir, '.aico', 'notes'), { recursive: true });
    writeFileSync(join(p1Dir, '.aico', 'notes', 'deploy.md'), '# A 部署\n蓝绿部署策略');
    // 项目B笔记
    mkdirSync(join(p2Dir, '.aico', 'notes'), { recursive: true });
    writeFileSync(join(p2Dir, '.aico', 'notes', 'deploy.md'), '# B 部署\n滚动更新策略');
    // 全局笔记
    mkdirSync(join(globalDir, 'notes'), { recursive: true });
    writeFileSync(join(globalDir, 'notes', 'deploy-global.md'), '# 全局部署规范\n统一用蓝绿');

    const results = searchNotes({
      query: '部署',
      projects: [
        { id: 1, name: '项目A', rootDir: p1Dir },
        { id: 2, name: '项目B', rootDir: p2Dir },
      ],
      globalDir,
    });
    assert.ok(results.length >= 3, `应至少命中 3 条（A+B+全局），实际 ${results.length}`);
    assert.ok(results.some((r) => r.projectName === '项目A'), '应命中项目A');
    assert.ok(results.some((r) => r.projectName === '项目B'), '应命中项目B');
    assert.ok(results.some((r) => r.projectName === null || r.projectName === '全局'), '应命中全局');
  } finally { cleanup(); }
});

test('K1-③ 升级：笔记→文档（文件搬家）', () => {
  try {
    mkdirSync(join(p1Dir, '.aico', 'notes'), { recursive: true });
    mkdirSync(join(p1Dir, '.aico', 'docs'), { recursive: true });
    writeFileSync(join(p1Dir, '.aico', 'notes', 'runbook.md'), '# 运维手册\n正式版');

    const p = promoteNote({ projectDir: p1Dir, name: 'runbook' });
    assert.ok(p.ok, `升级应成功：${JSON.stringify(p)}`);
    assert.ok(!existsSync(join(p1Dir, '.aico', 'notes', 'runbook.md')), '旧位置应不存在');
    assert.ok(existsSync(join(p1Dir, '.aico', 'docs', 'runbook.md')), '新位置应存在');
    assert.match(readFileSync(join(p1Dir, '.aico', 'docs', 'runbook.md'), 'utf8'), /正式版/);
  } finally { cleanup(); }
});

test('K1-④ 路径安全：路径穿越被拒', () => {
  try {
    const w = writeNote({ projectDir: null, globalDir, name: '../evil', content: 'x' });
    assert.ok(!w.ok, '路径穿越应被拒');
  } finally { cleanup(); }
});

test('K1-⑤ 列表：项目笔记＋全局笔记＋文档＋产物', () => {
  try {
    // 项目A：笔记＋文档＋产物
    mkdirSync(join(p1Dir, '.aico', 'notes'), { recursive: true });
    mkdirSync(join(p1Dir, '.aico', 'docs'), { recursive: true });
    writeFileSync(join(p1Dir, '.aico', 'notes', 'tip.md'), '# 小技巧');
    writeFileSync(join(p1Dir, '.aico', 'docs', 'spec.md'), '# 规范');
    writeFileSync(join(p1Dir, 'build-log.md'), '# 构建日志');
    // 全局
    mkdirSync(join(globalDir, 'notes'), { recursive: true });
    writeFileSync(join(globalDir, 'notes', 'style.md'), '# 风格指南');

    const items = listNotes({
      projects: [{ id: 1, name: '项目A', rootDir: p1Dir }],
      globalDir,
    });
    assert.ok(items.some((i) => i.name === 'tip' && i.type === 'note' && i.projectName === '项目A'), `应含项目A笔记：${JSON.stringify(items.filter(i => i.name === 'tip'))}`);
    assert.ok(items.some((i) => i.name === 'spec' && i.type === 'doc'), '应含文档');
    assert.ok(items.some((i) => i.name === 'build-log' && i.type === 'artifact'), '应含产物');
    assert.ok(items.some((i) => i.name === 'style' && i.type === 'note' && (i.projectName === null || i.projectName === '全局')), '应含全局笔记');
  } finally { cleanup(); }
});
