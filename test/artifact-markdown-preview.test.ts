/**
 * 产物「读」的 .md 只读渲染（2026-11-05：任务详情→变更与产物→「读」看到的是源码，
 * 「看着不是很对，没有渲染过」→ 裁「抽屉内只读渲染」）。
 *
 * 口径：
 *  - `.md`/`.markdown` 产物：抽屉内用既有 `MilkdownEditor readOnly` 渲染（标题/列表/表格可读），
 *    并提供「看原文」显式切换（**不自动回落裸源码**——/2026-10-28 老板口径：阅读态不显示源码；
 *    渲染失败时显式报错，用户可主动切原文）；
 *  - 其它文本（.py/.json/.txt…）：保持 `<pre>` 原文（既有契约不变，测试见 overlay-batch）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, type ArtifactPreviewDTO, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

function fixture(): TaskDetailDTO {
  return {
    task: {
      id: 1,
      shortId: 'T-1',
      title: 't',
      goal: 'g',
      state: 'ready',
      stateLabel: '待执行',
      projectId: 1,
      projectName: 'p',
      riskLevel: 1,
      ownerId: 0,
      ownerName: 'a',
      createdAt: 1,
      updatedAt: 1,
      acceptance: [],
      steps: [],
      archived: false,
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    artifacts: [
      { id: 21, kind: 'file', name: '分析.md', path: 'artifacts/分析.md', sha256: 'abcdef0123456789', source: null, commit: null, workItemId: 1, at: 1 },
    ],
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  } as unknown as TaskDetailDTO;
}

function preview(over: Partial<ArtifactPreviewDTO>): ArtifactPreviewDTO {
  return {
    artifactId: 21,
    name: '分析.md',
    path: 'artifacts/分析.md',
    size: 2048,
    sha256: 'abcdef0123456789deadbeef',
    sha256Mismatch: false,
    truncated: false,
    text: '# 标题\n\n- 要点一\n- 要点二\n',
    ...over,
  } as unknown as ArtifactPreviewDTO;
}

function render(previewData: ArtifactPreviewDTO | null): string {
  return renderToStaticMarkup(
    createElement(TaskDetail, {
      data: fixture(),
      initialTab: 'artifacts',
      artifactPreview: previewData,
      onCloseArtifactPreview: () => undefined,
    }),
  );
}

test('md 产物：抽屉内走只读渲染（MilkdownEditor），不直接摊源码', () => {
  const html = render(preview({}));
  assert.match(html, /data-testid="artifact-preview"/, '抽屉在场');
  assert.match(html, /data-testid="milkdown-readonly"[^>]*data-readonly="true"/, '必须用只读 Crepe 渲染');
  assert.equal(html.includes('data-testid="artifact-preview-text"'), false, '默认不摊裸源码');
});

test('md 产物：提供「看原文」显式切换（不自动回落源码）', () => {
  const html = render(preview({}));
  assert.match(html, /data-testid="artifact-preview-mode-toggle"/, '缺原文/渲染切换');
  assert.match(html, /看原文/, '切换文案要人话');
});

test('非 md 文本（.py）：仍走 <pre> 原文（既有契约不变）', () => {
  const html = render(preview({ name: 'r.py', path: 'reports/r.py', text: 'print("hi")' }));
  assert.match(html, /data-testid="artifact-preview-text"[^>]*>print\(&quot;hi&quot;\)/, '非 md 必须继续显示原文');
  assert.equal(html.includes('data-testid="milkdown-readonly"'), false, '非 md 不得拉起 Crepe');
  assert.equal(html.includes('data-testid="artifact-preview-mode-toggle"'), false, '非 md 不需要切换');
});

test('.markdown 扩展同样识别（不只 .md）', () => {
  const html = render(preview({ name: 'README.markdown', path: 'README.markdown' }));
  assert.match(html, /data-testid="milkdown-readonly"/, '.markdown 也要渲染');
});
