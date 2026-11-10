import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskGet } from '../src/main/ipc/ipc.js';

// ── OPT-：`task:get` 产物元信息（只读、按 id 升序、空数组=无产物、按 task 定界） ──
// **列无关**：`artifacts.source`/`commit_sha`/`at`（003）存在则映射、缺则 null——本测试在
// 「003 在」与「003 不在」两种世界里都必须绿（口径冻结前后都不做红源）。

test('OPT-M8-1: task:get 带 artifacts（空态 + 字段映射 + 只取本任务；列无关）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const task = repo.createTask({ title: 't', goal: 'g' });

  // 空数组 = 本任务无产物（渲染层走空态，不伪装）
  assert.deepEqual(handleTaskGet({ repo }, { taskId: task.id })?.artifacts, []);

  // 探测可选列（003）
  const cols = new Set(
    (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const hasSource = cols.has('source');
  const hasCommit = cols.has('commit_sha');
  const hasAt = cols.has('at');
  const extraCols = `${hasSource ? ', source' : ''}${hasCommit ? ', commit_sha' : ''}${hasAt ? ', at' : ''}`;
  const extraMarks = `${hasSource ? ', ?' : ''}${hasCommit ? ', ?' : ''}${hasAt ? ', ?' : ''}`;
  const extraVals: unknown[] = [
    ...(hasSource ? ['real'] : []),
    ...(hasCommit ? ['deadbeef1234'] : []),
    ...(hasAt ? [999] : []),
  ];

  // 本任务两条产物：一条 file（带 sha256 + 可选的 source/commit_sha/at）；一条 url（全缺省）
  db.prepare(
    `INSERT INTO artifacts (task_id, work_item_id, path, kind, sha256, created_at${extraCols}) VALUES (?, ?, ?, ?, ?, ?${extraMarks})`,
  ).run(task.id, null, 'out\\report.md', 'file', 'abc123', 111, ...extraVals);
  db.prepare('INSERT INTO artifacts (task_id, path, kind, created_at) VALUES (?, ?, ?, ?)').run(
    task.id,
    'https://x/y.png',
    'url',
    222,
  );
  // 别的任务的产物——不得混入
  const other = repo.createTask({ title: 'o', goal: 'g' });
  db.prepare('INSERT INTO artifacts (task_id, path, kind, created_at) VALUES (?, ?, ?, ?)').run(
    other.id,
    'other.txt',
    'file',
    333,
  );

  const dto = handleTaskGet({ repo }, { taskId: task.id });
  assert.ok(dto);
  assert.equal(dto!.artifacts!.length, 2, '只取本任务产物');
  const [a, b] = dto!.artifacts!;
  assert.equal(a.name, 'report.md', 'name = path basename（不读盘）');
  assert.equal(a.path, 'out\\report.md');
  assert.equal(a.kind, 'file');
  assert.equal(a.sha256, 'abc123');
  assert.equal(a.source, hasSource ? 'real' : null, '有列则映射、缺列则 null（不阻塞）');
  assert.equal(a.commit, hasCommit ? 'deadbeef1234' : null, 'commit_sha → DTO commit');
  assert.equal(a.workItemId, null);
  assert.equal(a.at, hasAt ? 999 : 111, 'at 优先，缺列回退 created_at');
  assert.ok(a.id < b.id, '按 id 升序');
  assert.equal(b.kind, 'url');
  assert.equal(b.source, null, '未填 → null（不臆造）');
  assert.equal(b.commit, null);
  assert.equal(b.at, 222);
  db.close();
});
