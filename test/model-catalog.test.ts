/**
 * 模型目录（D-22 配套）——纯投影的可执行锚。
 *
 * 判据：
 *   ① 只列 chat 模型（图片/分类不进选择器）；
 *   ② 已知供应商即使未配置 Key 也列出；陌生供应商只在 Key 已配置时出现；
 *   ③ 去重、按供应商/名称排序；价格与上下文原样透传（USD/1M）；
 *   ④ Key 状态只回 source，不出现明文/掩码字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelCatalog, buildProviderCatalog, type CatalogModelInput } from '../src/main/agent/model-catalog.js';

function model(over: Partial<CatalogModelInput> & Pick<CatalogModelInput, 'provider' | 'id'>): CatalogModelInput {
  return {
    name: over.id,
    type: 'chat',
    contextWindow: 128000,
    maxTokens: 8192,
    input: ['text'],
    reasoning: false,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    ...over,
  };
}

const KEYS: Record<string, { configured: boolean; source: 'env' | 'file' | null }> = {
  deepseek: { configured: true, source: 'file' },
  xiaomi: { configured: false, source: null },
  moonshotai: { configured: true, source: 'env' },
};

test('模型目录：只列 chat；已知未配置供应商仍列；陌生未配置供应商不铺屏', () => {
  const rows = buildModelCatalog(
    [
      model({ provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash' }),
      model({ provider: 'xiaomi', id: 'mimo-v2.6-flash', name: 'MiMo Flash' }),
      model({ provider: 'moonshotai', id: 'kimi-k2', name: 'Kimi K2' }),
      model({ provider: 'stranger', id: 'mystery', name: 'Mystery' }),
      model({ provider: 'deepseek', id: 'img', name: 'Image', type: 'image' }),
      model({ provider: 'deepseek', id: 'clf', name: 'Classifier', type: 'classifier' }),
    ],
    {
      knownProviders: ['deepseek', 'xiaomi'],
      providerLabels: { deepseek: 'DeepSeek', xiaomi: 'Xiaomi MiMo' },
      keyInfo: (p) => KEYS[p] ?? { configured: false, source: null },
    },
  );
  assert.deepEqual(
    rows.map((r) => `${r.provider}/${r.id}`),
    ['deepseek/deepseek-flash', 'moonshotai/kimi-k2', 'xiaomi/mimo-v2.6-flash'],
    'chat 过滤＋已知/已配置供应商＋排序',
  );
  assert.equal(rows[0].providerLabel, 'DeepSeek');
  assert.equal(rows[2].providerLabel, 'Xiaomi MiMo');
  assert.equal(rows[0].keyConfigured, true);
  assert.equal(rows[0].keySource, 'file');
  assert.equal(rows[2].keyConfigured, false);
  assert.equal(rows[2].keySource, null);
});

test('供应商目录：所有有 chat 模型的供应商都列出（含未配置）；已配置优先；计数只算 chat', () => {
  const providers = buildProviderCatalog(
    [
      model({ provider: 'deepseek', id: 'a' }),
      model({ provider: 'deepseek', id: 'b' }),
      model({ provider: 'xiaomi', id: 'c' }),
      model({ provider: 'openai', id: 'd' }),
      model({ provider: 'openai', id: 'img', type: 'image' }),
    ],
    { providerLabels: { deepseek: 'DeepSeek', xiaomi: 'Xiaomi MiMo', openai: 'OpenAI' }, keyInfo: (p) => KEYS[p] ?? { configured: false, source: null } },
  );
  assert.deepEqual(
    providers.map((p) => `${p.provider}:${p.modelCount}:${p.keyConfigured}`),
    ['deepseek:2:true', 'openai:1:false', 'xiaomi:1:false'],
    '已配置优先；计数只算 chat',
  );
  assert.equal(providers[0].providerLabel, 'DeepSeek');
  assert.equal(providers[1].providerLabel, 'OpenAI');
});

test('模型目录：去重；价格/上下文原样；Key 字段不含明文', () => {
  const rows = buildModelCatalog(
    [
      model({ provider: 'deepseek', id: 'd', name: 'D', contextWindow: 1_000_000, maxTokens: 384_000 }),
      model({ provider: 'deepseek', id: 'd', name: 'D dup' }),
    ],
    { knownProviders: ['deepseek'], keyInfo: () => ({ configured: true, source: 'env' }) },
  );
  assert.equal(rows.length, 1, '同 provider/id 去重');
  assert.equal(rows[0].contextWindow, 1_000_000);
  assert.equal(rows[0].maxTokens, 384_000);
  assert.deepEqual(rows[0].cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'contextWindow',
    'cost',
    'id',
    'input',
    'keyConfigured',
    'keySource',
    'maxTokens',
    'name',
    'provider',
    'providerLabel',
    'reasoning',
  ]);
});
