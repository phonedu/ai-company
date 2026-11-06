/**
 * S13-A 回归 · RW-32（老板真机 2026-10-28）：点「编辑」仍不可编辑。
 *
 * 根因：阅读态与编辑态是同一位置的同型子树，React 复用同一 Crepe 实例——
 * 阅读时 setReadonly(true) 后切编辑不会放开。
 * 判据：① 两个分支 key 不同（切换即重建）；② MilkdownEditor 在 readOnly 变化时同步
 * setReadonly；③ 编辑分支不得传 readOnly。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const editor = readFileSync('src/renderer/components/MilkdownEditor.tsx', 'utf8');

test('RW-32① 阅读/编辑分支 key 不同（强制重建，不复用只读实例）', () => {
  // 2026-10-29：大笔记按章编辑，编辑 key 形如 knowledge-edit-<章号>；无分章时仍 knowledge-edit。
  assert.match(page, /\? `knowledge-edit-\$\{editChunkIndex\}` : 'knowledge-edit'/, '编辑分支需独立 key');
  assert.match(page, /key: 'knowledge-read'/, '阅读分支需独立 key');
});

test('RW-32② 编辑分支不得传 readOnly', () => {
  const at = page.indexOf('? `knowledge-edit-');
  assert.ok(at > 0, '找不到编辑 key 分支');
  const editBlock = page.slice(at, page.indexOf('readOnly: true', at));
  assert.doesNotMatch(editBlock, /readOnly/, '编辑分支不得 readOnly');
});

test('RW-32③ readOnly 变化时同步 setReadonly（兜底，不锁死编辑态）', () => {
  assert.match(editor, /useEffect\(\(\) => \{\s*\n\s*if \(!ready\) return;[\s\S]*?setReadonly\?\.\(readOnly\)/, '需有 readOnly 同步 effect');
});
