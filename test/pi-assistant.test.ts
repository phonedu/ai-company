/**
 *  幕僚长生命周期（冷启预热 + 就绪可见）—— 不联网单测（1351）。
 * 覆盖：未就绪 → onWaiting（供接线处推 `assistant_starting`）；就绪 → 正常 runTurn；不可用 → null、不重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantRuntime, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import {
  __resetAssistantStateForTests,
  ASSISTANT_SYSTEM_PROMPT_M0,
  assistantError,
  assistantStatus,
  ensureAssistant,
  isAssistantReady,
  preloadPiAssistant,
  type PiAssistant,
} from '../src/main/agent/pi-assistant.js';
import { listHumanMessages, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

/** 假工厂：延迟一小段（模拟冷启），返回接在 fake runtime 上的 AssistantRuntime。 */
function fakeFactory(db: SqliteDb, reply: string): (o: unknown) => Promise<PiAssistant> {
  const runtime = makeFakeAgentRuntime([{ text: reply, toolCalls: [] }]);
  return async (): Promise<PiAssistant> => {
    await new Promise((r) => setTimeout(r, 10));
    return {
      assistant: new AssistantRuntime({ db, runtime, systemPrompt: 'x' }),
      credentialSource: 'env',
      credentialDescriptor: { source: 'env', length: 0, skPrefix: false },
      modelRef: 'fake/model',
    };
  };
}

test('T0.4: 幕僚长提示词写死角色边界——不验收、不代签', () => {
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /不验收/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /不代签/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /独立 verifier/);
});

test('T0.4: 未就绪 → onWaiting（一次）；就绪后 runTurn 正常；再次调用不再等待', async () => {
  __resetAssistantStateForTests();
  const db = fresh();
  try {
    let waited = 0;
    const a = await ensureAssistant({ db, systemPrompt: 'x' }, () => waited++, fakeFactory(db, '你好呀。'));
    assert.equal(waited, 1, '冷启期间应触发一次 waiting（接线处据此推 assistant_starting）');
    assert.equal(assistantStatus(), 'ready');
    assert.equal(isAssistantReady(), true);
    assert.ok(a);

    const turn = await a!.runTurn({ text: '你好' });
    assert.equal(turn.reply, '你好呀。');
    assert.equal(listHumanMessages(db).filter((m) => m.direction === 'out').length, 1);

    // 已就绪 → 不再 waiting、直接返回同一实例
    const b = await ensureAssistant({ db, systemPrompt: 'x' }, () => waited++, fakeFactory(db, 'unused'));
    assert.equal(waited, 1, '已就绪不得再触发 waiting');
    assert.equal(b, a, '就绪后返回同一 AssistantRuntime');
  } finally {
    __resetAssistantStateForTests();
    db.close();
  }
});

test('T0.4: 预热非阻塞 → starting → ready（无需首条消息触发）', async () => {
  __resetAssistantStateForTests();
  const db = fresh();
  try {
    preloadPiAssistant({ db, systemPrompt: 'x' }, fakeFactory(db, 'ok'));
    assert.equal(assistantStatus(), 'starting', '调用后立即进入 starting（未阻塞）');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(assistantStatus(), 'ready');
  } finally {
    __resetAssistantStateForTests();
    db.close();
  }
});

test('T0.4: 不可用（缺凭据）→ 返回 null、状态 unavailable、不重试也不 mock', async () => {
  __resetAssistantStateForTests();
  const db = fresh();
  try {
    let waited = 0;
    const a = await ensureAssistant({ db, provider: 'no-such-provider-xyz', systemPrompt: 'x' }, () => waited++);
    assert.equal(waited, 1);
    assert.equal(a, null);
    assert.equal(assistantStatus(), 'unavailable');
    assert.match(assistantError() ?? '', /缺少 no-such-provider-xyz 凭据/);

    let waitedAgain = 0;
    const b = await ensureAssistant({ db, provider: 'no-such-provider-xyz', systemPrompt: 'x' }, () => waitedAgain++);
    assert.equal(b, null);
    assert.equal(waitedAgain, 0, 'unavailable 后不再 waiting / 不再启动');
  } finally {
    __resetAssistantStateForTests();
    db.close();
  }
});
