/**
 * 修（2026-10-14 真机暴露）· 系统提示词**逐轮注入**的守卫。
 *
 * 现场（chain-e2e 真机）：员工会话把任务当「入参为空」升级（任务停 `needs_decision`）。取证：会话落盘的
 * `sections.preamble` 竟是**构造期占位符**（`EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER`）——`run({ systemPrompt })`
 * 逐次传入的五层真值**从未到达模型**。根因：`DefaultResourceLoader.systemPromptOverride` 只在 `loader.reload()`
 * 时求值一次，而会话是长生命周期对象 ⇒ 首轮定终身。
 *
 * 修法（本文件守卫）：逐轮 prompt 存 `sessionSystemPrompts`（键＝`sessionKey@cwd`）＋ `before_agent_start`
 * 强制注入（官方扩展口：`BeforeAgentStartEventResult.systemPrompt`＝"Replace the complete system prompt
 * for this turn"）；另改写 `systemPromptOptions.customPrompt` ⇒ 落盘 `sections.preamble` 如实（取证不受骗）。
 *
 * 覆盖面：fake pi 钩子行为（强制文本 / 改写 customPrompt / 无 prompt 不改）＋ 源码级接线守卫（防"写了没人调"与
 * "退回按 cwd 共享 loader"）＋ 有牙（改坏即红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerSystemPromptInjection, sessionCacheKey, usageModelName } from '../src/main/agent/pi-runtime.js';

/** 最小 fake pi：只记 `on` 注册表（模拟底座扩展 API 的注册面）。 */
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

const FIVE_LAYER = '[平台底座] 五层真值\n[角色规则] 你是员工 #0。\n[题目] 把 1+1 写成一句话\n[工作项] #1 …';

test('修·提示注入: fake pi → 注册 before_agent_start；返回强制文本且改写 customPrompt（落盘如实）', () => {
  const { handlers, pi } = makeFakePi();
  registerSystemPromptInjection(pi, () => FIVE_LAYER);

  const h = handlers.get('before_agent_start');
  assert.ok(h, '必须订阅 before_agent_start（否则逐轮五层真值仍到不了模型）');

  const ev: { type: string; systemPromptOptions: Record<string, unknown> } = {
    type: 'before_agent_start',
    systemPromptOptions: { cwd: 'D:/x' },
  };
  const ret = h(ev);
  assert.deepEqual(ret, { systemPrompt: FIVE_LAYER }, '返回值必须是官方口「整轮替换系统提示」');
  assert.equal(ev.systemPromptOptions.customPrompt, FIVE_LAYER, 'customPrompt 必须改写 ⇒ sections.preamble 如实（取证不被占位符骗）');
  assert.equal(ev.systemPromptOptions.cwd, 'D:/x', '不得动其他段（cwd 等由底座维护）');
});

test('修·提示注入: 无 prompt（undefined）→ 返回 undefined，不改写事件（保持底座现状，不臆造）', () => {
  const { handlers, pi } = makeFakePi();
  registerSystemPromptInjection(pi, () => undefined);
  const ev: { systemPromptOptions: Record<string, unknown> } = { systemPromptOptions: {} };
  assert.equal(handlers.get('before_agent_start')!(ev), undefined);
  assert.equal(ev.systemPromptOptions.customPrompt, undefined, '没值就不写（不塞空串冒充）');
});

test('修·提示注入: 事件无 systemPromptOptions（SDK 面变化）→ 仍返回强制文本，不炸', () => {
  const { handlers, pi } = makeFakePi();
  registerSystemPromptInjection(pi, () => FIVE_LAYER);
  assert.deepEqual(handlers.get('before_agent_start')!({ type: 'before_agent_start' }), { systemPrompt: FIVE_LAYER });
});

test('修·提示注入: pi 无 on（SDK 面变化）→ 静默不炸（免得整个会话装配失败）', () => {
  assert.doesNotThrow(() => registerSystemPromptInjection({}, () => FIVE_LAYER));
});

test('修·提示注入 接线: pi-runtime 逐轮登记 + loader 按会话取 + 注入注册在场（防"写了没人调"）', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'pi-runtime.ts'), 'utf8');
  assert.ok(
    /sessionSystemPrompts\.set\(\s*(?:sessionCacheKey\(input\.sessionKey, input\.cwd \?\? defaultCwd\)|runCacheKey),\s*input\.systemPrompt/.test(src),
    'run() 必须先登记逐轮 systemPrompt（键＝sessionKey@cwd）——否则首轮创建 loader 时读到的是占位符',
  );
  assert.ok(
    /getLoader\(cacheKey,\s*c,\s*sessionKey\)/.test(src),
    'loader 必须按**会话键**取并带 sessionKey（退回纯 cwd 共享 ⇒ 不同会话的系统提示词/压缩读数互串）',
  );
  assert.ok(
    /systemPromptOverride:\s*\(\)\s*=>\s*sessionSystemPrompts\.get\(cacheKey\)\s*\?\?\s*options\.systemPrompt/.test(src),
    'override 必须读逐轮表（回退构造期占位符仅作兜底）',
  );
  assert.ok(
    /registerSystemPromptInjection\(api,\s*\(\)\s*=>\s*sessionSystemPrompts\.get\(cacheKey\)\)/.test(src),
    '注入器必须进 extensionFactories（否则 before_agent_start 无人订阅＝写了没人调）',
  );
});

test('修·提示注入 "有牙": 逐条改坏 → 对应判据必红（合成，证明上述断言承重）', () => {
  // ① 钩子行为：返回空对象（不要求整轮替换）必被抓（deepEqual 判据）
  const { handlers, pi } = makeFakePi();
  registerSystemPromptInjection(pi, () => FIVE_LAYER);
  assert.notDeepEqual(handlers.get('before_agent_start')!({ type: 'before_agent_start', systemPromptOptions: {} }), {});
  // ② 源码级：退回旧写法（无逐轮登记、loader 按 cwd）即不匹配
  const brokenOld = 'const getLoader = (c) => loaderPromises.get(c); // systemPromptOverride: () => options.systemPrompt';
  assert.ok(!/sessionSystemPrompts\.set\(/.test(brokenOld));
  assert.ok(!/getLoader\(cacheKey,\s*c,\s*sessionKey\)/.test(brokenOld));
  assert.ok(!/registerSystemPromptInjection\(api,/.test(brokenOld));
  // ③ 键口径：同 sessionKey 不同 cwd ⇒ 不同键（注入表与 loader 表同键，防串）
  assert.notEqual(sessionCacheKey('employee_0_task_1_wi_1', 'D:/a'), sessionCacheKey('employee_0_task_1_wi_1', 'D:/b'));
});

test('修·计费模型名: 逐轮 setModel 后按**已应用**模型记账（否则贵档被记成便宜档）', () => {
  // 无应用值 ⇒ 回落构造期默认
  assert.equal(usageModelName(undefined, 'deepseek/deepseek-flash'), 'deepseek/deepseek-flash');
  assert.equal(usageModelName('', 'deepseek/deepseek-flash'), 'deepseek/deepseek-flash');
  // 应用值带 provider ⇒ 原样
  assert.equal(usageModelName('deepseek/deepseek-v4-pro', 'deepseek/deepseek-flash'), 'deepseek/deepseek-v4-pro');
  // 应用值不带 provider ⇒ 按构造期 provider 补全（与 run() 里 setModel 的解析同口径）
  assert.equal(usageModelName('deepseek-v4-pro', 'deepseek/deepseek-flash'), 'deepseek/deepseek-v4-pro');
  // 有牙：若实现退回"恒返回 fallbackRef"，上面两条必红（证明本测能咬住那个 bug）
  assert.notEqual(usageModelName('deepseek-v4-pro', 'deepseek/deepseek-flash'), 'deepseek/deepseek-flash');
});
