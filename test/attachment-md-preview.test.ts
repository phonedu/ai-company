/**
 * 附件（频道）预览的 .md 只读渲染（2026-11-05：「附件 .md 也要渲染」）。
 *
 * 背景：任务产物的「读」上次已改只读渲染（`verify-artifact-md-preview-2026-11-05`），
 * 但频道附件走的是同一个抽屉的 `variant="attachment"`，仍按原文 `<pre>` 显示。
 * 本次把 `markdown` 标记同样接到附件，口径与产物一致：
 *  - `.md`/`.markdown` → 只读渲染（Milkdown/Crepe）＋「看原文」显式切换；不自动回落裸源码；
 *  - 其它文本 → 原文 `<pre>`（契约不变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PreviewDrawer } from '../src/renderer/components/PreviewDrawer.js';

const md = (over: Record<string, unknown> = {}) => ({
  title: '方案.md',
  meta: 'text/markdown · 2 KB',
  kind: 'text' as const,
  text: '# 标题\n\n- 要点\n',
  ...over,
});

test('附件 .md：attachment 变体也走只读渲染，默认不摊源码', () => {
  const html = renderToStaticMarkup(
    createElement(PreviewDrawer, {
      variant: 'attachment',
      onClose: () => undefined,
      data: { ...md(), markdown: true },
    }),
  );
  assert.match(html, /data-testid="attachment-preview-panel"/, '仍是附件抽屉');
  assert.match(html, /data-testid="milkdown-readonly"[^>]*data-readonly="true"/, '必须用只读渲染器');
  assert.equal(html.includes('attachment-preview__text'), false, '默认不摊裸源码');
  assert.match(html, /data-testid="artifact-preview-mode-toggle"/, '提供「看原文」切换');
});

test('附件非 md（.txt）：仍原文 <pre>，不拉渲染器', () => {
  const html = renderToStaticMarkup(
    createElement(PreviewDrawer, {
      variant: 'attachment',
      onClose: () => undefined,
      data: md({ title: 'note.txt', text: 'plain line\n' }),
    }),
  );
  assert.match(html, /attachment-preview__text/, '非 md 仍原文');
  assert.equal(html.includes('milkdown-readonly'), false);
});

test('接线：BossChannel 必须按附件名判断 .md 传 markdown（防「写了没人用」）', () => {
  const src = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
  assert.match(
    src,
    /markdown:\s*\/\\\.\(md\|markdown\)\$\/i\.test\(/,
    'BossChannel 的 PreviewDrawer data 必须带 markdown 判定',
  );
});
