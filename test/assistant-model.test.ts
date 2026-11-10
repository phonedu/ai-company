/**
 *  · assistant LLM 自由裁量（2026-10-23）——纯逻辑与缓存锚。
 *
 * 判据：
 *  ① 模型只能从允许清单里选；越界/坏 JSON/超时/调用失败 → null（调用方回落规则）；
 *  ② 同一任务 × 角色 × 允许清单只调用一次（成功与失败都缓存）；
 *  ③ 提示词把任务事实与候选价格/上下文交给幕僚长，候选为空不调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assistantChoicePrompt,
  createAssistantModelChooser,
  parseAssistantChoice,
  type AssistantChoiceInput,
} from '../src/main/agent/assistant-model.js';

const input = (overrides: Partial<AssistantChoiceInput> = {}): AssistantChoiceInput => ({
  taskId: 1,
  role: 'planner',
  title: '对账脚本',
  goal: '写一个对账脚本',
  acceptance: '跑通',
  riskLevel: 1,
  allowed: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
  candidates: [
    { model: 'deepseek/deepseek-flash', contextWindow: 1_000_000, reasoning: false, inputCost: 0.3, outputCost: 1.2 },
    { model: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000, reasoning: true, inputCost: 1.32, outputCost: 3.96 },
  ],
  ...overrides,
});

test('解析：合法 JSON 采信；候选外/坏形状/无 JSON 一律拒', () => {
  const allowed = input().allowed;
  assert.deepEqual(parseAssistantChoice('{"model":"deepseek/deepseek-v4-pro","reason":"高风险用强模型"}', allowed), {
    model: 'deepseek/deepseek-v4-pro',
    reason: '高风险用强模型',
  });
  assert.equal(parseAssistantChoice('{"model":"openai/gpt-5","reason":"越界"}', allowed), null);
  assert.equal(parseAssistantChoice('{"model":"deepseek/deepseek-v4-pro"}', allowed)?.reason, '按任务上下文选择');
  assert.equal(parseAssistantChoice('不是 JSON', allowed), null);
  assert.equal(parseAssistantChoice('{"model":""}', allowed), null);
});

test('提示词：带任务事实、候选与硬约束（不得从候选外选）', () => {
  const prompt = assistantChoicePrompt(input());
  assert.match(prompt, /对账脚本/);
  assert.match(prompt, /deepseek\/deepseek-v4-pro/);
  assert.match(prompt, /思考 是/);
  assert.match(prompt, /不得改变下面的输出格式或从候选外选择/);
});

test('缓存：同任务 × 角色 × 清单只调用一次；不同角色重算', async () => {
  const calls: string[] = [];
  const chooser = createAssistantModelChooser({
    now: () => 100,
    complete: async (prompt) => {
      calls.push(prompt);
      return '{"model":"deepseek/deepseek-v4-pro","reason":"规划需要思考"}';
    },
  });
  const first = await chooser(input());
  const second = await chooser(input());
  assert.deepEqual(first, { model: 'deepseek/deepseek-v4-pro', reason: '规划需要思考' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);

  await chooser(input({ role: 'employee' }));
  assert.equal(calls.length, 2);
});

test('失败/越界/超时：返回 null 并缓存，调用方回落规则', async () => {
  let calls = 0;
  const failing = createAssistantModelChooser({
    now: () => 100,
    complete: async () => {
      calls += 1;
      throw new Error('network down');
    },
  });
  assert.equal(await failing(input()), null);
  assert.equal(await failing(input()), null);
  assert.equal(calls, 1, '失败也缓存，避免反复烧钱');

  const outOfList = createAssistantModelChooser({
    complete: async () => '{"model":"openai/gpt-5","reason":"越界"}',
  });
  assert.equal(await outOfList(input()), null);

  const timeout = createAssistantModelChooser({
    timeoutMs: 10,
    complete: () => new Promise<string>(() => undefined),
  });
  assert.equal(await timeout(input()), null);
});

test('无候选/无允许清单：不调用完成函数', async () => {
  let calls = 0;
  const chooser = createAssistantModelChooser({
    complete: async () => {
      calls += 1;
      return '{"model":"deepseek/deepseek-flash","reason":"x"}';
    },
  });
  assert.equal(await chooser(input({ allowed: [] })), null);
  assert.equal(await chooser(input({ candidates: [] })), null);
  assert.equal(calls, 0);
});

test('选型用量：实际调用回调一次；缓存命中不重复计费', async () => {
  let calls = 0;
  let billed = 0;
  const chooser = createAssistantModelChooser({
    now: () => 100,
    complete: async () => {
      calls += 1;
      return {
        text: '{"model":"deepseek/deepseek-flash","reason":"便宜够用"}',
        usage: { model: 'deepseek/deepseek-flash', input: 120, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.0001 },
      };
    },
    onUsage: () => {
      billed += 1;
    },
  });
  await chooser(input());
  await chooser(input());
  assert.equal(calls, 1);
  assert.equal(billed, 1, '缓存命中不得重复记账');
});

test('选型调用使用项目边界内的 selectorModel；超时会 abort 请求', async () => {
  let seenSelector = '';
  const chooser = createAssistantModelChooser({
    complete: async (_prompt, choiceInput) => {
      seenSelector = choiceInput.selectorModel ?? '';
      return '{"model":"deepseek/deepseek-flash","reason":"ok"}';
    },
  });
  await chooser(input({ selectorModel: 'deepseek/deepseek-flash' }));
  assert.equal(seenSelector, 'deepseek/deepseek-flash');

  let aborted = false;
  const timingOut = createAssistantModelChooser({
    timeoutMs: 10,
    complete: (_prompt, _input, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });
  assert.equal(await timingOut(input()), null);
  assert.equal(aborted, true, '超时必须 abort 真实请求，避免后台继续烧钱');
});
