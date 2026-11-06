/**
 * 2026-11-03 笔记 Phase B：媒体/附件预览。
 * 判据：图片/PDF/视频/音频/HTML 拿到受控短票 URL；文本截断如实；二进制/Office/越界显式拒；
 * 系统打开走注入的 openPath/revealPath。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleNotesPreview, notesPreviewPathAllowed, NOTES_PREVIEW_CAP, NOTES_TEXT_CAP, type NotesPreviewResult } from '../src/main/ipc/ipc.js';
import { resolvePreviewToken } from '../src/main/ipc/attachment-preview.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';

interface Fixture {
  dir: string;
  root: string;
  db: ReturnType<typeof openMemoryDatabase>;
  deps: IpcDeps;
}

function seed(openPath?: (p: string) => Promise<string> | string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'aico-notes-preview-'));
  const root = join(dir, 'proj');
  mkdirSync(join(root, '.aico', 'docs'), { recursive: true });
  mkdirSync(join(root, '.aico', 'notes'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(1, '甲项目', root, 1);
  let revealed = '';
  const deps: IpcDeps = {
    repo: createSqliteChatRepo(db),
    db,
    openPath: openPath ?? (() => ''),
    revealPath: (p: string) => {
      revealed = p;
    },
  };
  return { dir, root, db, deps };
}

function cleanup(f: Fixture): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

function tokenPath(result: NotesPreviewResult): string | null {
  if (!result.ok || result.mode !== 'read' || result.url == null) return null;
  const token = result.url.replace('aico-file://preview/', '');
  return resolvePreviewToken(token)?.path ?? null;
}

test('Phase B 文本：按 UTF-8 读入，kind=text，不带 URL', async () => {
  const f = seed();
  try {
    const abs = join(f.root, '.aico', 'docs', 'runbook.md');
    writeFileSync(abs, '# 部署\n\n步骤一\n');
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok || res.mode !== 'read') return;
    assert.equal(res.kind, 'text');
    assert.equal(res.text, '# 部署\n\n步骤一\n');
    assert.equal(res.truncated, false);
    assert.equal(res.url, undefined);
  } finally {
    cleanup(f);
  }
});

test('Phase B 文本：超过 256KB 截断并标注，不整读返回', async () => {
  const f = seed();
  try {
    const abs = join(f.root, 'big.txt');
    writeFileSync(abs, 'a'.repeat(NOTES_TEXT_CAP + 100));
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return;
    assert.equal(res.kind, 'text');
    assert.equal(res.truncated, true);
    assert.equal(Buffer.byteLength(res.text ?? '', 'utf8'), NOTES_TEXT_CAP);
  } finally {
    cleanup(f);
  }
});

test('Phase B 二进制：NUL 探测显式拒，不返回乱码', async () => {
  const f = seed();
  try {
    const abs = join(f.root, 'blob.bin');
    writeFileSync(abs, Buffer.from([0x41, 0x00, 0x42]));
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, 'binary_file');
  } finally {
    cleanup(f);
  }
});

test('Phase B 图片/视频/音频/PDF/HTML：签受控短票，短票解析回同一路径', async () => {
  const f = seed();
  try {
    const cases: Array<[string, Buffer, string]> = [
      ['shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image'],
      ['clip.mp4', Buffer.from('fake-video'), 'video'],
      ['voice.mp3', Buffer.from('fake-audio'), 'audio'],
      ['doc.pdf', Buffer.from('%PDF-1.4'), 'pdf'],
      ['page.html', Buffer.from('<!doctype html><h1>hi</h1>'), 'html'],
    ];
    for (const [name, bytes, kind] of cases) {
      const abs = join(f.root, '.aico', 'docs', name);
      writeFileSync(abs, bytes);
      const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
      assert.equal(res.ok, true, `${name}: ${JSON.stringify(res)}`);
      if (!res.ok || res.mode !== 'read') continue;
      assert.equal(res.kind, kind, name);
      assert.ok(res.url?.startsWith('aico-file://preview/'), `${name} 必须有短票 URL`);
      assert.equal(tokenPath(res), abs, `${name} 短票必须解析回原路径`);
    }
  } finally {
    cleanup(f);
  }
});

test('Phase B Office：不内嵌，给出系统打开提示', async () => {
  const f = seed();
  try {
    const abs = join(f.root, 'report.docx');
    writeFileSync(abs, 'fake-office');
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return;
    assert.equal(res.kind, 'office');
    assert.match(res.message ?? '', /系统打开/);
    assert.equal(res.url, undefined);
  } finally {
    cleanup(f);
  }
});

test('Phase B 越界：项目外文件、node_modules、.git 均显式拒', async () => {
  const f = seed();
  try {
    const outside = join(f.dir, 'outside.txt');
    writeFileSync(outside, 'x');
    const escape = await handleNotesPreview(f.deps, { projectId: 1, path: outside });
    assert.equal(escape.ok, false);
    if (!escape.ok) assert.equal(escape.code, 'path_escape');

    const dep = join(f.root, 'node_modules', 'pkg.txt');
    writeFileSync(dep, 'x');
    const inDeps = await handleNotesPreview(f.deps, { projectId: 1, path: dep });
    assert.equal(inDeps.ok, false);
    if (!inDeps.ok) assert.equal(inDeps.code, 'bad_request');

    mkdirSync(join(f.root, '.git'), { recursive: true });
    const gitFile = join(f.root, '.git', 'config');
    writeFileSync(gitFile, 'x');
    const inGit = await handleNotesPreview(f.deps, { projectId: 1, path: gitFile });
    assert.equal(inGit.ok, false);
    if (!inGit.ok) assert.equal(inGit.code, 'bad_request');
  } finally {
    cleanup(f);
  }
});

test('Phase B 系统打开：注入 openPath 成功；失败如实回；无注入显式不可用', async () => {
  const f = seed(async () => '');
  try {
    const abs = join(f.root, 'report.docx');
    writeFileSync(abs, 'x');
    const ok = await handleNotesPreview(f.deps, { projectId: 1, path: abs, mode: 'open' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.mode, 'open');

    const failDeps = { ...f.deps, openPath: async () => '失败原因' };
    const fail = await handleNotesPreview(failDeps, { projectId: 1, path: abs, mode: 'open' });
    assert.equal(fail.ok, false);
    if (!fail.ok) assert.match(fail.message, /失败原因/);

    const noDeps = { ...f.deps, openPath: undefined };
    const unavailable = await handleNotesPreview(noDeps, { projectId: 1, path: abs, mode: 'open' });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.code, 'open_unavailable');
  } finally {
    cleanup(f);
  }
});

test('Phase B 项目不存在：拒绝（不做全局回退，避免错根）', async () => {
  const f = seed();
  try {
    const abs = join(f.root, 'a.txt');
    writeFileSync(abs, 'x');
    const res = await handleNotesPreview(f.deps, { projectId: 99, path: abs });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'no_project');
  } finally {
    cleanup(f);
  }
});

test('Phase B 路径形状：只允许根浅层与 .aico/notes|docs 浅层，挡住未进列表的路径', () => {
  assert.equal(notesPreviewPathAllowed('README.md'), true);
  assert.equal(notesPreviewPathAllowed('.aico/notes/a.md'), true);
  assert.equal(notesPreviewPathAllowed('.aico/docs/a.md'), true);
  assert.equal(notesPreviewPathAllowed('.AICO/DOCS/a.md'), true, 'Windows 大小写应等价');
  assert.equal(notesPreviewPathAllowed('.aico/company.json'), false);
  assert.equal(notesPreviewPathAllowed('src/main/ipc/ipc.ts'), false);
  assert.equal(notesPreviewPathAllowed('node_modules/pkg/a.txt'), false);
  assert.equal(notesPreviewPathAllowed('.aico/docs/sub/a.md'), false);
  assert.equal(notesPreviewPathAllowed('.secret'), false);
});

test('Phase B symlink 指向根外：按真实路径拒绝（无权限建链则跳过）', async (t) => {
  const f = seed();
  try {
    const outside = join(f.dir, 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    const link = join(f.root, '.aico', 'notes', 'leak.txt');
    try {
      symlinkSync(outside, link, 'file');
    } catch {
      t.diagnostic('本机无 symlink 权限，跳过');
      return;
    }
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: link });
    assert.equal(res.ok, false, JSON.stringify(res));
    if (!res.ok) assert.equal(res.code, 'path_escape');
  } finally {
    cleanup(f);
  }
});

test('Phase B 其它隐藏目录：显式拒', async () => {
  const f = seed();
  try {
    mkdirSync(join(f.root, '.secret'), { recursive: true });
    const abs = join(f.root, '.secret', 'x.txt');
    writeFileSync(abs, 'x');
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'bad_request');
  } finally {
    cleanup(f);
  }
});

test('Phase B 20MB 上限：超限返回 too_large，不读文件', async () => {
  const f = seed();
  try {
    const abs = join(f.root, '.aico', 'docs', 'huge.txt');
    writeFileSync(abs, '');
    truncateSync(abs, NOTES_PREVIEW_CAP + 1);
    const res = await handleNotesPreview(f.deps, { projectId: 1, path: abs });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return;
    assert.equal(res.kind, 'too_large');
  } finally {
    cleanup(f);
  }
});
