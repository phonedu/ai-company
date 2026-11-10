/**
 * 运行/产物页签：项目页「运行 / 产物」拼装与三格派生的纯函数守卫。
 * 口径：空数组＝真的没有；同一路径多版本默认只显示最新，旧版本保留可展开；
 * 三格摘要标明「自动摘要」（派生自任务状态，不调模型）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  artifactKindLabel,
  collectActiveWorkItems,
  collectProjectArtifacts,
  groupProjectArtifacts,
  liveEmployeesOfProject,
  pendingCardsOfProject,
  progressSummary,
  type ProjectArtifactRow,
} from '../src/renderer/components/projectRuns.js';
import type { TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';
import type { ReportDTO, TaskDTO } from '../src/renderer/types.js';

const detail = (patch: {
  id: number;
  state: string;
  steps?: Array<{ idx: number; text: string; state: string }>;
  artifacts?: Array<{ id: number; kind: string; name: string; path: string; at: number; sha256?: string | null; originProjectId?: number | null; originProjectName?: string | null }>;
}): TaskDetailDTO =>
  ({
    task: { id: patch.id, shortId: `T-${patch.id}`, title: `任务${patch.id}`, state: patch.state },
    planSteps: (patch.steps ?? []).map((s) => ({ ...s, workItemId: null, evidenceRef: null })),
    artifacts: patch.artifacts ?? [],
  }) as unknown as TaskDetailDTO;

test('S3·运行：只列在流程中的任务的未完成步骤（done/skipped 不算）', () => {
  const rows = collectActiveWorkItems([
    detail({
      id: 1,
      state: 'executing',
      steps: [
        { idx: 1, text: '实现', state: 'done' },
        { idx: 2, text: '自测', state: 'running' },
        { idx: 3, text: '收尾', state: 'pending' },
      ],
    }),
    detail({ id: 2, state: 'done', steps: [{ idx: 1, text: '已结束任务的步骤', state: 'running' }] }),
    detail({ id: 3, state: 'paused', steps: [{ idx: 1, text: '暂停中', state: 'pending' }] }),
  ]);
  assert.deepEqual(rows.map((r) => `${r.taskId}:${r.idx}:${r.state}`), ['1:2:running', '1:3:pending', '3:1:pending']);
});

test('S3·产物：跨任务摊平只取产出类；同路径多版本按 at 取最新，旧版本保留', () => {
  const rows = collectProjectArtifacts([
    detail({
      id: 1,
      state: 'done',
      artifacts: [
        { id: 11, kind: 'doc', name: 'spec.md', path: 'docs/spec.md', at: 100 },
        { id: 12, kind: 'input', name: 'ref.md', path: 'refs/ref.md', at: 90 },
      ],
    }),
    detail({
      id: 2,
      state: 'done',
      artifacts: [{ id: 21, kind: 'doc', name: 'spec.md', path: 'docs/spec.md', at: 200 }],
    }),
  ]);
  assert.deepEqual(rows.map((r) => r.artifactId), [21, 11]);
  const groups = groupProjectArtifacts(rows);
  assert.equal(groups.length, 1, '同 kind|path 归一组');
  assert.equal(groups[0]!.latest.artifactId, 21);
  assert.deepEqual(groups[0]!.older.map((o) => o.artifactId), [11]);
});

test('S3·产物：不同来源项目不合并（引用副本单独成组）', () => {
  const base: ProjectArtifactRow[] = [
    { artifactId: 1, taskId: 1, shortId: 'T-1', taskTitle: 'a', kind: 'doc', name: 'x.md', path: 'x.md', sha256: null, at: 10, originProjectId: null, originProjectName: null },
    { artifactId: 2, taskId: 2, shortId: 'T-2', taskTitle: 'b', kind: 'doc', name: 'x.md', path: 'x.md', sha256: null, at: 20, originProjectId: 9, originProjectName: '别的项目' },
  ];
  const groups = groupProjectArtifacts(base);
  assert.equal(groups.length, 2);
});

test('S3·三格：进展摘要＝真实计数＋最近更新；待拍板只认本项目未决的 ask 卡', () => {
  const tasks = [
    { id: 1, state: 'executing', updatedAt: 10 },
    { id: 2, state: 'needs_decision', updatedAt: 30 },
    { id: 3, state: 'done', updatedAt: 20 },
    { id: 4, state: 'blocked', updatedAt: 5 },
    { id: 5, state: 'awaiting_approval', updatedAt: 50 },
    { id: 6, state: 'planning', updatedAt: 60 },
  ] as unknown as TaskDTO[];
  const p = progressSummary(tasks);
  assert.deepEqual(
    { running: p.running, waiting: p.waiting, pendingStart: p.pendingStart, done: p.done },
    { running: 1, waiting: 3, pendingStart: 1, done: 1 },
  );
  assert.equal(p.latest?.id, 6);

  const cards = [
    { id: 1, projectId: 7, state: 'pending', kind: 'ask', createdAt: 10 },
    { id: 2, projectId: 7, state: 'resolved', kind: 'ask', createdAt: 20 },
    { id: 3, projectId: 8, state: 'pending', kind: 'ask', createdAt: 30 },
    { id: 4, projectId: null, state: 'pending', kind: 'ask', createdAt: 40 },
    { id: 5, projectId: 7, state: 'pending', kind: 'notification', createdAt: 50 },
  ] as unknown as ReportDTO[];
  assert.deepEqual(pendingCardsOfProject(cards, 7).map((c) => c.id), [1]);
});

test('S3·产物：真实 kind 有中文标签（不直接给用户看英文）', () => {
  assert.equal(artifactKindLabel('file'), '文件');
  assert.equal(artifactKindLabel('snapshot'), '快照');
  assert.equal(artifactKindLabel('url'), '链接');
  assert.equal(artifactKindLabel('image'), '图片');
});

test('S3·三格：员工现场只留「本项目任务上在跑/在等」的员工', () => {
  const employees = [
    { id: 1, name: '甲', activity: { status: 'running', currentAction: '实现', taskId: 11, currentMinutes: 3 } },
    { id: 2, name: '乙', activity: { status: 'running', currentAction: '别的项目', taskId: 99, currentMinutes: 9 } },
    { id: 3, name: '丙', activity: { status: 'idle', currentAction: null, taskId: 11 } },
    { id: 4, name: '丁', activity: { status: 'waiting', currentAction: null, taskId: 12 } },
    { id: 5, name: '戊' },
  ];
  const rows = liveEmployeesOfProject(employees, new Set([11, 12]));
  assert.deepEqual(rows.map((r) => `${r.id}:${r.status}`), ['1:running', '4:waiting']);
  assert.equal(rows[0]!.taskId, 11);
});
