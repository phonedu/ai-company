/**
 * 知识页判脏基线（复核 2026-11-06）。
 *
 * 背景：终验 g3 真机暴露「一字未改，退出编辑也弹确认」。首版修法在 KnowledgePage 用
 * `now.trim() !== base.trim()`，把「只改首行缩进/末尾空行」也当未修改（可能静默丢编辑）；
 * 同时 MilkdownEditor 里 `lastSetRef = getMarkdown()` 的基线会被紧随的 [value, ready]
 * effect 覆盖，实际没生效。
 *
 * 现修法：编辑器暴露 `getBaseline()`（Crepe 规范化后的初始正文），判脏按基线比；
 * 兜底只忽略**尾部**空白。本测守源码契约（Crepe 依赖 document，不能在 Node 里跑组件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync('src/renderer/components/MilkdownEditor.tsx', 'utf8');
const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');

test('MilkdownApi 暴露 getBaseline，且基线取 Crepe 规范化后的正文', () => {
  assert.match(editor, /interface MilkdownApi\s*\{[^}]*getBaseline:\s*\(\)\s*=>\s*string/s, 'MilkdownApi 必须有 getBaseline');
  assert.match(
    editor,
    /lastSetRef\.current = crepe\.getMarkdown\(\);\s*\n\s*baselineRef\.current = lastSetRef\.current;/,
    '初值注入后必须把规范化结果同时记为 lastSet 与基线',
  );
  assert.match(editor, /getBaseline:\s*\(\)\s*=>\s*baselineRef\.current/, 'apiRef 必须把基线暴露给上层');
});

test('父层换文只认 lastExternalRef（否则 ready 翻真会重灌原文、基线失效）', () => {
  assert.match(editor, /lastExternalRef/, '需要 lastExternalRef 区分「父层换文」与「规范化回吐」');
  assert.match(
    editor,
    /value !== lastExternalRef\.current/,
    '同步 effect 的条件必须是「父层值真的变了」',
  );
});

test('判脏优先用编辑器基线，兜底只忽略尾部空白（不吞首行缩进编辑）', () => {
  assert.match(page, /editApiRef\.current\?\.getBaseline\?\.\(\)/, 'dirty() 必须优先取编辑器基线');
  assert.match(page, /replace\(\/\[ \\t\\r\\n\]\+\$\/, ''\)/, '兜底只能裁尾部空白');
  assert.ok(!/now\.trim\(\) !== base\.trim\(\)/.test(page), '不得再用 trim 双侧比较（会吞掉首部空白编辑）');
});

test('"有牙"：删掉基线 / 改回 trim 双侧比较 → 上述断言必红（合成）', () => {
  const brokenBase = 'const now = editApiRef.current?.getMarkdown(); const base = editContent;';
  assert.ok(!/getBaseline/.test(brokenBase), '缺基线应被抓住');
  const brokenTrim = 'return now.trim() !== base.trim();';
  assert.ok(!/replace\(\/\[ \\t\\r\\n\]\+\$\/, ''\)/.test(brokenTrim), 'trim 双侧比较不应满足尾部裁切契约');
});
