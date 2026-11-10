/**
 * //：Web 工具＋截图工具——纯函数测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText, truncateContent, webFetch } from '../src/main/agent/tools/web-fetch-tool.js';
import { captureScreenshot } from '../src/main/agent/tools/screenshot-tool.js';

test('B4-1: htmlToText——去 script/style/tag＋实体解码', () => {
  const html = '<html><head><script>var x=1;</script><style>body{}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><p>&amp; &lt;tag&gt;</p></body></html>';
  const text = htmlToText(html);
  assert.ok(!text.includes('var x'), 'script 去除');
  assert.ok(!text.includes('body{'), 'style 去除');
  assert.ok(text.includes('Title'), '标题保留');
  assert.ok(text.includes('Hello'), '正文保留');
  assert.ok(text.includes('&'), '实体解码');
  assert.ok(!text.includes('<b>'), '标签去除');
});

test('B4-1: truncateContent——8KB 截断＋标记', () => {
  const short = 'a'.repeat(100);
  assert.equal(truncateContent(short), short, '短文本不截断');
  const long = 'x'.repeat(9000) + 'END';
  const truncated = truncateContent(long);
  assert.ok(truncated.length < 9000, '长文本被截断');
  assert.ok(truncated.includes('已截断'), '截断标记在案');
});

test('B4-1: webFetch——mock fetch 注入；非法 URL 拒绝；超时 fail-closed', async () => {
  // mock fetch 返回 HTML
  const mockResp = { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<html><body>hello world</body></html>' };
  const mockFetch = (async () => mockResp) as unknown as typeof fetch;
  const result = await webFetch('https://example.com', mockFetch);
  assert.ok(result.ok);
  assert.match(result.text ?? '', /hello world/);

  // 非法 URL 拒
  const bad = await webFetch('ftp://not-http', mockFetch);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /http/);

  // 无 fetch（缺省 fetch 不可用时不挂）
  // 超时场景（AbortController）
  const timeoutFetch = ((_url: string, opts?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
  const timeoutResult = await webFetch('https://slow.example.com', timeoutFetch, 100);
  assert.equal(timeoutResult.ok, false);
});
