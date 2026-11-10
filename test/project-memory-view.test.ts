/**
 * B-6· 项目概览「项目记忆」纯视图：空态/行/操作按钮/时间文案 + 接线守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MEMORY_KIND_LABEL,
  memoryTimeText,
  ProjectMemoryView,
  type ProjectMemoryViewProps,
} from '../src/renderer/components/ProjectMemoryView.js';
import type { MemoryAuditDTO, MemoryHitDTO, MemoryItemDTO } from '../src/renderer/types.js';

const base: ProjectMemoryViewProps = {
  projectId: 1,
  scope: 'project',
  items: [],
  loading: false,
  error: null,
  notice: null,
  draft: '',
  kind: 'fact',
  busy: false,
  actingId: null,
  onScopeChange: () => undefined,
  onDraftChange: () => undefined,
  onKindChange: () => undefined,
  onRemember: () => undefined,
  onTogglePin: () => undefined,
  onForget: () => undefined,
  onPromote: () => undefined,
  onRefresh: () => undefined,
};

function item(over: Partial<MemoryItemDTO> = {}): MemoryItemDTO {
  return {
    id: 7,
    scope: { type: 'project', projectId: 1 },
    kind: 'decision',
    key: 'billing.unit',
    value: '对账单以万元为单位',
    source: { type: 'boss', ref: 'boss:command', at: 100 },
    confidence: 'confirmed',
    status: 'active',
    pinned: false,
    validFrom: 100,
    validTo: null,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: null,
    lastVerifiedAt: 100,
    supersededBy: null,
    ...over,
  };
}

test('B-6 视图：空态不伪装；空草稿时「记住」disabled', () => {
  const html = renderToStaticMarkup(createElement(ProjectMemoryView, base));
  assert.match(html, /data-testid="project-memory"/);
  assert.match(html, /还没有项目记忆/);
  assert.match(html, /data-testid="project-memory-add"[^>]*disabled/);
  assert.match(html, /data-testid="project-memory-scope-project"/);
  assert.match(html, /data-testid="project-memory-scope-global"/);
});

test('P-03 视图：全局 tab 不依赖项目；显示全局空态且无「提升为全局」', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectMemoryView, {
      ...base,
      projectId: null,
      scope: 'global',
      items: [item({ scope: { type: 'global' } })],
      draft: '全局事实',
    }),
  );
  assert.match(html, /全局记忆/);
  assert.match(html, /data-testid="project-memory-scope-global"[^>]*aria-pressed="true"/);
  assert.match(html, /data-testid="project-memory-add"(?![^>]*disabled)/);
  assert.doesNotMatch(html, /data-testid="project-memory-promote"/, '全局条目不再提升');
  const empty = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, projectId: null, scope: 'global', items: [] }),
  );
  assert.match(empty, /还没有全局记忆/);
});

test('B-6 视图：行显示类型/值/时间；项目条目有 pin/提升全局/忘记', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, draft: '新事实', items: [item()] }),
  );
  assert.match(html, /data-testid="project-memory-row"/);
  assert.match(html, /data-memory-id="7"/);
  assert.ok(html.includes(MEMORY_KIND_LABEL.decision));
  assert.match(html, /对账单以万元为单位/);
  assert.match(html, /billing\.unit/);
  assert.match(html, /data-testid="project-memory-pin"/);
  assert.match(html, /data-testid="project-memory-promote"/);
  assert.match(html, /data-testid="project-memory-forget"/);
  assert.match(html, /data-testid="project-memory-updated"/);
});

test('F-3 视图：加载失败只显示错误，不把失败伪装成“还没有项目记忆”', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, loading: false, error: '记忆通道不可用', items: [] }),
  );
  assert.match(html, /data-testid="project-memory-error"/);
  assert.doesNotMatch(html, /data-testid="project-memory-empty"/);
});

test('UG-09：搜索/审计只读面板——命中、空命中、审计汇总与分类', () => {
  const hit: MemoryHitDTO = { item: item(), score: 12, snippet: '对账单以万元为单位' };
  const search = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, mode: 'search', query: '万元', hits: [hit] }),
  );
  assert.match(search, /data-testid="project-memory-mode-search"[^>]*aria-pressed="true"/);
  assert.match(search, /data-testid="project-memory-search-input"/);
  assert.match(search, /data-testid="project-memory-search-hit"/);
  assert.match(search, /对账单以万元为单位/);
  assert.match(search, /score 12/);
  const empty = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, mode: 'search', query: 'x', hits: [] }),
  );
  assert.match(empty, /data-testid="project-memory-search-empty"/);

  const audit: MemoryAuditDTO = {
    scope: { type: 'project', projectId: 1 },
    total: 3,
    active: 2,
    duplicates: [item()],
    conflicts: [],
    stale: [],
    oversize: [],
    missingSource: [item({ id: 8 })],
    tokens: 42,
  };
  const auditHtml = renderToStaticMarkup(
    createElement(ProjectMemoryView, { ...base, mode: 'audit', audit }),
  );
  assert.match(auditHtml, /data-testid="project-memory-audit-summary"[^>]*>[\s\S]*?总数 3 · 活跃 2 · token 42/);
  assert.match(auditHtml, /data-testid="project-memory-audit-duplicates"[^>]*>[\s\S]*?重复（1）/);
  assert.match(auditHtml, /data-testid="project-memory-audit-missingSource"[^>]*>[\s\S]*?缺来源（1）/);
  assert.match(auditHtml, /data-testid="project-memory-audit-conflicts"[^>]*>[\s\S]*?无/);
});

test('B-6：时间文案无效 → —；项目概览挂载项目记忆卡', () => {
  assert.equal(memoryTimeText(null), '—');
  assert.equal(memoryTimeText(Number.NaN), '—');
  assert.notEqual(memoryTimeText(100), '—');
  const overview = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.match(overview, /<ProjectMemory\s+projectId=/);
});
