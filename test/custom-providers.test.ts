import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { customProvidersShapeError, type CustomProviderDef } from '../src/core/custom-provider.js';
import { listCustomProviders, removeCustomProvider, upsertCustomProvider } from '../src/main/agent/custom-providers.js';
import { handleProviderCustom } from '../src/main/ipc/ipc.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';

function def(over: Partial<CustomProviderDef> = {}): CustomProviderDef {
  return {
    id: 'my-provider',
    label: 'My Provider',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'my-model',
        name: 'My Model',
        contextWindow: 128000,
        maxTokens: 8192,
        input: ['text'],
        reasoning: true,
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    ...over,
  };
}

test('自定义供应商形状：非法 id/URL/api/模型字段给人话原因', () => {
  assert.match(customProvidersShapeError([def({ id: 'Bad Id' })]) ?? '', /id 需为/);
  assert.match(customProvidersShapeError([def({ baseUrl: 'ftp://x' })]) ?? '', /Base URL/);
  assert.match(customProvidersShapeError([def({ api: 'nope' as never })]) ?? '', /API 需为/);
  assert.match(
    customProvidersShapeError([def({ models: [{ ...def().models[0]!, contextWindow: 0 }] })]) ?? '',
    /contextWindow/,
  );
  assert.equal(customProvidersShapeError([def()]), null);
});

test('自定义供应商写 Pi models.json：增删改查；文件不含 Key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-models-'));
  const old = process.env.AICO_MODELS_PATH;
  process.env.AICO_MODELS_PATH = join(dir, 'models.json');
  try {
    upsertCustomProvider(def());
    assert.deepEqual(listCustomProviders().map((p) => p.id), ['my-provider']);
    const raw = readFileSync(process.env.AICO_MODELS_PATH, 'utf8');
    assert.match(raw, /"providers"/);
    assert.equal(raw.includes('apiKey'), false, 'models.json 不写 Key');
    upsertCustomProvider(def({ label: 'Renamed' }));
    assert.equal(listCustomProviders()[0]?.label, 'Renamed');
    removeCustomProvider('my-provider');
    assert.equal(listCustomProviders().length, 0);
  } finally {
    if (old === undefined) delete process.env.AICO_MODELS_PATH;
    else process.env.AICO_MODELS_PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider:custom IPC：save（含 Key）/list/remove 全链；Key 只落本机 secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-custom-'));
  const old = process.env.AICO_MODELS_PATH;
  process.env.AICO_MODELS_PATH = join(dir, 'models.json');
  const db = openMemoryDatabase();
  runMigrations(db);
  let resets = 0;
  const deps = { providerSecretsDir: () => dir, db, onProviderKeyChanged: () => { resets += 1; } } as never;
  try {
    const save = await handleProviderCustom(deps, { action: 'save', provider: def(), key: 'test-key-12345678' });
    assert.equal(save.ok, true);
    assert.equal(save.ok && save.providers.length, 1);
    assert.equal(resets, 1, '新增自定义供应商后必须重置懒运行时，否则下一次会话读不到新 models.json');
    const list = await handleProviderCustom(deps, { action: 'list' });
    assert.equal(list.ok && list.providers[0]?.models[0]?.id, 'my-model');
    const remove = await handleProviderCustom(deps, { action: 'remove', id: 'my-provider' });
    assert.equal(remove.ok, true);
    assert.equal(remove.ok && remove.providers.length, 0);
    assert.equal(resets, 2, '删除自定义供应商后同样要重置（旧模型不能留在运行时会话里）');
  } finally {
    db.close();
    if (old === undefined) delete process.env.AICO_MODELS_PATH;
    else process.env.AICO_MODELS_PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
