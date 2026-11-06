/**
 * S13-E P1 第一批：C2 结束三选项、U-N05 阅读态隐藏编辑菜单、U-N03 主按钮对比度、U-N01/02 深色。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
const knowledge = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('C2 结束前有合并/保留/丢弃三选项；合并需等待成功', () => {
  for (const id of ['td-finish-merge', 'td-finish-keep', 'td-finish-discard', 'td-finish-cancel']) {
    assert.match(detail, new RegExp(id), `缺 ${id}`);
  }
  assert.match(detail, /action\.id === 'finish'[\s\S]{0,160}setFinishAction/, 'finish 需先弹选择');
  assert.match(view, /await mergeTaskChangeset/, '合并需可等待，成功后才结束');
});

test('U-N05 阅读态不渲染块把手/菜单', () => {
  assert.match(css, /\[data-testid='milkdown-readonly'\] \.milkdown-block-handle[\s\S]{0,120}display: none !important/);
});

test('U-N03 知识页主按钮用 accent-strong/on-accent（不得 accent+#fff）', () => {
  assert.doesNotMatch(knowledge, /background: 'var\(--accent\)', color: '#fff'/);
  assert.match(knowledge, /var\(--accent-strong\)', color: 'var\(--on-accent\)'/);
});

test('U-N01/02 深色选中态覆盖在场', () => {
  assert.match(css, /--3a3a3c|#3a3a3c/);
  assert.match(css, /\.left-rail__item\[aria-current='page'\][\s\S]{0,200}color: var\(--text\)/);
});
