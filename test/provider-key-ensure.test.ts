/**
 * M2 尾巴 T1 · `ensureProviderKey` 隔离单测（M2 台账 §2 覆盖风险第 1 条）。
 *
 * 只用注入的 resolve/inject，不读 `~/.aico/secrets`、不发网络、不启动 Pi SDK。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureProviderKeyFor } from '../src/main/agent/pi-runtime.js';

test('T1：缺 Key → 抛人话、不注入、不记为已注入', async () => {
  const keyed = new Set<string>();
  let injected = 0;
  await assert.rejects(
    () =>
      ensureProviderKeyFor('xiaomi', {
        keyed,
        resolve: () => null,
        inject: async () => {
          injected += 1;
        },
      }),
    /缺少 xiaomi 凭据/,
  );
  assert.equal(injected, 0);
  assert.equal(keyed.has('xiaomi'), false);
});

test('T1：已注入 → 不重复解析/注入', async () => {
  const keyed = new Set(['xiaomi']);
  let resolved = 0;
  let injected = 0;
  await ensureProviderKeyFor('xiaomi', {
    keyed,
    resolve: () => {
      resolved += 1;
      return { key: 'sk-x' };
    },
    inject: async () => {
      injected += 1;
    },
  });
  assert.equal(resolved, 0);
  assert.equal(injected, 0);
});

test('T1：首次成功 → 只注入一次，之后用缓存', async () => {
  const keyed = new Set<string>();
  const calls: Array<{ provider: string; key: string }> = [];
  const deps = {
    keyed,
    resolve: () => ({ key: 'sk-secret-tail' }),
    inject: async (provider: string, key: string) => {
      calls.push({ provider, key });
    },
  };
  await ensureProviderKeyFor('deepseek', deps);
  await ensureProviderKeyFor('deepseek', deps);
  assert.deepEqual(calls, [{ provider: 'deepseek', key: 'sk-secret-tail' }]);
  assert.equal(keyed.has('deepseek'), true);
});

test('T1：注入失败 → 不记为已注入，重试可成功', async () => {
  const keyed = new Set<string>();
  let attempts = 0;
  const deps = {
    keyed,
    resolve: () => ({ key: 'sk-retry' }),
    inject: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('runtime not ready');
    },
  };
  await assert.rejects(() => ensureProviderKeyFor('xiaomi', deps), /runtime not ready/);
  assert.equal(keyed.has('xiaomi'), false, '失败不得标记为已注入');
  await ensureProviderKeyFor('xiaomi', deps);
  assert.equal(attempts, 2);
  assert.equal(keyed.has('xiaomi'), true);
});
