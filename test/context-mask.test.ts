/**
 * CTX-1 P1 · CTX1-1 工具输出裁剪（模型边界）——纯逻辑＋钩子接线（fake pi）。
 *
 * 断言都能被弄红：放宽阈值、遮错误、删消息（配对断裂）、不写标记、ref 不落归档，测试即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEEP_RECENT_TOOL_RESULTS,
  maskNewToolOutput,
  maskOldToolResults,
  maskStats,
  isContextMaskingEnabled,
  recordOldMasked,
  resetMaskStats,
  TOOL_OUTPUT_MASK_THRESHOLD_CHARS,
} from '../src/main/agent/context-mask.js';
import { registerContextMasking } from '../src/main/agent/pi-runtime.js';

function fakePi(): { handlers: Map<string, (ev: unknown) => unknown>; pi: unknown } {
  const handlers = new Map<string, (ev: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (ev: unknown) => unknown): () => void {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  return { handlers, pi };
}

const longText = (n: number): string => 'A'.repeat(n);

test('CTX1-1: 新输出未达阈值原样；达到阈值 → 头尾＋显式标记＋ref', () => {
  const small = maskNewToolOutput({ text: longText(7999), toolName: 'bash' });
  assert.equal(small.masked, false);
  assert.equal(small.text.length, 7999);

  const text = 'HEAD'.repeat(1000) + 'MIDDLE'.repeat(2000) + 'TAIL'.repeat(1000);
  const masked = maskNewToolOutput({ text, toolName: 'bash', ref: 's/1.txt', bytes: 123456 });
  assert.equal(masked.masked, true);
  assert.ok(masked.text.startsWith('HEAD'), '保留头');
  assert.ok(masked.text.endsWith('TAIL'), '保留尾');
  assert.match(masked.text, /【工具输出已裁剪：bash；原文 \d+ 字符 \/ 123456 字节/);
  assert.match(masked.text, /ref=s\/1\.txt/);
  assert.ok(masked.text.length < text.length, '确实变短');
  assert.ok(text.length >= TOOL_OUTPUT_MASK_THRESHOLD_CHARS);
});

test('CTX1-1: 旧输出只遮最近 K 之外、非错误、≥400 字符；不删消息、配对不断', () => {
  const messages: unknown[] = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `t${i}`, name: 'bash', arguments: {} }] });
    messages.push({
      role: 'toolResult',
      toolCallId: `t${i}`,
      toolName: 'bash',
      content: [{ type: 'text', text: `OUT-${i}-` + 'x'.repeat(1000) }],
      isError: i === 1, // 错误不遮
      timestamp: i,
    });
  }
  messages.push({ role: 'user', content: '继续' });
  messages.splice(2, 0, {
    role: 'toolResult',
    toolCallId: 'short',
    toolName: 'read',
    content: [{ type: 'text', text: 'short' }],
    isError: false,
    timestamp: 99,
  });

  const snapshot = JSON.stringify(messages);
  const result = maskOldToolResults(messages);
  assert.equal(result.messages.length, messages.length, '消息数不变（不删消息）');
  assert.equal(JSON.stringify(messages), snapshot, '不改原数组对象（纯替换）');

  const toolResults = result.messages.filter((m) => (m as { role?: string }).role === 'toolResult');
  assert.equal(toolResults.length, 11, 'tool_result 条数不变（配对）');
  // 最近 K 条（t4..t9 中最后 6 条 toolResult）不动
  const recent = toolResults.slice(-KEEP_RECENT_TOOL_RESULTS) as Array<{ content: Array<{ text: string }> }>;
  for (const m of recent) assert.doesNotMatch(m.content[0]!.text, /旧工具输出已清理/);
  // 错误不动
  const errorMsg = result.messages.find((m) => (m as { toolCallId?: string }).toolCallId === 't1') as { content: Array<{ text: string }> };
  assert.match(errorMsg.content[0]!.text, /OUT-1-/);
  // 短输出不动
  const shortMsg = result.messages.find((m) => (m as { toolCallId?: string }).toolCallId === 'short') as { content: Array<{ text: string }> };
  assert.equal(shortMsg.content[0]!.text, 'short');
  // 旧大输出被遮：标记＋前 200 字
  const old = result.messages.find((m) => (m as { toolCallId?: string }).toolCallId === 't0') as { content: Array<{ text: string }> };
  assert.match(old.content[0]!.text, /【旧工具输出已清理：bash；原 \d+ 字符；摘要：OUT-0-/);
  assert.ok(result.maskedCount >= 1);
  assert.ok(result.savedChars > 0);
});

test('CTX1-1 策略收窄：read 的文件内容不遮（新/旧都不遮），bash 仍遮', () => {
  const text = 'x'.repeat(10000);
  assert.equal(maskNewToolOutput({ text, toolName: 'read' }).masked, false, 'read 新输出不遮（分析素材）');
  const messages = [
    { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text }], isError: false },
    { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', content: [{ type: 'text', text }], isError: false },
  ];
  const result = maskOldToolResults(messages, { keepRecent: 0 });
  const readMsg = result.messages.find((m) => (m as { toolCallId?: string }).toolCallId === 'r1') as { content: Array<{ text: string }> };
  const bashMsg = result.messages.find((m) => (m as { toolCallId?: string }).toolCallId === 'b1') as { content: Array<{ text: string }> };
  assert.equal(readMsg.content[0]!.text, text, 'read 旧输出原样保留');
  assert.match(bashMsg.content[0]!.text, /旧工具输出已清理/, 'bash 旧输出仍遮');
});

test('CTX1-1: 旧输出保留图片项（只替换文本）', () => {
  const messages = [
    { role: 'toolResult', toolCallId: 'img', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(600) }, { type: 'image', data: 'abc', mimeType: 'image/png' }], isError: false },
  ];
  const result = maskOldToolResults(messages, { keepRecent: 0 });
  const content = (result.messages[0] as { content: Array<{ type: string }> }).content;
  assert.equal(content[0]!.type, 'text');
  assert.ok(content.some((item) => item.type === 'image'), '图片必须保留');
});

test('CTX1-1: 环境开关可关；计数器可读可复位', () => {
  assert.equal(isContextMaskingEnabled({}), true);
  assert.equal(isContextMaskingEnabled({ AICO_CTX_MASK: 'off' }), false);
  assert.equal(isContextMaskingEnabled({ AICO_CTX_MASK: '0' }), false);
  assert.equal(isContextMaskingEnabled({ AICO_CTX: 'off' }), false, '总开关 AICO_CTX=off 必须关闭裁剪');
  resetMaskStats();
  recordOldMasked({ maskedCount: 2, savedChars: 300 });
  assert.deepEqual(maskStats(), { newMaskedCount: 0, newMaskedChars: 0, oldMaskedCount: 2, oldSavedChars: 300 });
  resetMaskStats();
});

test('CTX1-1: 钩子接线——大输出替换并归档（可读回原文本），错误输出不遮；context 钩子遮旧输出', () => {
  resetMaskStats();
  const dir = mkdtempSync(join(tmpdir(), 'aico-mask-'));
  try {
    const { handlers, pi } = fakePi();
    const archived = new Map<string, { ref: string; bytes: number; summary: string }>();
    registerContextMasking(pi, { sessionKey: 'employee:1:task:1:wi:-', toolOutputDir: dir, archived });
    const toolResult = handlers.get('tool_result');
    const context = handlers.get('context');
    assert.ok(toolResult && context, '两个钩子都必须注册');

    const big = 'H'.repeat(3000) + 'M'.repeat(8000) + 'T'.repeat(2000);
    const out = toolResult!({
      type: 'tool_result',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: big }],
      isError: false,
    }) as { content: Array<{ type: string; text: string }>; structuredContent?: { ref?: string } };
    assert.match(out.content[0]!.text, /工具输出已裁剪/);
    assert.ok(out.structuredContent?.ref, 'structuredContent 必须同步替换并带 ref');
    const entry = archived.get('call-1');
    assert.ok(entry, '归档结果回填（供 tool_execution_end 复用）');
    assert.ok(existsSync(join(dir, entry!.ref)), '归档文件可读');
    assert.equal(readFileSync(join(dir, entry!.ref), 'utf8'), big, '归档保留原文');

    const errOut = toolResult!({
      type: 'tool_result',
      toolCallId: 'call-2',
      toolName: 'bash',
      content: [{ type: 'text', text: big }],
      isError: true,
    });
    assert.equal(errOut, undefined, '错误输出不裁剪（原样留在上下文）');

    // 没有归档根 ⇒ 不裁（裁了就没有可展开的原文；不拿信息换 token）
    const noDirHandlers = new Map<string, (ev: unknown) => unknown>();
    registerContextMasking(
      { on: (e: string, h: (ev: unknown) => unknown) => (noDirHandlers.set(e, h), () => undefined) },
      { sessionKey: 's' },
    );
    assert.equal(
      noDirHandlers.get('tool_result')!({
        type: 'tool_result',
        toolCallId: 'call-3',
        toolName: 'bash',
        content: [{ type: 'text', text: big }],
        isError: false,
      }),
      undefined,
      '无归档根不得裁剪',
    );

    const oldMessages = Array.from({ length: 8 }, (_, i) => ({
      role: 'toolResult',
      toolCallId: `old-${i}`,
      toolName: 'bash',
      content: [{ type: 'text', text: `OLD-${i}-` + 'y'.repeat(800) }],
      isError: false,
    }));
    const masked = context!({ type: 'context', messages: oldMessages }) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.equal(masked.messages.length, oldMessages.length);
    assert.match(masked.messages[0]!.content[0]!.text, /旧工具输出已清理/);
    assert.equal(maskStats().newMaskedCount, 1);
    assert.ok(maskStats().oldMaskedCount >= 1);
  } finally {
    resetMaskStats();
    rmSync(dir, { recursive: true, force: true });
  }
});
