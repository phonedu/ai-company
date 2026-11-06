import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompanyHallView, collabEdgeText, groupByDepartment } from '../src/renderer/components/CompanyHallView.js';
import type { HallStateDTO } from '../src/renderer/types.js';

// ─────────────── 公司大厅（简单版 B0/B1）· 纯展示 + 分组/协作文案 ───────────────
// 口径：轻量部门（零迁移配置）· 不显示负责人 · 协作**只用真实流向 + 真实次数**（没往来不画边）。
// 手法同 T0.7：`renderToStaticMarkup` 渲染真实组件 → 数 `data-testid`（不引 jsdom）。

function countTestId(html: string, id: string): number {
  const needle = `data-testid="${id}"`;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

const DATA: HallStateDTO = {
  employees: [
    { id: 1, name: '林悦', role: '产品负责人' },
    { id: 2, name: '苏然', role: '运营' },
    { id: 0, name: '幕僚长', role: '编排', isAssistant: true },
  ],
  departments: [
    { id: 'product', name: '产品部', memberIds: [1] },
    { id: 'ops', name: '运营部', memberIds: [2] },
  ],
  collab: [
    { from: 'product', to: 'ops', count: 12, kinds: { assign: 12 } },
    { from: 'ops', to: 'product', count: 0 }, // 没有往来 → **不得出边**
  ],
  windowDays: 7,
};

function render(
  data: HallStateDTO | null,
  opts: {
    loading?: boolean;
    error?: string | null;
    onSelectEmployee?: (id: number) => void;
    onOpenTask?: (taskId: number) => void;
    pane?: 'employee' | 'collab' | 'activity';
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(CompanyHallView, {
      data,
      loading: opts.loading ?? false,
      error: opts.error ?? null,
      pane: opts.pane ?? 'employee',
      onSelectEmployee: opts.onSelectEmployee,
      onOpenTask: opts.onOpenTask,
    }),
  );
}

test('双栏批：员工行可点（onSelectEmployee 在场 → role=button/tabIndex=0；缺省 → aria-disabled，不假装可点）', () => {
  const clickable = render(DATA, { onSelectEmployee: () => {} });
  const rows = clickable.match(/<div[^>]*data-testid="hall-employee"[^>]*>/g) ?? [];
  assert.equal(rows.length, 3, '三名员工都是可交互行');
  assert.equal(rows.every((c) => c.includes('role="button"')), true, '行是 role=button（内含任务短号按钮，不能嵌套 button）');
  assert.equal(rows.every((c) => c.includes('tabindex="0"')), true, '有回调 → 键盘可达');
  assert.equal(rows.every((c) => !c.includes('aria-disabled="true"')), true, '有回调 → 全部可点（切右栏，不跳页）');
  assert.match(rows[0], /看 林悦 当前在做什么（右栏）/, 'title 说明去处（不猜）');

  const inert = render(DATA);
  const inertRows = inert.match(/<div[^>]*data-testid="hall-employee"[^>]*>/g) ?? [];
  assert.equal(inertRows.length, 3);
  assert.equal(inertRows.every((c) => c.includes('aria-disabled="true"')), true, '缺省回调 → 禁用（不假装可点）');
  assert.equal(inertRows.every((c) => c.includes('tabindex="-1"')), true);
});

test('分组：按部门归组，未在任何部门的员工落入「未分组」（不隐藏、不臆造）', () => {
  const { groups, ungrouped } = groupByDepartment(DATA);
  assert.deepEqual(
    groups.map((g) => [g.id, g.employees.map((e) => e.id)]),
    [
      ['product', [1]],
      ['ops', [2]],
    ],
  );
  assert.deepEqual(
    ungrouped.map((e) => e.id),
    [0],
    '幕僚长(0)未挂部门 → 必须出现在「未分组」',
  );
});

test('render：平铺在岗名单（员工数与 DTO 一致）；不再渲染部门/未分组空壳', () => {
  const html = render(DATA);
  assert.equal(countTestId(html, 'hall-employee'), DATA.employees.length, 'DOM 员工卡数 == 查询人数');
  assert.match(html, /data-testid="hall-roster-list"/);
  assert.match(html, /data-testid="hall-on-duty"[^>]*>3 人在岗/);
  assert.match(html, /data-testid="hall-busy"[^>]*>0 人在忙/);
  assert.equal(html.includes('data-testid="hall-department"'), false, '不再摆部门空壳');
  assert.equal(html.includes('data-testid="hall-ungrouped"'), false, '不再摆未分组空壳');
  assert.match(html, /data-testid="hall-idle"/, '全员空闲右栏收口');
  assert.match(html, /data-testid="hall-idle-channel"/, '全员空闲只留一个动作');
  assert.match(html, /幕僚长（幕僚长）|幕僚长/);
});

test('协作：**只画真实发生的边**（count>0）；count=0 的那条不得出现', () => {
  const html = render(DATA, { pane: 'collab' });
  assert.equal(countTestId(html, 'hall-collab-edge'), 1, '只有 count>0 的边');
  assert.match(html, /data-count="12"/);
  assert.match(html, /近 7 天/);
  assert.equal(html.includes('data-count="0"'), false, 'count=0 不得渲染');
});

test('协作文案：**只报真实次数 + 中性文案**（不得凭 count 编动作名细分）', () => {
  const name = (id: string): string => (id === 'product' ? '产品部' : '运营部');
  assert.equal(collabEdgeText({ from: 'product', to: 'ops', count: 12 }, name, 7), '产品部 → 运营部 · 近 7 天 12 次');
  assert.equal(collabEdgeText({ from: 'a', to: 'b', count: 5 }, (id) => id), 'a → b · 5 次');
  // 禁止凭空动作名：文案不得含「派工/提问/评审/交付」这些细分词
  assert.equal(/派工|提问|评审|交付/.test(collabEdgeText({ from: 'a', to: 'b', count: 9 }, (id) => id, 7)), false);
  // **即使 DTO 带了 `kinds`，也不得改装成动作名**（当前实现完全不消费 kinds；本断言锁住这一点）
  const withKinds = collabEdgeText({ from: 'a', to: 'b', count: 9, kinds: { assign: 9, ask: 1 } }, (id) => id, 7);
  assert.equal(withKinds, 'a → b · 近 7 天 9 次');
  assert.equal(/派工|提问|评审|交付/.test(withKinds), false);
});

test('无任何真实协作 → 显示「暂无真实协作记录」，不画边', () => {
  const html = render({ ...DATA, collab: [{ from: 'product', to: 'ops', count: 0 }] }, { pane: 'collab' });
  assert.equal(countTestId(html, 'hall-collab-edge'), 0);
  assert.match(html, /暂无真实协作记录/);
});

test('空态：没有员工 → hall-empty（不显示部门/协作空壳）＋大厅内「＋招募」入口', () => {
  const html = render({ employees: [], departments: [], collab: [] });
  assert.equal(countTestId(html, 'hall-empty'), 1);
  assert.equal(countTestId(html, 'hall-department'), 0);
  assert.match(html, /暂无动态/);
  assert.equal(countTestId(html, 'hall-recruit'), 1, 'RM-1：空态也不得把招募入口只留在老板频道');
  assert.match(html, /点下方「＋招募」直接招一名/);
});

test('错误态：加载失败 → hall-error（不白屏）', () => {
  const html = render(null, { error: 'hall:state not implemented' });
  assert.equal(countTestId(html, 'hall-error'), 1);
});

test('负责人不渲染（老板口径；DTO 里预留也不显示）', () => {
  const html = render({ ...DATA, departments: [{ id: 'product', name: '产品部', leadEmployeeId: 1, memberIds: [1] }] });
  // 注意：员工 role 文案里可能含「负责人」字样（如「产品负责人」），故断言**标记**而非子串
  assert.equal(/负责人[:：·]/.test(html), false, '不得渲染「负责人」标记');
  assert.equal(countTestId(html, 'hall-dept-lead'), 0);
});

test('BRK19：大厅容器不重复订阅（订阅只由 AppShell 全局单点挂载）', () => {
  const hallSource = readFileSync('src/renderer/components/CompanyHall.tsx', 'utf8');
  const shellSource = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.doesNotMatch(hallSource, /subscribeEvents\s*\(/, 'CompanyHall 不得再局部订阅');
  assert.match(shellSource, /subscribeEvents\(\)/, 'AppShell 必须保留全局订阅');
});
