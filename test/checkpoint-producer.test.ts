/**
 * M3 联动修复 P0-1：**真实任务**（纯文本 brief，无 touchedPaths）在 staging 下
 * 提交时必须按工作区真实改动产生 commit → checkpoint head/paths → changeset files。
 *
 * 这个测试专门防止「D3 用种子行通过、真实生产者没接线」回归：
 * 不预插 changesets/task_checkpoints，只让引擎跑真实流程。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  getCheckpointForAttempt,
  insertWorkItem,
  listChangesetFiles,
  listChangesetsByTask,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { WorktreeManager, createGitRunner } from '../src/main/git/index.js';

const git = createGitRunner();
const g = (args: string[], cwd: string) => {
  const r = git.run(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function initRepo(): { db: SqliteDb; root: string; dir: string; base: string; taskId: number; projectId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-cp-producer-'));
  const root = join(dir, 'repo');
  const base = join(dir, 'wt');
  mkdirSync(root, { recursive: true });
  g(['init', '-q', '-b', 'main'], root);
  g(['config', 'user.email', 'a@b.c'], root);
  g(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  g(['add', '--', 'a.ts'], root);
  g(['commit', '-q', '-m', 'init'], root);

  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1', 'standard', 1)").run();
  const projectId = Number(
    db
      .prepare("INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES('P', ?, 'staging', 1)")
      .run(root).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' });
  return { db, root, dir, base, taskId: task.id, projectId };
}

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

test('staging 真实任务：纯文本 brief → 提交实际改动 → checkpoint head/paths + changeset files 全部落库', async () => {
  const { db, dir, base, taskId } = initRepo();
  try {
    // 关键：不传 touchedPaths（真实 planner 产出的工作项就是纯文本 brief）。
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: '按计划改 a.ts 并新增 src/new.ts', now: 1 });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });

    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved')); // → executing + dispatch work item

    const mgr = new WorktreeManager(join(dir, 'repo'), base, git);
    const wt = mgr.list()[0];
    assert.ok(wt, 'staging 应建立 worktree');
    assert.ok(existsSync(wt.path));

    writeFileSync(join(wt.path, 'a.ts'), 'export const a = 2;\n');
    mkdirSync(join(wt.path, 'src'), { recursive: true });
    writeFileSync(join(wt.path, 'src', 'new.ts'), 'export const n = 1;\n');

    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { summary: '改完', artifacts: ['a.ts', 'src/new.ts'] } },
    });

    const head = g(['rev-parse', 'HEAD'], wt.path);
    const baseSha = g(['rev-parse', 'HEAD~1'], wt.path);
    assert.notEqual(head, baseSha, '提交必须产生新 commit（不再因 touched 为空而跳过）');
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], wt.path)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(names, ['a.ts', 'src/new.ts'], '提交范围＝真实改动（含新增文件）');

    const cp = getCheckpointForAttempt(db, wi.id, 0);
    assert.ok(cp, '检查点应存在');
    assert.equal(cp.state, 'open', '检查点收尾后仍为 open（回滚前置）');
    assert.notEqual(cp.base_sha, cp.head_sha, 'checkpoint head != base');
    assert.deepEqual([...JSON.parse(String(cp.paths_json))].sort(), ['a.ts', 'src/new.ts']);

    const changesets = listChangesetsByTask(db, taskId);
    assert.equal(changesets.length, 1, '应写一条 changeset');
    assert.equal(changesets[0]!.files_changed, 2, 'changeset 文件数＝真实改动数');
    const files = listChangesetFiles(db, changesets[0]!.id)
      .map((f) => f.path)
      .sort();
    assert.deepEqual(files, ['a.ts', 'src/new.ts']);

    const kinds = listTaskEvents(db, taskId).map((e) => e.kind);
    assert.ok(kinds.includes('checkpoint_created'), '应有 checkpoint_created');
    assert.ok(kinds.includes('changeset_created'), '应有 changeset_created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
