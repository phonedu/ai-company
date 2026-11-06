/**
 * T0.4: Pi 运行时接缝测试（**不加载 SDK、不发网络**）。
 * 覆盖凭据解析顺序与「缺凭据明确报错、不静默 mock」（1158 约束③）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPiAgentRuntime, resolveProviderCredential, sessionIdForCacheKey } from '../src/main/agent/pi-runtime.js';

test('pi-runtime: 会话 id 首尾必须是字母数字（staging 项目名含中文/空格也不失败）', () => {
  const cases = [
    'role:planner:task:7@C:\\Users\\Tup\\AppData\\Local\\Temp\\aico-m3-d5\\staging-parent\\M3 Staging 验收',
    'employee:0:task:7:wi:-@/d/ai-company-projects/bookkeeping',
    'role:critic:task:7@C:\\中文 项目\\',
  ];
  for (const key of cases) {
    const id = sessionIdForCacheKey(key);
    assert.match(id, /^[A-Za-z0-9]/, `开头必须是字母数字：${id}`);
    assert.match(id, /[A-Za-z0-9]$/, `结尾必须是字母数字：${id}`);
    assert.match(id, /^[A-Za-z0-9._-]+$/, `只允许字母数字/._-：${id}`);
    assert.ok(id.length > 0);
  }
});

test('pi-runtime: 缺凭据 → 明确报错（不降级 mock）', async () => {
  await assert.rejects(
    () => createPiAgentRuntime({ provider: 'no-such-provider-xyz', systemPrompt: 'x' }),
    /缺少 no-such-provider-xyz 凭据/,
  );
});

test('pi-runtime: 凭据解析顺序 env 优先（只读、不打印明文）', () => {
  const envName = 'ZZ_API_KEY';
  const previous = process.env[envName];
  try {
    process.env[envName] = 'dummy-value-for-test';
    const fromEnv = resolveProviderCredential('zz');
    assert.equal(fromEnv?.source, 'env');
    assert.equal(fromEnv?.key, 'dummy-value-for-test');

    delete process.env[envName];
    assert.equal(resolveProviderCredential('no-such-provider-xyz'), null, '无 env 无文件 → null');
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});
