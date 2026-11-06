/**
 * 待我处理批（2026-10-16，替换批·第四批）——判据：
 *   ① 「等了 X」时间锚（纯函数边界）；② INBOX_TABS 去 emoji（无 icon 字段）；
 *   ③ 层级纪律：**一线页无返回钮**（「返回老板频道」已删）——源码级断言；
 *   ④ 行内三件：短号可点（→任务详情）／超时注（timeoutAt 真读数、临近＝warn 点）／动作组
 *      （去验收／标记已阅／在频道看）；样式键帽＋主次按钮在场。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { INBOX_TABS, digestLine, sourceLabel, waitedText } from '../src/renderer/components/inboxModel.js';

const AT = 1_700_000_000_000;

test('「等了 X」时间锚：刚刚 / 分钟 / 小时 / 天（真读数，不摆假精度）', () => {
  assert.equal(waitedText(AT - 30_000, AT), '刚刚');
  assert.equal(waitedText(AT - 5 * 60_000, AT), '5 分钟');
  assert.equal(waitedText(AT - (3 * 60 + 12) * 60_000, AT), '3 小时');
  assert.equal(waitedText(AT - 26 * 3_600_000, AT), '1 天');
  assert.equal(waitedText(AT - 73 * 3_600_000, AT), '3 天');
});

test('INBOX_TABS 去 emoji：无 icon 字段；标签与来源映射不变', () => {
  assert.deepEqual(INBOX_TABS.map((t) => t.key), ['ask', 'report', 'alert', 'notification']);
  assert.deepEqual(INBOX_TABS.map((t) => t.label), ['决策', '验收', '异常', '通知']);
  for (const tab of INBOX_TABS) {
    assert.equal('icon' in tab, false, 'tab 不得再带 icon（板＝纯文字＋计数）');
  }
  assert.equal(sourceLabel('ask'), '决策');
  assert.equal(sourceLabel('other'), '卡片');
});

test('层级纪律：待我处理**无返回钮**（「返回老板频道」已删）；样式随之退役', () => {
  const view = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.equal(view.includes('返回老板频道'), false, '一级页不得有返回钮');
  assert.equal(view.includes('inbox-back'), false, 'inbox-back 应已删除');
  assert.equal(css.includes('.inbox-view__back'), false, '退役样式不得残留');
});

test('日报读数行：只写真实字段；成本 null＝—，全缺省＝不渲染', () => {
  assert.equal(
    digestLine({ completedShortIds: ['T-1', 'T-2'], failedCount: 1, cancelledCount: 0, employeeCount: 2, usd: 0.0123, pendingCards: 2 }),
    '完成 2 · 失败 1 · 取消 0 · 参与员工 2 人 · 成本 $0.0123 · 待你处理 2 张卡',
  );
  // 2026-10-29 P2（F-N12）：完成 0 时不写「参与员工 0 人」（不造读数）。
  assert.equal(
    digestLine({ completedShortIds: [], employeeCount: 0, pendingCards: 0 }),
    '完成 0 · 待你处理 0 张卡',
  );
  assert.equal(digestLine({ usd: null }), '成本 —', '无成本行＝—（不写假 0）');
  assert.equal(digestLine({}), null, '没有任何字段 → 不造读数行');
  assert.equal(digestLine(undefined), null);
});

test('行内三件在场：短号可点（→详情）／等锚／超时注／动作组（去验收·标记已阅·在频道看）', () => {
  const view = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  assert.ok(view.includes('openTaskDetail'), '短号/去验收必须能开任务详情');
  assert.ok(view.includes('data-testid="inbox-short"'), '缺可点短号');
  assert.ok(view.includes('data-testid="inbox-wait"'), '缺「等了 X」锚');
  assert.ok(view.includes('data-testid="inbox-timeout"'), '缺超时注');
  assert.ok(view.includes('data-near='), '超时临近态必须可辨（warn 点）');
  assert.ok(view.includes('data-testid="inbox-goto-task"'), '缺「去验收」');
  assert.ok(view.includes('data-testid="inbox-goto-channel"'), '缺「在频道看」');
  assert.ok(view.includes('data-testid="inbox-option"'), '选项 testid 保持（CDP 脚本在吃）');
  // 超时注文案口径（与频道卡同源：remainText ＋ defaultAction）。
  assert.ok(view.includes('到点默认按'), '超时注须写清"到点会发生什么"');
});

test('日报行补摘要/读数；「在频道看」走精准定位（不是裸切频道）', () => {
  const view = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  assert.ok(view.includes('data-testid="inbox-summary"'), '缺摘要行');
  assert.ok(view.includes('data-testid="inbox-digest"'), '缺日报读数行');
  assert.ok(view.includes('digestLine(card.payload.digest)'), '日报读数必须来自 payload.digest');
  assert.ok(view.includes('focusChannelCard(card.id)'), '「在频道看」必须带目标卡 id');
  assert.equal(view.includes('onClick={showChannel}'), false, '不得只切频道而丢失目标卡');
});

test('样式守门：键帽／主次按钮／超时注（warn 点，warn 不作文字）在场', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `缺规则 ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  // 卡片可读性批（老板 2026-10-28）：行内键帽退役（桌面点按钮即答；序号只在 IM 侧）。
  assert.equal(css.includes('.inbox-row__key'), false, 'inbox-row__key 键帽应已退役');
  assert.match(rule('.inbox-row__btn--primary'), /background:\s*var\(--accent-strong\)/, '主钮＝实底');
  const timeout = rule(".inbox-row__timeout[data-near='true']::before");
  assert.match(timeout, /background:\s*var\(--warn\)/, '临近＝warn 点');
  assert.match(rule('.inbox-row__short--link'), /color:\s*var\(--accent-ink\)/, '可点短号＝accent-ink');
});
