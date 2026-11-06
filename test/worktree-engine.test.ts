/**
 * M1-4 接缝（引擎侧）：派发时解析任务工作目录 + 完成时按 `touched_paths` 白名单提交，
 * 并与 effect scope（M1-1）配套。**硬要求**：`inplace`（M0 默认）行为不变（不建 worktree、不提交）。
 * 真 `git` + 临时仓库；用完删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, EffectScopeManager, makeRecordingExecutor } from '../src/main/engine/index.js';
import { WorktreeManager, createGitRunner, listChangedPaths } from '../src/main/git/index.js';

const git = createGitRunner();
const g = (args: string[], cwd: string) => {
  const r = git.run(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};

function initRepo(accessMode: string): { db: SqliteDb; root: string; dir: string; base: string; taskId: number; projectId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-wteng-'));
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
  return { db, root, dir, base, taskId: task.id, projectId };
}

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

async function runToDone(engine: Engine, db: SqliteDb, taskId: number, wiId: number, root: string): Promise<void> {
  await engine.dispatch(ev(taskId, 'triage'));
  await engine.dispatch(ev(taskId, 'plan_drafted'));
  await engine.dispatch(ev(taskId, 'plan_reviewed'));
  await engine.dispatch(ev(taskId, 'plan_approved')); // → executing + dispatch work item
  void db;
  void root;
  await engine.dispatch({ scope: 'work_item', id: wiId, event: 'submit_work_item', actor: 'employee:1', payload: { result: { ok: true } } });
  // D3：免验件提交即自动接受（不再手写 review_accept；此处的驱动序列保持"走到完成"的语义）
}

test('M1-4 接缝/staging: 派发建 worktree；完成按 touched_paths 提交；effect scope open→reclaim', async () => {
  const { db, root, dir, base, taskId } = initRepo('staging');
  try {
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const scopes = new EffectScopeManager(db, { clock: () => 1_000, killer: { kill: () => undefined } });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, effectScopes: scopes, now: () => 1_000 });

    const mgr = new WorktreeManager(root, base, git);
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));

    const wts = mgr.list();
    assert.equal(wts.length, 1, 'staging 应建立 worktree');
    const wtPath = wts[0]!.path;
    assert.ok(existsSync(wtPath));
    // 2026-10-19 staging 真机：dispatch 动作必须带 worktree cwd，否则员工写到项目根、changeset 为空。
    const dispatchRow = db
      .prepare("SELECT payload FROM action_log WHERE action_key LIKE 'dispatch:work_item:%' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    assert.ok(dispatchRow, '缺 dispatch 动作');
    assert.equal(JSON.parse(dispatchRow.payload).cwd, wtPath, 'dispatch.payload.cwd 必须是 worktree');
    assert.equal(scopes.list('open').length, 1, 'effect scope 应 open');

    writeFileSync(join(wtPath, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(wtPath, 'b.ts'), 'export const b = 2;\n'); // 不应被提交

    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'submit_work_item', actor: 'employee:1', payload: { result: { ok: true } } });

    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], wtPath).stdout.trim().split('\n');
    assert.deepEqual(names, ['a.ts'], '完成时只提交 touched_paths');
    assert.equal(scopes.list('open').length, 0, '完成后 effect scope 应 reclaim');
    assert.equal(scopes.list('reclaimed').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MF2 staging retry：failed→retry 仍解析 worktree cwd，并落 attempt=1 检查点', async () => {
  const { db, root, dir, base, taskId } = initRepo('staging');
  try {
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });
    const mgr = new WorktreeManager(root, base, git);
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));
    const wtPath = mgr.list()[0]!.path;

    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'error', actor: 'employee:1', payload: { reason: 'x' } });
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'retry', actor: 'boss' });

    const row = db.prepare('SELECT state, attempt FROM work_items WHERE id = ?').get(wi.id) as {
      state: string;
      attempt: number;
    };
    assert.equal(row.state, 'running');
    assert.equal(row.attempt, 1, 'retry 必须递增 attempt');
    const action = db
      .prepare("SELECT payload FROM action_log WHERE action_key = ?")
      .get(`dispatch:work_item:${wi.id}:1`) as { payload: string } | undefined;
    assert.ok(action, '缺 retry 的 dispatch 动作');
    assert.equal(JSON.parse(action.payload).cwd, wtPath, 'retry dispatch 必须带 worktree cwd');
    const attempts = (db.prepare('SELECT attempt FROM task_checkpoints WHERE work_item_id = ? ORDER BY attempt').all(wi.id) as Array<{ attempt: number }>).map((r) => r.attempt);
    assert.deepEqual(attempts, [0, 1], '每次尝试都有检查点');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-4 接缝/inplace: M0 默认行为不变（不建 worktree、不产生提交）', async () => {
  const { db, root, dir, base, taskId } = initRepo('inplace');
  try {
    const headBefore = g(['rev-parse', 'HEAD'], root).stdout.trim();
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });

    await runToDone(engine, db, taskId, wi.id, root);

    assert.equal(new WorktreeManager(root, base, git).list().length, 0, 'inplace 不得建 worktree');
    assert.equal(g(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, 'inplace 不得产生提交');
    assert.ok(!existsSync(base), 'worktree 根目录不应被创建');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BRK22 装配守卫（有牙）：生产入口必须给 Engine 注入 git ＋ worktreesBaseDir（摘掉即红）', () => {
  // 为什么用源码守卫：main 装配（index.ts）起不到无头测里；但「git 未注入」正是 BRK22 的根因
  //（产物 source/sha256 恒 NULL、staging 实按 inplace 走）——摘除注入 ⇒ 本测必红。
  const src = readFileSync('src/main/index.ts', 'utf8');
  assert.match(src, /git:\s*createGitRunner\(\)/, 'Engine 配置必须注入 createGitRunner()（BRK22）');
  assert.match(src, /worktreesBaseDir:\s*join\(app\.getPath\('userData'\),\s*'worktrees'\)/, 'worktree 根须落 userData（不散在仓库旁）');
});

test('M3-CR inplace：派发前干净＋有 touched_paths → 只提交白名单；b.ts 在制改动不卷入', async () => {
  const { db, root, dir, base, taskId } = initRepo('inplace');
  try {
    const headBefore = g(['rev-parse', 'HEAD'], root).stdout.trim();
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });

    // 先派发（此时工作区干净，baselineClean=true），再改文件——否则派发前已脏，守卫不会自动提交。
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 9;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 9;\n');
    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { ok: true } },
    });

    assert.notEqual(g(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, '干净基线＋白名单应自动提交');
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], root).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(names, ['a.ts'], '只提交 touched_paths，b.ts 不卷入');
    assert.match(g(['status', '--porcelain'], root).stdout, /b\.ts/, 'b.ts 仍在制');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-03 inplace：gitignored 产物不阻塞自动提交；只提交真实改动', async () => {
  const { db, root, dir, base, taskId } = initRepo('inplace');
  try {
    writeFileSync(join(root, '.gitignore'), 'out/\n');
    mkdirSync(join(root, 'out'), { recursive: true });
    g(['add', '.gitignore'], root);
    g(['commit', '-q', '-m', 'ignore out'], root);
    const headBefore = g(['rev-parse', 'HEAD'], root).stdout.trim();
    const wi = insertWorkItem(db, {
      taskId,
      employeeId: 1,
      title: 'edit a',
      brief: 'b',
      now: 1,
      touchedPaths: ['a.ts', 'out/layout.png'],
    });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 11;\n');
    writeFileSync(join(root, 'out', 'layout.png'), 'not-a-real-png');
    const changed = listChangedPaths(git, root);
    assert.ok(changed.paths.includes('a.ts'), '真实改动必须被识别');
    assert.equal(changed.paths.includes('out/layout.png'), false, 'gitignored 产物不得进入提交面');
    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { ok: true } },
    });
    assert.notEqual(g(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, '有效白名单必须自动提交');
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], root).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(names, ['a.ts'], '只提交真实改动，不提交 out/');
    const failed = listTaskEvents(db, taskId).filter(
      (e) => e.kind === 'action_failed' && String(e.payload).includes('auto_commit'),
    );
    assert.equal(failed.length, 0, 'ignored 产物不得让自动提交失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-03 inplace：员工漏报锁文件时自动纳入 Cargo.lock', async () => {
  const { db, root, dir, base, taskId } = initRepo('inplace');
  try {
    const headBefore = g(['rev-parse', 'HEAD'], root).stdout.trim();
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });
    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 12;\n');
    writeFileSync(join(root, 'Cargo.lock'), '# generated lock\n');
    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { ok: true } },
    });
    assert.notEqual(g(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, '锁文件应被自动纳入提交');
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], root)
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(names, ['Cargo.lock', 'a.ts'], '漏报的锁文件必须随任务提交');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-CR inplace：派发前工作区脏 → 不自动提交，留 action_failed', async () => {
  const { db, root, dir, base, taskId } = initRepo('inplace');
  try {
    writeFileSync(join(root, 'b.ts'), 'export const b = 7; // dirty before dispatch\n');
    const headBefore = g(['rev-parse', 'HEAD'], root).stdout.trim();
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });

    writeFileSync(join(root, 'a.ts'), 'export const a = 8;\n');
    await runToDone(engine, db, taskId, wi.id, root);

    assert.equal(g(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, '脏基线不得自动提交');
    assert.ok(
      listTaskEvents(db, taskId).some(
        (e) =>
          e.kind === 'action_failed' &&
          String(e.payload).includes('派发前工作区已有未提交改动'),
      ),
      '脏基线必须留 action_failed（不静默）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
