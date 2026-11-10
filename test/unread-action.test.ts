/**
 *  P0-2：老板实际处理卡片（批准/标已阅）必须推进 `channel:cards` 游标，
 * 且 `read_cursors.source='action'`（不是只刷新 UI）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SqliteCounterStore,
  createTask,
  insertApproval,
  insertReport,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleInboxAnswer, handleTaskApprove, type IpcDeps } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','C:/p',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
  db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
  const deps: IpcDeps = {
    repo: createSqliteChatRepo(db),
    db,
    engine: { dispatch: async () => undefined },
  };
  return { db, task, deps };
}

function cursor(db: ReturnType<typeof setup>['db']) {
  return db
    .prepare("SELECT last_item_id, source FROM read_cursors WHERE principal='boss' AND surface='channel:cards'")
    .get() as { last_item_id: number; source: string } | undefined;
}

test('批准卡：handleTaskApprove 推进卡片游标且 source=action', async () => {
  const { db, task, deps } = setup();
  try {
    const report = insertReport(db, {
      taskId: task.id,
      kind: 'ask',
      payload: { title: '批准？' },
      state: 'pending',
      now: AT,
    });
    const approval = insertApproval(db, {
      taskId: task.id,
      reportId: report.id,
      question: '批准计划？',
      options: [
        { key: 'approve', label: '批准' },
        { key: 'revise', label: '打回' },
      ],
      defaultAction: null,
    });
    const res = await handleTaskApprove(deps, { approvalId: approval.id, chosen: 'approve' }, AT + 1);
    assert.equal(res.ok, true);
    const c = cursor(db);
    assert.equal(c?.source, 'action');
    assert.ok(Number(c?.last_item_id) >= report.id);
  } finally {
    db.close();
  }
});

test('标已阅：handleInboxAnswer 推进卡片游标且 source=action', () => {
  const { db, task, deps } = setup();
  try {
    const report = insertReport(db, {
      taskId: task.id,
      kind: 'report',
      payload: { title: '验收' },
      state: 'pending',
      now: AT,
    });
    const res = handleInboxAnswer(deps, { id: report.id }, AT + 1);
    assert.equal(res.ok, true);
    const c = cursor(db);
    assert.equal(c?.source, 'action');
    assert.ok(Number(c?.last_item_id) >= report.id);
  } finally {
    db.close();
  }
});
