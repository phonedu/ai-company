/**
 *  · 文档检查挂任务验收项 + P6 命令门禁守据。
 *
 * 判据：
 *  ① 项目开关默认开：新建任务自动带 `{check:'aico:docs-check'}`；关＝不带；显式同检查不重复；
 *  ② `aico:docs-check` 真跑检查器（通过/悬空失败）；项目关/无树 ⇒ skip（未检查，不冒充通过）；
 *  ③ 普通 check 命令真执行：exit 0 pass、非 0 fail；
 *  ④ 项目 DTO 暴露 `docsCheckEnabled`，写开关落库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acceptanceTexts, createTask, openMemoryDatabase, runMigrations, SqliteCounterStore } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectDocsCheckSet, handleTaskCreate, type IpcDeps } from '../src/main/ipc/ipc.js';
import { DOCS_CHECK_COMMAND, parseAcceptanceChecks, runAcceptanceChecks } from '../src/main/agent/acceptance-checks.js';

function fixture(): {
  dir: string;
  root: string;
  db: ReturnType<typeof openMemoryDatabase>;
  repo: ReturnType<typeof createSqliteChatRepo>;
  projectId: number;
  deps: IpcDeps;
} {
  const dir = mkdtempSync(join(tmpdir(), 'aico-docs-accept-'));
  const root = join(dir, 'proj');
  const docs = join(root, '.aico', 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'README.md'), '# 入口\n\n正文\n', 'utf8');
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: '验收项目', rootDir: root, accessMode: 'inplace', now: 1 });
  return { dir, root, db, repo, projectId: project.id, deps: { repo } };
}

function cleanup(f: { dir: string; db: ReturnType<typeof openMemoryDatabase> }): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test('项目开关默认开；新建任务自动挂 aico:docs-check；关闭后不挂；显式同检查不重复', async () => {
  const f = fixture();
  try {
    assert.equal(f.repo.getProject(f.projectId)?.docsCheckEnabled, true, '新项目默认开');
    const t1 = await handleTaskCreate(f.deps, { projectId: f.projectId, title: '默认挂', goal: 'g' });
    assert.ok(
      t1.acceptance.some((a) => (a as { check?: string }).check === DOCS_CHECK_COMMAND),
      '默认应挂文档检查',
    );

    const off = handleProjectDocsCheckSet(f.deps, { projectId: f.projectId, enabled: false });
    assert.equal(off.ok, true);
    if (off.ok) assert.equal(off.project.docsCheckEnabled, false);
    const t2 = await handleTaskCreate(f.deps, { projectId: f.projectId, title: '关闭', goal: 'g' });
    assert.equal(
      t2.acceptance.some((a) => (a as { check?: string }).check === DOCS_CHECK_COMMAND),
      false,
      '关闭后不应自动挂',
    );

    const l0 = await handleTaskCreate(f.deps, { projectId: f.projectId, title: 'L0 直通', goal: 'g', riskLevel: 0 });
    assert.equal(
      l0.acceptance.some((a) => (a as { check?: string }).check === DOCS_CHECK_COMMAND),
      false,
      'L0 免验不挂文档检查（没有 verifier 执行者）',
    );

    const on = handleProjectDocsCheckSet(f.deps, { projectId: f.projectId, enabled: true });
    assert.equal(on.ok, true);
    const t3 = await handleTaskCreate(f.deps, {
      projectId: f.projectId,
      title: '显式',
      goal: 'g',
      acceptance: [{ text: '我自己写的文档检查', check: DOCS_CHECK_COMMAND }],
    });
    assert.equal(
      t3.acceptance.filter((a) => (a as { check?: string }).check === DOCS_CHECK_COMMAND).length,
      1,
      '用户显式给同一检查时不得重复',
    );
    assert.equal(parseAcceptanceChecks(t3.acceptance).length, 1);
  } finally {
    cleanup(f);
  }
});

test('aico:docs-check 真跑检查器：通过 → pass；悬空 → fail；项目关/无树 → skip', () => {
  const f = fixture();
  try {
    const db = f.db;
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId: f.projectId,
      title: '文档检查',
      goal: 'g',
      acceptance: [{ text: '文档检查', check: DOCS_CHECK_COMMAND }],
    });
    const pass = runAcceptanceChecks(db, task.id);
    assert.equal(pass.items[0]?.status, 'pass');
    assert.equal(pass.failed, false);

    writeFileSync(join(f.root, '.aico', 'docs', 'README.md'), '# 入口\n\n[坏链](gone.md)\n', 'utf8');
    const fail = runAcceptanceChecks(db, task.id);
    assert.equal(fail.items[0]?.status, 'fail');
    assert.equal(fail.failed, true);
    assert.match(fail.items[0]?.reason ?? '', /悬空|问题 1/);

    f.repo.projectDocsCheckSet({ projectId: f.projectId, enabled: false });
    const skip = runAcceptanceChecks(db, task.id);
    assert.equal(skip.items[0]?.status, 'skip');
    assert.match(skip.items[0]?.reason ?? '', /未检查/);

    f.repo.projectDocsCheckSet({ projectId: f.projectId, enabled: true });
    rmSync(join(f.root, '.aico'), { recursive: true, force: true });
    const noTree = runAcceptanceChecks(db, task.id);
    assert.equal(noTree.items[0]?.status, 'skip');
    assert.match(noTree.items[0]?.reason ?? '', /无 .aico\/docs/);
  } finally {
    cleanup(f);
  }
});

test('普通 check 命令：exit 0 pass；非 0 fail（硬门数据源）', () => {
  const f = fixture();
  try {
    const db = f.db;
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId: f.projectId,
      title: '命令门禁',
      goal: 'g',
      acceptance: [
        { text: '通过命令', check: 'node -e "process.exit(0)"' },
        { text: '失败命令', check: 'node -e "process.exit(2)"' },
      ],
    });
    const res = runAcceptanceChecks(db, task.id, { cwd: process.cwd() });
    assert.equal(res.items[0]?.status, 'pass');
    assert.equal(res.items[1]?.status, 'fail');
    assert.equal(res.failed, true, '任一命令失败 → 硬门');
  } finally {
    cleanup(f);
  }
});

test('规划/员工上下文过滤机器文档检查（不把它当“要干的一步”）', () => {
  const texts = acceptanceTexts([
    { text: '写出结论' },
    { text: '文档检查通过（.aico/docs）', check: DOCS_CHECK_COMMAND },
  ]);
  assert.deepEqual(texts, ['写出结论']);
  assert.deepEqual(parseAcceptanceChecks([{ text: '文档检查', check: DOCS_CHECK_COMMAND }]).length, 1, '机器检查仍要执行');
});

test('UI/Store 接线：项目概览有文档检查开关，store 透传 project:docs-check-set', () => {
  const page = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.ok(page.includes('data-testid="docs-check-enabled"'), '缺项目文档检查开关');
  assert.ok(page.includes('saveProjectDocsCheck'), '开关未接 store');
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.ok(store.includes('project.docsCheckSet'), 'store 未调 project:docs-check-set');
});
