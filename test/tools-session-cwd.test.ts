/**
 * 自定义工具按**会话 cwd** 解析（B4b 效果终验设计期实抓）。
 *
 * 缺陷：员工运行时全局共享一份（生产 `cwd: process.cwd()`），经 extensionFactories 注册的自定义工具
 * 在装配期绑死该 cwd ⇒ 生产里 read_doc 读应用目录、screenshot/image_generate 写进应用目录、
 * export_format「门禁按 run.cwd 批 A、工具按应用目录写 B」。单测一律直接传临时项目目录，测不出。
 * 修：Pi 每次 execute 传 `ExtensionToolContext`，其 `cwd`＝会话 `_cwd`（与门禁同源）⇒ 逐次解析。
 *
 * 本文件的统一做法：工具用**兜底目录 A** 装配、以**会话上下文 cwd=B** 执行，断言一切读写落在 B。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionCwd } from '../src/main/agent/tools/session-cwd.js';
import { createExportFormatTool, createImageGenerateTool } from '../src/main/agent/tools/content-tools.js';
import { createScreenshotTool, SCREENSHOT_SUBDIR } from '../src/main/agent/tools/web-tools.js';
import { createReadDocTool } from '../src/main/agent/read-doc-tool.js';
import { createRepoMapTool } from '../src/main/agent/repo-map-tool.js';

type Out = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Exec<P> = { execute(id: string, params: P, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<Out> };

function twoDirs(): { a: string; b: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'tool-cwd-'));
  const a = join(root, 'fallback-A');
  const b = join(root, 'session-B');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return { a, b, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('sessionCwd：取 ctx.cwd；缺失/空/非字符串/getter 抛错一律回落兜底', () => {
  assert.equal(sessionCwd({ cwd: 'D:/proj' }, 'D:/app'), 'D:/proj');
  assert.equal(sessionCwd(undefined, 'D:/app'), 'D:/app');
  assert.equal(sessionCwd(null, 'D:/app'), 'D:/app');
  assert.equal(sessionCwd({ cwd: '' }, 'D:/app'), 'D:/app');
  assert.equal(sessionCwd({ cwd: 42 }, 'D:/app'), 'D:/app');
  const throwing = {
    get cwd(): string {
      throw new Error('runner inactive');
    },
  };
  assert.equal(sessionCwd(throwing, 'D:/app'), 'D:/app', 'Pi 的 cwd getter 会 assertActive——抛错不得炸工具');
});

test('export_format：按会话 cwd 读源、写导出；兜底目录不被触碰', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    writeFileSync(join(b, 'post.md'), '# 标题\n\n正文\n', 'utf8');
    const tool = (await createExportFormatTool(a)) as unknown as Exec<{ path: string; format: string }>;
    const out = await tool.execute('tc', { path: 'post.md', format: 'wechat_html' }, undefined, undefined, { cwd: b });
    assert.equal(out.details?.['outcome'], 'ok', out.content.map((c) => c.text).join('\n'));
    assert.equal(out.details?.['path'], 'post.wechat.html', '回给员工的相对路径相对会话 cwd');
    assert.ok(existsSync(join(b, 'post.wechat.html')), '导出落在会话 cwd');
    assert.ok(!existsSync(join(a, 'post.wechat.html')), '兜底目录无导出');
  } finally {
    cleanup();
  }
});

test('image_generate：输出目录＝会话 cwd/assets/images（注入生成器，不解任何 Key）', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    const seen: string[] = [];
    const tool = (await createImageGenerateTool(a, {
      channel: 'dalle', // 钉通道：不按真 Key 解析（单测不碰真 secrets）
      generate: async (opts) => {
        seen.push(opts.outputDir);
        return { ok: true, path: join(opts.outputDir, 'image-1.png') };
      },
    })) as unknown as Exec<{ prompt: string }>;
    const out = await tool.execute('tc', { prompt: 'cover' }, undefined, undefined, { cwd: b });
    assert.deepEqual(seen, [join(b, 'assets', 'images')]);
    assert.equal(out.details?.['path'], 'assets/images/image-1.png');
  } finally {
    cleanup();
  }
});

test('screenshot：截图目录＝会话 cwd/.aico/screenshots；兜底目录不建 .aico', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    const seen: string[] = [];
    const tool = (await createScreenshotTool(a, {
      capture: (dir) => {
        seen.push(dir);
        return { ok: true, path: join(dir, 'shot.png') };
      },
    })) as unknown as Exec<Record<string, never>>;
    await tool.execute('tc', {}, undefined, undefined, { cwd: b });
    assert.deepEqual(seen, [join(b, SCREENSHOT_SUBDIR)]);
    assert.ok(existsSync(join(b, SCREENSHOT_SUBDIR)), '会话 cwd 下建截图目录');
    assert.ok(!existsSync(join(a, '.aico')), '装配期目录不再被写（修前：生产＝应用进程目录）');
  } finally {
    cleanup();
  }
});

test('read_doc：读会话 cwd 的项目文档；无上下文才回落装配根', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    writeFileSync(join(a, 'AGENTS.md'), 'FALLBACK-A-DOC', 'utf8');
    writeFileSync(join(b, 'AGENTS.md'), 'SESSION-B-DOC', 'utf8');
    const tool = (await createReadDocTool(a)) as unknown as Exec<{ path: string }>;
    const viaSession = await tool.execute('tc', { path: 'AGENTS.md' }, undefined, undefined, { cwd: b });
    assert.match(viaSession.content[0]!.text, /SESSION-B-DOC/);
    const noCtx = await tool.execute('tc', { path: 'AGENTS.md' });
    assert.match(noCtx.content[0]!.text, /FALLBACK-A-DOC/, '单测/无上下文：兜底行为不变');
  } finally {
    cleanup();
  }
});

test('read_doc：会话 cwd 下穿越仍拒（边界跟着会话根走，不放宽）', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    writeFileSync(join(a, 'secret.md'), 'A-ONLY', 'utf8');
    const tool = (await createReadDocTool(b)) as unknown as Exec<{ path: string }>;
    const out = await tool.execute('tc', { path: '../fallback-A/secret.md' }, undefined, undefined, { cwd: b });
    assert.equal(out.details?.['outcome'], 'denied');
    assert.ok(!/A-ONLY/.test(out.content[0]!.text));
  } finally {
    cleanup();
  }
});

test('repo_map：索引会话 cwd 的仓库；不同根分别缓存不串', async () => {
  const { a, b, cleanup } = twoDirs();
  try {
    writeFileSync(join(a, 'only-in-a.md'), '# Alpha Heading\n', 'utf8');
    writeFileSync(join(b, 'only-in-b.md'), '# Beta Heading\n', 'utf8');
    const tool = (await createRepoMapTool(a)) as unknown as Exec<{ query?: string }>;
    const inB = await tool.execute('tc', {}, undefined, undefined, { cwd: b });
    const inA = await tool.execute('tc', {}, undefined, undefined, { cwd: a });
    const textB = inB.content.map((c) => c.text).join('\n');
    const textA = inA.content.map((c) => c.text).join('\n');
    assert.match(textB, /only-in-b\.md/);
    assert.ok(!/only-in-a\.md/.test(textB), '会话 B 看不到 A 的文件');
    assert.match(textA, /only-in-a\.md/, '先建的 B 缓存不污染 A');
  } finally {
    cleanup();
  }
});
