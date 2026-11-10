import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskGet } from '../src/main/ipc/ipc.js';
import {
  DEVIATION_KIND,
  hasUnclosedUnmanaged,
  summarizeDeviations,
  validateDeviation,
} from '../src/main/ipc/deviation.js';

// ── OPT-：差异清单（复用 task_events，kind='deviation_recorded'）──

test('M6-1: validateDeviation —— owner 与里程碑必填', () => {
  assert.deepEqual(validateDeviation({ owner: 2, milestone: 'M1' }), { missingOwner: false, missingMilestone: false });
  assert.deepEqual(validateDeviation({}), { missingOwner: true, missingMilestone: true });
  assert.deepEqual(validateDeviation({ owner: 2 }), { missingOwner: false, missingMilestone: true });
  assert.equal(validateDeviation({ milestone: 'M1' }).missingOwner, true);
});

test('M6-1: summarizeDeviations —— 收尾读数（未结且无 owner）', () => {
  const s = summarizeDeviations([
    { kind: DEVIATION_KIND, payload: { title: 'A', owner: 2, milestone: 'M1', status: 'resolved' } },
    { kind: DEVIATION_KIND, payload: { title: 'B', owner: 3, milestone: 'M1', status: 'open' } },
    { kind: DEVIATION_KIND, payload: { title: 'C', milestone: 'M2', status: 'open' } }, // 无 owner
    { kind: 'tool_call', payload: {} }, // 非偏离，不计
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.open, 2);
  assert.deepEqual(s.openWithoutOwner, ['C']);
  assert.equal(s.items?.length, 3);
  assert.equal(s.items?.[1]?.title, 'B');
  assert.equal(s.items?.[1]?.owner, '3');
  assert.equal(s.items?.[1]?.open, true);
  assert.equal(s.items?.[0]?.open, false);
  assert.equal(hasUnclosedUnmanaged(s), true);
  // 补齐 owner 后清零
  assert.equal(hasUnclosedUnmanaged(summarizeDeviations([{ kind: DEVIATION_KIND, payload: { title: 'C', owner: 4, milestone: 'M2' } }])), false);
});

test('M6-1: task:get 暴露 deviations（真 task_events → DTO）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const task = repo.createTask({ title: 't', goal: 'g' });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: 1000,
    kind: DEVIATION_KIND,
    actor: 'boss',
    payload: { title: '绕过 X', why: '时间紧', owner: 2, milestone: 'M1', status: 'open' },
  });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: 1001,
    kind: DEVIATION_KIND,
    actor: 'boss',
    payload: { title: '未认领偏离', milestone: 'M1', status: 'open' },
  });

  const dto = handleTaskGet({ repo }, { taskId: task.id });
  assert.ok(dto);
  assert.equal(dto!.deviations!.total, 2);
  assert.equal(dto!.deviations!.open, 2);
  assert.deepEqual(dto!.deviations!.openWithoutOwner, ['未认领偏离']);
  db.close();
});
