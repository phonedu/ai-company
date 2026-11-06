/**
 * RW-18 落点跟随范围（M5 真机 S9 批登记，老板 2026-10-28 裁 A）：
 * 知识页「＋新建笔记」落点跟随当前范围——范围内落该项目 `.aico/notes/`，范围＝公司落全局。
 * 与 RW-14（助手 note_write 落点跟随范围）同语义，老板心智统一；提示文案随落点如实变化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newNoteTarget } from '../src/renderer/components/knowledge-types.js';

test('RW-18① 范围＝项目 → 落该项目（projectId 透传），提示写明项目与目录', () => {
  const t = newNoteTarget(1);
  assert.equal(t.projectId, 1);
  assert.match(t.hint, /review-site|当前项目|\.aico\/notes/);
  assert.doesNotMatch(t.hint, /全局笔记库/);
});

test('RW-18② 范围＝公司（null/0）→ 落全局笔记库，提示写明全局', () => {
  const a = newNoteTarget(null);
  assert.equal(a.projectId, null);
  assert.match(a.hint, /全局笔记库/);
  const b = newNoteTarget(0);
  assert.equal(b.projectId, null);
  assert.match(b.hint, /全局笔记库/);
});

test('RW-18③ 源码守卫：handleCreate 不再硬编码 projectId:null，落点经 newNoteTarget', () => {
  const src = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  const from = src.indexOf('const handleCreate');
  const to = src.indexOf('return createElement', from);
  const body = src.slice(from, to);
  assert.match(body, /newNoteTarget/, '落点必须经 newNoteTarget（跟随范围）');
  assert.doesNotMatch(body, /projectId:\s*null/, '不得再硬编码全局落点');
});
