/**
 * B4b/裁决 5（2026-11-09 老板拍板走 qwen + 提供 endpoint）：image_generate 的 Qwen 通道。
 *  - 通道解析：dashscope Key 优先 → qwen；仅 openai → dalle；都没有 → 工具层人话报错（不碰真 secrets）；
 *  - 兼容模式响应：b64_json 与 url 两种形状都落盘；url 下载过两层安全检查
 *    （isSafeDownloadUrl：https＋IP 段判；isSafeDownloadTarget：域名解析全公网——注入 resolver 不碰真 DNS）；
 *  - 老板提供的 endpoint/模型为源码常量（https://maas.qianwenaiapi.com/compatible-mode/v1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isPrivateOrReservedAddress,
  isSafeDownloadTarget,
  isSafeDownloadUrl,
  QWEN_IMAGE_ENDPOINT,
  QWEN_IMAGE_MODEL,
  qwenImageGenerate,
  resolveImageChannel,
} from '../src/main/agent/tools/image-generate-tool.js';
import { createImageGenerateTool } from '../src/main/agent/tools/content-tools.js';

type Out = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Exec<P> = { execute(id: string, params: P, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<Out> };

const ENV_KEYS = ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'];

test('裁决 5：通道解析——dashscope 优先 qwen；仅 openai 走 dalle；全无 → null', () => {
  const o = { env: {} as NodeJS.ProcessEnv };
  assert.equal(resolveImageChannel({ env: o.env }), null);
  assert.equal(resolveImageChannel({ env: { DASHSCOPE_API_KEY: 'sk-test' } as NodeJS.ProcessEnv }), 'qwen');
  assert.equal(resolveImageChannel({ env: { OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv }), 'dalle');
  assert.equal(resolveImageChannel({ env: { DASHSCOPE_API_KEY: '', OPENAI_API_KEY: 'sk-x' } as NodeJS.ProcessEnv }), 'dalle', '空值不当已配置');
});

test('裁决 5：Qwen 通道 b64 响应落盘；endpoint/模型为老板指定常量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-img-'));
  try {
    const bodies: string[] = [];
    const b64 = Buffer.from('fake-qwen-png').toString('base64');
    const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
      bodies.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: b64 }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await qwenImageGenerate({ prompt: '封面', outputDir: dir, apiKey: 'sk-test-key', fetchImpl });
    assert.ok(r.ok, r.error);
    assert.deepEqual(readdirSync(dir), [r.path && r.path.split(/[\\/]/).pop()]);
    assert.equal(bodies.length, 1, 'b64 形状不发生第二次下载');
    assert.equal(QWEN_IMAGE_ENDPOINT, 'https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations');
    assert.equal(QWEN_IMAGE_MODEL, 'qwen-image-3.0-pro');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('裁决 5：url 响应——公网 https 下载落盘；私网/非 https/解析到内网一律拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-url-'));
  const fakePng = Buffer.from('downloaded-png');
  const resolveHost = async (host: string): Promise<string[]> =>
    host === 'bad.example.com' ? ['10.0.0.8'] : ['93.184.216.34'];
  try {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/img.png')) {
        return { ok: true, status: 200, arrayBuffer: async () => fakePng.buffer.slice(fakePng.byteOffset, fakePng.byteOffset + fakePng.byteLength) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ url: String(url).includes('gen') ? 'https://cdn.example.com/img.png' : 'https://evil.test/x' }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const okCase = await qwenImageGenerate({ prompt: 'p', outputDir: join(dir, 'a'), apiKey: 'sk-k', fetchImpl, resolveHost });
    assert.ok(okCase.ok, okCase.error);
    assert.ok(existsSync(okCase.path!), 'url 下载落盘');

    const privCase = await qwenImageGenerate({
      prompt: 'p',
      outputDir: join(dir, 'b'),
      apiKey: 'sk-k',
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: 'http://192.168.1.5/x.png' }] }) }) as unknown as Response),
      resolveHost,
    });
    assert.equal(privCase.ok, false);
    assert.match(privCase.error ?? '', /不安全/);

    const dnsCase = await qwenImageGenerate({
      prompt: 'p',
      outputDir: join(dir, 'c'),
      apiKey: 'sk-k',
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://bad.example.com/x.png' }] }) }) as unknown as Response),
      resolveHost,
    });
    assert.equal(dnsCase.ok, false, '域名解析到私网也拒');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('裁决 5：下载安全检查——地址段逐类判定', () => {
  assert.equal(isSafeDownloadUrl('https://maas.qianwenaiapi.com/x.png'), true);
  assert.equal(isSafeDownloadUrl('http://maas.qianwenaiapi.com/x.png'), false, '仅 https');
  for (const bad of ['http://127.0.0.1/x', 'https://169.254.169.254/meta', 'https://10.1.2.3/x', 'https://172.16.0.9/x', 'https://192.168.0.7/x', 'https://localhost/x.png', 'https://box.internal/x.png']) {
    assert.equal(isSafeDownloadUrl(bad), false, bad);
  }
  for (const bad of ['::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '999.1.1.1']) {
    assert.equal(isPrivateOrReservedAddress(bad), true, bad);
  }
  assert.equal(isPrivateOrReservedAddress('93.184.216.34'), false);
  assert.equal(isSafeDownloadUrl('not a url'), false);
});

test('裁决 5：工具层——qwen Key 在配置时走 qwen 通道；全无 Key 人话报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-tool-'));
  try {
    const calls: string[] = [];
    const b64 = Buffer.from('x').toString('base64');
    const tool = (await createImageGenerateTool(dir, {
      keyOptions: { env: { DASHSCOPE_API_KEY: 'sk-test' } as NodeJS.ProcessEnv },
      generateQwen: async (opts) => {
        calls.push('qwen');
        return { ok: true, path: join(opts.outputDir, 'i.png') };
      },
      generate: async () => {
        calls.push('dalle');
        return { ok: true, path: 'x' };
      },
    })) as unknown as Exec<{ prompt: string }>;
    const out = await tool.execute('tc', { prompt: '封面' }, undefined, undefined, { cwd: dir });
    assert.deepEqual(calls, ['qwen'], 'dashscope 配置 ⇒ qwen 通道');
    assert.equal(out.details?.['outcome'], 'ok');

    const noKey = (await createImageGenerateTool(dir, { keyOptions: { env: {} as NodeJS.ProcessEnv } })) as unknown as Exec<{ prompt: string }>;
    const errOut = await noKey.execute('tc', { prompt: '封面' });
    assert.equal(errOut.details?.['outcome'], 'error');
    assert.match(errOut.content[0]!.text, /阿里云百炼（Qwen 出图）或 OpenAI/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
