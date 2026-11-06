/**
 * B-2（M4）· `task:discard`：真 git 仓库 + 内存库。
 *
 * 判据：只改该 changeset 台账；主分支/分支/worktree 不动；同任务其它 changeset 不动；
 * 二次调用幂等（不重复事件）；merge 对 discarded 显式拒；归档/取消/错任务显式拒。
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
  getChangeset,
  insertChangeset,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { createGitRunner, discardChangeset, mergeChangeset } from '../src/main/git/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskDiscard } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-discard-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'aico@example.test']);
  git(root, ['config', 'user.name', 'AICO Test']);
  writeFileSync(join(root, 'a.txt'), 'base\n', 'utf8');
  git(root, ['add', '--', 'a.txt']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', '-M', 'main']);
  return root;
}

function makeBranch(root: string, branch: string, content: string): { baseSha: string; headSha: string } {
  const baseSha = git(root, ['rev-parse', 'main']).trim();
  git(root, ['checkout', '-b', branch, 'main']);
  writeFileSync(join(root, 'a.txt'), content, 'utf8');
  git(root, ['add', '--', 'a.txt']);
  git(root, ['commit', '-m', `change ${branch}`]);
  const headSha = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', 'main']);
  return { baseSha, headSha };
}

function setupDb(root: string): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  const repo = createSqliteChatRepo(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P',?,1)").run(root).lastInsertRowid,
  );
  return { db, repo, projectId };
}

function seedTask(db: SqliteDb, projectId: number): number {
  return createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '丢弃测试',
    goal: 'g',
    riskLevel: 0,
  }).id;
}

function seedChangeset(
  db: SqliteDb,
  taskId: number,
  input: { branch: string; baseSha: string; headSha: string; state?: string },
): number {
  return insertChangeset(db, {
    taskId,
    workItemId: null,
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    state: input.state ?? 'open',
    now: AT,
  }).row.id;
}

test('B-2 丢弃：只改台账；主分支/分支/工作区不动；二次幂等；merge 拒绝', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const { baseSha, headSha } = makeBranch(root, 'aico/T-1001', 'branch-change\n');
    const taskId = seedTask(db, projectId);
    const changesetId = seedChangeset(db, taskId, { branch: 'aico/T-1001', baseSha, headSha });
    const mainHead = git(root, ['rev-parse', 'main']).trim();
    const branchHead = git(root, ['rev-parse', 'aico/T-1001']).trim();
    const mainContent = readFileSync(join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n');

    const first = discardChangeset({ db, taskId, changesetId, now: AT });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.alreadyDiscarded, false);
      assert.equal(first.filesChanged, 1);
    }
    assert.equal(getChangeset(db, changesetId)?.state, 'discarded');
    assert.equal(git(root, ['rev-parse', 'main']).trim(), mainHead, '主分支 HEAD 不动');
    assert.equal(git(root, ['rev-parse', 'aico/T-1001']).trim(), branchHead, '任务分支不动');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), mainContent, '主分支文件不动');

    const events = listTaskEvents(db, taskId).filter((e) => e.kind === 'changeset_discarded');
    assert.equal(events.length, 1, '丢弃事件只写一次');

    const second = discardChangeset({ db, taskId, changesetId, now: AT + 1 });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.alreadyDiscarded, true);
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'changeset_discarded').length, 1, '幂等不重复事件');

    const merged = mergeChangeset({ db, git: createGitRunner(), taskId, changesetId, repoRoot: root, now: AT + 2 });
    assert.equal(merged.ok, false);
    if (!merged.ok) assert.equal(merged.code, 'changeset_state', 'discarded 不得被合并复活');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-2 只影响该工作项：同任务另一个 changeset 仍 open', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const a = makeBranch(root, 'aico/T-1001', 'a\n');
    const b = makeBranch(root, 'aico/T-1002', 'b\n');
    const taskId = seedTask(db, projectId);
    const csA = seedChangeset(db, taskId, { branch: 'aico/T-1001', baseSha: a.baseSha, headSha: a.headSha });
    const csB = seedChangeset(db, taskId, { branch: 'aico/T-1002', baseSha: b.baseSha, headSha: b.headSha });

    assert.equal(discardChangeset({ db, taskId, changesetId: csA, now: AT }).ok, true);
    assert.equal(getChangeset(db, csA)?.state, 'discarded');
    assert.equal(getChangeset(db, csB)?.state, 'open', '别的 changeset 不受影响');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-2 守卫：错任务/merged/归档/取消显式拒；IPC 入参校验', () => {
  const root = initRepo();
  const { db, repo, projectId } = setupDb(root);
  try {
    const { baseSha, headSha } = makeBranch(root, 'aico/T-1001', 'x\n');
    const taskId = seedTask(db, projectId);
    const otherTaskId = seedTask(db, projectId);
    const changesetId = seedChangeset(db, taskId, { branch: 'aico/T-1001', baseSha, headSha });

    const wrongTask = discardChangeset({ db, taskId: otherTaskId, changesetId, now: AT });
    assert.equal(wrongTask.ok, false);
    if (!wrongTask.ok) assert.equal(wrongTask.code, 'not_found');

    db.prepare("UPDATE changesets SET state='merged' WHERE id=?").run(changesetId);
    const merged = discardChangeset({ db, taskId, changesetId, now: AT });
    assert.equal(merged.ok, false);
    if (!merged.ok) assert.equal(merged.code, 'changeset_state');
    db.prepare("UPDATE changesets SET state='open' WHERE id=?").run(changesetId);

    db.prepare('UPDATE tasks SET archived=1 WHERE id=?').run(taskId);
    const archived = discardChangeset({ db, taskId, changesetId, now: AT });
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.code, 'task_archived');
    db.prepare('UPDATE tasks SET archived=0, state=\'cancelled\' WHERE id=?').run(taskId);
    const cancelled = discardChangeset({ db, taskId, changesetId, now: AT });
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, 'task_state');

    const badInput = handleTaskDiscard({ repo } as never, { taskId, changesetId: 'x' }, AT);
    assert.equal(badInput.ok, false);
    if (!badInput.ok) assert.equal(badInput.code, 'bad_request');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
