/**
 * CTX-1 P1 · CTX1-9 缓存/前缀稳定性审计（源码级守卫）。
 *
 * 判据：
 *  - 工具声明只在**会话创建**时确定，`run` 内不得动态增删（杜绝每次请求工具表变化）；
 *  - 裁剪/压缩观测不得改写 system prompt（前缀抖动会打穿 cache）；
 *  - system prompt 指纹逐轮落 `context_metrics`（同会话可比）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'main', 'agent', 'pi-runtime.ts');
const EXECUTOR = join(process.cwd(), 'src', 'main', 'agent', 'employee-executor.ts');
const MASK = join(process.cwd(), 'src', 'main', 'agent', 'context-mask.ts');

test('CTX1-9: 会话创建处不得按轮传入 tools/excludeTools/customTools（工具表固定）', () => {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('sdk\n          .createAgentSession(');
  assert.ok(start >= 0, '找不到 createAgentSession 装配点');
  const block = src.slice(start, start + 1200);
  for (const key of ['tools:', 'excludeTools:', 'customTools:']) {
    assert.equal(block.includes(key), false, `createAgentSession 不得带 ${key}（否则工具声明随装配抖动）`);
  }
});

test('CTX1-9: run 内不得 registerTool / 改 system 注入源之外的提示词', () => {
  const src = readFileSync(RUNTIME, 'utf8');
  const runStart = src.indexOf('run(input: AgentRunInput');
  assert.ok(runStart >= 0, '找不到 run()');
  const block = src.slice(runStart, runStart + 6000);
  assert.equal(/registerTool\s*\(/.test(block), false, 'run 内不得动态注册工具');
  // 允许逐轮登记（值来自 run 入参）；但不允许在 run 内改写/拼接出别的 system 文本。
  const sets = block.match(/sessionSystemPrompts\.set\([^;]+/g) ?? [];
  for (const line of sets) assert.match(line, /input\.systemPrompt/, 'run 内登记的系统提示词必须原样来自入参');
});

test('CTX1-9: 裁剪/压缩观测不改 system prompt（只动工具结果/观测）', () => {
  const mask = readFileSync(MASK, 'utf8');
  assert.equal(/systemPrompt|system_prompt/.test(mask), false, 'context-mask 不得触碰 system prompt');
  const src = readFileSync(RUNTIME, 'utf8');
  const injectAt = src.indexOf('export function registerSystemPromptInjection');
  const fn = src.slice(src.indexOf('export function registerContextMasking'), src.lastIndexOf('/**', injectAt));
  assert.equal(/systemPrompt/.test(fn), false, '裁剪钩子不得改 system prompt');
});

test('CTX1-9: 每行遥测带 system prompt 指纹与模型（cache 命中可逐轮对照）', () => {
  const src = readFileSync(EXECUTOR, 'utf8');
  assert.match(src, /systemPromptHash:\s*createHash\('sha256'\)\.update\(options\.ctx\.systemPrompt\)/);
  assert.match(src, /model:\s*options\.model/);
  const runtime = readFileSync(RUNTIME, 'utf8');
  assert.match(runtime, /buildCompactionHandoff && isCtxEnabled\(\)/, '总开关必须能关掉交接块（A/B 单变量）');
  const ctx = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'context.ts'), 'utf8');
  assert.match(ctx, /!isCtxEnabled\(\)/, '总开关必须能关掉计划复述（A/B 单变量）');
});
