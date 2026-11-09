/**
 * B4b/D-29：内容工具接线与门禁——
 *  - image_generate 归 spend：external grant 不放行（一次对外批准不得顺带授权花钱），只认 consent:spend；
 *    工具参数不得含路径类键（spend 类不经路径层，收路径即未受检的写路径）；
 *  - export_format 归 write：走路径层（项目外/穿越/敏感/外部文档根一律拒）；输出与源同目录派生；
 *  - 公众号 HTML：链接不可注入属性、javascript: 不出链接、未闭合代码块收尾；错误回文 Key 片段脱敏；
 *  - 接线守卫：四个 B4 员工工具都在 employee-factory 注册（防「模块在、零调用方」回归——B3 换方向审查实抓过）。
 * 顺带补 B4a：web_fetch/screenshot 的门禁分类此前无测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { permissionGate, toolCategory, type GateContext } from '../src/main/permission/gate.js';
import { createExportFormatTool, createImageGenerateTool } from '../src/main/agent/tools/content-tools.js';
import { convertFormat, exportPathFor, exportToFile } from '../src/main/agent/tools/export-format-tool.js';
import { imageGenerate, redactKeyFragments } from '../src/main/agent/tools/image-generate-tool.js';

const ROOT = 'D:/repo';
function ctx(extra: Partial<GateContext> = {}): GateContext {
  return { capabilityTier: 'standard', autonomy: 'standard', riskLevel: 1, projectRoot: ROOT, cwd: ROOT, employeeSession: true, ...extra };
}

/** gate.ts `pathArg` 检查的键（与源码同一名单）。 */
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'dir', 'cwd'];

test('B4 门禁分类：web_fetch/screenshot＝external；image_generate＝spend；export_format＝write', () => {
  assert.equal(toolCategory('web_fetch'), 'external');
  assert.equal(toolCategory('screenshot'), 'external');
  assert.equal(toolCategory('image_generate'), 'spend');
  assert.equal(toolCategory('export_format'), 'write');
});

test('B4-4: image_generate 每次 ask；external grant 不放行；只有同名 consent:spend 才放行', () => {
  const call = { name: 'image_generate', args: { prompt: 'cat' } };
  const plain = permissionGate(call, ctx());
  assert.equal(plain.decision, 'ask');
  assert.equal(plain.rule, 'consent:spend');

  // 老板批过这个工具的 external 放行——不得顺带授权花钱。
  const withExternal = permissionGate(call, ctx({
    policy: {
      grants: [
        { rule: 'external', scope: 'task', toolName: 'image_generate' },
        { rule: 'consent:external', scope: 'task', toolName: 'image_generate' },
      ],
    },
  }));
  assert.equal(withExternal.decision, 'ask', 'external grant 不放行花钱动作');

  // 别的工具的 spend 批准不外溢。
  const otherSpend = permissionGate(call, ctx({ policy: { grants: [{ rule: 'consent:spend', scope: 'task', toolName: 'purchase' }] } }));
  assert.equal(otherSpend.decision, 'ask', '其它工具的 spend grant 不外溢');

  const withSpend = permissionGate(call, ctx({ policy: { grants: [{ rule: 'consent:spend', scope: 'once', toolName: 'image_generate' }] } }));
  assert.equal(withSpend.decision, 'allow');

  const sandbox = permissionGate(call, ctx({ capabilityTier: 'sandbox' }));
  assert.equal(sandbox.decision, 'deny', 'sandbox 档不允许 spend 类');
});

test('B4-6: export_format 走路径层——项目内放行；项目外/穿越/敏感/外部文档根拒；strict 档要批', () => {
  const at = (path: string, extra: Partial<GateContext> = {}) =>
    permissionGate({ name: 'export_format', args: { path, format: 'wechat_html' } }, ctx(extra));

  assert.equal(at('drafts/a.md').decision, 'allow');
  const outside = at('C:/Users/x/Documents/a.md');
  assert.equal(outside.decision, 'deny');
  assert.equal(outside.rule, 'path_scope');
  assert.equal(at('../other/a.md').decision, 'deny', '相对穿越解析后出根即拒');
  const sensitive = at('.env.md');
  assert.equal(sensitive.decision, 'deny');
  assert.equal(sensitive.rule, 'sensitive_path');
  assert.equal(at('E:/docs/a.md', { docRoots: ['E:/docs'] }).decision, 'deny', '外部文档根只给读类，写类导出不得写进去');
  assert.equal(at('a.md', { autonomy: 'strict' }).decision, 'ask');
});

test('B4-6: exportToFile——与源同目录派生输出；只收 .md/.markdown/.txt，拒绝时不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b4-6-export-'));
  try {
    const src = join(dir, 'article.md');
    writeFileSync(src, '# 标题\n\n正文 **重点**\n', 'utf8');
    const r = exportToFile(src, 'wechat_html');
    if (!r.ok) assert.fail(r.error);
    assert.equal(r.outputPath, join(dir, 'article.wechat.html'));
    assert.match(readFileSync(r.outputPath, 'utf8'), /<h1[^>]*>标题<\/h1>/);
    assert.equal(exportPathFor(src, 'plain_text'), join(dir, 'article.plain.txt'));
    assert.equal(exportPathFor(src, 'markdown'), join(dir, 'article.export.md'));

    writeFileSync(join(dir, 'secret.ts'), 'export const k = 1;', 'utf8');
    const bad = exportToFile(join(dir, 'secret.ts'), 'wechat_html');
    assert.equal(bad.ok, false);
    assert.ok(!existsSync(join(dir, 'secret.wechat.html')), '拒绝时不落盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4-6: 公众号 HTML——链接不可注入属性；javascript: 不出链接；代码块转义且未闭合时收尾', () => {
  const html = convertFormat(
    '[点我](https://a.com/" onmouseover="alert(1))\n\n[坏](javascript:alert(1))\n\n```\n<b>x</b>',
    'wechat_html',
  );
  assert.ok(!/onmouseover="/.test(html), '引号已转义，属性未注入');
  assert.ok(!/href="javascript:/i.test(html), 'javascript: 不出 href');
  assert.match(html, /<a href="https:\/\/a\.com\/&quot;/, '安全链接保留且引号转义');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, '代码块内容转义');
  assert.ok(html.trimEnd().endsWith('</code></pre>'), '未闭合代码块收尾');
});

test('B4-4: Key 片段脱敏——401 回显的掩码 Key 不回给模型', async () => {
  assert.equal(
    redactKeyFragments('Incorrect API key provided: sk-proj-****abcd. You can find'),
    'Incorrect API key provided: sk-***. You can find',
  );
  const resp401 = {
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"Incorrect API key provided: sk-proj-****wxyz"}}',
  } as unknown as Response;
  const dir = mkdtempSync(join(tmpdir(), 'b4-4-401-'));
  try {
    const r = await imageGenerate({
      prompt: 'x',
      outputDir: dir,
      apiKey: 'sk-test-not-real',
      fetchImpl: (async () => resp401) as unknown as typeof fetch,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /401/);
    assert.ok(!/wxyz/.test(r.error ?? ''), '掩码 Key 尾巴已脱敏');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4-4: image_generate 工具定义——名称对；参数无路径类键（spend 类不经路径层）', async () => {
  const tool = (await createImageGenerateTool(ROOT)) as unknown as {
    name: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
  };
  assert.equal(tool.name, 'image_generate');
  const keys = Object.keys(tool.parameters.properties);
  assert.deepEqual(keys.filter((k) => PATH_ARG_KEYS.includes(k) || /dir|path/i.test(k)), [], `不收路径参数（实际：${keys.join(',')}）`);
  assert.deepEqual(tool.parameters.required, ['prompt']);
});

test('B4-6: export_format 工具定义——参数名 path（门禁路径层首查键）；执行落盘并回相对路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b4-6-tool-'));
  try {
    writeFileSync(join(dir, 'post.md'), '# 封面文案\n\n**要点**一\n', 'utf8');
    const tool = (await createExportFormatTool(dir)) as unknown as {
      name: string;
      parameters: { properties: Record<string, unknown> };
      execute(id: string, params: { path: string; format: string }): Promise<{ content: Array<{ text: string }>; details?: { outcome: string; path: string | null } }>;
    };
    assert.equal(tool.name, 'export_format');
    assert.ok('path' in tool.parameters.properties, '源路径参数名为 path');
    const out = await tool.execute('tc', { path: 'post.md', format: 'plain_text' });
    assert.equal(out.details?.outcome, 'ok');
    assert.equal(out.details?.path, 'post.plain.txt');
    assert.equal(readFileSync(join(dir, 'post.plain.txt'), 'utf8'), '封面文案\n\n要点一\n');
    const missing = await tool.execute('tc', { path: 'nope.md', format: 'markdown' });
    assert.equal(missing.details?.outcome, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4 接线守卫：web_fetch/screenshot/image_generate/export_format 四个工具都在 employee-factory 注册', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'employee-factory.ts'), 'utf8');
  for (const factory of ['createWebFetchTool', 'createScreenshotTool', 'createImageGenerateTool', 'createExportFormatTool']) {
    assert.match(src, new RegExp(`employeeTools\\.push\\(await ${factory}\\(`), `${factory} 已推入 employeeTools`);
  }
});
