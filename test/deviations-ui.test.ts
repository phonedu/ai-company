/**
 *  · 差异清单上屏：顶部 warning + 变更/产物 tab 明细卡；未结无主显式警告。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

const AT = 1_700_000_000_000;

function fixture(): TaskDetailDTO {
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: '差异台账演示',
      goal: 'g',
      state: 'executing',
      riskLevel: 1,
      priority: 0,
      createdAt: AT,
      updatedAt: AT,
      acceptance: [],
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    artifacts: [],
    changesets: [],
    deviations: {
      total: 2,
      open: 1,
      openWithoutOwner: ['未认领偏离'],
      items: [
        {
          title: '绕过 X',
          why: '时间紧',
          owner: '研究员',
          milestone: 'v1.1',
          status: 'resolved',
          open: false,
        },
        {
          title: '未认领偏离',
          why: null,
          owner: null,
          milestone: 'v1.1',
          status: 'open',
          open: true,
        },
      ],
    },
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}

function render(d: TaskDetailDTO, tab: 'plan' | 'artifacts'): string {
  return renderToStaticMarkup(createElement(TaskDetail, { data: d, initialTab: tab }));
}

test('UG-07 差异台账：顶部 warning（total/open/无主）在两个 tab 都可见', () => {
  for (const tab of ['plan', 'artifacts'] as const) {
    const html = render(fixture(), tab);
    assert.match(html, /data-testid="task-deviations-warning"/);
    assert.match(html, /2 条 · 1 未结 · 1 无主/);
  }
});

test('UG-07 差异台账：明细卡逐条 owner/里程碑/状态；未结无主显式标红文案', () => {
  const html = render(fixture(), 'artifacts');
  assert.equal((html.match(/data-testid="deviation-item"/g) ?? []).length, 2);
  assert.match(html, /绕过 X[\s\S]*owner 研究员[\s\S]*里程碑 v1\.1[\s\S]*已结/);
  assert.match(html, /未认领偏离[\s\S]*owner 未指定[\s\S]*未结/);
  assert.match(html, /data-testid="deviations-unowned"[\s\S]*未认领偏离[\s\S]*收尾前必须清零/);
});

test('UG-07 差异台账：无偏离 → 不渲染 warning / 明细卡（不摆假读数）', () => {
  const data = { ...fixture(), deviations: { total: 0, open: 0, openWithoutOwner: [] } };
  const html = render(data as TaskDetailDTO, 'artifacts');
  assert.equal(html.includes('data-testid="task-deviations-warning"'), false);
  assert.equal(html.includes('data-testid="deviations-panel"'), false);
});
