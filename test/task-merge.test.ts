/**
 * M3-P-4 / BRK16-b `task:merge`：真 git 合并的真值表、幂等与冲突可见。
 *
 * 每个用例独立临时仓库＋内存库；不碰真实项目。
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
import { createGitRunner, mergeChangeset } from '../src/main/git/index.js';

const AT = 1_800_000_000_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-merge-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'aico@example.test']);
  git(root, ['config', 'user.name', 'AICO Test']);
  writeFileSync(join(root, 'a.txt'), 'base\n', 'utf8');
  git(root, ['add', '--', 'a.txt']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', '-M', 'main']);
  return root;
}

/** 从 main 建任务分支，改同一文件并提交；回 main。 */
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

function seedTask(
  db: SqliteDb,
  projectId: number,
  changeset: { branch: string; baseSha: string; headSha: string; state?: string },
): { taskId: number; changesetId: number } {
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '合并测试',
    goal: 'g',
    riskLevel: 0,
  });
  const cs = insertChangeset(db, {
    taskId: task.id,
    workItemId: null,
    branch: changeset.branch,
    baseSha: changeset.baseSha,
    headSha: changeset.headSha,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    state: changeset.state ?? 'open',
    now: AT,
  });
  return { taskId: task.id, changesetId: cs.row.id };
}

function setupDb(root: string): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P',?,1)").run(root).lastInsertRowid,
  );
  return { db, projectId };
}

test('BRK16-b 合并：open→merged，主分支真前进；二次调用幂等（不重复 merge）', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const { baseSha, headSha } = makeBranch(root, 'aico/T-1001', 'merged\n');
    const { taskId, changesetId } = seedTask(db, projectId, { branch: 'aico/T-1001', baseSha, headSha });
    const first = mergeChangeset({ db, git: createGitRunner(), taskId, changesetId, repoRoot: root, now: AT });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.alreadyMerged, false);
      assert.ok(first.mergeCommit);
    }
    assert.equal(getChangeset(db, changesetId)?.state, 'merged');
    assert.equal(getChangeset(db, changesetId)?.merged_at, AT);
    assert.equal(
      readFileSync(join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'),
      'merged\n',
      'main 工作区真拿到改动',
    );
    const mainHead = git(root, ['rev-parse', 'HEAD']).trim();

    const second = mergeChangeset({ db, git: createGitRunner(), taskId, changesetId, repoRoot: root, now: AT + 1 });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.alreadyMerged, true);
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), mainHead, '幂等不产生第二个 merge commit');
    const mergedEvents = listTaskEvents(db, taskId).filter((e) => e.kind === 'changeset_merged');
    assert.equal(mergedEvents.length, 1, '合并事件只写一次');
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', '合并后工作区干净');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BRK16-b 冲突：返回冲突文件、状态仍 open、main 未改动且 merge 已中止', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const a = makeBranch(root, 'aico/T-1001', 'one\n');
    const b = makeBranch(root, 'aico/T-1002', 'two\n');
    const first = seedTask(db, projectId, { branch: 'aico/T-1001', ...a });
    const second = seedTask(db, projectId, { branch: 'aico/T-1002', ...b });
    const r1 = mergeChangeset({ db, git: createGitRunner(), ...first, repoRoot: root, now: AT });
    assert.equal(r1.ok, true);
    const r2 = mergeChangeset({ db, git: createGitRunner(), ...second, repoRoot: root, now: AT + 1 });
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      assert.equal(r2.code, 'merge_conflict');
      assert.deepEqual(r2.conflicts, ['a.txt']);
      assert.match(r2.message, /已中止/);
    }
    assert.equal(getChangeset(db, second.changesetId)?.state, 'open', '冲突不改状态');
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', '冲突后已 abort，现场干净');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
    assert.equal(
      readFileSync(join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'),
      'one\n',
      'main 保留第一次合并结果',
    );
    const failed = listTaskEvents(db, second.taskId).filter((e) => e.kind === 'action_failed');
    assert.equal(failed.length, 1, '冲突留审计事件');
    assert.match(failed[0]!.payload, /merge_conflict/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BRK16-b 拒绝面：dirty / 非主分支 / discarded 状态都显式拒且不动库', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const a = makeBranch(root, 'aico/T-1001', 'dirty-test\n');
    const seeded = seedTask(db, projectId, { branch: 'aico/T-1001', ...a });

    // dirty：改已跟踪文件不提交
    writeFileSync(join(root, 'a.txt'), 'local edit\n', 'utf8');
    const dirty = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT });
    assert.equal(dirty.ok, false);
    if (!dirty.ok) assert.equal(dirty.code, 'dirty_worktree');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'open');

    git(root, ['checkout', '--', 'a.txt']);
    // 非主分支
    git(root, ['checkout', 'aico/T-1001']);
    const offBase = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT + 1 });
    assert.equal(offBase.ok, false);
    if (!offBase.ok) assert.equal(offBase.code, 'not_on_base');
    assert.match(String(offBase.ok ? '' : offBase.message), /main\/master/);
    git(root, ['checkout', 'main']);

    // discarded 状态：不偷偷复活
    db.prepare("UPDATE changesets SET state='discarded' WHERE id=?").run(seeded.changesetId);
    const discarded = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT + 2 });
    assert.equal(discarded.ok, false);
    if (!discarded.ok) assert.equal(discarded.code, 'changeset_state');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'discarded');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M3-CR：归档/取消任务显式拒合并；done 合并落 verification_invalidated', () => {
  const root = initRepo();
  const { db, projectId } = setupDb(root);
  try {
    const a = makeBranch(root, 'aico/T-1001', 'guard-merge\n');
    const seeded = seedTask(db, projectId, { branch: 'aico/T-1001', ...a });

    db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(seeded.taskId);
    const archived = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT });
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.code, 'task_archived');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'open', '归档拒合并不改状态');

    db.prepare("UPDATE tasks SET archived = 0, state = 'cancelled' WHERE id = ?").run(seeded.taskId);
    const cancelled = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT + 1 });
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, 'task_state');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'open', '取消拒合并不改状态');

    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(seeded.taskId);
    const done = mergeChangeset({ db, git: createGitRunner(), ...seeded, repoRoot: root, now: AT + 2 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.ok(
      listTaskEvents(db, seeded.taskId).some((e) => e.kind === 'verification_invalidated'),
      'done 后合并必须落 verification_invalidated（证据可能过期）',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
