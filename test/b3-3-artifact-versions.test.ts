/**
 * /：产物版本快照——inplace 登记时快照＋与上一版 diff。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, runMigrations } from '../src/main/db/index.js';
import { snapshotArtifactFile, diffSummary, diffWithPrevious, sha256 } from '../src/main/git/artifact-versions.js';

test('B3-3: snapshotArtifactFile——inplace 文件复制到 .aico/versions/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-3-snap-'));
  const { openDatabase } = await import('../src/main/db/open.js') as { openDatabase: (p: string) => import('../src/main/db/index.js').SqliteDb };
  const db = openDatabase(join(dir, 'aico.sqlite'));
  runMigrations(db);
  try {
    const srcFile = join(dir, 'report.md');
    writeFileSync(srcFile, '# v1', 'utf8');
    const snapPath = snapshotArtifactFile(db, 42, srcFile);
    assert.ok(snapPath != null, '快照路径返回');
    assert.ok(snapPath!.includes('.aico'), '快照在 .aico/versions/');
    assert.equal(readFileSync(snapPath!, 'utf8'), '# v1', '内容一致');
  } finally {
    db.close();
    await new Promise((r) => setTimeout(r, 50)); // WAL flush
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

test('B3-3: diffSummary——行级差异计数', () => {
  const d = diffSummary('a\nb\nc', 'a\nb\nd');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.changed, true);
  const same = diffSummary('x\ny', 'x\ny');
  assert.equal(same.changed, false);
});

test('B3-3: diffWithPrevious——同目录找上一版并对比', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-3-diff-'));
  const { openDatabase } = await import('../src/main/db/open.js') as { openDatabase: (p: string) => import('../src/main/db/index.js').SqliteDb };
  const db = openDatabase(join(dir, 'aico.sqlite'));
  runMigrations(db);
  try {
    const srcFile = join(dir, 'report.md');
    writeFileSync(srcFile, '# v1\n\ncontent', 'utf8');
    // 插 artifacts 行（diffWithPrevious 按 path 查库找同产物历史快照）
    db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(1,'P','D:/p',1)").run();
    db.prepare("INSERT INTO tasks(id, short_id, title, goal, state, project_id, created_at, updated_at) VALUES(1,'T-1','T','g','done',1,1,1)").run();
    db.prepare("INSERT INTO artifacts(task_id, work_item_id, path, kind, sha256, source, created_at) VALUES(1, NULL, 'report.md', 'file', 'a', 'test', 1)").run();
    const snap1 = snapshotArtifactFile(db, 1, srcFile);
    assert.ok(snap1 != null);
    // 第二条 artifacts 行（代表 v2 登记）
    db.prepare("INSERT INTO artifacts(task_id, work_item_id, path, kind, sha256, source, created_at) VALUES(1, NULL, 'report.md', 'file', 'b', 'test', 2)").run();
    // 改文件
    writeFileSync(srcFile, '# v2\n\nnew content', 'utf8');
    const snap2 = snapshotArtifactFile(db, 2, srcFile);
    assert.ok(snap2 != null);
    // diff 当前 vs snap1（按 artifacts 表 path='report.md' 查历史快照）
    const result = diffWithPrevious(db, 'report.md', srcFile);
    assert.equal(result.changed, true, 'v2 与 v1 有差异');
    assert.ok(result.added > 0 || result.removed > 0);
  } finally {
    db.close();
    await new Promise((r) => setTimeout(r, 50)); // WAL flush
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

test('B3-3: sha256——内容指纹', () => {
  assert.equal(sha256('hello'), sha256('hello'));
  assert.notEqual(sha256('hello'), sha256('world'));
});
