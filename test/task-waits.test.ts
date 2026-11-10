import test from 'node:test';
import assert from 'node:assert/strict';

import { insertWorkItem, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskGet, handleTaskList, type IpcDeps } from '../src/main/ipc/ipc.js';

// ─────────────：task:get / task:list 的 `waits`（等待原因）★ 引擎为源，不推断 ─────────────

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; taskId: number; workItemId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const task = repo.createTask({ title: 't', goal: 'g' });
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES('A','standard',1)").run();
  const employeeId = (db.prepare('SELECT id FROM employees LIMIT 1').get() as { id: number }).id;
  const wi = insertWorkItem(db, { taskId: task.id, employeeId, title: 'w', brief: 'b', now: 1 });
  return { db, repo, taskId: task.id, workItemId: wi.id };
}

test('M1-3 waits: task:get 带引擎 hold（path_conflict + conflictsWithShortIds）；空则 []', () => {
  const { db, repo, taskId, workItemId } = setup();

  const deps: IpcDeps = {
    repo,
    engine: {
      dispatch: async () => undefined,
      listDispatchHolds: () => [{ workItemId, reason: 'path_conflict', conflictsWith: [workItemId + 1] }],
    },
  };

  const detail = handleTaskGet(deps, { taskId });
  assert.ok(detail, 'task:get 应返回详情');
  assert.equal(detail!.waits?.length, 1);
  assert.equal(detail!.waits![0].reason, 'path_conflict');
  assert.deepEqual(detail!.waits![0].conflictsWith, [workItemId + 1]);
  // conflictsWith 的短号：work_item+1 无对应任务 → 过滤为空（不造假的短号）
  assert.deepEqual(detail!.waits![0].conflictsWithShortIds, []);

  // task:list 同源带 waits
  const list = handleTaskList(deps, {});
  assert.equal(list[0].waits?.length, 1);

  // 无 hold → 空数组（渲染层据此不显示占位）
  const noHold: IpcDeps = { repo, engine: { dispatch: async () => undefined, listDispatchHolds: () => [] } };
  assert.deepEqual(handleTaskGet(noHold, { taskId })!.waits, []);
  assert.deepEqual(handleTaskList(noHold, {})[0].waits, []);

  // 引擎未提供 listDispatchHolds（旧装配）→ 空数组，不崩
  const legacy: IpcDeps = { repo, engine: { dispatch: async () => undefined } };
  assert.deepEqual(handleTaskGet(legacy, { taskId })!.waits, []);

  db.close();
});

test('R3-2 waits: `detail` 从引擎决策点透传（数字/阈值只在引擎侧知道；缺 → 不显示）', () => {
  const { db, repo, taskId, workItemId } = setup();
  const deps: IpcDeps = {
    repo,
    engine: {
      dispatch: async () => undefined,
      listDispatchHolds: () => [
        { workItemId, reason: 'concurrency_limit', conflictsWith: [], detail: '同任务并发已达上限 3' },
      ],
    },
  };
  const waits = handleTaskGet(deps, { taskId })!.waits!;
  assert.equal(waits[0].detail, '同任务并发已达上限 3', 'detail 必须原样透传到 DTO');

  // 引擎没给 detail（旧装配）→ 字段缺席（渲染层不显示空括号）
  const legacy: IpcDeps = {
    repo,
    engine: { dispatch: async () => undefined, listDispatchHolds: () => [{ workItemId, reason: 'rate_limit', conflictsWith: [] }] },
  };
  assert.equal('detail' in handleTaskGet(legacy, { taskId })!.waits![0], false, '无 detail → 字段缺席（不造空串）');
  db.close();
});

test('M1-3 waits: 只返回本任务的 hold（其他任务的工作项不串入）', () => {
  const { db, repo, taskId, workItemId } = setup();
  const other = repo.createTask({ title: 'other', goal: 'g' });

  const deps: IpcDeps = {
    repo,
    engine: {
      dispatch: async () => undefined,
      listDispatchHolds: () => [
        { workItemId, reason: 'employee_busy', conflictsWith: [] },
        { workItemId: workItemId + 999, reason: 'path_conflict', conflictsWith: [] }, // 非本任务
      ],
    },
  };
  const detail = handleTaskGet(deps, { taskId });
  assert.equal(detail!.waits?.length, 1);
  assert.equal(detail!.waits![0].reason, 'employee_busy');
  assert.deepEqual(handleTaskGet(deps, { taskId: other.id })!.waits, []);

  db.close();
});
