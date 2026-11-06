/**
 * M2 尾（G-D）：跨项目全局搜索——真库断言：
 *  - 任务（短号/标题）、消息正文、产物路径/备注可搜；
 *  - 跨项目命中带项目名；空查询＝空（不刷屏）；限条数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { insertArtifact, insertEmployee, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo> } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(1, '甲项目', 'D:/a', 1)").run();
  db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(2, '乙项目', 'D:/b', 1)").run();
  insertEmployee(db, { id: 7, name: '林悦', role: 'dev', now: 1 });
  db.prepare(
    "INSERT INTO tasks(id, short_id, project_id, title, goal, state, created_at, updated_at) VALUES(11, 'T-1001', 1, '财务报表整理', 'g', 'executing', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO tasks(id, short_id, project_id, title, goal, state, created_at, updated_at) VALUES(12, 'T-1002', 2, '官网改版', 'g', 'executing', 1, 1)",
  ).run();
  db.prepare("INSERT INTO human_messages(direction, task_id, content, created_at) VALUES('in', 12, '官网改版的文案再对一遍', 2)").run();
  insertArtifact(db, { taskId: 11, path: 'docs/财务报表.md', kind: 'file', note: '季度对账', sha256: null, now: 3 });
  return { db, repo: createSqliteChatRepo(db) };
}

test('M2 尾 G-D：跨项目搜索任务/消息/产物，结果带项目名', () => {
  const { db, repo } = setup();
  const byTask = repo.globalSearch('财务');
  assert.equal(byTask.tasks.length, 1);
  assert.equal(byTask.tasks[0]!.shortId, 'T-1001');
  assert.equal(byTask.tasks[0]!.projectName, '甲项目');
  assert.equal(byTask.artifacts.length, 1, '产物路径/备注也命中');
  assert.equal(byTask.artifacts[0]!.projectName, '甲项目');

  const byMessage = repo.globalSearch('文案');
  assert.equal(byMessage.messages.length, 1);
  assert.equal(byMessage.messages[0]!.taskId, 12);
  assert.equal(byMessage.messages[0]!.projectName, '乙项目');

  const byShort = repo.globalSearch('T-1002');
  assert.equal(byShort.tasks[0]!.id, 12);
  db.close();
});

test('M2 尾 G-D：空查询＝空结果（不主动罗列全库）', () => {
  const { db, repo } = setup();
  assert.deepEqual(repo.globalSearch('   '), { query: '', tasks: [], messages: [], artifacts: [], total: 0 });
  db.close();
});
