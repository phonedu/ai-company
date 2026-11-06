/**
 * S13-G（2026-10-29）：四项延后改进的可执行锚。
 *
 * 判据：
 *   D-N06 合并目标分支可配：迁移 022 落列；设置了目标分支就只认它；非法分支名拒且不落库；
 *         merge 的 not_on_base 文案要说清「配置了多少」而不是永远说 main/master。
 *   D-N07 合并冲突结构化：store 把 conflicts 留在 taskDetail（成功即清空）；
 *         详情面板有 `merge-conflict-panel` / 文件列表 / 重试按钮。
 *   D-N09 diff 审查进度：localStorage 键 + 「下一处未看」按钮存在（读写口径同源）。
 *   C3 项目变更历史：`project:get` 回带 changesets（读面仍走同一通道，不新增 IPC）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertChangeset,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { createGitRunner, mergeChangeset } from '../src/main/git/index.js';
import { setProjectTargetBranch } from '../src/main/db/projects.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectGet, handleProjectTargetBranchSet } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-s13g-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'aico@example.test']);
  git(root, ['config', 'user.name', 'AICO Test']);
  writeFileSync(join(root, 'a.txt'), 'base\n', 'utf8');
  git(root, ['add', '--', 'a.txt']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', '-M', 'main']);
  return root;
}

function setupDb(root: string): { db: SqliteDb; projectId: number; deps: { repo: ReturnType<typeof createSqliteChatRepo> } } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P',?,1)").run(root).lastInsertRowid,
  );
  return { db, projectId, deps: { repo: createSqliteChatRepo(db) } };
}

test('D-N06① 迁移 022：projects 有 target_branch，且默认 NULL（不臆造主干名）', () => {
  const { db } = setupDb(mkdtempSync(join(tmpdir(), 'aico-s13g-m-')));
  try {
    const cols = db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === 'target_branch'), '022 应有 projects.target_branch');
    const row = db.prepare('SELECT target_branch FROM projects LIMIT 1').get() as { target_branch: string | null };
    assert.equal(row.target_branch, null, '已有项目行默认 NULL（不臆造主干名）');
  } finally {
    db.close();
  }
});

test('D-N06② 设置/清空目标分支：trim 落库；空串归一 NULL', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-s13g-b-'));
  const { db, projectId } = setupDb(root);
  try {
    assert.equal(setProjectTargetBranch(db, projectId, '  trunk  ')?.target_branch, 'trunk');
    assert.equal(setProjectTargetBranch(db, projectId, '')?.target_branch, null);
    assert.equal(setProjectTargetBranch(db, projectId, null)?.target_branch, null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('D-N06③ IPC：非法分支名拒且不落库；合法名回报 DTO.targetBranch', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-s13g-i-'));
  const { db, projectId, deps } = setupDb(root);
  try {
    for (const bad of ['a..b', '-lead', '/lead', 'has space', 'x;rm']) {
      const res = handleProjectTargetBranchSet(deps, { projectId, branch: bad }) as { ok: false; code: string };
      assert.equal(res.ok, false, `${bad} 应拒`);
      assert.equal(res.code, 'bad_branch');
    }
    const row = db.prepare('SELECT target_branch FROM projects WHERE id = ?').get(projectId) as { target_branch: string | null };
    assert.equal(row.target_branch, null, '非法值不落库');

    const good = handleProjectTargetBranchSet(deps, { projectId, branch: 'release/2026' }) as {
      ok: true;
      project: { targetBranch: string | null };
    };
    assert.equal(good.ok, true);
    assert.equal(good.project.targetBranch, 'release/2026');
    const dto = handleProjectGet(deps, { projectId }) as { targetBranch: string | null } | null;
    assert.equal(dto?.targetBranch, 'release/2026', '读面仍走 project:get');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('D-N06④ merge：配了 trunk 就在 trunk 上合；没配仍只认 main/master 且文案提示可配', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    // trunk 线：从 main 建 trunk，任务分支从 main 出发改同一文件
    git(root, ['checkout', '-b', 'trunk', 'main']);
    const baseSha = git(root, ['rev-parse', 'trunk']).trim();
    git(root, ['checkout', '-b', 'aico/T-2001', 'trunk']);
    writeFileSync(join(root, 'a.txt'), 'trunk-line\n', 'utf8');
    git(root, ['add', '--', 'a.txt']);
    git(root, ['commit', '-m', 'trunk change']);
    const headSha = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['checkout', 'trunk']);

    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'D-N06', goal: 'g', riskLevel: 0 });
    const cs = insertChangeset(db, {
      taskId: task.id,
      workItemId: null,
      branch: 'aico/T-2001',
      baseSha,
      headSha,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      state: 'open',
      now: AT,
    });

    // 未配置 → trunk 不是 main/master：拒，且文案点明「可在设置里指定」
    const withoutCfg = mergeChangeset({ db, git: createGitRunner(), taskId: task.id, changesetId: cs.row.id, repoRoot: root, now: AT });
    assert.equal(withoutCfg.ok, false);
    if (!withoutCfg.ok) {
      assert.equal(withoutCfg.code, 'not_on_base');
      assert.match(withoutCfg.message, /可在设置里指定目标分支/);
    }

    // 配置成 trunk → 合得进去
    setProjectTargetBranch(db, projectId, 'trunk');
    const withCfg = mergeChangeset({
      db,
      git: createGitRunner(),
      taskId: task.id,
      changesetId: cs.row.id,
      repoRoot: root,
      targetBranch: 'trunk',
      now: AT,
    });
    assert.equal(withCfg.ok, true, withCfg.ok ? '' : withCfg.message);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'trunk-line\n');

    // 配置成 develop 但当前在 trunk → 拒，文案点明配置值
    git(root, ['checkout', '-b', 'aico/T-2002', 'main']);
    writeFileSync(join(root, 'a.txt'), 'second\n', 'utf8');
    git(root, ['add', '--', 'a.txt']);
    git(root, ['commit', '-m', 'second']);
    const head2 = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['checkout', 'trunk']);
    const task2 = createTask(db, new SqliteCounterStore(db), { projectId, title: 'D-N06-b', goal: 'g', riskLevel: 0 });
    const cs2 = insertChangeset(db, {
      taskId: task2.id,
      workItemId: null,
      branch: 'aico/T-2002',
      baseSha: head2,
      headSha: head2,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      state: 'open',
      now: AT,
    });
    const wrong = mergeChangeset({
      db,
      git: createGitRunner(),
      taskId: task2.id,
      changesetId: cs2.row.id,
      repoRoot: root,
      targetBranch: 'develop',
      now: AT,
    });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.match(wrong.message, /develop/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('D-N07 冲突留在 store，成功即清空', () => {
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.match(store, /mergeConflicts: \[\] as string\[\]/);
  assert.match(store, /mergeConflictChangesetId: null as number \| null/);
  assert.match(
    store,
    /if \(res\?\.ok === true\) \{[\s\S]{0,200}mergeConflicts = \[\][\s\S]{0,120}mergeConflictChangesetId = null;/,
    '合并成功要清掉旧冲突',
  );
  assert.match(store, /Array\.isArray\(res\?\.conflicts\)[\s\S]{0,120}mergeConflicts = res\.conflicts/);
});

test('D-N07 详情面板：结构化冲突块 + 重试按钮 + 类型贯通到容器', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /data-testid="merge-conflict-panel"/);
  assert.match(detail, /data-testid="merge-conflict-files"/);
  assert.match(detail, /data-testid="merge-conflict-retry"/);
  assert.match(detail, /mergeConflicts=\{mergeConflicts \?\? null\}/, '容器把冲突传进产物面板');
  const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
  assert.match(view, /mergeConflicts=\{detailSnap\.mergeConflicts \?\? null\}/);
});

test('D-N09 diff 审查进度：同一键读写；「下一处未看」按钮存在', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /function diffReviewedKey\(/);
  assert.match(detail, /aico:diff-reviewed:/);
  assert.match(detail, /data-testid="diff-reviewed"/);
  assert.match(detail, /data-testid=\{`changeset-next-unseen-\$\{cs\.id\}`\}/);
});

test('C3 项目变更历史：project:get 回带 changesets（不新增 IPC 通道）', () => {
  const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');
  assert.match(ipc, /FROM changesets c JOIN tasks t ON t\.id = c\.task_id\s+WHERE t\.project_id = \?/);
  const ui = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.match(ui, /data-testid="project-history"/);
  assert.match(ui, /data-testid="project-history-empty"/);
  assert.match(ui, /data-testid="project-history-row"/);
});
