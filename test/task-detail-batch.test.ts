/**
 * 任务详情批（2026-10-16，替换批·第三批）——判据：
 *   ① 「返回」随入口动态（`detailReturn` 纯映射）；插话命令＝`#短号话`（与频道同路径）；
 *   ② tab 计数真读数（变更与产物 N；行为日志/成本不再占 tab；成本读数在标题行）；
 *   ③ 验收三态：点色（pass/fail/pending）＋ 文案（已过/未过/未跑）双编码；
 *   ④ 源码守门：Esc 返回、tab 数字键 1–3、插话入口（输入/按钮/tooltip）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';
import { detailReturn } from '../src/renderer/components/detailReturn.js';
import { steerCommand } from '../src/renderer/components/taskActions.js';

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
      acceptance: [
        { text: '覆盖 ≥90%', check: 'pytest -q', state: 'pass' },
        { text: '无回归', state: 'fail' },
        { text: '文档更新', state: 'pending' },
        { text: '未判定项' },
      ],
    },
    progress: { done: 1, total: 2 },
    planSteps: [
      { idx: 1, text: 'a', state: 'done', workItemId: 1, evidenceRef: 'ev-1' },
      { idx: 2, text: 'b', state: 'running', workItemId: 2, evidenceRef: null },
    ],
    timeline: [],
    behaviorLog: [
      { id: 1, ts: AT, actor: 'e', workItemId: 1, payload: { tool: 'x' } },
      { id: 2, ts: AT + 1, actor: 'e', workItemId: 1, payload: { tool: 'y' } },
      { id: 3, ts: AT + 2, actor: 'e', workItemId: 1, payload: { tool: 'z' } },
    ],
    artifacts: [
      { id: 11, kind: 'file', name: 'r.py', path: 'r.py', sha256: null, source: null, commit: null, workItemId: 1, at: AT },
    ],
    counts: { planSteps: 2, timeline: 0, behaviorLog: 3, acceptance: 4 },
  } as unknown as TaskDetailDTO;
}

function render(tab: 'plan' | 'behavior' | 'artifacts' | 'cost'): string {
  const cost = { costRows: 2, tokens: 10, usd: 0.02, byModel: [], byEmployee: [] };
  return renderToStaticMarkup(createElement(TaskDetail, { data: fixture(), initialTab: tab, cost: cost as never }));
}

test('「返回」随入口动态：各视图映射 + 未知/详情自身 ⇒ 老板频道', () => {
  assert.deepEqual(detailReturn('inbox'), { label: '待我处理', target: 'inbox' });
  assert.deepEqual(detailReturn('hall'), { label: '公司大厅', target: 'hall' });
  assert.deepEqual(detailReturn('project'), { label: '项目树', target: 'projects' }, '旧入口→项目树（双栏改版）');
  assert.deepEqual(detailReturn('employee'), { label: '员工设置', target: 'employee' });
  assert.deepEqual(detailReturn('settings'), { label: '设置', target: 'settings' });
  assert.deepEqual(detailReturn('channel'), { label: '老板频道', target: 'channel' });
  assert.deepEqual(detailReturn(null), { label: '老板频道', target: 'channel' });
  assert.deepEqual(detailReturn(undefined), { label: '老板频道', target: 'channel' });
  assert.deepEqual(detailReturn('task'), { label: '老板频道', target: 'channel' }, '详情自身 ⇒ 不绕圈，回落频道');
});

test('插话命令：`#短号 话`；短号缺失回落 `#id`（不臆造短号）', () => {
  assert.equal(steerCommand('T-1042', 42, '快一点'), '#T-1042 快一点');
  assert.equal(steerCommand(null, 42, '快一点'), '#42 快一点');
  assert.equal(steerCommand('', 42, '快一点'), '#42 快一点');
});

test('tab 计数（真读数）：变更与产物 2；行为日志/成本不再占 tab', () => {
  const html = render('plan');
  assert.match(html, /变更与产物 2/, '产物 1 ＋ 证据 1 = 2（合并 tab 的合计）');
  assert.equal(/行为日志 \d/.test(html), false, '行为日志已并入记录筛选，不再占 tab 计数');
  assert.equal(/时间线 \d/.test(html), false, '记录 tab 不带计数');
  assert.match(html, /data-testid="task-cost"[^>]*>成本 \$0\.0200/, '成本读数在标题行');

  // 无成本行 ⇒ 成本显 —（不写假 0）
  const noCost = renderToStaticMarkup(createElement(TaskDetail, { data: fixture(), initialTab: 'plan' }));
  assert.match(noCost, /data-testid="task-cost"[^>]*>成本 —/, '无成本数据 ⇒ 标题行显 —');
});

test('验收三态双编码：点色 data-state（pass/fail/pending）＋ 文案 title（已过/未过/未跑）', () => {
  const html = render('plan');
  assert.match(html, /data-testid="acceptance-item"[^>]*data-state="pass"[^>]*title="已过"/);
  assert.match(html, /data-testid="acceptance-item"[^>]*data-state="fail"[^>]*title="未过"/);
  assert.match(html, /data-testid="acceptance-item"[^>]*data-state="pending"[^>]*title="未跑"/);
});

test('徽标人话（2026-10-17 逐页审查批）：状态「执行中」/「风险：中」上屏；executing / L1 只进悬停', () => {
  const html = render('plan');
  // 读数化（设计板 §4.2 v2）：状态人话＋状态点；风险人人话档位；预算如实。
  assert.match(html, /data-testid="task-state"[^>]*data-tone="accent"[^>]*>.*?执行中/);
  assert.match(html, /data-testid="task-risk"[^>]*>风险：中/);
  assert.match(html, /预算：未设/);
  // **术语不上屏**（§2.3 反模式禁清单）：原文只进 title 悬停。
  assert.equal(html.includes('>executing<'), false, '原始状态键（executing）不得上屏');
  assert.equal(html.includes('>L1<'), false, '档位代号（L1）不得上屏');
  assert.match(html, /title="任务状态：executing"/);
  assert.match(html, /title="风险档 L1 · 审计划：计划先经你批准"/);
});

test('源码守门：Esc 返回（不抢输入/确认条）、tab 数字键 1–3、插话入口三件', () => {
  const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  const store = readFileSync('src/renderer/store.ts', 'utf8');

  assert.ok(view.includes('leaveTaskDetail'), '详情返回走 store.leaveTaskDetail');
  assert.ok(view.includes("event.key !== 'Escape'"), '缺 Esc 返回');
  assert.ok(view.includes("data-testid=\"task-action-confirm\""), 'Esc 必须让位于危险动作确认条');
  assert.ok(view.includes('data-testid="task-steer"'), '缺插话入口');
  assert.ok(view.includes('steerCommand('), '插话必须走 steerCommand（同频道路径）');
  assert.ok(detail.includes("Number.isInteger(index)"), '缺 tab 数字键');
  assert.ok(store.includes('detailReturnView'), '缺入口记录（session.detailReturnView）');
  assert.ok(store.includes('export function leaveTaskDetail'), '缺 leaveTaskDetail');

  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.ok(css.includes('.tdv__steerinput'), '缺插话输入样式');
  assert.ok(detail.includes(".td__dot[data-state='pass']"), '缺验收三态点色（pass）');
});

test('源码守门（React #310 回归）：TaskDetail 的 hooks 必须在 `if (!data)` 早退之前', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  const componentAt = detail.indexOf('export function TaskDetail(');
  assert.ok(componentAt > -1, '找不到 TaskDetail 组件');
  const earlyReturn = detail.indexOf('if (!data) {', componentAt);
  assert.ok(earlyReturn > -1, '找不到 `if (!data)` 早退锚点');
  // 2026-10-17 真机白屏根因：tab 数字键的 useEffect 曾在早退之后 →
  // data null→有值时 hooks 数量变化 → React #310（整屏白）。此处锁死顺序。
  let from = componentAt;
  let effects = 0;
  for (;;) {
    const at = detail.indexOf('useEffect(() => {', from);
    if (at === -1 || at > earlyReturn) break;
    effects += 1;
    from = at + 1;
  }
  assert.ok(effects >= 1, 'TaskDetail 内至少一个 useEffect（tab 数字键），且必须出现在早退之前');
  assert.equal(detail.indexOf('useEffect(() => {', earlyReturn), -1, '早退之后不得再挂 hook（hooks 顺序必须恒定）');
});
