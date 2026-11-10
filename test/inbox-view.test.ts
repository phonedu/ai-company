/**
 *  · 「待我处理」视图纯逻辑 + 未读游标（可见/同源/分组/未读/空态），含"有牙"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_TABS,
  OTHER_TAB,
  groupByTab,
  inboxEntries,
  isActionable,
  sourceLabel,
  tabKeyOf,
  unreadCount,
  visibleTabs,
} from '../src/renderer/components/inboxModel.js';
import { loadSeenAt, saveSeenAt } from '../src/renderer/components/inboxCursor.js';
import type { ReportDTO } from '../src/renderer/types.js';

const AT = 1_700_000_000_000;

function card(over: Omit<Partial<ReportDTO>, 'kind'> & { id: number; kind?: string }): ReportDTO {
  return {
    id: over.id,
    taskId: over.taskId ?? 1,
    shortId: over.shortId ?? `T-${1000 + over.id}`,
    kind: (over.kind ?? 'report') as ReportDTO['kind'],
    state: over.state ?? 'pending',
    createdAt: over.createdAt ?? AT,
    approvalId: over.approvalId ?? null,
    payload: over.payload ?? { title: `card ${over.id}` },
  };
}

test('OPT-EXT-2 可处理：pending/delivered 算；resolved/acknowledged 不算（否则空态造假）', () => {
  assert.equal(isActionable(card({ id: 1, state: 'pending' })), true);
  assert.equal(isActionable(card({ id: 2, state: 'delivered' })), true);
  assert.equal(isActionable(card({ id: 3, state: 'resolved' })), false);
  assert.equal(isActionable(card({ id: 4, state: 'acknowledged' })), false);
});

test('OPT-EXT-2 同源排序：条目按 createdAt（同则 id）升序，且等于 cards 的可处理子集', () => {
  const list = [
    card({ id: 30, createdAt: AT + 20 }),
    card({ id: 10, createdAt: AT }),
    card({ id: 20, createdAt: AT + 20 }),
    card({ id: 99, createdAt: AT - 5, state: 'resolved' }),
  ];
  const entries = inboxEntries(list);
  assert.deepEqual(entries.map((c) => c.id), [10, 20, 30], 'resolved 被剔除、时间升序、同时间按 id');
});

test('OPT-EXT-2 分组：四类 kind 各自成 tab；未知 kind 归 other（不丢、不臆造来源）', () => {
  const list = [
    card({ id: 1, kind: 'ask' }),
    card({ id: 2, kind: 'report' }),
    card({ id: 3, kind: 'alert' }),
    card({ id: 4, kind: 'notification' }),
    card({ id: 5, kind: 'weird_kind' }),
  ];
  const g = groupByTab(list);
  assert.deepEqual(Object.keys(g).sort(), [...INBOX_TABS.map((t) => t.key), OTHER_TAB].sort());
  assert.equal(g.ask.length, 1);
  assert.equal(g.report.length, 1);
  assert.equal(g.alert.length, 1);
  assert.equal(g.notification.length, 1, '通知是独立 tab（来源可区分）');
  assert.equal(g[OTHER_TAB].length, 1, '未知 kind 不丢');
  assert.equal(tabKeyOf('weird_kind'), OTHER_TAB);
});

test('OPT-EXT-2 来源标签：四类各有名；未知 → 通用「卡片」（不假装知道来源）', () => {
  assert.equal(sourceLabel('ask'), '决策');
  assert.equal(sourceLabel('report'), '验收');
  assert.equal(sourceLabel('alert'), '异常');
  assert.equal(sourceLabel('notification'), '通知');
  assert.equal(sourceLabel('weird_kind'), '卡片');
  assert.equal(sourceLabel(OTHER_TAB), '卡片');
});

test('OPT-EXT-2 未读数：只数"三类可处理 且 createdAt > seenAt"；已处理/更早的/FYI 都不算', () => {
  const list = [
    card({ id: 1, createdAt: AT + 100 }), // 未读
    card({ id: 2, createdAt: AT + 50 }), // 未读
    card({ id: 3, createdAt: AT }), // 已读（== seenAt）
    card({ id: 4, createdAt: AT + 100, state: 'resolved' }), // 已处理，不算
    card({ id: 5, kind: 'notification', createdAt: AT + 100 }), // FYI（日报/提醒）：不算（UI §409）
    card({ id: 6, kind: 'weird_kind', createdAt: AT + 100 }), // 未知来源：不算（不冒充三类）
  ];
  assert.equal(unreadCount(list, AT), 2);
  assert.equal(unreadCount(list, AT + 50), 1, '推进游标 → 未读减少');
  assert.equal(unreadCount(list, AT + 1000), 0, '全看过 → 0（噪音被控）');
  // "有牙"：把 kind 过滤去掉（旧写法 = 全部可处理卡）→ 必然多 2（证明三类过滤真的承重）。
  const ifNoKindFilter = list.filter((c) => isActionable(c) && c.createdAt > AT).length;
  assert.equal(ifNoKindFilter, 4, '去掉 kind 过滤 → 4（含通知/未知）⇒ 上面 2 来自过滤');
});

test('OPT-EXT-2 空 tab 不渲染（F-B）：只有 1 类卡 → 只 1 个 tab；多类 → 按顺序只列有卡的', () => {
  assert.deepEqual(
    visibleTabs([card({ id: 1, kind: 'notification' })]).map((t) => t.key),
    ['notification'],
    '只有通知 → 只 1 个 tab',
  );
  assert.deepEqual(visibleTabs([]).map((t) => t.key), [], '无卡 → 0 个 tab（进空态）');
  assert.deepEqual(
    visibleTabs([card({ id: 1, kind: 'ask' }), card({ id: 2, kind: 'alert' })]).map((t) => t.key),
    ['ask', 'alert'],
    '按 INBOX_TABS 顺序只列有卡的',
  );
});

test('OPT-EXT-2 "有牙"：去掉"空 tab 过滤" → 必是 4 个 tab（证明过滤真承重）', () => {
  const only = [card({ id: 1, kind: 'notification' })];
  assert.equal(visibleTabs(only).length, 1, '过滤后 = 1');
  assert.equal(INBOX_TABS.length, 4, '不过滤（无条件 map）→ 4（证明过滤承重）');
  assert.notEqual(visibleTabs(only).length, INBOX_TABS.length);
});

test('OPT-EXT-2 空态：无可处理卡 → entries 为空（视图应显「暂无待处理事项」，不造占位条）', () => {
  assert.deepEqual(inboxEntries([]), []);
  assert.deepEqual(inboxEntries([card({ id: 1, state: 'resolved' })]), [], '只有已处理 → 也是空');
});

test('OPT-EXT-2 "有牙"：若把"已处理"也当可处理，列表/未读数必须变化（证明过滤真的承重）', () => {
  const list = [card({ id: 1, state: 'pending' }), card({ id: 2, state: 'resolved' })];
  assert.equal(inboxEntries(list).length, 1);
  // 模拟"守卫被去掉"（把 resolved 也算可处理）→ 必然多一条：
  const broken = list.filter((c) => c.state !== 'acknowledged').length;
  assert.equal(broken, 2, '去掉过滤 → 2 条（证明上面 1 条来自过滤）');
});

test('OPT-EXT-2 游标跨重启：save→load 往返保留；无/清空/非法 → 0；无 storage 安全降级', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  try {
    saveSeenAt(AT + 7);
    assert.equal(loadSeenAt(), AT + 7, '往返保留（= 重启后仍在）');
    mem.delete('aico.inbox.seenAt');
    assert.equal(loadSeenAt(), 0, '有牙：清掉 → 回 0（不是写死）');
    mem.set('aico.inbox.seenAt', 'not-a-number');
    assert.equal(loadSeenAt(), 0, '非法值 → 0');
    mem.set('aico.inbox.seenAt', '-5');
    assert.equal(loadSeenAt(), 0, '负数 → 0');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.equal(loadSeenAt(), 0, '无 storage → 安全降级（不抛）');
  assert.doesNotThrow(() => saveSeenAt(1), '无 storage 时写入不抛');
});
