/**
 *  · 一键整理（索引补全）守据。
 *
 * 判据：
 *  ① 只补含 ≥2 个 md 的子目录索引；只追加、不删改；根目录/归档区/单文件目录不碰；
 *  ② 预览不写文件；token 防“预览后目标 README 变了仍照写”；
 *  ③ 越界/符号链接拒绝；写入失败按备份回滚（新建删除、旧文恢复）；
 *  ④ 真临时目录预览→应用→检查归零；UI 有预览/应用/取消入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleDocsCheck, handleDocsOrganizeApply, handleDocsOrganizePreview, type IpcDeps } from '../src/main/ipc/ipc.js';
import {
  applyDocsIndexChanges,
  buildDocsIndexPlan,
  docsOrganizeToken,
  type DocsIndexChange,
  type OrganizeIo,
} from '../src/main/docs/organize.js';

const HEADER = '> **头注**｜状态：在办｜规范的家：本件｜关闭时处置：归档\n\n正文\n';

function readFrom(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

test('buildDocsIndexPlan：子目录缺 README → 新建并列出全部 md；已有 README → 只追加缺失项', () => {
  const newDir = buildDocsIndexPlan(['guide/a.md', 'guide/b.md'], readFrom({}));
  assert.equal(newDir.length, 1);
  assert.equal(newDir[0]?.path, 'guide/README.md');
  assert.equal(newDir[0]?.before, null);
  assert.deepEqual(newDir[0]?.added, ['a.md', 'b.md']);
  assert.match(newDir[0]?.after ?? '', /`a\.md`/);
  assert.match(newDir[0]?.after ?? '', /`b\.md`/);

  const partial = buildDocsIndexPlan(
    ['guide/a.md', 'guide/b.md'],
    readFrom({ 'guide/README.md': '# guide\n\n- `a.md`\n' }),
  );
  assert.equal(partial.length, 1);
  assert.deepEqual(partial[0]?.added, ['b.md']);
  assert.ok((partial[0]?.after ?? '').startsWith('# guide\n\n- `a.md`\n'), '已有内容必须原样保留（只追加）');
  assert.ok((partial[0]?.after ?? '').includes('`b.md`'));

  assert.deepEqual(buildDocsIndexPlan(['guide/a.md', 'guide/b.md'], readFrom({ 'guide/README.md': '- a.md\n- b.md\n' })), []);
});

test('buildDocsIndexPlan：根目录/单内容文件目录/归档区不碰（保守边界）', () => {
  assert.deepEqual(buildDocsIndexPlan(['a.md', 'b.md'], readFrom({})), [], '根 README 不由整理代建');
  assert.deepEqual(buildDocsIndexPlan(['guide/a.md'], readFrom({})), [], '只有一个内容文件的目录不代建 README');
  assert.deepEqual(buildDocsIndexPlan(['history/a.md', 'history/b.md'], readFrom({})), [], '归档区不碰');
  // 已有 README ＋ 一个内容文件：检查器要求索引点名 → 整理只补这一项。
  const one = buildDocsIndexPlan(['guide/a.md', 'guide/README.md'], readFrom({ 'guide/README.md': '# guide\n' }));
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]?.added, ['a.md']);
});

test('applyDocsIndexChanges：正常写入；token 随项目/计划变化', () => {
  const root = join(tmpdir(), 'aico-organize-memory');
  const target = join(root, 'guide', 'README.md');
  const map = new Map<string, string>();
  const io: OrganizeIo = {
    stat: (abs) => ({ exists: map.has(abs), symlink: false }),
    read: (abs) => map.get(abs) ?? null,
    write: (abs, content) => map.set(abs, content),
    remove: (abs) => map.delete(abs),
  };
  const changes = buildDocsIndexPlan(['guide/a.md', 'guide/b.md'], readFrom({}));
  assert.equal(changes.length, 1);
  const res = applyDocsIndexChanges(root, changes, io);
  assert.deepEqual(res, { ok: true, applied: ['guide/README.md'] });
  assert.ok((map.get(target) ?? '').includes('a.md'));

  const token = docsOrganizeToken(7, changes);
  assert.notEqual(token, docsOrganizeToken(8, changes), '项目不同 token 不同');
  assert.notEqual(token, docsOrganizeToken(7, []), '计划不同 token 不同');
});

test('applyDocsIndexChanges：stale / 符号链接 / 越界 均拒绝且不写', () => {
  const root = join(tmpdir(), 'aico-organize-memory');
  const changes = buildDocsIndexPlan(['guide/a.md', 'guide/b.md'], readFrom({}));
  const target = join(root, 'guide', 'README.md');

  const staleMap = new Map<string, string>([[target, '# 用户刚写的\n']]);
  const stale = applyDocsIndexChanges(root, changes, {
    stat: (abs) => ({ exists: staleMap.has(abs), symlink: false }),
    read: (abs) => staleMap.get(abs) ?? null,
    write: (abs, content) => staleMap.set(abs, content),
    remove: (abs) => staleMap.delete(abs),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'stale');
  assert.equal(staleMap.get(target), '# 用户刚写的\n', 'stale 不得覆盖');

  const symlinked = applyDocsIndexChanges(root, changes, {
    stat: () => ({ exists: true, symlink: true }),
    read: () => null,
    write: () => assert.fail('不应写符号链接'),
    remove: () => assert.fail('不应删符号链接'),
  });
  assert.equal(symlinked.ok, false);
  if (!symlinked.ok) assert.equal(symlinked.code, 'unsafe');

  const escaped: DocsIndexChange[] = [{ path: '../evil/README.md', before: null, after: '# x\n', added: ['x.md'] }];
  const out = applyDocsIndexChanges(root, escaped, {
    stat: () => ({ exists: false, symlink: false }),
    read: () => null,
    write: () => assert.fail('不应写越界路径'),
    remove: () => undefined,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, 'unsafe');
});

test('applyDocsIndexChanges：第二个写入失败 → 已写文件回滚（旧文恢复/新建删除）', () => {
  const root = join(tmpdir(), 'aico-organize-memory');
  const map = new Map<string, string>([
    [join(root, 'a', 'keep.md'), 'old-a'],
    [join(root, 'b', 'keep.md'), 'old-b'],
  ]);
  const changes = buildDocsIndexPlan(['a/one.md', 'a/two.md', 'b/one.md', 'b/two.md'], (p) => map.get(join(root, ...p.split('/'))) ?? null);
  assert.equal(changes.length, 2);
  const secondTarget = join(root, 'b', 'README.md');
  const res = applyDocsIndexChanges(root, changes, {
    stat: (abs) => ({ exists: map.has(abs), symlink: false }),
    read: (abs) => map.get(abs) ?? null,
    write: (abs, content) => {
      if (abs === secondTarget) throw new Error('磁盘满');
      map.set(abs, content);
    },
    remove: (abs) => map.delete(abs),
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'write_failed');
    assert.equal(res.rolledBack, true);
    assert.deepEqual(res.applied, ['a/README.md']);
  }
  assert.equal(map.has(join(root, 'a', 'README.md')), false, '新建的第一个 README 应被删除');
  assert.equal(map.has(secondTarget), false, '第二个未写成功');
});

function fixture(): { dir: string; root: string; projectId: number; db: ReturnType<typeof openMemoryDatabase>; deps: IpcDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-organize-'));
  const root = join(dir, 'proj');
  const docs = join(root, '.aico', 'docs');
  mkdirSync(join(docs, 'guide'), { recursive: true });
  writeFileSync(join(docs, 'README.md'), '# 入口\n', 'utf8');
  writeFileSync(join(docs, 'guide', 'a.md'), HEADER, 'utf8');
  writeFileSync(join(docs, 'guide', 'b.md'), HEADER, 'utf8');
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: '整理项目', rootDir: root, accessMode: 'inplace', now: 1 });
  return { dir, root, projectId: project.id, db, deps: { repo } };
}

test('handler：预览不写 → 应用补索引 → docs:check 归零；预览后目标出现 ⇒ stale_plan', () => {
  const f = fixture();
  try {
    const preview = handleDocsOrganizePreview(f.deps, { projectId: f.projectId });
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.hasDocsTree, true);
    assert.equal(preview.changes.length, 1, '只应补 guide/README.md');
    assert.equal(existsSync(join(f.root, '.aico', 'docs', 'guide', 'README.md')), false, '预览不得写文件');
    assert.ok(preview.token);

    const applied = handleDocsOrganizeApply(f.deps, { projectId: f.projectId, token: preview.token });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.deepEqual(applied.applied, ['guide/README.md']);
    const readme = readFileSync(join(f.root, '.aico', 'docs', 'guide', 'README.md'), 'utf8');
    assert.match(readme, /a\.md/);
    assert.match(readme, /b\.md/);
    const check = handleDocsCheck(f.deps, { projectId: f.projectId });
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.equal(check.counts.issues, 0, '补索引后检查应归零');

    // 新造一个目录 → 预览；预览后手写 README → 应用必须 stale_plan（不覆盖人的改动）。
    writeFileSync(join(f.root, '.aico', 'docs', 'guide', 'c.md'), HEADER, 'utf8');
    const again = handleDocsOrganizePreview(f.deps, { projectId: f.projectId });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.changes.length, 1);
    writeFileSync(join(f.root, '.aico', 'docs', 'guide', 'README.md'), '# 人手改的索引\n', 'utf8');
    const stale = handleDocsOrganizeApply(f.deps, { projectId: f.projectId, token: again.token });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'stale_plan');
    assert.equal(readFileSync(join(f.root, '.aico', 'docs', 'guide', 'README.md'), 'utf8'), '# 人手改的索引\n');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('UI/Store 接线：预览/应用/取消与 diff 预览在场', () => {
  const page = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  for (const id of ['docs-organize-preview', 'docs-organize-plan', 'docs-organize-apply', 'docs-organize-cancel', 'docs-organize-diff']) {
    assert.ok(page.includes(`data-testid="${id}"`), `缺 ${id}`);
  }
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.ok(store.includes('previewProjectDocsOrganize'), 'store 缺预览');
  assert.ok(store.includes('applyProjectDocsOrganize'), 'store 缺应用');
});
