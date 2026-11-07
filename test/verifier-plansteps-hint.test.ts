/**
 * F-02 引导（B0 出口修复）：verifier 的 pass 若计划还有未完成步骤、却没填 `planStepsNote`，
 * 宿主会改判 fail 并返工（真机出口测试里 Thinking app 就卡在这）。修复＝在 verifier 上下文里
 * **显式列出未完成步骤并要求必填**，减少返工往返。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertEmployee,
  insertWorkItem,
  openMemoryDatabase,
  replacePlanSteps,
  runMigrations,
} from '../src/main/db/index.js';
import { buildReviewContext } from '../src/main/agent/context.js';

function setup(): { db: ReturnType<typeof openMemoryDatabase>; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
  insertEmployee(db, { id: 4, name: '苏芮', role: 'reviewer', now: 1 });
  db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(11,'P','D:/p',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId: 11, title: 'T', goal: 'g', riskLevel: 1, ownerId: 3 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 3, title: 'w', brief: 'b', now: 2 });
  replacePlanSteps(db, task.id, ['第一步', '第二步', '第三步']);
  // 只关第一步，留两步未完成。
  db.prepare("UPDATE plan_steps SET state='done' WHERE task_id=? AND idx=1").run(task.id);
  return { db, taskId: task.id, wiId: wi.id };
}

test('verifier 上下文：有未完成步骤时显式列出并要求 planStepsNote 必填', () => {
  const { db, taskId, wiId } = setup();
  try {
    const ctx = buildReviewContext(db, { role: 'verifier', taskId, workItemId: wiId, reviewerEmployeeId: 4, bossText: null });
    assert.match(ctx.userPrompt, /未完成步骤（2\/3）/, '必须点名未完成步骤数量');
    assert.match(ctx.userPrompt, /第 2、3 步/, '必须列出具体步骤号');
    assert.match(ctx.userPrompt, /planStepsNote.*必填|必填.*planStepsNote/s, '必须要求 planStepsNote');
    assert.match(ctx.userPrompt, /改判 fail 并触发返工/, '说明后果（宿主机器校验）');
  } finally {
    db.close();
  }
});

test('verifier 上下文：全部完成时不加「未完成」提示（不制造噪音）', () => {
  const { db, taskId, wiId } = setup();
  try {
    db.prepare("UPDATE plan_steps SET state='done' WHERE task_id=?").run(taskId);
    const ctx = buildReviewContext(db, { role: 'verifier', taskId, workItemId: wiId, reviewerEmployeeId: 4, bossText: null });
    assert.equal(ctx.userPrompt.includes('【未完成步骤'), false);
  } finally {
    db.close();
  }
});
