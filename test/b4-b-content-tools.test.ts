/**
 * B4b/：图像生成＋导出适配器＋自媒体 SOP——纯函数/接口测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { imageGenerate } from '../src/main/agent/tools/image-generate-tool.js';
import { convertFormat, exportFormatLabels } from '../src/main/agent/tools/export-format-tool.js';
import { sopFor } from '../src/main/agent/role-sops.js';

test('B4-4: imageGenerate——无 Key fail-closed；mock fetch 返回图片', async () => {
  // 无 Key
  const noKey = await imageGenerate({ prompt: 'test', outputDir: join(tmpdir(), 'b4-4-'), apiKey: '' });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error ?? '', /未配置/);

  // mock fetch 返回 b64_json
  const b64 = Buffer.from('fake-png-data').toString('base64');
  const mockResp = {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: b64 }] }),
  } as unknown as Response;
  const outDir = mkdtempSync(join(tmpdir(), 'b4-4-img-'));
  const result = await imageGenerate({
    prompt: 'A cute cat',
    outputDir: outDir,
    apiKey: 'sk-test',
    fetchImpl: (async () => mockResp) as unknown as typeof fetch,
  });
  assert.ok(result.ok, `imageGenerate 成功（实际：${result.error}）`);
  assert.ok(result.path && existsSync(result.path), '图片落盘');
  rmSync(outDir, { recursive: true, force: true });
});

test('B4-6: exportFormat——公众号 HTML/通用 MD/纯文本三格式', () => {
  const md = '# 标题\n\n**粗体** 内容\n\n```code```';
  // 公众号 HTML
  const html = convertFormat(md, 'wechat_html');
  assert.match(html, /<h1/);
  assert.match(html, /<strong/);
  assert.match(html, /<pre/);
  // 通用 MD
  const mdOut = convertFormat(md, 'markdown');
  assert.equal(mdOut, md, 'MD 透传');
  // 纯文本
  const plain = convertFormat(md, 'plain_text');
  assert.ok(!plain.includes('#'), '纯文本去标题符号');
  assert.ok(!plain.includes('**'), '纯文本去粗体符号');
  // 标签列表
  const labels = exportFormatLabels();
  assert.equal(labels.length, 3);
});

test('B4-7: 自媒体运营 SOP——三段齐＋≥700 字', () => {
  const sop = sopFor('自媒体运营');
  assert.ok(sop, 'SOP 在案');
  assert.ok(sop!.method.split('\n').length >= 5, '方法 ≥5 条');
  assert.ok(sop!.checklist.split('\n').filter(l => l.includes('□')).length >= 5, '清单 ≥5 条');
  const total = sop!.method.length + sop!.outputSpec.length + sop!.checklist.length;
  assert.ok(total >= 700, `总字数 ${total} ≥700`);
});
