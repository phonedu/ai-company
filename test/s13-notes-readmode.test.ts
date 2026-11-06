/**
 * S13-A · RW-28（老板 2026-10-28 裁）：笔记阅读态**只渲染、不显示源码**。
 *
 * 老板原话：「编辑态和阅读的时候都不显示源码。只显示渲染过后的内容，不然我们选择这个编辑器干嘛。」
 * 判据：
 * ① 笔记阅读分支不得渲染 `<pre>`/`knowledge-view`（旧实现是源码）；
 * ② 阅读态用同一 Crepe 渲染器只读化（MilkdownEditor readOnly）；
 * ③ 渲染失败时阅读态**不退回裸源码**（显式报错）；
 * ④ 全仓不出现「查看源码」入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const editor = readFileSync('src/renderer/components/MilkdownEditor.tsx', 'utf8');

test('RW-28① 笔记阅读分支不再渲染 <pre> 源码（knowledge-view 退役）', () => {
  assert.doesNotMatch(page, /data-testid:\s*'knowledge-view'/, 'knowledge-view 源码视图必须退役');
  // Phase B 起文本附件预览合法使用 <pre>（不是 Markdown 源码）——只对笔记阅读分支断言。
  const readStart = page.indexOf("'data-testid': 'knowledge-readonly'");
  assert.ok(readStart > 0, '阅读容器 testid 必须在场');
  assert.doesNotMatch(page.slice(readStart), /createElement\('pre'/, '笔记阅读分支不得用 <pre> 渲染源码');
});

test('RW-28② 阅读态复用 Crepe 渲染器（readOnly）', () => {
  assert.match(page, /'data-testid':\s*'knowledge-readonly'/, '阅读容器 testid');
  assert.match(page, /readOnly:\s*true/, '必须传 readOnly');
  assert.match(editor, /setReadonly\?\.\(true\)/, 'Crepe 只读化');
  assert.match(editor, /'data-readonly':\s*readOnly/, '只读标记可取证');
});

test('RW-28③ 阅读态渲染失败不退回裸源码（显式报错）', () => {
  assert.match(editor, /milkdown-readonly-failed/, '只读失败要有显式报错节点');
  // 失败分支（readOnly 与编辑态共用）不得渲染 textarea；全文件也不存在 createElement('textarea')。
  assert.doesNotMatch(editor, /createElement\('textarea'/, '失败分支不得渲染 textarea（源码）');
  const failedStart = editor.indexOf('if (failed) {');
  assert.ok(failedStart > 0, '失败分支必须在场');
  const failedBlock = editor.slice(failedStart, failedStart + 2500);
  assert.match(failedBlock, /readOnly \? 'milkdown-readonly-failed'/, '只读失败节点由 readOnly 分支决定');
});

test('RW-28④ 全仓无「查看源码」入口（老板口径：任何状态都不显示源码）', () => {
  const files = [
    'src/renderer/components/KnowledgePage.tsx',
    'src/renderer/components/MilkdownEditor.tsx',
    'src/renderer/components/TaskDetail.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /查看源码/, `${f} 不得提供查看源码入口`);
  }
});
