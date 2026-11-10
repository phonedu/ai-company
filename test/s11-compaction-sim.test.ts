/**
 *  边界批 · 长会话压缩的**模拟测试**（真机不触发：deepseek 窗口 1M，压不到阈值）。
 *
 * 用 Pi 官方 `shouldCompact`（压缩触发判据的唯一真源）＋本仓阈值推导（CTX1-5）联合验证：
 * ① 阈值公式：触发线＝contextWindow − reserveTokens；恰好等于→不压，超过→压；
 * ② 本仓推导：6000 窗口 → reserve 900 / keepRecent 2100，喂 6000 窗口时 5200 token 即触发；
 * ③ 1M 窗口（真机实际）→ 991k token 才触发——解释真机为何压不到，不是功能坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldCompact } from '@earendil-works/pi-coding-agent';
import { deriveCompactionOverrides } from '../src/main/agent/compaction-policy.js';

test('S11-压缩① Pi 触发判据：超过窗口−reserve 才压（等于不压）', () => {
  const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
  const window = 100_000;
  assert.equal(shouldCompact(window - 16_384, window, settings), false, '恰好等于触发线 → 不压');
  assert.equal(shouldCompact(window - 16_384 + 1, window, settings), true, '超过 1 token → 压');
  assert.equal(shouldCompact(10_000, window, settings), false, '远低于 → 不压');
  assert.equal(shouldCompact(window, window, { ...settings, enabled: false }), false, 'enabled=false → 永不压');
});

test('S11-压缩② 本仓推导：6000 窗口 → reserve 900/keep 2100；5200 token 即触发', () => {
  const out = deriveCompactionOverrides([{ provider: 'deepseek', id: 'x', contextWindow: 6000 }]);
  const s = out['deepseek/x'];
  assert.deepEqual(s, { reserveTokens: 900, keepRecentTokens: 2100 });
  assert.equal(shouldCompact(6000 - 900, 6000, { enabled: true, ...s }), false, '恰好 5100 → 不压');
  assert.equal(shouldCompact(5101, 6000, { enabled: true, ...s }), true, '5101 → 压');
});

test('S11-压缩③ 真机窗口 1M：需 ~991k token 才触发（解释真机未触发，非缺陷）', () => {
  const out = deriveCompactionOverrides([{ provider: 'deepseek', id: 'chat', contextWindow: 1_000_000 }]);
  const s = out['deepseek/chat'];
  const threshold = 1_000_000 - s.reserveTokens;
  assert.equal(shouldCompact(threshold - 1, 1_000_000, { enabled: true, ...s }), false);
  assert.equal(shouldCompact(threshold + 1, 1_000_000, { enabled: true, ...s }), true);
  assert.ok(threshold > 980_000, `触发线在 ${threshold}（真机对话远未达到）`);
});
