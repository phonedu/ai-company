/**
 * B3-2/D-31③：多文档根注册层——project_documents DAO＋读边界扩展。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import {
  insertProjectDocument,
  listProjectDocuments,
  disableProjectDocument,
  projectDocRoots,
} from '../src/main/db/project_documents.js';
import type { SqliteDb } from '../src/main/db/index.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('B3-2: project_documents——插入/列表/禁用；绝对路径校验', () => {
  const db = fresh();
  try {
    const projectId = Number(
      (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
    );
    const r1 = insertProjectDocument(db, { projectId, dir: 'D:/knowledge', label: '知识库', now: 1 });
    assert.ok(r1.ok, '合法插入');
    const r2 = insertProjectDocument(db, { projectId, dir: 'D:/素材', now: 2 });
    assert.ok(r2.ok, '中文 label 自动取目录名');
    assert.equal(listProjectDocuments(db, projectId).length, 2, '两条启用中');
    // 相对路径拒
    assert.equal(insertProjectDocument(db, { projectId, dir: 'relative/path' }).ok, false, '相对路径拒');
    assert.equal(insertProjectDocument(db, { projectId, dir: '' }).ok, false, '空路径拒');
    // 禁用
    disableProjectDocument(db, r1.ok ? r1.id : 0);
    assert.equal(listProjectDocuments(db, projectId).length, 1, '禁用后只剩 1 条');
    // 读边界扩展
    assert.deepEqual(projectDocRoots(db, projectId), ['D:/素材'], 'projectDocRoots 只返回启用的根');
  } finally {
    db.close();
  }
});

test('B3-2: 多文档根——两项目互不干扰', () => {
  const db = fresh();
  try {
    const p1 = Number(
      (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('A','D:/a',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
    );
    const p2 = Number(
      (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('B','D:/b',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
    );
    insertProjectDocument(db, { projectId: p1, dir: 'D:/a-docs', now: 1 });
    insertProjectDocument(db, { projectId: p2, dir: 'D:/b-docs', now: 2 });
    assert.deepEqual(projectDocRoots(db, p1), ['D:/a-docs']);
    assert.deepEqual(projectDocRoots(db, p2), ['D:/b-docs']);
  } finally {
    db.close();
  }
});
