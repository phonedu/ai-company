/**
 * N4（``）· 压缩**可观测**（次数/原因/阈值可读）+ 「基线段被真接上」的守卫。
 *
 * 覆盖面（对照 plan §5.6「N4：压缩后三要素仍在；次数/阈值可读」）：
 *  - **纯策略**（`compaction-policy`）：观测/累计/复位/人读描述（含"基线在 system 段"提示，防误读）；
 *  - **钩子接线**（`registerCompactionObserver`）：fake pi（无凭据/无真会话）→ 两事件都注册、回调返回 `undefined`（**不取消压缩**）；
 *  - **接线在场**（源码级）：`pi-runtime` 的 `extensionFactories` 必须含 `registerCompactionObserver`——
 *    否则"写了没人调"，生产里次数恒 0 = **静默不可读**（P6 违规）；
 *  - **有牙**：拿掉/改坏 → 断言必红（合成用例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeCompaction,
  observeBeforeCompact,
  observeCompacted,
  resetCompactionStats,
  sessionCompactionStats,
  stats,
  type CompactionObservation,
} from '../src/main/agent/compaction-policy.js';
import { registerCompactionObserver } from '../src/main/agent/pi-runtime.js';

/** 最小 fake pi：只记 `on` 注册表（模拟底座扩展 API 的观测面）。 */
function makeFakePi(): { handlers: Map<string, (ev: unknown) => unknown>; pi: unknown } {
  const handlers = new Map<string, (ev: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (ev: unknown) => unknown): () => void {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  return { handlers, pi };
}

const BEFORE_EVENT = {
  type: 'session_before_compact',
  reason: 'threshold',
  willRetry: true,
  preparation: { tokensBefore: 123456, previousSummary: '旧摘要' },
};

test('N4 policy: 观测最近一次压缩 + 累计计数/复位（不臆造初始值）', () => {
  resetCompactionStats();
  assert.deepEqual(stats(), { count: 0, lastBefore: null }, '初始必须如实为空（不是假 0 计数带假观测）');

  const o: CompactionObservation = { reason: 'threshold', tokensBefore: 123456, willRetry: true, hadPreviousSummary: true };
  assert.equal(observeBeforeCompact(o), o, '返回值=入参（纯观测，不改行为）');
  assert.deepEqual(stats().lastBefore, o);
  assert.equal(stats().count, 0, '「即将压缩」不计成功数（可能被取消）');

  const s1 = observeCompacted();
  assert.equal(s1.count, 1);
  assert.equal(observeCompacted().count, 2, '累计');

  resetCompactionStats();
  assert.deepEqual(stats(), { count: 0, lastBefore: null }, '复位可回初始（测试间不串）');
});

test('N4 policy: 人读描述含 reason/tokensBefore/willRetry + 基线提示（防误读为"简报被压掉"）', () => {
  const iterative = describeCompaction({ reason: 'overflow', tokensBefore: 999, willRetry: true, hadPreviousSummary: true });
  assert.ok(iterative.includes('reason=overflow') && iterative.includes('tokensBefore=999') && iterative.includes('willRetry=true'));
  assert.ok(iterative.includes('（迭代摘要）'));
  assert.ok(iterative.includes('任务基线在 system 段'), '必须提示基线不参与压缩（读者不必担心三要素丢失）');

  const first = describeCompaction({ reason: 'threshold', tokensBefore: 1, willRetry: false, hadPreviousSummary: false });
  assert.ok(!first.includes('（迭代摘要）'), '首次压缩不标迭代摘要');
});

test('N4 hook: fake pi → 两事件都注册；回调返回 undefined（不取消压缩）且更新观测', () => {
  resetCompactionStats();
  const { handlers, pi } = makeFakePi();
  registerCompactionObserver(pi);

  assert.ok(handlers.has('session_before_compact'), '必须订阅 session_before_compact（阈值/原因可读）');
  assert.ok(handlers.has('session_compact'), '必须订阅 session_compact（次数可读）');

  const beforeRet = handlers.get('session_before_compact')!(BEFORE_EVENT);
  assert.equal(beforeRet, undefined, '返回 undefined ⇒ 底座照常压缩（观测不夺权）');
  assert.deepEqual(stats().lastBefore, {
    reason: 'threshold',
    tokensBefore: 123456,
    willRetry: true,
    hadPreviousSummary: true,
  });

  handlers.get('session_compact')!({ type: 'session_compact', reason: 'threshold', willRetry: true });
  assert.equal(stats().count, 1);
});

test('N4 hook: 事件字段缺失 → 如实兜底（unknown/0/false），不抛出', () => {
  resetCompactionStats();
  const { handlers, pi } = makeFakePi();
  registerCompactionObserver(pi);
  const ret = handlers.get('session_before_compact')!(undefined);
  assert.equal(ret, undefined);
  assert.deepEqual(stats().lastBefore, { reason: 'unknown', tokensBefore: 0, willRetry: false, hadPreviousSummary: false });
});

test('CTX1-2: 压缩读数按会话隔离（sessionKey 闭包），进程总数不冒充本会话', () => {
  resetCompactionStats();
  observeBeforeCompact({ reason: 'threshold', tokensBefore: 900, willRetry: false, hadPreviousSummary: false }, 's1');
  observeCompacted('s1');
  observeCompacted('s1');
  observeCompacted('s2');
  assert.deepEqual(sessionCompactionStats('s1'), {
    count: 2,
    lastBefore: { reason: 'threshold', tokensBefore: 900, willRetry: false, hadPreviousSummary: false },
  });
  assert.equal(sessionCompactionStats('s2').count, 1);
  assert.deepEqual(sessionCompactionStats('never'), { count: 0, lastBefore: null }, '未观测 → 0/空，不臆造');
  assert.equal(stats().count, 3, '进程总数仍如实累计');
  resetCompactionStats();
});

test('N4 hook: pi 无 on（SDK 面变化）→ 静默不炸但**不假装已观测**（计数仍 0）', () => {
  resetCompactionStats();
  assert.doesNotThrow(() => registerCompactionObserver({}), '缺 on 不得抛（免得整个会话装配失败）');
  assert.equal(stats().count, 0, '没接上就是没接上（不臆造观测）');
});

test('N4 wiring: pi-runtime 的 extensionFactories 必须含 registerCompactionObserver（防"写了没人调"）', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'pi-runtime.ts'), 'utf8');
  assert.ok(
    /extensionFactories:\s*\[[\s\S]{0,400}?registerCompactionObserver\(api,\s*sessionKey\)/.test(src),
    'ResourceLoader 装配点必须前置注册观测器，且**按会话**传入 sessionKey（否则 context_metrics 只能记进程总数）',
  );
});

test('CTX1-1/5 wiring: mask 钩子按会话注册；压缩档经 SettingsManager.applyOverrides 注入', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'pi-runtime.ts'), 'utf8');
  assert.ok(
    /registerContextMasking\(api,\s*\{[\s\S]{0,200}?sessionKey/.test(src),
    'tool_result/context 裁剪必须按会话注册（否则 ref/归档目录跨会话串）',
  );
  assert.ok(/deriveCompactionOverrides\(/.test(src), '必须从模型窗口推导压缩档');
  assert.ok(/SettingsManager\.create\(/.test(src), '必须基于用户/Pi 既有设置再叠加');
  assert.ok(
    /applyOverrides\(\{\s*compaction:\s*\{\s*modelOverrides/.test(src),
    '必须用 Pi 原生 compaction.modelOverrides（不另造阈值）',
  );
});

test('N4 "有牙": 改坏观测面 → 断言必红（合成，证明上述断言有意义）', () => {
  // ① 计数可被弄红：观测后 count 必增
  resetCompactionStats();
  observeCompacted();
  assert.notDeepEqual(stats(), { count: 0, lastBefore: null });
  // ② "接线在场"的判据：拿掉前置注册即不匹配
  const broken = 'extensionFactories: (options.extensionFactories ?? []) as never,';
  assert.ok(!/extensionFactories:\s*\[[\s\S]{0,400}?registerCompactionObserver\(api,\s*sessionKey\)/.test(broken));
  // ③ 事件字段解析：willRetry 取自**顶层**（写死 false 的实现会被这条抓出来）
  resetCompactionStats();
  const { handlers, pi } = makeFakePi();
  registerCompactionObserver(pi);
  handlers.get('session_before_compact')!(BEFORE_EVENT);
  assert.equal(stats().lastBefore?.willRetry, true);
});
