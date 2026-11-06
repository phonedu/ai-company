/**
 * M3-DOC-1 · 项目文档骨架模板守据。
 *
 * 判据：
 *  ① 新建项目默认生成 `.aico/docs` 四件（入口/宪章/状态/命名），且模板自身通过 `docs:check`（零 issue）；
 *  ② `docsTemplate:false` 只建 README（不偷偷代建文档树）；
 *  ③ 已存在文件**逐个跳过、绝不覆盖**（含并发 `EEXIST` 兜底）；
 *  ④ UI/Store 真有开关与透传（不是只写后端）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleDocsCheck, handleProjectCreate, type IpcDeps } from '../src/main/ipc/ipc.js';
import { applyDocsTemplate } from '../src/main/docs/template.js';

const AT = 1_800_000_000_000;

function fixture(): { dir: string; db: ReturnType<typeof openMemoryDatabase>; deps: IpcDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-docstpl-'));
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { dir, db, deps: { repo, pickDirectory: async () => dir } };
}

function cleanup(f: { dir: string; db: ReturnType<typeof openMemoryDatabase> }): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test('project:create 默认生成 .aico/docs 四件；模板自身通过 docs:check（零 issue）', async () => {
  const f = fixture();
  try {
    const res = await handleProjectCreate(f.deps, { name: '模板项目' }, AT);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const target = join(f.dir, '模板项目');
    assert.ok(existsSync(join(target, '.aico', 'docs', 'README.md')), '缺文档入口');
    assert.deepEqual(
      res.docsTemplate?.created.slice().sort(),
      ['00-项目宪章.md', '05-状态与计划.md', 'README.md', 'naming.md'],
      '默认应创建四件模板',
    );
    assert.deepEqual(res.docsTemplate?.skipped, [], '新项目无既有文件可跳过');

    const check = handleDocsCheck(f.deps, { projectId: res.project.id });
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.equal(check.hasDocsTree, true);
    assert.equal(check.counts.live, 4, `活文档应为 4（实际 ${JSON.stringify(check.counts)}）`);
    assert.deepEqual(check.issues, [], '模板自身必须能过默认检查器（入口/头注/索引/引用/体量）');
  } finally {
    cleanup(f);
  }
});

test('docsTemplate:false ⇒ 只建 README，不代建 .aico（不偷偷替用户决定）', async () => {
  const f = fixture();
  try {
    const res = await handleProjectCreate(f.deps, { name: '不要文档树', docsTemplate: false }, AT);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const target = join(f.dir, '不要文档树');
    assert.ok(existsSync(join(target, 'README.md')), 'README 骨架仍应在');
    assert.equal(res.docsTemplate, undefined, '显式关闭时不应回报模板结果');
    assert.ok(!existsSync(join(target, '.aico')), '未勾选时不得创建 .aico');
  } finally {
    cleanup(f);
  }
});

test('applyDocsTemplate 对已有文件逐个跳过，绝不覆盖（可重复执行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-docstpl-apply-'));
  try {
    const first = applyDocsTemplate(dir, '已有项目');
    assert.equal(first.created.length, 4);
    const readme = join(dir, '.aico', 'docs', 'README.md');
    writeFileSync(readme, '# 用户改过的入口\n\n别覆盖我\n', 'utf8');

    const second = applyDocsTemplate(dir, '已有项目');
    assert.deepEqual(second.created, [], '第二次不应新建任何文件');
    assert.deepEqual(second.skipped.slice().sort(), first.created.slice().sort(), '四件均被跳过');
    assert.equal(readFileSync(readme, 'utf8'), '# 用户改过的入口\n\n别覆盖我\n', '已有文件必须原样');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UI/Store 接线：新建项目表单有文档骨架开关，且把选择透传给主进程', () => {
  const page = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
  assert.ok(page.includes('data-testid="project-create-docs"'), '缺文档骨架复选框');
  assert.ok(page.includes('createProject(name.trim(), docsTemplate)'), '选择未透传给 createProject');
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.ok(store.includes('docsTemplate'), 'store 未透传 docsTemplate');
});
