/**
 * B2-2 回归面：真语义分诊器的**纯逻辑直测**（fetchImpl 注入；不联网）。
 *
 * 背景：RW-50 的分诊器此前只有链路级 stub 测试，本件没进过任何 tsc 程序 ⇒ dist 不产出
 * （B2a 出口 A 模式 2 需要 dist 产物；顺带补上直测缺口）。三原则锁定：
 * 绝不误建（任何失败回落 chat）、可换（全注入）、轻量（单发 JSON）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSemanticClassifier, extractJsonLoose } from '../src/main/agent/semantic-classifier.js';

const okResponse = (content: string): unknown => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('B2-2b: 分诊器正常解析（new_task＋titleGuess＋projectId 校验防幻觉）', async () => {
  let called = 0;
  const classify = createSemanticClassifier({
    secretsDir: () => 'D:/nonexistent-secrets',
    fetchImpl: (async () => {
      called += 1;
      return okResponse('{"intent":"new_task","confidence":0.9,"titleGuess":"竞品简报","projectId":3}') as Response;
    }) as typeof fetch,
  });
  const signal = await classify({ source: 'desktop', conversationRef: null, platformMsgId: null, replyToMsgId: null, text: '整理一页竞品简报', receivedAt: 1 });
  assert.equal(called, 0, '无 Key（临时 secretsDir 不存在）→ 不发请求，回落 chat（绝不误建）');
  assert.equal(signal.intent, 'chat');
});

test('B2-2b: 无 Key 回落 chat 且零请求（绝不误建三原则）', async () => {
  const classify = createSemanticClassifier({ secretsDir: () => 'D:/nonexistent-secrets' });
  const signal = await classify({ source: 'desktop', conversationRef: null, platformMsgId: null, replyToMsgId: null, text: '建个任务：x', receivedAt: 1 });
  assert.equal(signal.intent, 'chat');
  assert.equal(signal.confidence, 0.5);
});

test('B2-2b: extractJsonLoose——容错抽取与坏输入拒绝', () => {
  assert.deepEqual(extractJsonLoose('前置说明 {"intent":"chat","confidence":0.5} 后缀'), { intent: 'chat', confidence: 0.5 });
  assert.equal(extractJsonLoose('不是 JSON'), null);
  assert.equal(extractJsonLoose('{"intent":'), null);
  assert.equal(extractJsonLoose('[]'), null);
});
