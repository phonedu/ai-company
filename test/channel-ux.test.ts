/**
 * 频道 UX 三修（老板 2026-10-26 D5 复核反馈）：
 *   ① 回复慢无指示——「幕僚长正在处理…」常驻（末条=老板消息即等回复；回复/回执一到自消，带秒数）；
 *   ② 发消息长时间不出现——sendMessage 乐观上屏（不等 IPC 里的语义分类模型调用）；
 *   ③ 助手回复/决策卡到达不滚动——在底部时任何新内容都跟随（上翻读历史仍不抢）。
 * 附带：F-19 白名单放行 `cd 项目根 && ls`（模型最常用形态，见 readonly-bash ⑪组）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const channel = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');

test('① 等回复指示：末条=老板消息时显示「幕僚长正在处理…」＋秒数；启动中态保留', () => {
  assert.ok(channel.includes('data-testid="assistant-thinking"'), '缺处理中指示');
  assert.ok(channel.includes('幕僚长正在处理…'), '缺文案');
  assert.ok(channel.includes('awaitingReply'), '缺推导');
  assert.ok(channel.includes("direction === 'in'"), '判据＝末条是老板自己的消息');
  assert.ok(channel.includes('setNowTick'), '带秒数计时');
  assert.ok(channel.includes('data-testid="assistant-status"'), '原启动中态保留');
});

test('② 乐观上屏：sendMessage 先插临时消息（负 id），loadChannel 整体替换后自然消失', () => {
  assert.ok(store.includes('const optimisticId = -Date.now();'), '缺乐观 id');
  assert.ok(store.includes('messages.list = ['), '缺临时插入');
  assert.ok(/临时项自然消失|乐观上屏/.test(store), '缺注释口径');
});

test('③ 底部跟随：在底部时任何新内容都滚（不再只认老板自己的消息）；上翻仍不抢', () => {
  // RW-24 后结构改为早退式（if (!atBottomRef.current) return;），语义不变：跟随只看是否在底部。
  assert.ok(
    channel.includes('if (!atBottomRef.current) return;') || channel.includes('atBottomRef.current) {'),
    '跟随只看是否在底部',
  );
  assert.ok(!channel.includes("direction === 'in' && atBottomRef.current"), '旧的只认 in 消息的条件必须移除');
  assert.ok(channel.includes('上翻读历史时仍不抢滚动位置'), '不抢原则注释在');
  assert.ok(channel.includes('focusSnap.cardId != null) return;'), '定位卡时不抢');
});
