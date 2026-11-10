import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BLANK_EARLY_PROBE_MS,
  BLANK_WINDOW_TIMEOUT_MS,
  appendConsoleLine,
  formatBlankWindowDiagnostics,
  isStuckOnPreCommit,
  shouldReloadBlankWindow,
  STARTUP_RETRY_MAX,
  STARTUP_RETRY_MS,
  STARTUP_UNRECOVERED_MS,
} from '../src/main/ui-watchdog.js';

test('BRK20：超时未挂载且未重载过 → 自动重载一次', () => {
  assert.equal(BLANK_WINDOW_TIMEOUT_MS, 15_000);
  assert.equal(shouldReloadBlankWindow({ mounted: false, alreadyReloaded: false, elapsedMs: 15_000 }), true);
});

test('BRK20 有牙：已挂载 / 已重载过 / 未到点 → 不重载（防抖动）', () => {
  assert.equal(shouldReloadBlankWindow({ mounted: true, alreadyReloaded: false, elapsedMs: 60_000 }), false);
  assert.equal(shouldReloadBlankWindow({ mounted: false, alreadyReloaded: true, elapsedMs: 60_000 }), false);
  assert.equal(shouldReloadBlankWindow({ mounted: false, alreadyReloaded: false, elapsedMs: 14_999 }), false);
});

test('BRK20 诊断：console 环形缓冲只留最后 N 条（默认 50）', () => {
  const lines = Array.from({ length: 55 }, (_, i) => `line-${i}`);
  const kept = appendConsoleLine(lines, 'line-55');
  assert.equal(kept.length, 50);
  assert.equal(kept[0], 'line-6');
  assert.equal(kept[49], 'line-55');
});

test('BRK20 诊断：文本含阶段/URL/耗时/console；空 console 如实写 (none)', () => {
  const text = formatBlankWindowDiagnostics({
    at: 1_700_000_000_000,
    url: 'file:///renderer/index.html',
    elapsedMs: 15_000,
    alreadyReloaded: false,
    phase: 'reloading',
    consoleLines: ['[error] boom (app.js:1)'],
  });
  assert.match(text, /phase: reloading/);
  assert.match(text, /url: file:\/\/\/renderer\/index\.html/);
  assert.match(text, /elapsedMs: 15000/);
  assert.match(text, /\[error\] boom/);
  const empty = formatBlankWindowDiagnostics({
    at: 1_700_000_000_000,
    url: '',
    elapsedMs: 1,
    alreadyReloaded: true,
    phase: 'unrecovered',
    consoleLines: [],
  });
  assert.match(empty, /url: \(empty\)/);
  assert.match(empty, /console:\n\(none\)/);
});

test('F-06：早探针常量口径保留；main 已由 F-05 启动状态机接管（旧探针退役）', () => {
  assert.equal(BLANK_EARLY_PROBE_MS, 6_000);
  assert.ok(BLANK_EARLY_PROBE_MS < BLANK_WINDOW_TIMEOUT_MS, '早探针必须早于兜底，才能缩短白屏暴露');
  const main = readFileSync('src/main/index.ts', 'utf8');
  // （2026-11-06）：about:blank 早探针会与真实加载互踩（abort 正常加载）——不得再接回。
  assert.ok(!main.includes('BLANK_EARLY_PROBE_MS'), '早探针不得再出现在 main（由启动页状态机取代）');
});

test('BRK20 根因修复：pre-commit 失败判据（about:blank/空 URL 且未挂载 ⇒ 触发；已提交/已挂载 ⇒ 不触发）', () => {
  // 现场：url=about:blank、未挂载 → 触发（旧看门狗对此失明）。
  assert.equal(isStuckOnPreCommit({ uiMounted: false, url: 'about:blank' }), true);
  assert.equal(isStuckOnPreCommit({ uiMounted: false, url: '' }), true);
  assert.equal(isStuckOnPreCommit({ uiMounted: false, url: '  about:blank  ' }), true, '空白容忍');
  // 已提交到真实 URL（含错误页/慢加载）→ 不由本判据接管（did-finish-load 看门狗负责）。
  assert.equal(isStuckOnPreCommit({ uiMounted: false, url: 'file:///out/renderer/index.html' }), false);
  assert.equal(isStuckOnPreCommit({ uiMounted: false, url: 'http://127.0.0.1:9/' }), false);
  // 已挂载 → 永不触发。
  assert.equal(isStuckOnPreCommit({ uiMounted: true, url: 'about:blank' }), false);
  // （2026-11-06）：该判据的语境已不存在——启动页是 data: URL、真实加载提交由状态机判定；
  // about:blank 判据若接回会把启动页误判成白窗，故 main 不得再引用。
  const main = readFileSync('src/main/index.ts', 'utf8');
  assert.ok(!main.includes('isStuckOnPreCommit'), 'main 不得再接回 about:blank 判据');
  assert.ok(main.includes('loadRenderer('), '恢复动作仍是重发渲染层加载');
  assert.ok(/startupState/.test(main), '必须有启动加载状态机（不依赖 did-finish-load）');
});

test('BRK20 复验修正：固定 6s 重发退役——改由 F-05 单飞＋快速退避状态机接管', () => {
  assert.equal(STARTUP_RETRY_MS, 6_000, '常量口径保留（历史证据），但不得再接回 main');
  assert.equal(STARTUP_RETRY_MAX, 3);
  assert.equal(STARTUP_UNRECOVERED_MS, 24_000, 'unrecovered 必须在全部重发失败之后');
  const main = readFileSync('src/main/index.ts', 'utf8');
  assert.ok(!/startupRetry\(/.test(main), '固定 6s 链式重发不得接回（会 abort 正常加载）');
  assert.ok(main.includes('takeRetryDelay'), '失败重发必须走状态机的快速退避');
  assert.ok(main.includes('buildStartupErrorDataUrl'), '全败必须落到可读错误页（不白窗）');
});
