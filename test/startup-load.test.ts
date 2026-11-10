/**
 * （2026-11-06）：冷启白窗修法的纯状态机与启动页契约。
 *
 * 守的是：真实加载**单飞**（在飞时不重发，避免自己 abort 自己）、启动页/空白页的完成事件
 * 不算提交、失败退避有界、mounted 超时只 reload 一次、全败落到可读错误页而不是白窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REAL_LOAD_RETRY_DELAYS_MS,
  beginRealLoad,
  initialStartupState,
  isRealRendererUrl,
  markMounted,
  onCommitTimeout,
  onMountTimeout,
  settleLoadFail,
  settleLoadOk,
  takeRetryDelay,
} from '../src/main/startup-load.js';
import { buildSplashDataUrl, buildStartupErrorDataUrl } from '../src/main/startup-splash.js';

test('F-05 单飞：在飞时 beginRealLoad 不重复发起；已挂载/已失败后也不再发起', () => {
  const s0 = initialStartupState();
  const s1 = beginRealLoad(s0);
  assert.equal(s1.inFlight, true);
  assert.equal(s1.attempts, 1);
  assert.equal(beginRealLoad(s1), s1, '在飞时必须原样返回（不得并发重发）');

  const mounted = markMounted(s1);
  assert.equal(beginRealLoad(mounted), mounted, '已挂载后不得再发');

  const failed = { ...s1, phase: 'failed' as const, inFlight: false };
  assert.equal(beginRealLoad(failed), failed, '已失败后不得再发');
});

test('F-05 提交判据：只有 file:/http(s): 算真实提交；data: 启动页与 about:blank 不算', () => {
  assert.equal(isRealRendererUrl('file:///C:/app/out/renderer/index.html'), true);
  assert.equal(isRealRendererUrl('http://127.0.0.1:5173/'), true);
  assert.equal(isRealRendererUrl('https://example.com/'), true);
  assert.equal(isRealRendererUrl('data:text/html,<html></html>'), false);
  assert.equal(isRealRendererUrl('about:blank'), false);

  const loading = beginRealLoad(initialStartupState());
  const still = settleLoadOk(loading, 'data:text/html,<html>splash</html>');
  assert.equal(still.phase, 'loading', '启动页完成事件不得把状态推到 committed');
  const committed = settleLoadOk(still, 'file:///C:/app/out/renderer/index.html');
  assert.equal(committed.phase, 'committed');
  assert.equal(committed.inFlight, false);
});

test('F-05 退避有界：300/1000/2000/4000ms，用尽后 failed（不无限重试）', () => {
  let s = initialStartupState();
  const seen: number[] = [];
  for (let i = 0; i < REAL_LOAD_RETRY_DELAYS_MS.length; i += 1) {
    s = beginRealLoad(s);
    s = settleLoadFail(s, `fail-${i + 1}`);
    const taken = takeRetryDelay(s);
    assert.equal(taken.delayMs, REAL_LOAD_RETRY_DELAYS_MS[i]);
    s = taken.state;
  }
  s = beginRealLoad(s); // 第 5 次
  s = settleLoadFail(s, 'fail-5');
  assert.equal(s.pendingRetryMs, null, '档位用尽后不得再排重试');
  assert.equal(s.phase, 'failed');
  assert.equal(s.lastError, 'fail-5');
  seen.push(...REAL_LOAD_RETRY_DELAYS_MS);
  assert.deepEqual(seen, [300, 1000, 2000, 4000]);
});

test('F-05 mounted 超时：第一次 reload 真实页，第二次放弃并转错误页状态', () => {
  let s = settleLoadOk(beginRealLoad(initialStartupState()), 'file:///C:/app/out/renderer/index.html');
  assert.equal(s.phase, 'committed');
  const first = onMountTimeout(s);
  assert.equal(first.action, 'reload');
  assert.equal(first.state.mountReloaded, true);
  const second = onMountTimeout(first.state);
  assert.equal(second.action, 'give-up');
  assert.equal(second.state.phase, 'failed');
  assert.equal(second.state.lastError, 'mounted-timeout');
});

test('F-05 提交超时：只在加载在飞时生效，走同一退避序列', () => {
  const idle = onCommitTimeout(initialStartupState());
  assert.equal(idle.action, 'none');

  const s = beginRealLoad(initialStartupState());
  const timedOut = onCommitTimeout(s);
  assert.equal(timedOut.action, 'failed');
  assert.equal(timedOut.state.inFlight, false);
  assert.equal(timedOut.state.pendingRetryMs, 300, '首次提交超时也按第一档退避');
});

test('F-05 启动页/错误页：内联 data URL、无脚本/外部资源、失败原因可见且转义', () => {
  const splash = buildSplashDataUrl();
  assert.ok(splash.startsWith('data:text/html;charset=utf-8,'), '必须是内联 data URL（不依赖网络栈）');
  const decodedSplash = decodeURIComponent(splash.slice('data:text/html;charset=utf-8,'.length));
  assert.match(decodedSplash, /正在启动…/);
  assert.ok(!/<script/i.test(decodedSplash), '启动页不得带脚本');
  assert.ok(!/https?:\/\//i.test(decodedSplash), '启动页不得引外部资源');

  const err = buildStartupErrorDataUrl({ reason: '<boom> & "x"', logDir: 'C:\\data\\logs' });
  const decodedErr = decodeURIComponent(err.slice('data:text/html;charset=utf-8,'.length));
  assert.match(decodedErr, /启动失败/);
  assert.match(decodedErr, /&lt;boom&gt; &amp; &quot;x&quot;/, '原因必须转义后展示');
  assert.match(decodedErr, /C:\\data\\logs/);
  assert.ok(!/正在启动/.test(decodedErr), '错误页不得继续显示「正在启动」');
});

test('F-05 接线契约：main 用启动页＋单飞状态机，旧的 about:blank 看门狗已退役', () => {
  const main = readFileSync('src/main/index.ts', 'utf8');
  assert.ok(main.includes('buildSplashDataUrl'), 'createWindow 必须先加载内联启动页');
  assert.ok(main.includes('beginRealLoad'), '真实加载必须经单飞状态机');
  assert.ok(main.includes('onMountTimeout'), 'mounted 超时必须走「reload 一次→错误页」');
  assert.ok(!main.includes('BLANK_EARLY_PROBE_MS'), 'about:blank 早探针应退役（它会与真实加载互踩）');
  assert.ok(!main.includes('isStuckOnPreCommit'), 'about:blank 判据应退役');
  assert.ok(!main.includes('startupRetry('), '旧的固定 6s 重发应退役');
});
