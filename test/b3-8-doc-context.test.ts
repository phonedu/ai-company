/**
 * （57 P1-10；）：文档进 AI 上下文——只读 read_doc 工具（路径白名单）＋文档索引层。
 *
 * 口径：
 *  - `read_doc`：员工会话内读**项目根内**的 .md/.txt（相对路径解析；穿越/绝对路径/白名单
 *    外扩展名拒）；单文件 8KB 截断（头 6KB＋尾 1KB＋显式标记——与 bash 输出裁剪同哲学）；
 *  - 文档索引层：`.aico/docs` 树＋根级 *.md 进员工上下文分节（`docsIndexLayer`），
 *    **无文档不注入空段**；
 *  - 幕僚长同样可用（只读、跟随频道范围项目根）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReadDocTool, extractReadDocPath, docsIndexLayer } from '../src/main/agent/read-doc-tool.js';
import { makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { sep } from 'node:path';

function makeProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'b3-8-proj-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# 项目约定\n\n术语统一「对账单」。', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# Demo\n\n示例项目。', 'utf8');
  mkdirSync(join(dir, '.aico', 'docs'), { recursive: true });
  writeFileSync(join(dir, '.aico', 'docs', 'api.md'), '## API\n\nGET /v1/items', 'utf8');
  writeFileSync(join(dir, 'notes.txt'), '随手记', 'utf8');
  writeFileSync(join(dir, 'secret.env'), 'KEY=1', 'utf8');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('B3-8: extractReadDocPath——相对路径解析；穿越/绝对/白名单外扩展名拒', () => {
  const root = 'D:' + sep + 'repo';
  const p = (...parts: string[]): string => root + sep + parts.join(sep);
  assert.equal(extractReadDocPath('docs/a.md', root), p('docs', 'a.md'));
  assert.equal(extractReadDocPath('.aico/docs/api.md', root), p('.aico', 'docs', 'api.md'));
  assert.equal(extractReadDocPath('notes.txt', root), p('notes.txt'));
  // 拒：穿越
  assert.equal(extractReadDocPath('../../etc/passwd', root), null);
  assert.equal(extractReadDocPath('docs/../../x.md', root), null);
  // 拒：绝对路径
  assert.equal(extractReadDocPath('D:/outside/x.md', root), null);
  assert.equal(extractReadDocPath('/etc/passwd', root), null);
  // 拒：白名单外扩展名
  assert.equal(extractReadDocPath('script.js', root), null);
  assert.equal(extractReadDocPath('secret.env', root), null);
  assert.equal(extractReadDocPath('image.png', root), null);
});

test('B3-8: read_doc 工具——白名单内命中返回正文；不存在明说；8KB 截断带标记', async () => {
  const { dir, cleanup } = makeProject();
  try {
    // 大文件：>8KB
    const big = 'x'.repeat(9000) + 'END-MARK';
    writeFileSync(join(dir, 'big.md'), big, 'utf8');
    const tool = (await createReadDocTool(dir)) as unknown as {
      execute(id: string, params: { path: string }): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
    };
    const read = async (path: string): Promise<string> =>
      (await tool.execute('tc', { path })).content.map((c) => c.text).join('\n');

    const agents = await read('AGENTS.md');
    assert.match(agents, /对账单/);
    const api = await read('.aico/docs/api.md');
    assert.match(api, /GET \/v1\/items/);
    const missing = await read('docs/nope.md');
    assert.match(missing, /不存在|没找到/);
    const deny = await read('../../etc/passwd');
    assert.match(deny, /拒绝|白名单|项目根/);
    const bigOut = await read('big.md');
    assert.ok(bigOut.includes('END-MARK') === false || bigOut.length < 9000, '大文件被截断（不整段回读）');
    assert.match(bigOut, /已截断/);
  } finally {
    cleanup();
  }
});

test('B3-8: docsIndexLayer——根级 *.md 与 .aico/docs 树成索引；空项目空串（不注入空段）', () => {
  const { dir, cleanup } = makeProject();
  try {
    const layer = docsIndexLayer(dir);
    assert.match(layer, /AGENTS\.md/);
    assert.match(layer, /README\.md/);
    assert.match(layer, /api\.md/, '.aico/docs 树入索引');
    assert.match(layer, /notes\.txt/, '白名单扩展名的根级文件入索引');
    assert.ok(!layer.includes('secret.env'), '白名单外扩展名不入索引');
    assert.match(layer, /read_doc/, '索引提示用 read_doc 读取');
    const empty = mkdtempSync(join(tmpdir(), 'b3-8-empty-'));
    try {
      assert.equal(docsIndexLayer(empty), '', '无文档 → 空串（不注入空段）');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test('B3-8: makeFakeAgentRuntime 仍可用（回归锚——B3-8 不动 runtime 面）', () => {
  const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [] }]);
  assert.ok(fake);
});
