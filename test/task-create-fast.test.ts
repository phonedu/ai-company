/**
 * F-05（2026-10-24）：建任务是“受理即回执”，不得同步等待规划/critic。
 *  - 源码守门：handleTaskCreate 内不得 `await deps.engine.dispatch`；
 *  - 行为守门：dispatch 永不 resolve 时，handler 仍必须返回已建任务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskCreate, type IpcDeps } from '../src/main/ipc/ipc.js';

test('F-05：建任务源码不再 await 规划派发；后台失败有 action_failed 留痕', () => {
  const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');
  const start = ipc.indexOf('export async function handleTaskCreate');
  const end = ipc.indexOf('/** `task:list`', start);
  assert.ok(start >= 0 && end > start, '找不到 handleTaskCreate 边界');
  const block = ipc.slice(start, end);
  assert.equal(block.includes('await deps.engine.dispatch'), false, '建任务不得同步等待规划');
  assert.ok(block.includes('void deps.engine'), '规划必须在后台派发');
  assert.ok(block.includes('reportCreateDispatchFailure'), '后台失败必须落 action_failed，不得静默');
});

test('F-05：dispatch 永不 resolve 时，建任务仍立即返回已建任务', { timeout: 5_000 }, async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const repo = createSqliteChatRepo(db);
    const project = repo.createProject({ name: 'fast', rootDir: 'D:/fast', accessMode: 'inplace', now: 1 });
    const never = new Promise<void>(() => undefined);
    const deps = {
      repo,
      db,
      engine: { dispatch: () => never },
    } as unknown as IpcDeps;
    const created = await handleTaskCreate(deps, {
      projectId: project.id,
      title: '快速回执',
      goal: 'g',
      riskLevel: 0,
    });
    assert.ok(created.id > 0, 'dispatch 永不 resolve 时仍必须返回已建任务（等待规划会超时）');
  } finally {
    db.close();
  }
});
