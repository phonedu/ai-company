/**
 *  / 产品面：open 变更集有回滚入口（二次确认），已回滚态显式；回执上屏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

function fixture(): TaskDetailDTO {
  const at = 1_700_000_000_000;
  const base = {
    branch: 'aico/T-1001',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
    summary: '',
    createdAt: at,
    files: [{ path: 'a.txt', status: 'modified', insertions: 2, deletions: 0, employeeId: 0 }],
  };
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: '回滚测试',
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
      { ...base, id: 1, state: 'open' },
      { ...base, id: 2, state: 'rolled_back', headSha: 'c'.repeat(40), files: [] },
      { ...base, id: 3, state: 'merged', headSha: 'd'.repeat(40), files: [] },
    ],
    counts: { planSteps: 1, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}

test('GAP4：open 行有回滚按钮，rolled_back/merged 只显示状态；回执上屏', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: fixture(),
      initialTab: 'artifacts',
      onMergeChangeset: () => undefined,
      onRollbackChangeset: () => undefined,
      rollbackNotice: '已回滚 2 个文件：1234abcd',
      onDiscardChangeset: () => undefined,
      discardNotice: '已丢弃变更集 #1：不会合并到 main',
    }),
  );
  assert.match(html, /data-testid="changeset-rollback-1"/);
  assert.doesNotMatch(html, /data-testid="changeset-rollback-2"/, '已回滚的变更集不再显示回滚按钮');
  assert.doesNotMatch(html, /data-testid="changeset-rollback-3"/, '已合并的变更集不再显示回滚按钮');
  assert.match(html, /data-testid="changeset-discard-1"/, 'open 变更集有丢弃入口');
  assert.doesNotMatch(html, /data-testid="changeset-discard-2"/, '已回滚的变更集不显示丢弃按钮');
  assert.doesNotMatch(html, /data-testid="changeset-discard-3"/, '已合并的变更集不显示丢弃按钮');
  assert.match(html, /data-testid="changeset-state"[^>]*data-state="rolled_back"[^>]*>已回滚/);
  assert.match(html, /data-testid="task-rollback-notice"[^>]*>已回滚 2 个文件：1234abcd/);
  assert.match(html, /data-testid="task-discard-notice"[^>]*>已丢弃变更集 #1/);
});
