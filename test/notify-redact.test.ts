import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSecrets, normalizeAbsPath, redactPayload } from '../src/main/notify/redact.js';

// ── OPT-EXT-1：通知载荷脱敏（密钥/令牌 + 绝对用户路径；不改原对象） ──

test('notify/redact: 敏感键整值替换；非敏感键保留', () => {
  const out = redactPayload({ title: '任务完成', apiKey: 'sk-abcdef123456', nested: { token: 'Bearer abc.def', note: 'ok' } }) as Record<string, unknown>;
  assert.equal(out.apiKey, '«redacted»');
  assert.equal(out.title, '任务完成');
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.token, '«redacted»');
  assert.equal(nested.note, 'ok');
});

test('notify/redact: 字符串里的 sk-… / Bearer … 脱敏；绝对路径归一（保留 basename）', () => {
  assert.equal(maskSecrets('key sk-abcdef123456 used'), 'key «redacted» used');
  assert.equal(maskSecrets('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer «redacted»');
  assert.equal(normalizeAbsPath('C:\\Users\\Tup\\secret\\x.txt'), '<abs>/x.txt');
  const s = redactPayload('写到 C:\\Users\\Tup\\a.txt，含 sk-abcdef123456') as string;
  assert.ok(!s.includes('sk-abcdef123456'));
  assert.ok(!s.includes('Tup'));
  assert.ok(s.includes('<abs>/a.txt'));
});

test('notify/redact: 深拷贝 —— 不改调用方对象；数组逐项脱敏', () => {
  const src = { items: [{ password: 'p@ss' }, 'C:\\Users\\Tup\\b.txt'] };
  const out = redactPayload(src) as { items: unknown[] };
  assert.equal((src.items[0] as Record<string, unknown>).password, 'p@ss', '原对象不得被改');
  assert.equal((out.items[0] as Record<string, unknown>).password, '«redacted»');
  assert.equal(out.items[1], '<abs>/b.txt');
});

test('notify/redact: 正常值不被误伤', () => {
  const out = redactPayload({ title: 'ok', count: 3, flag: true, nil: null }) as Record<string, unknown>;
  assert.deepEqual(out, { title: 'ok', count: 3, flag: true, nil: null });
});
