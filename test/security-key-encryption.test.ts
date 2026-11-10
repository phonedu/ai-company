/**
 * 供应商 Key 明文落盘的回归测试。
 *
 * 旧实现：`saveProviderKey` 明文写 `~/.aico/secrets/<provider>_api_key`，chmod 0600 在 Windows
 * 无效；对照 IM 凭据已用 safeStorage/DPAPI——保护不对等。
 *
 * 新口径：主进程装 safeStorage 编解码器后，canonical 落 `<provider>_api_key.enc`（v1: + DPAPI 密文）；
 * 旧明文文件在首次读取时**迁移**为密文并删除；编码器不可用（无 OS 密钥环）时回落明文并在状态里如实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearProviderKey,
  resolveProviderKey,
  saveProviderKey,
  setProviderKeyCodec,
} from '../src/main/agent/provider-keys.js';

/** 测试用编解码器：base64 + 前缀（证明落盘不是明文即可；不假装等价 DPAPI）。 */
const fakeCodec = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`TESTONLY:${plain}`, 'utf8').toString('base64'),
  decrypt: (payload: string) => {
    const raw = Buffer.from(payload, 'base64').toString('utf8');
    if (!raw.startsWith('TESTONLY:')) throw new Error('bad ciphertext');
    return raw.slice('TESTONLY:'.length);
  },
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'aico-keyenc-'));
}

test('B0-9①：保存后落盘是密文（不含明文），解析能回读', () => {
  const dir = freshDir();
  setProviderKeyCodec(fakeCodec);
  try {
    saveProviderKey('deepseek', 'sk-TESTONLY-plain-value-123456', { baseDir: dir, env: {} });
    const encPath = join(dir, 'deepseek_api_key.enc');
    assert.ok(existsSync(encPath), '必须落 .enc 文件（不是明文 canonical）');
    const onDisk = readFileSync(encPath, 'utf8');
    assert.ok(!onDisk.includes('sk-TESTONLY-plain-value-123456'), '磁盘上不得出现明文 Key');
    assert.match(onDisk, /^v1:/, '密文带版本前缀（可迁移）');
    const cred = resolveProviderKey('deepseek', { baseDir: dir, env: {} });
    assert.equal(cred?.key, 'sk-TESTONLY-plain-value-123456');
    assert.equal(cred?.source, 'file');
  } finally {
    setProviderKeyCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B0-9①：**读取不迁移**（事故修复）——旧明文保持原样，只有显式保存才加密', () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deepseek_api_key'), 'sk-TESTONLY-legacy-abcdef\n');
  setProviderKeyCodec(fakeCodec);
  try {
    const cred = resolveProviderKey('deepseek', { baseDir: dir, env: {} });
    assert.equal(cred?.key, 'sk-TESTONLY-legacy-abcdef', '旧文件仍可读');
    assert.ok(!existsSync(join(dir, 'deepseek_api_key.enc')), '读操作不得写密文（读=只读）');
    assert.ok(existsSync(join(dir, 'deepseek_api_key')), '读操作不得删除明文');
    // 显式保存 → 才加密并清掉明文。
    saveProviderKey('deepseek', 'sk-TESTONLY-legacy-abcdef', { baseDir: dir, env: {} });
    assert.ok(existsSync(join(dir, 'deepseek_api_key.enc')));
    assert.ok(!existsSync(join(dir, 'deepseek_api_key')));
  } finally {
    setProviderKeyCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B0-9①：profile 不稳定（临时 userData）→ 禁用加密、只写明文（防止密钥随 profile 消失）', () => {
  const dir = freshDir();
  setProviderKeyCodec({ ...fakeCodec, stable: false });
  try {
    saveProviderKey('deepseek', 'sk-TESTONLY-ephemeral-01', { baseDir: dir, env: {} });
    assert.ok(existsSync(join(dir, 'deepseek_api_key')), '不稳定 profile 必须回落明文');
    assert.ok(!existsSync(join(dir, 'deepseek_api_key.enc')), '不得写密文（否则密钥随临时目录消失）');
    assert.equal(resolveProviderKey('deepseek', { baseDir: dir, env: {} })?.key, 'sk-TESTONLY-ephemeral-01');
    // 已存在的密文也不会被“解成明文再覆盖”——保存明文时清掉不可用密文（避免两边并存）。
    writeFileSync(join(dir, 'xiaomi_api_key.enc'), 'v1:garbage');
    saveProviderKey('xiaomi', 'sk-TESTONLY-ephemeral-02', { baseDir: dir, env: {} });
    assert.ok(!existsSync(join(dir, 'xiaomi_api_key.enc')), '保存明文必须清掉不可用密文');
  } finally {
    setProviderKeyCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B0-9①：编码器不可用时回落明文（诚实降级，不静默丢 Key）', () => {
  const dir = freshDir();
  setProviderKeyCodec({ ...fakeCodec, available: () => false });
  try {
    saveProviderKey('xiaomi', 'sk-TESTONLY-fallback-0001', { baseDir: dir, env: {} });
    const plain = join(dir, 'xiaomi_api_key');
    assert.ok(existsSync(plain), '无密钥环时必须回落到明文文件（否则用户无法保存 Key）');
    assert.equal(resolveProviderKey('xiaomi', { baseDir: dir, env: {} })?.key, 'sk-TESTONLY-fallback-0001');
  } finally {
    setProviderKeyCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B0-9①：清除同时删密文与旧明文；env 仍优先生效', () => {
  const dir = freshDir();
  setProviderKeyCodec(fakeCodec);
  try {
    saveProviderKey('openai', 'sk-TESTONLY-clear-0001', { baseDir: dir, env: {} });
    clearProviderKey('openai', { baseDir: dir, env: {} });
    assert.ok(!existsSync(join(dir, 'openai_api_key.enc')));
    assert.equal(resolveProviderKey('openai', { baseDir: dir, env: {} }), null);
    const fromEnv = resolveProviderKey('openai', { baseDir: dir, env: { OPENAI_API_KEY: 'sk-env' } });
    assert.equal(fromEnv?.source, 'env');
    assert.equal(fromEnv?.key, 'sk-env');
  } finally {
    setProviderKeyCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
