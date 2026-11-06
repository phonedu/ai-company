/**
 * F-02 回归：报告 payload 的「计划步骤交代」字段**不得**叫 `planSteps`。
 *
 * 真机现场（2026-11-06，L1 复跑）：报告卡 payload 里放了字符串 `planSteps`，而 BossChannel 的
 * 批准卡按 `payload.planSteps`（数组）渲染 `<CardPlan steps=…>` → 对字符串 `.map` → 未捕获异常
 * → React 整棵卸载 → 空白窗口（截图纯背景色、`center` 消失）。
 *
 * 修：字段改名 `planStepsNote`；渲染端只认数组（历史/外部 payload 也不再能炸）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
const executor = readFileSync('src/main/agent/employee-executor.ts', 'utf8');

test('CardPlan 只接受数组：字符串/其它类型不得进入 CardPlan', () => {
  assert.match(
    card,
    /Array\.isArray\(card\.payload\.planSteps\)\s*&&\s*card\.payload\.planSteps\.length > 0/,
    'Card 渲染前必须 Array.isArray 守卫（否则字符串 .map 崩溃）',
  );
  assert.match(card, /<CardPlan steps=\{card\.payload\.planSteps\}/);
});

test('InboxView 的计划摘要/完整计划同样只认数组', () => {
  assert.match(inbox, /Array\.isArray\(card\.payload\.planSteps\)/, '摘要行必须有数组守卫');
  const full = inbox.match(/card\.kind === 'ask' && Array\.isArray\(card\.payload\.planSteps\) && card\.payload\.planSteps\.length > 0/g) ?? [];
  assert.equal(full.length, 1, '完整计划展开必须有数组守卫');
});

test('报告 payload 用 planStepsNote，不再占用 planSteps 这个数组字段名', () => {
  assert.match(executor, /planStepsNote: planStepsExplanation\.length > 0/, '报告/事件必须写 planStepsNote');
  assert.ok(
    !/payload: \{ role: 'verifier', verdict: raw, notes, title: [^}]*\bplanSteps:/.test(executor),
    '报告 payload 不得再写 planSteps 字符串',
  );
});
