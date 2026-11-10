/**
 *  · 变更集只读 diff（`task:diff`）+ unified diff 投影。
 *
 * 判据：
 *  - 只接受变更集已登记 path；绝对路径/`..` 拒；
 *  - base/head 缺失显式 base_unknown；git 失败显式 git_failed（不返回仓库路径）；
 *  - 返回 diff 文本 + truncated；parser 的 old/new 行号正确。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertChangeset, insertChangesetFile, insertEmployee, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleReadChangesetDiff, type IpcDeps } from '../src/main/ipc/ipc.js';
import { parseUnifiedDiff } from '../src/renderer/components/changesetDiff.js';

const SAMPLE_DIFF = [
  'diff --git a/reconcile.py b/reconcile.py',
  'index 1111111..2222222 100644',
  '--- a/reconcile.py',
  '+++ b/reconcile.py',
  '@@ -44,3 +44,3 @@',
  ' def load_rows(path):',
  '-    rows = pd.read_excel(path)',
  '+    rows = pd.read_excel(path, dtype=str)',
  '     return rows.dropna()',
  '',
].join('\n');

function setup(over: { baseSha?: string | null; headSha?: string | null; path?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aico-diff-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: 'diff', rootDir: root, accessMode: 'staging', now: 1 });
  const task = repo.createTask({ projectId: project.id, title: 'diff task', goal: 'g', riskLevel: 0 });
  insertEmployee(db, { id: 1, name: '研究员', role: 'engineer', now: 1 });
  const cs = insertChangeset(db, {
    taskId: task.id,
    workItemId: null,
    baseSha: over.baseSha === undefined ? 'a'.repeat(40) : over.baseSha,
    headSha: over.headSha === undefined ? 'b'.repeat(40) : over.headSha,
    filesChanged: 1,
    insertions: 1,
    deletions: 1,
    state: 'open',
    now: 2,
  }).row;
  insertChangesetFile(db, {
    changesetId: cs.id,
    path: over.path ?? 'reconcile.py',
    status: 'modified',
    insertions: 1,
    deletions: 1,
    employeeId: 1,
  });
  const calls: string[][] = [];
  const deps: IpcDeps = {
    repo,
    db,
    git: {
      run(args) {
        calls.push(args);
        return { status: 0, stdout: SAMPLE_DIFF, stderr: '' };
      },
    },
  };
  return { db, root, task, cs, deps, calls, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('UG-06 task:diff：从变更集 base..head 读单文件 diff；只传登记 path', () => {
  const f = setup();
  try {
    const res = handleReadChangesetDiff(f.deps, {
      taskId: f.task.id,
      changesetId: f.cs.id,
      path: 'reconcile.py',
    });
    if (!res.ok) return assert.fail(res.message);
    assert.equal(res.ok, true);
    assert.equal(res.path, 'reconcile.py');
    assert.match(res.diff, /rows = pd\.read_excel\(path, dtype=str\)/);
    assert.equal(res.truncated, false);
    assert.equal(res.baseSha, 'a'.repeat(40));
    assert.equal(res.headSha, 'b'.repeat(40));
    assert.deepEqual(f.calls[0]?.slice(0, 4), ['diff', '--no-color', '--unified=3', 'a'.repeat(40)]);
    assert.equal(f.calls[0]?.includes('reconcile.py'), true);
  } finally {
    f.cleanup();
  }
});

test('UG-06 task:diff：绝对路径 / .. / 未登记文件 → 拒；base 缺失 → base_unknown', () => {
  const f = setup();
  try {
    for (const path of ['C:/abs.py', '../escape.py']) {
      const res = handleReadChangesetDiff(f.deps, { taskId: f.task.id, changesetId: f.cs.id, path });
      assert.equal(res.ok, false, `${path} 应被拒`);
      if (!res.ok) assert.equal(res.code, 'bad_request');
    }
    const other = handleReadChangesetDiff(f.deps, { taskId: f.task.id, changesetId: f.cs.id, path: 'other.py' });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.code, 'not_found');

    const unknown = setup({ baseSha: null });
    try {
      const res = handleReadChangesetDiff(unknown.deps, {
        taskId: unknown.task.id,
        changesetId: unknown.cs.id,
        path: 'reconcile.py',
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, 'base_unknown');
    } finally {
      unknown.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('UG-06 task:diff：git 失败 → git_failed（不把 stderr/路径交给 renderer）', () => {
  const f = setup();
  try {
    const deps: IpcDeps = {
      ...f.deps,
      git: { run: () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision C:/secret/path' }) },
    };
    const res = handleReadChangesetDiff(deps, { taskId: f.task.id, changesetId: f.cs.id, path: 'reconcile.py' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'git_failed');
      assert.equal(res.message.includes('C:/secret/path'), false);
    }
  } finally {
    f.cleanup();
  }
});

test('UG-06 parseUnifiedDiff：old/new 行号与 add/del/context 分类', () => {
  const rows = parseUnifiedDiff(SAMPLE_DIFF);
  const relevant = rows.filter((row) => row.kind === 'context' || row.kind === 'add' || row.kind === 'del');
  assert.deepEqual(
    relevant.map((row) => [row.oldNo, row.newNo, row.kind, row.text.trim()]),
    [
      [44, 44, 'context', 'def load_rows(path):'],
      [45, null, 'del', 'rows = pd.read_excel(path)'],
      [null, 45, 'add', 'rows = pd.read_excel(path, dtype=str)'],
      [46, 46, 'context', 'return rows.dropna()'],
    ],
  );
  assert.ok(rows.some((row) => row.kind === 'hunk'));
  assert.ok(rows.some((row) => row.kind === 'meta'));
  assert.deepEqual(parseUnifiedDiff(''), []);
});
