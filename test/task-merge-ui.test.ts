/**
 * 变更集合并的产品面（状态/行内合并按钮/操作条入口/回执）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

function fixture(): TaskDetailDTO {
  const at = 1_700_000_000_000;
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: '合并测试',
      goal: 'g',
      state: 'verifying',
      riskLevel: 1,
      priority: 0,
      createdAt: at,
      updatedAt: at,
      acceptance: [],
      projectAccessMode: 'staging',
    },
    progress: { done: 1, total: 1 },
    planSteps: [{ idx: 1, text: '实现', state: 'done' }],
    timeline: [],
    behaviorLog: [],
    changesets: [
      {
        id: 1,
        branch: 'aico/T-1001',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        filesChanged: 1,
        insertions: 2,
        deletions: 0,
        summary: '',
        state: 'open',
        createdAt: at,
        files: [{ path: 'a.txt', status: 'modified', insertions: 2, deletions: 0, employeeId: 0 }],
      },
      {
        id: 2,
        branch: 'aico/T-1001',
        baseSha: 'a'.repeat(40),
        headSha: 'c'.repeat(40),
        filesChanged: 1,
        insertions: 1,
        deletions: 1,
        summary: '',
        state: 'merged',
        createdAt: at,
        files: [],
      },
    ],
    counts: { planSteps: 1, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}

test('M3-P-4 变更集：open 行有合并按钮、merged 行只显示状态；操作条合并入口已实现', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: fixture(),
      initialTab: 'artifacts',
      onMergeChangeset: () => undefined,
      mergeNotice: '已合并：1234abcd',
    }),
  );
  assert.match(html, /data-testid="changeset-row"[^>]*data-changeset-id="1"/);
  assert.match(html, /data-testid="changeset-merge-1"/);
  assert.doesNotMatch(html, /data-testid="changeset-merge-2"/, '已合并的变更集不再显示合并按钮');
  assert.match(html, /data-testid="changeset-state"[^>]*data-state="open"[^>]*>待合并/);
  assert.match(html, /data-testid="changeset-state"[^>]*data-state="merged"[^>]*>已合并/);
  assert.match(html, /data-testid="task-merge-notice"[^>]*>已合并：1234abcd/);
  assert.match(html, /data-testid="task-action-merge"[^>]*data-implemented="true"/);
  assert.doesNotMatch(html, /data-testid="task-action-merge"[^>]*\sdisabled=/);
});
