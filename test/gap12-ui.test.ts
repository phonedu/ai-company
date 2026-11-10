/**
 * GAP12UI：结论人话/色调、任务详情结论组、打回批注合成动作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { verdictText, verdictTone } from '../src/renderer/components/cardCopy.js';
import { rejectActionWithNotes, taskActionsOf } from '../src/renderer/components/taskActions.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

test('GAP12 结论人话：pass/approve/revise/fail 双编码；未知值原样回显', () => {
  assert.equal(verdictText('pass'), '通过');
  assert.equal(verdictText('approve'), '通过');
  assert.equal(verdictText('revise'), '打回');
  assert.equal(verdictText('fail'), '未通过');
  assert.equal(verdictText('reject'), '未通过');
  assert.equal(verdictText('partial'), '部分通过');
  assert.equal(verdictText('weird'), 'weird');
  assert.equal(verdictText(null), null);
  assert.equal(verdictTone('pass'), 'ok');
  assert.equal(verdictTone('fail'), 'danger');
  assert.equal(verdictTone('partial'), 'warn');
  assert.equal(verdictTone(undefined), 'dim');
});

test('GAP12 任务详情：结论组上屏（阶段/结论/批注/查看证据）', () => {
  const html = renderToStaticMarkup(createElement(TaskDetail, { data: fixture(), initialTab: 'plan' }));
  assert.match(html, /data-testid="review-panel"[^>]*data-count="2"/);
  assert.equal((html.match(/data-testid="review-item"/g) ?? []).length, 2);
  assert.match(html, /data-testid="review-item"[^>]*data-stage="plan"[^>]*data-verdict="revise"/);
  assert.match(html, /data-testid="review-item"[^>]*data-stage="verification"[^>]*data-verdict="fail"/);
  assert.ok(html.includes('第一步太笼统'));
  assert.ok(html.includes('按钮文案应为「对账单」'));
  assert.equal((html.match(/data-testid="review-evidence"/g) ?? []).length, 1, '只有带件的验证结论可跳证据');
  assert.equal((html.match(/data-testid="review-notes"/g) ?? []).length, 2);
});

test('GAP12 打回：动作 payload=fail；批注合成 trim 后写入；带来源 workItemId', () => {
  const reject = taskActionsOf('verifying').find((action) => action.id === 'reject');
  assert.ok(reject);
  assert.deepEqual(reject.payload, { verdict: 'fail' }, '手动打回与 verifier 同口径 fail（非 pass 即返工）');
  const merged = rejectActionWithNotes(reject, '  按钮文案应为「对账单」  ', 42);
  assert.deepEqual(merged.payload, {
    verdict: 'fail',
    notes: '按钮文案应为「对账单」',
    workItemId: 42,
  });
  const noId = rejectActionWithNotes(reject, '补测试');
  assert.equal('workItemId' in (noId.payload ?? {}), false, '无来源件时不伪造 id（服务端兜底）');
});

function fixture(): TaskDetailDTO {
  const at = 1_700_000_000_000;
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: '结论上屏',
      goal: 'g',
      state: 'verifying',
      riskLevel: 1,
      priority: 0,
      createdAt: at,
      updatedAt: at,
      acceptance: [],
    },
    progress: { done: 1, total: 2 },
    planSteps: [
      { idx: 1, text: '第一步', state: 'done' },
      { idx: 2, text: '第二步', state: 'pending' },
    ],
    reviews: [
      {
        eventId: 1,
        ts: at,
        stage: 'plan',
        actor: 'employee:2',
        role: 'critic',
        verdict: 'revise',
        notes: '第一步太笼统',
        workItemId: null,
        reportId: null,
        verifierEmployeeId: null,
      },
      {
        eventId: 2,
        ts: at + 1,
        stage: 'verification',
        actor: 'employee:9',
        role: 'verifier',
        verdict: 'fail',
        notes: '按钮文案应为「对账单」',
        workItemId: 7,
        reportId: 3,
        verifierEmployeeId: 9,
      },
    ],
    verificationWorkItemId: 7,
    timeline: [],
    behaviorLog: [],
    counts: { planSteps: 2, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}
