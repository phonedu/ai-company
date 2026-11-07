/**
 * M2-C 第 5 项：`artifacts` 归属列 + `changesets` 写者（迁移 `003`）。
 *
 * **本测试要证的是"真接通"**（C1 的教训：机制对了、没接线不算完）：
 * 跑一次**真 staging 流程**（真 temp git 仓库 + 真 worktree + 真提交）⇒ 库里出现
 * `changesets` / `changeset_files` / `artifacts.source` / `artifacts.changeset_id` / `task_events(changeset_created)`。
 *
 * 另含：`003` 老库升级路径（v2 → v3 只加列）、`(work_item_id, head_sha)` 幂等（关掉唯一索引必红）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  insertArtifact,
  insertChangeset,
  insertWorkItem,
  listArtifactsByTask,
  listChangesetFiles,
  listChangesetsByTask,
  listTaskEvents,
  loadMigrations,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createGitRunner } from '../src/main/git/index.js';

const git = createGitRunner();
const g = (args: string[], cwd: string) => {
  const r = git.run(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};

function initRepo(): { db: SqliteDb; root: string; dir: string; base: string; taskId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-cs-'));
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
  return { db, root, dir, base, taskId: task.id };
}

const ev = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });

test('真 staging 流程：提交产物 → 完成 ⇒ changesets/changeset_files/artifacts.source+changeset_id/事件 全部真落库', async () => {
  const { db, dir, base, taskId } = initRepo();
  try {
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'edit a', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });

    await engine.dispatch(ev(taskId, 'triage'));
    await engine.dispatch(ev(taskId, 'plan_drafted'));
    await engine.dispatch(ev(taskId, 'plan_reviewed'));
    await engine.dispatch(ev(taskId, 'plan_approved')); // → executing + 建 worktree

    // 员工在 worktree 里真改文件
    const wtPath = join(base, 'T-1001');
    assert.ok(existsSync(wtPath), 'staging 应建立 worktree');
    writeFileSync(join(wtPath, 'a.ts'), 'export const a = 2;\nexport const extra = 3;\n');

    // 提交（带 artifacts 列表）→ 写 `artifacts`（含 source）
    await engine.dispatch({
      scope: 'work_item',
      id: wi.id,
      event: 'submit_work_item',
      actor: 'employee:1',
      payload: { result: { summary: '改完', artifacts: ['a.ts'] } },
    });
    const arts = listArtifactsByTask(db, taskId);
    assert.equal(arts.length, 1, '提交应写一条产物');
    assert.equal(arts[0]!.path, 'a.ts');
    assert.match(String(arts[0]!.source), /^staging:/, '产物归属 = staging:<归一化 cwd>');
    assert.ok(arts[0]!.sha256 && arts[0]!.sha256.length === 64, '产物指纹（sha256）尽力而为地写上');
    // D3 后：免验件（默认 L1 未命中抽验）**提交即自动接受** → finishWorkspace 按 touched_paths 提交 + 写 changeset
    //（时点前移：从"验证接受时"变成"提交即"——本测不再手写 review_accept）
    assert.notEqual(arts[0]!.changeset_id ?? null, null, 'D3：提交（自动接受）后 changeset 已产生并回挂');

    const cs = listChangesetsByTask(db, taskId);
    assert.equal(cs.length, 1, '完成应写一条 changeset');
    const row = cs[0]!;
    assert.equal(row.work_item_id, wi.id);
    assert.equal(row.branch, 'aico/T-1001', '分支名 = aico/<任务短号>');
    assert.match(String(row.head_sha), /^[0-9a-f]{40}$/, 'head_sha 真取到提交');
    assert.match(String(row.base_sha), /^[0-9a-f]{40}$/, 'base_sha 由 merge-base 现算');
    assert.equal(row.state, 'open');
    assert.equal(row.files_changed, 1);
    assert.ok(row.insertions >= 1, '插入行数来自 numstat');

    const files = listChangesetFiles(db, row.id);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, 'a.ts');
    assert.equal(files[0]!.status, 'modified');
    assert.equal(files[0]!.employee_id, 1, '"哪个员工改的" 落到 changeset_files');

    // 产物已回挂变更集（diff tab 的 join）
    const after = listArtifactsByTask(db, taskId);
    assert.equal(after[0]!.changeset_id, row.id, 'artifacts.changeset_id 已回挂');

    // 关键事件留痕
    assert.ok(
      listTaskEvents(db, taskId).some((e) => e.kind === 'changeset_created'),
      'task_events 应有 changeset_created',
    );
    // 提交确实发生在 worktree 里（只提交 touched_paths）
    const names = g(['show', '--pretty=format:', '--name-only', 'HEAD'], wtPath).stdout.trim().split('\n');
    assert.deepEqual(names, ['a.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('幂等：同 (work_item_id, head_sha) 只写一条 changeset（重放不重复）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/x', 1)").run();
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1', 'standard', 1)").run();
    const task = createTask(db, new SqliteCounterStore(db), { projectId: 1, title: 'T', goal: 'g', now: 1 });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    const input = {
      taskId: task.id,
      workItemId: wi.id,
      branch: 'aico/T-1001',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      now: 1,
    };
    const first = insertChangeset(db, input);
    assert.equal(first.created, true);
    // 重放（同键）⇒ 不新增
    const replay = insertChangeset(db, { ...input, insertions: 999 });
    assert.equal(replay.created, false, '同键重放不得新写');
    assert.equal(replay.row.id, first.row.id);
    assert.equal(listChangesetsByTask(db, task.id).length, 1, '库里只有一条');
    assert.equal(listChangesetsByTask(db, task.id)[0]!.insertions, 2, '重放不得改写既有行');
  } finally {
    db.close();
  }
});

test('`003`–`017` 老库升级路径：v2 库 → 补应用（只加列＋005 重建 costs＋008 重建 reports；表数 +11、索引 23→31；**老库数据不丢**；可重复跑）', () => {
  const db = openMemoryDatabase();
  try {
    // ① 模拟"已发布的旧库"：只应用到 v2
    const upToV2 = loadMigrations().filter((m) => m.version <= 2);
    const first = runMigrations(db, upToV2);
    assert.deepEqual(first.applied, [1, 2]);
    assert.equal(first.userVersion, 2);
    const tablesBefore = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
    const idxBefore = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
    const colsBefore = (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!colsBefore.includes('source'), 'v2 库还没 003 的列（这就是升级前状态）');
    assert.equal(idxBefore, 23);

    // ② 升到 v3：只应用 003
    // 005 会重建 costs 表 ⇒ 先塞一行（含真项目+任务，满足 v2 的 NOT NULL/FK），验证**重建后数据不丢**
    const pid = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',1)").run().lastInsertRowid);
    // 老库（v2 期）种子用**裸 SQL**：`createTask` 自 009 起带 `model` 列，在 v2 期表上会 SQLITE_ERROR。
    const tid = Number(
      db
        .prepare("INSERT INTO tasks(short_id, project_id, title, goal, acceptance, state, created_at, updated_at) VALUES('T-1001', ?, 'T', 'g', '[]', 'inbox', 1, 1)")
        .run(pid).lastInsertRowid,
    );
    db.prepare("INSERT INTO costs(task_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?, 'm', 1, 2, 0.5, 1)").run(tid);
    const second = runMigrations(db);
    assert.deepEqual(second.applied, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], '老库应补应用 003–023（B2-3 工作项 DAG）');
    assert.deepEqual(second.skipped, [1, 2], '已应用的 001/002 不重跑');
    assert.equal(second.userVersion, 23);
    const reportTaskId = (db.prepare('PRAGMA table_info(reports)').all() as Array<{ name: string; notnull: number }>).find(
      (c) => c.name === 'task_id',
    );
    assert.equal(reportTaskId?.notnull, 0, '008 后 task_id 可空（重建；全局卡）');
    const notifCols = (db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(notifCols.includes('read_at'), '006 的 read_at 列应已就位（老库升级零破坏）');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM costs').get() as { n: number }).n, 1, '005 重建 costs 后老数据不丢');
    const colsAfter = (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(colsAfter.includes('source') && colsAfter.includes('changeset_id') && colsAfter.includes('commit_sha'));
    assert.ok(!colsAfter.includes('at'), '`at` 不加（用已有的 created_at）');
    assert.ok(
      colsAfter.includes('origin_artifact_id') && colsAfter.includes('origin_project_id'),
      '007（G-A）的来源两列应已就位（老库升级零破坏；既有行两列为 NULL＝自产）',
    );
    const tablesAfter = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
    const idxAfter = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
    assert.equal(tablesAfter, tablesBefore + 13, '012/013/014/016/020 各新增表＋017 FTS 虚拟表及 4 shadow 表＋B2-3 work_item_deps');
    assert.equal(idxAfter, 34, 'v1 22 + idx_seams_project + idx_changesets_wi_head + idx_task_checkpoints_task + 两个 im_outbox + remote_event_log 过期索引 + 016 三个 + 020 两个＋B2-3 idx_work_item_deps_dep');
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(taskCols.includes('max_parallel_work_items'), '005 的 P20 列应已就位');
    const costInfo = (db.prepare('PRAGMA table_info(costs)').all() as Array<{ name: string; notnull: number }>).find((c) => c.name === 'task_id');
    assert.equal(costInfo?.notnull, 0, 'C2：costs.task_id 必须可空（公司级开销）');
    const costCols = (db.prepare('PRAGMA table_info(costs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(costCols.includes('project_id') && costCols.includes('cache_read_tokens') && costCols.includes('cache_write_tokens'), '004 的三列应已就位');
    const projectCols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(projectCols.includes('docs_check_enabled'), '011 的文档检查开关应已就位');

    // ③ 幂等：再跑一遍无变更
    const third = runMigrations(db);
    assert.deepEqual(third.applied, []);
    assert.equal(third.userVersion, 23);
  } finally {
    db.close();
  }
});

test('列无关口径：未升 003 的库也能登记产物（缺列不写、不抛）', () => {
  const db = openMemoryDatabase();
  try {
    // 模拟 003 之前的 `artifacts` 表（无 source/changeset_id/commit_sha）
    db.exec(`CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, work_item_id INTEGER,
      path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file', note TEXT NOT NULL DEFAULT '',
      sha256 TEXT, created_at INTEGER NOT NULL
    );`);
    const r = insertArtifact(db, { taskId: 1, workItemId: 1, path: 'x.ts', now: 1 });
    assert.equal(r.created, true, '缺列也能插入（列无关）');
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(r.id) as Record<string, unknown>;
    assert.equal(row.source, undefined, '缺列时不写 source（不抛错）');
    // 幂等：同 (wi, path) 不重复
    assert.equal(insertArtifact(db, { taskId: 1, workItemId: 1, path: 'x.ts', now: 2 }).created, false);
    assert.equal(listArtifactsByTaskViaSql(db), 1);
  } finally {
    db.close();
  }
});

test('`base_sha` 解析不到 ⇒ NULL + `action_failed` 留痕 + **不拿猜的基准充当 diff**（空态不伪装）', async () => {
  // 仓库用 `-b trunk`，且无 origin/HEAD / main / master ⇒ merge-base 必失败
  const dir = mkdtempSync(join(tmpdir(), 'aico-cs-nb-'));
  const root = join(dir, 'repo');
  const base = join(dir, 'wt');
  mkdirSync(root, { recursive: true });
  g(['init', '-q', '-b', 'trunk'], root);
  g(['config', 'user.email', 'a@b.c'], root);
  g(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  g(['add', '--', 'a.ts'], root);
  g(['commit', '-q', '-m', 'init'], root);
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1', 'standard', 1)").run();
    const projectId = Number(
      db
        .prepare("INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES('P', ?, 'staging', 1)")
        .run(root).lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' });
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 1, title: 'w', brief: 'b', now: 1, touchedPaths: ['a.ts'] });
    const engine = new Engine(db, makeRecordingExecutor(), { git, worktreesBaseDir: base, now: () => 1_000 });
    await engine.dispatch(ev(task.id, 'triage'));
    await engine.dispatch(ev(task.id, 'plan_drafted'));
    await engine.dispatch(ev(task.id, 'plan_reviewed'));
    await engine.dispatch(ev(task.id, 'plan_approved'));
    const wtPath = join(base, 'T-1001');
    writeFileSync(join(wtPath, 'a.ts'), 'export const a = 9;\n\n\n\n');
    await engine.dispatch({ scope: 'work_item', id: wi.id, event: 'submit_work_item', actor: 'employee:1', payload: { result: { summary: 's' } } });
    // D3：提交即自动接受（免验件）⇒ finishWorkspace 已跑（不再手写 review_accept）
    const cs = listChangesetsByTask(db, task.id);
    assert.equal(cs.length, 1, '仍应写一条（state=open）');
    assert.equal(cs[0]!.base_sha, null, 'base_sha 解析不到 ⇒ NULL');
    assert.equal(cs[0]!.state, 'open');
    assert.equal(cs[0]!.files_changed, 0, '**不得拿猜的基准充当 diff**（不产出行数/文件行）');
    assert.equal(cs[0]!.insertions, 0);
    assert.equal(cs[0]!.deletions, 0);
    assert.equal(listChangesetFiles(db, cs[0]!.id).length, 0, '无 changeset_files（基准未知）');
    const evs = listTaskEvents(db, task.id);
    assert.ok(
      evs.some((e) => e.kind === 'action_failed' && String(e.payload).includes('changeset_base_sha')),
      '必须落 action_failed 留痕',
    );
    assert.ok(
      evs.some((e) => e.kind === 'changeset_created' && String(e.payload).includes('"baseUnknown":true')),
      'changeset_created 带 baseUnknown 标记（消费侧显式显示「基准未知」）',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function listArtifactsByTaskViaSql(db: SqliteDb): number {
  return (db.prepare('SELECT count(*) c FROM artifacts').get() as { c: number }).c;
}
