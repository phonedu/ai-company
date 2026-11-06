/**
 * 浮层批（2026-10-17，替换批·第九批）——判据：
 *   ① **预览抽屉**（设计板 §4.9：480 宽、元信息行、截断/不一致如实标注）：`artifact-preview`＝
 *      `role=dialog` 抽屉；✕ / 遮罩点击 / Esc 三路关闭（容器清 store）；正文与 `artifact-preview-text` 同源；
 *   ② **命令面板**：二选一未裁 ⇒ **保持现状**（顶栏搜索盒 disabled＋理由＝诚实的"撤下"等价物；
 *      真面随搜索件）——源码级锁住现状，防被误做成假可点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { TaskDetail, type ArtifactPreviewDTO, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

const AT = 1_700_000_000_000;

function fixture(): TaskDetailDTO {
  return {
    task: {
      id: 7,
      shortId: 'T-1007',
      projectId: 1,
      title: '演示',
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
    artifacts: [
      { id: 11, kind: 'file', name: 'r.py', path: 'r.py', sha256: 'abcdef0123456789', source: null, commit: null, workItemId: 1, at: AT },
    ],
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  } as unknown as TaskDetailDTO;
}

const PREVIEW: ArtifactPreviewDTO = {
  artifactId: 11,
  name: 'r.py',
  path: 'reports/r.py',
  size: 2048,
  sha256: 'abcdef0123456789deadbeef',
  sha256Mismatch: true,
  truncated: true,
  text: 'print("hi")',
} as unknown as ArtifactPreviewDTO;

function render(preview: ArtifactPreviewDTO | null, onClose?: () => void): string {
  return renderToStaticMarkup(
    createElement(TaskDetail, { data: fixture(), initialTab: 'artifacts', artifactPreview: preview, onCloseArtifactPreview: onClose }),
  );
}

test('预览抽屉：role=dialog＋遮罩 scrim；元信息行含截断与 sha 不一致如实标注；正文同源', () => {
  const html = render(PREVIEW, () => {});
  assert.match(html, /data-testid="artifact-drawer-scrim"/, '缺遮罩');
  assert.match(html, /data-testid="artifact-preview"[^>]*role="dialog"/, '缺 role=dialog');
  assert.match(html, /data-testid="artifact-preview"[^>]*aria-label="产物预览"/);
  assert.match(html, /data-testid="artifact-preview-meta"[^>]*>[\s\S]*?已截断（仅前 256 KiB）/, '截断如实标注');
  assert.match(html, /⚠️ 与记录不一致/, 'sha 不一致如实标注');
  assert.match(html, /reports\/r\.py · 2048 B/, '元信息行＝真读数');
  assert.match(html, /data-testid="artifact-preview-text"[^>]*>print\(&quot;hi&quot;\)/, '正文同源');
  assert.match(html, /data-testid="artifact-drawer-close"/, '缺关闭钮');
  // 无预览 ⇒ 不渲染抽屉（不摆空壳）。
  assert.equal(render(null).includes('artifact-drawer-scrim'), false);
});

test('关闭三路在场：✕／遮罩点击／Esc（容器清 store——源码级）', () => {
  const drawer = readFileSync('src/renderer/components/PreviewDrawer.tsx', 'utf8');
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
  assert.ok(drawer.includes("artifact ? 'artifact-drawer-close'") && drawer.includes('onClick={onClose}'), '✕ 关闭');
  assert.ok(drawer.includes('onClick={onClose}'), '遮罩点击关闭');
  assert.ok(drawer.includes("event.key === 'Escape'"), 'Esc 关闭');
  assert.ok(detail.includes('onCloseArtifactPreview?.()'), '容器清掉 store 里的预览');
  assert.ok(view.includes('taskDetail.artifactPreview = null'), '容器清掉 store 里的预览');
});

test('UG-05（D4 must-fix）：抽屉 Esc 只关抽屉——capture 阻断 + 详情 Esc 避让抽屉（源码级）', () => {
  const drawer = readFileSync('src/renderer/components/PreviewDrawer.tsx', 'utf8');
  const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
  // 抽屉：capture 阶段监听 + stopImmediatePropagation（先于 document 冒泡跑，断链）。
  assert.match(drawer, /addEventListener\('keydown', onKey, true\)/, '抽屉 Esc 必须 capture 阶段监听');
  assert.match(drawer, /stopImmediatePropagation\(\)/, '抽屉 Esc 必须阻断后续监听');
  // 详情：抽屉在场（scrim / 频道附件弹层）时 Esc 不退详情。
  assert.match(view, /artifact-drawer-scrim/, '详情 Esc 必须避让产物抽屉');
  assert.match(view, /attachment-preview/, '详情 Esc 必须避让频道附件弹层');
});

test('样式守门：遮罩 rgba(0,0,0,.35)＋480 抽屉＋关闭 hover 红', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `缺规则 ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.td__drawer-scrim'), /background:\s*rgba\(0, 0, 0, 0\.35\)/);
  assert.match(rule('.td__drawer'), /width:\s*480px/);
  assert.match(rule('.td__drawer-scrim'), /position:\s*fixed/);
  // 老板真机：抽屉盖住顶栏；从顶栏下方到底栏上方，壳层始终可见。
  assert.match(rule('.td__drawer-scrim'), /inset:\s*var\(--topbar-h\)\s+0\s+var\(--statusbar-h\)\s+0/);
});

test('命令面板：2026-10-18 起已落地（顶栏可点＋Ctrl K＋面板组件在场）', () => {
  const chrome = readFileSync('src/renderer/components/AppChrome.tsx', 'utf8');
  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.match(chrome, /data-testid="topbar-search"[^>]*title="打开命令面板（Ctrl K）"/, '顶栏搜索盒可点');
  assert.ok(!/data-testid="topbar-search"[^>]*\n?[^>]*disabled/.test(chrome), '不再 disabled');
  assert.ok(shell.includes("event.key === 'k'") || shell.includes("event.key === 'K'"), 'Ctrl K 挂载');
  assert.ok(shell.includes('CommandPalette'), '面板组件已挂壳');
});
