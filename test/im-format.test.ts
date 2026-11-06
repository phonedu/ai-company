import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, formatCardText } from '../src/main/im/format.js';

test('IM 卡片降级：批准卡带完整选项与回复提示', () => {
  const text = formatCardText(
    'ask',
    JSON.stringify({
      card: 'approval',
      title: '等你批准：T-1042 的计划',
      question: '批准计划？',
      options: [
        { key: 'approve', label: '批准（推荐）', recommended: true },
        { key: 'revise', label: '打回，改计划' },
      ],
    }),
  );
  assert.match(text, /【等你批准】T-1042/);
  assert.match(text, /1\) 批准（推荐）/);
  assert.match(text, /2\) 打回，改计划/);
  assert.match(text, /回复 1\/2/);
});

test('IM 卡片降级：完成卡带摘要，不摆空态', () => {
  const text = formatCardText('report', JSON.stringify({ card: 'report', title: '完成：T-1042 竞品简报', summary: '已产出 1 页简报。' }));
  assert.match(text, /【完成】T-1042/);
  assert.match(text, /已产出 1 页简报/);
  assert.match(text, /详情见桌面/);
});

test('IM 卡片降级：权限卡有 【权限请求】 与 1/2 选项（不再伪装成异常）', () => {
  const text = formatCardText(
    'ask',
    JSON.stringify({
      card: 'permission',
      title: '权限请求：mcp_call',
      question: '[权限] 会话工具 mcp_call（consent:external）[sess-1]',
      options: [
        { key: 'approve', label: '批准一次' },
        { key: 'deny', label: '拒绝' },
      ],
    }),
  );
  assert.match(text, /【权限请求】/);
  assert.match(text, /1\) 批准一次/);
  assert.match(text, /2\) 拒绝/);
  assert.match(text, /回复 1\/2/);
});

test('IM 卡片降级：无选项决策卡明确指路，不诱导无效回复', () => {
  const text = formatCardText('ask', JSON.stringify({ card: 'decision', title: '等你决策：T-1042', question: '要重试吗？' }));
  assert.match(text, /没有预设选项/);
  assert.doesNotMatch(text, /回复 1\/2/);
});

test('IM 卡片降级：完成卡带验证结论与批注', () => {
  const text = formatCardText(
    'report',
    JSON.stringify({ card: 'report', title: '完成：T-1042', verdict: 'pass', notes: '文档检查通过' }),
  );
  assert.match(text, /结论：通过/);
  assert.match(text, /文档检查通过/);
});

test('IM 文本切块：每块不超上限，且不丢内容', () => {
  const text = `${'甲'.repeat(50)}\n${'乙'.repeat(50)}\n${'丙'.repeat(50)}`;
  const chunks = chunkText(text, 60);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 60, `块长 ${chunk.length} > 60`);
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
});
