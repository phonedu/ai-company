/** 幕僚长回合注入全局/项目事实（按可见面，不含员工 L1）。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantRuntime, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { SqliteMemoryStore } from '../src/main/memory/index.js';

test('memory-assistant: 幕僚长回合拿到全局事实，并保留原 systemPrompt', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    new SqliteMemoryStore(db).remember({
      scope: { type: 'global' },
      kind: 'preference',
      key: 'report.style',
      value: '汇报先给结论，再给证据',
      source: { type: 'boss', ref: 'boss:1' },
      now: 1,
    });
    const fake = makeFakeAgentRuntime([{ text: '好的', toolCalls: [] }]);
    const a = new AssistantRuntime({ db, runtime: fake, systemPrompt: 'BASE_PROMPT' });
    await a.runTurn({ text: '汇报一下' });
    const prompt = fake.runs[0]?.systemPrompt ?? '';
    assert.ok(prompt.includes('BASE_PROMPT'), '原 systemPrompt 不能被记忆顶掉');
    assert.ok(prompt.includes('[记忆·global]'), '应注入全局事实段');
    assert.ok(prompt.includes('汇报先给结论'));
    assert.ok(!prompt.includes('[员工记忆]'), '幕僚长不读员工 L1');
  } finally {
    db.close();
  }
});
