/**
 * M3-N-2 / GAP4：工作项级检查点与回滚。
 *
 * 覆盖：
 *  - 引擎真 staging 流程：派发即落检查点（base），完成提交后补 head/真实路径；
 *  - 回滚只恢复该工作项 `base..head` 改过的文件（修改恢复/新增删除），**无关文件与未提交改动不碰**；
 *  - 反向提交 + `changeset open→rolled_back` + `checkpoint open→restored` + 事件；幂等；
 *  - 守卫：脏的受影响路径 / 后续提交碰同文件 / 已合并变更集 / inplace / 无检查点 全部显式拒。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  finishCheckpoint,
  getCheckpointForAttempt,
  getChangeset,
  insertCheckpoint,
  insertChangeset,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  updateWorkItem,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { WorktreeManager, createGitRunner, rollbackChangeset } from '../src/main/git/index.js';

const git = createGitRunner();
const g = (args: string[], cwd: string) => {
  const r = git.run(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function initRepo(accessMode = 'staging'): { db: SqliteDb; root: string; dir: string; base: string; taskId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-cp-'));
  const root = join(dir, 'repo');
  const base = join(dir, 'wt');
  mkdirSync(root, { recursive: true });
  g(['init', '-q', '-b', 'main'], root);
  g(['config', 'user.email', 'a@b.c'], root);
  g(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  g(['add', '--', 'a.ts', 'b.ts'], root);
  g(['commit', '-q', '-m', 'init'], root);

  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1', 'standard', 1)").run();
  const projectId = Number(
    db
      .prepare('INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES(?, ?, ?, 1)')
      .run('P', root, accessMode).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' });
  return { db, root, dir, base, taskId: task.id };
}

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

/** 手动造一个「已提交、检查点已完成」的 work item + changeset（回滚单测用，不跑引擎）。 */
function seedSubmitted(input: {
  db: SqliteDb;
  root: string;
  base: string;
  taskId: number;
  shortId: string;
}): { workItemId: number; checkpointId: number; changesetId: number; wtPath: string; baseSha: string; headSha: string } {
  const { db, root, base, taskId, shortId } = input;
  const mgr = new WorktreeManager(root, base, git);
  const { info } = mgr.ensure(shortId);
  const baseSha = g(['rev-parse', 'HEAD'], info.path);
  db.prepare("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(taskId);
  const wi = insertWorkItem(db, {
    taskId,
    employeeId: 1,
    title: 'edit a',
    brief: 'b',
    now: 1,
    touchedPaths: ['a.ts', 'c.ts'],
  });
  updateWorkItem(db, wi.id, { state: 'submitted' });
  const cp = insertCheckpoint(db, {
    taskId,
    workItemId: wi.id,
    attempt: 0,
    branch: info.branch,
    baseSha,
    worktreePath: info.path,
    now: 2,
  });

  writeFileSync(join(info.path, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(info.path, 'c.ts'), 'export const c = 3;\n');
  g(['add', '--', 'a.ts', 'c.ts'], info.path);
  g(['commit', '-q', '-m', 'task change'], info.path);
  const headSha = g(['rev-parse', 'HEAD'], info.path);
  finishCheckpoint(db, { checkpointId: cp.row.id, headSha, paths: ['a.ts', 'c.ts'] });
  const cs = insertChangeset(db, {
    taskId,
    workItemId: wi.id,
    branch: info.branch,
    baseSha,
    headSha,
    filesChanged: 2,
    insertions: 2,
    deletions: 0,
    state: 'open',
    now: 3,
  });
  return { workItemId: wi.id, checkpointId: cp.row.id, changesetId: cs.row.id, wtPath: info.path, baseSha, headSha };
}

test('引擎 staging：派发即记检查点，完成提交后补 head 与真实路径', async () => {
  const { db, root, dir, base, taskId } = initRepo();
  try {
    const wi = insertWorkItem(db, {
      taskId,
      employeeId: 1,
      title: 'edit a',
      brief: 'b',
      now: 1,
      touchedPaths: ['a.ts'],
    });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));

    const created = getCheckpointForAttempt(db, wi.id, 0);
    assert.ok(created, '派发后应落检查点');
    assert.equal(created!.state, 'open');
    assert.match(String(created!.base_sha), /^[0-9a-f]{40}$/, 'base_sha 是真 HEAD');
    assert.equal(created!.branch, 'aico/T-1001');
    assert.equal(created!.head_sha, null, '未完成前没有 head');

    const wtPath = created!.worktree_path;
    assert.ok(wtPath && existsSync(wtPath), '检查点记录真 worktree 路径');
    writeFileSync(join(wtPath!, 'a.ts'), 'export const a = 2;\n');
    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { ok: true } },
    });

    const done = getCheckpointForAttempt(db, wi.id, 0);
    assert.ok(done?.head_sha, '完成提交后补 head');
    assert.deepEqual(JSON.parse(done!.paths_json), ['a.ts'], '路径来自 base..head 真 diff');
    assert.ok(
      listTaskEvents(db, taskId).some((e) => e.kind === 'checkpoint_created'),
      'task_events 留 checkpoint_created',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回滚：只恢复该工作项改过的文件（修改恢复/新增删除），无关文件与未提交改动不碰；状态/事件/幂等', () => {
  const { db, root, dir, base, taskId } = initRepo();
  try {
    const seeded = seedSubmitted({ db, root, base, taskId, shortId: 'T-1001' });
    // 无关的未提交文件：回滚不得碰它。
    writeFileSync(join(seeded.wtPath, 'unrelated.txt'), 'keep me\n');
    // 另一条无关的已跟踪文件也保持原样
    assert.equal(readFileSync(join(seeded.wtPath, 'b.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const b = 1;\n');

    const res = rollbackChangeset({
      db,
      git,
      taskId,
      changesetId: seeded.changesetId,
      repoRoot: root,
      now: 100,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.ok && res.rollbackCommit, '应产生反向提交');
    assert.deepEqual(res.ok ? res.files.sort() : [], ['a.ts', 'c.ts']);

    assert.equal(readFileSync(join(seeded.wtPath, 'a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 1;\n');
    assert.ok(!existsSync(join(seeded.wtPath, 'c.ts')), '新增文件应删除');
    assert.equal(readFileSync(join(seeded.wtPath, 'unrelated.txt'), 'utf8'), 'keep me\n', '无关未提交文件必须原样保留');
    assert.equal(readFileSync(join(seeded.wtPath, 'b.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const b = 1;\n');

    // 新提交只含这两个路径；base..HEAD 不再有 a/c 改动。
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], seeded.wtPath).split('\n').filter(Boolean).sort();
    assert.deepEqual(names, ['a.ts', 'c.ts']);
    assert.deepEqual(
      g(['diff', '--name-only', '--no-renames', seeded.baseSha, 'HEAD'], seeded.wtPath).split('\n').filter(Boolean),
      [],
      '回滚后 base..HEAD 无该工作项改动',
    );
    assert.match(g(['status', '--porcelain'], seeded.wtPath), /unrelated\.txt/, '无关文件仍以未跟踪态存在');

    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'rolled_back');
    assert.equal(getCheckpointForAttempt(db, seeded.workItemId, 0)?.state, 'restored');
    assert.ok(
      listTaskEvents(db, taskId).some((e) => e.kind === 'work_item_rolled_back'),
      'task_events 留 work_item_rolled_back',
    );

    const headBefore = g(['rev-parse', 'HEAD'], seeded.wtPath);
    const again = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 101 });
    assert.equal(again.ok, true);
    assert.ok(again.ok && again.alreadyRestored, '二次回滚幂等');
    assert.equal(g(['rev-parse', 'HEAD'], seeded.wtPath), headBefore, '幂等不产生第二个提交');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守卫：受影响路径脏 / 后续提交碰同文件 / 已合并 / inplace / 无检查点 全部显式拒且不动文件', () => {
  const { db, root, dir, base, taskId } = initRepo();
  try {
    const seeded = seedSubmitted({ db, root, base, taskId, shortId: 'T-1001' });
    const headBefore = g(['rev-parse', 'HEAD'], seeded.wtPath);

    // ① 受影响路径有未提交改动
    writeFileSync(join(seeded.wtPath, 'a.ts'), 'dirty\n');
    const dirty = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 1 });
    assert.equal(dirty.ok, false);
    assert.equal(!dirty.ok && dirty.code, 'dirty_paths');
    assert.equal(readFileSync(join(seeded.wtPath, 'a.ts'), 'utf8'), 'dirty\n', '拒绝时不动文件');
    g(['checkout', '--', 'a.ts'], seeded.wtPath);

    // ② 该工作项之后有提交碰同一文件
    writeFileSync(join(seeded.wtPath, 'a.ts'), 'export const a = 4;\n');
    g(['add', '--', 'a.ts'], seeded.wtPath);
    g(['commit', '-q', '-m', 'later change'], seeded.wtPath);
    const newer = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 2 });
    assert.equal(newer.ok, false);
    assert.equal(!newer.ok && newer.code, 'newer_changes');
    assert.equal(readFileSync(join(seeded.wtPath, 'a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 4;\n');

    // ③ 已合并变更集
    db.prepare("UPDATE changesets SET state = 'merged' WHERE id = ?").run(seeded.changesetId);
    const merged = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 3 });
    assert.equal(merged.ok, false);
    assert.equal(!merged.ok && merged.code, 'changeset_state');

    // ④ 无检查点
    db.prepare("UPDATE changesets SET state = 'open' WHERE id = ?").run(seeded.changesetId);
    db.prepare('DELETE FROM task_checkpoints WHERE id = ?').run(seeded.checkpointId);
    const missing = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 4 });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.code, 'checkpoint_missing');
    assert.notEqual(g(['rev-parse', 'HEAD'], seeded.wtPath), headBefore, '② 的后续提交在，但没有被回滚改写');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const inplace = initRepo('inplace');
  try {
    const task = inplace.taskId;
    const wi = insertWorkItem(inplace.db, { taskId: task, employeeId: 1, title: 'x', brief: 'b', now: 1 });
    updateWorkItem(inplace.db, wi.id, { state: 'submitted' });
    const cs = insertChangeset(inplace.db, {
      taskId: task,
      workItemId: wi.id,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      state: 'open',
      now: 1,
    });
    const res = rollbackChangeset({
      db: inplace.db,
      git,
      taskId: task,
      changesetId: cs.row.id,
      repoRoot: inplace.root,
      now: 1,
    });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.code, 'unsupported_mode');
  } finally {
    rmSync(inplace.dir, { recursive: true, force: true });
  }
});

test('M3-CR：归档/取消任务显式拒回滚；done 回滚落 verification_invalidated', () => {
  const { db, root, dir, base, taskId } = initRepo();
  try {
    const seeded = seedSubmitted({ db, root, base, taskId, shortId: 'T-1001' });

    db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(taskId);
    const archived = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 10 });
    assert.equal(archived.ok, false);
    assert.equal(!archived.ok && archived.code, 'task_archived');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'open', '归档拒回滚不改状态');

    db.prepare("UPDATE tasks SET archived = 0, state = 'cancelled' WHERE id = ?").run(taskId);
    const cancelled = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 11 });
    assert.equal(cancelled.ok, false);
    assert.equal(!cancelled.ok && cancelled.code, 'task_state');
    assert.equal(getChangeset(db, seeded.changesetId)?.state, 'open', '取消拒回滚不改状态');

    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(taskId);
    const done = rollbackChangeset({ db, git, taskId, changesetId: seeded.changesetId, repoRoot: root, now: 12 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.ok(
      listTaskEvents(db, taskId).some((e) => e.kind === 'verification_invalidated'),
      'done 后回滚必须落 verification_invalidated（证据可能过期）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
