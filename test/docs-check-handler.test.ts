/**
 * M2 §7 序 4 · `docs:check` handler 守据（真库＋真临时目录）。
 *
 * 口径：文档根＝`<项目根>/.aico/docs`；**不存在 ⇒ `hasDocsTree:false` ＋ 零计数且不代建**（模板属 M3）；
 * 跳过依赖/产物目录与符号链接；只读（不改任何文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleDocsCheck, type IpcDeps } from '../src/main/ipc/ipc.js';

const HEADER = '> **头注**｜状态：在办｜规范的家：本件｜关闭时处置：归档\n\n正文\n';

function fixture(): { dir: string; root: string; db: ReturnType<typeof openMemoryDatabase>; deps: IpcDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-docs-'));
  const root = join(dir, 'proj');
  mkdirSync(root, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(7, '文档项目', root, 1);
  return { dir, root, db, deps: { repo: createSqliteChatRepo(db) } };
}

function cleanup(f: { dir: string; db: ReturnType<typeof openMemoryDatabase> }): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test('docs:check: 无 `.aico/docs` ⇒ hasDocsTree:false ＋ 零计数，且**不代建**任何目录', () => {
  const f = fixture();
  try {
    const res = handleDocsCheck(f.deps, { projectId: 7 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.hasDocsTree, false);
    assert.deepEqual(res.counts, { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 });
    assert.deepEqual(res.issues, []);
    assert.equal(res.truncated, false);
    assert.ok(!existsSync(join(f.root, '.aico')), '检查是只读的：不得代建 `.aico`（模板属 M3）');
  } finally {
    cleanup(f);
  }
});

test('docs:check·有牙: 脏文档树 → 悬空计数＋1 且点名；修好后归零（真文件系统走一遍）', () => {
  const f = fixture();
  try {
    const docs = join(f.root, '.aico', 'docs');
    mkdirSync(join(docs, 'guide'), { recursive: true });
    mkdirSync(join(docs, 'node_modules', 'pkg'), { recursive: true }); // 应被跳过
    writeFileSync(join(docs, 'README.md'), '# 入口\n\n- [坏链](./guide/gone.md)\n', 'utf8');
    writeFileSync(join(docs, 'guide', 'a.md'), HEADER, 'utf8');
    writeFileSync(join(docs, 'guide', 'b.md'), HEADER, 'utf8');
    writeFileSync(join(docs, 'guide', 'README.md'), '# guide\n\n- a.md · b.md\n', 'utf8');
    writeFileSync(join(docs, 'node_modules', 'pkg', 'junk.md'), '不该被检查\n', 'utf8');

    const dirty = handleDocsCheck(f.deps, { projectId: 7 });
    assert.equal(dirty.ok, true);
    if (!dirty.ok) return;
    assert.equal(dirty.hasDocsTree, true);
    assert.equal(dirty.counts.dangling, 1, `悬空必须恰好 1（实际 ${JSON.stringify(dirty.counts)}）`);
    assert.ok(dirty.issues.some((i) => i.kind === 'ref' && i.message.includes('gone.md')), '悬空引用必须点名');
    assert.equal(dirty.counts.live, 4, '活文档＝README＋guide/README＋a＋b（node_modules 被跳过）');

    // 有牙的"牙"：修好坏链 → 归零（证明上一条不是恒真）
    writeFileSync(join(docs, 'README.md'), '# 入口\n\n- [好链](./guide/a.md)\n', 'utf8');
    const fixed = handleDocsCheck(f.deps, { projectId: 7 });
    assert.equal(fixed.ok, true);
    if (!fixed.ok) return;
    assert.equal(fixed.counts.dangling, 0);
    assert.deepEqual(fixed.issues, []);
  } finally {
    cleanup(f);
  }
});

test('docs:check: 入参/项目不存在各给明确码（不臆造）', () => {
  const f = fixture();
  try {
    assert.equal((handleDocsCheck(f.deps, {}) as { code: string }).code, 'bad_request');
    assert.equal((handleDocsCheck(f.deps, { projectId: 999 }) as { code: string }).code, 'not_found');
    assert.equal((handleDocsCheck(f.deps, { projectId: -1 }) as { code: string }).code, 'bad_request');
  } finally {
    cleanup(f);
  }
});
