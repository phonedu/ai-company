/**
 * 设置·模型与供应商：本机 Key 写入/掩码/清除 + provider_keys 台账。
 * 口径：只回掩码；env 优先；文件 0600；未知 provider/短 key 显式拒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearProviderKey,
  providerStatuses,
  resolveProviderKey,
  saveProviderKey,
  ProviderKeyError,
} from '../src/main/agent/provider-keys.js';
import { handleProviderClearKey, handleProviderList, handleProviderSetKey, type IpcDeps } from '../src/main/ipc/ipc.js';
import { listProviderKeys, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aico-provider-'));
}

test('provider-keys：未配置 → 全部 configured=false；保存后只回尾号掩码，文件内容可读', () => {
  const baseDir = tempDir();
  try {
    const before = providerStatuses({ baseDir, env: {} });
    assert.equal(before.every((p) => !p.configured && p.masked === null), true);

    const status = saveProviderKey('deepseek', 'sk-test-1234567890', { baseDir, env: {} });
    assert.equal(status.configured, true);
    assert.equal(status.source, 'file');
    assert.equal(status.fileConfigured, true);
    assert.equal(status.masked, '••••7890');
    assert.equal(JSON.stringify(status).includes('sk-test-1234567890'), false, '状态不得泄露明文');
    const file = join(baseDir, 'deepseek_api_key');
    assert.equal(readFileSync(file, 'utf8').trim(), 'sk-test-1234567890');
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, '文件权限应为 0600');
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：SDK 内置但非 4 家的 provider 可保存/清除；非法 id 拒（自定义供应商入口）', () => {
  const baseDir = tempDir();
  try {
    const status = saveProviderKey('google', 'google-test-key-123', { baseDir, env: {} });
    assert.equal(status.provider, 'google');
    assert.equal(status.configured, true);
    assert.equal(status.label, 'google', '未知显示名回落 id（不臆造品牌名）');
    assert.equal(existsSync(join(baseDir, 'google_api_key')), true);
    assert.equal(resolveProviderKey('google', { baseDir, env: {} })?.source, 'file');

    assert.throws(
      () => saveProviderKey('Bad Provider', 'long-enough-key', { baseDir, env: {} }),
      (error: unknown) => error instanceof ProviderKeyError && error.code === 'bad_provider',
    );
    clearProviderKey('google', { baseDir, env: {} });
    assert.equal(existsSync(join(baseDir, 'google_api_key')), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：env 优先于文件；env 命中时仍能清除本机文件', () => {
  const baseDir = tempDir();
  try {
    saveProviderKey('deepseek', 'sk-file-1234567890', { baseDir, env: {} });
    const status = providerStatuses({ baseDir, env: { DEEPSEEK_API_KEY: 'sk-env-abcdefgh' } }).find((p) => p.provider === 'deepseek');
    assert.equal(status?.source, 'env');
    assert.equal(status?.envConfigured, true);
    assert.equal(status?.fileConfigured, true, '文件仍在（应可清除）');
    assert.equal(status?.masked, '••••efgh');

    const after = clearProviderKey('deepseek', { baseDir, env: { DEEPSEEK_API_KEY: 'sk-env-abcdefgh' } });
    assert.equal(after.source, 'env', '清文件后 env 仍生效');
    assert.equal(after.fileConfigured, false);
    assert.equal(existsSync(join(baseDir, 'deepseek_api_key')), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：旧文件名可读；清除会一并删 canonical 与旧文件', () => {
  const baseDir = tempDir();
  try {
    const legacy = join(baseDir, 'anthropic-api-key.txt');
    saveProviderKey('deepseek', 'sk-canonical-1234', { baseDir, env: {} });
    // 直接写旧文件（模拟老板既有布局）
    writeFileSync(legacy, 'sk-legacy-123456\n');
    const cred = resolveProviderKey('anthropic', { baseDir, env: {} });
    assert.equal(cred?.source, 'file');
    assert.equal(cred?.path, legacy);

    clearProviderKey('anthropic', { baseDir, env: {} });
    assert.equal(existsSync(legacy), false);
    clearProviderKey('deepseek', { baseDir, env: {} });
    assert.equal(existsSync(join(baseDir, 'deepseek_api_key')), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：`<provider>_api_key.txt` 变体可读（Explorer 隐藏扩展名场景）；canonical 优先、清除一并删除', () => {
  const baseDir = tempDir();
  try {
    const variant = join(baseDir, 'deepseek_api_key.txt');
    writeFileSync(variant, 'sk-TESTONLY-underscore-txt-123456\n');
    const cred = resolveProviderKey('deepseek', { baseDir, env: {} });
    assert.equal(cred?.source, 'file');
    assert.equal(cred?.path, variant);

    const status = providerStatuses({ baseDir, env: {} }).find((p) => p.provider === 'deepseek');
    assert.equal(status?.configured, true);
    assert.equal(status?.fileConfigured, true);
    assert.equal(status?.masked, '••••3456');
    assert.equal(JSON.stringify(status).includes('sk-TESTONLY-underscore-txt-123456'), false, '状态不得泄露明文');

    // canonical 文件存在时仍优先，避免两种写法并存时读到旧值。
    const canonical = join(baseDir, 'deepseek_api_key');
    writeFileSync(canonical, 'sk-canonical-123456\n');
    assert.equal(resolveProviderKey('deepseek', { baseDir, env: {} })?.path, canonical);

    clearProviderKey('deepseek', { baseDir, env: {} });
    assert.equal(existsSync(variant), false);
    assert.equal(existsSync(canonical), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：非法供应商 id/短 key/含空白 → 显式拒（不写文件）', () => {
  const baseDir = tempDir();
  try {
    assert.throws(() => saveProviderKey('Not A Provider', 'sk-12345678', { baseDir, env: {} }), (e: unknown) => e instanceof ProviderKeyError && e.code === 'bad_provider');
    assert.throws(() => saveProviderKey('deepseek', 'short', { baseDir, env: {} }), (e: unknown) => e instanceof ProviderKeyError && e.code === 'bad_key');
    assert.throws(() => saveProviderKey('deepseek', 'sk-has space-1234', { baseDir, env: {} }), (e: unknown) => e instanceof ProviderKeyError && e.code === 'bad_key');
    assert.equal(existsSync(join(baseDir, 'deepseek_api_key')), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('provider-keys：IPC list/set/clear 全链——只回掩码、落 provider_keys 台账', () => {
  const baseDir = tempDir();
  const db = openMemoryDatabase();
  runMigrations(db);
  let keyChanges = 0;
  const deps = { providerSecretsDir: () => baseDir, db, onProviderKeyChanged: () => { keyChanges += 1; } } as unknown as IpcDeps;
  try {
    const list0 = handleProviderList(deps);
    assert.equal(list0.ok, true);
    assert.equal(list0.ok && list0.providers.every((p) => !p.configured), true);

    const set = handleProviderSetKey(deps, { provider: 'deepseek', key: 'sk-ipc-123456789' });
    assert.equal(set.ok, true);
    if (set.ok) {
      assert.equal(set.providers.find((p) => p.provider === 'deepseek')?.masked, '••••6789');
      assert.equal(JSON.stringify(set).includes('sk-ipc-123456789'), false, 'IPC 回执不得含明文');
    }
    assert.equal(keyChanges, 1, '保存 Key 后必须通知运行时丢弃旧装配');
    const rows = listProviderKeys(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.provider, 'deepseek');
    assert.equal(rows[0]?.secretRef, 'deepseek_api_key');

    const clear = handleProviderClearKey(deps, { provider: 'deepseek' });
    assert.equal(keyChanges, 2, '清除 Key 同样要重新装配');
    assert.equal(clear.ok, true);
    assert.equal(listProviderKeys(db).length, 0);
    assert.equal(existsSync(join(baseDir, 'deepseek_api_key')), false);

    // 添加供应商：SDK 内置但非 4 家的 provider 走同一入口；只回 4 家状态，但台账/文件真落。
    const custom = handleProviderSetKey(deps, { provider: 'google', key: 'google-ipc-key-123' });
    assert.equal(custom.ok, true);
    assert.equal(listProviderKeys(db).some((r) => r.provider === 'google'), true);
    assert.equal(resolveProviderKey('google', { baseDir, env: {} })?.source, 'file');
    handleProviderClearKey(deps, { provider: 'google' });

    const bad = handleProviderSetKey(deps, { provider: 'NoPe!', key: 'sk-12345678' });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.code, 'bad_provider');
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
