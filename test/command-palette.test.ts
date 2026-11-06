/**
 * 命令面板落地批（2026-10-18，老板令「就落地吧」）——判据：
 *   ① 纯过滤 `paletteResults`：大小写不敏感；空查询＝空结果（不刷屏）；短号/标题/消息正文命中；
 *      每组上限；总数＝0 ⇒ 面板显「没有匹配」；
 *   ② 面板（纯展示）：关闭不渲染；空查询提示行；`↑↓/Enter/Esc` 键位在场；组题＝任务/消息；
 *      脚注＝「产物搜索随索引件」（数据面如实）；
 *   ③ 源码守门：壳挂 Ctrl K＋搜索盒可点；选中＝任务→详情、消息→频道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { CommandPalette } from '../src/renderer/components/CommandPalette.js';
import { paletteResults } from '../src/renderer/components/paletteModel.js';

const TASKS = [
  { id: 1, shortId: 'T-1001', title: '写周报' },
  { id: 2, shortId: 'T-1002', title: '对账脚本调研' },
  { id: 3, shortId: null, title: '官网改版' },
];
const MESSAGES = [
  { id: 11, content: '这两张表字段对不上，看下附件' },
  { id: 12, content: '已受理 T-1002（记账系统）' },
];

test('纯过滤：命中短号/标题/消息；大小写不敏感；空查询＝空（不刷屏）', () => {
  const byShort = paletteResults('t-1001', TASKS, MESSAGES);
  assert.equal(byShort.tasks.length, 1);
  assert.equal(byShort.tasks[0]!.label, 'T-1001 · 写周报');

  const byTitle = paletteResults('对账', TASKS, MESSAGES);
  assert.equal(byTitle.tasks.length, 1);
  assert.equal(byTitle.tasks[0]!.id, 2);
  assert.equal(byTitle.messages.length, 0, '「对账」不在消息正文 ⇒ 消息组不硬凑');

  const both = paletteResults('T-1002', TASKS, MESSAGES);
  assert.equal(both.tasks.length, 1, '短号命中任务');
  assert.equal(both.messages.length, 1, '消息正文里的 T-1002 也命中');
  assert.equal(both.total, 2);

  const noShort = paletteResults('#3', TASKS, MESSAGES);
  assert.equal(noShort.tasks[0]!.id, 3, '短号缺失回落 #id 可搜');

  const empty = paletteResults('   ', TASKS, MESSAGES);
  assert.deepEqual({ t: empty.tasks.length, m: empty.messages.length, n: empty.total }, { t: 0, m: 0, n: 0 });
});

test('无命中 ⇒ total=0（面板显「没有匹配」）；每组上限 6', () => {
  const none = paletteResults('不存在的东西', TASKS, MESSAGES);
  assert.equal(none.total, 0);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, shortId: `T-20${i}`, title: '项目文档整理' }));
  assert.equal(paletteResults('文档', many, []).tasks.length, 6, '每组至多 6 条');
});

test('面板渲染：关闭不渲染；空查询提示；无命中空态；有结果＝组题＋行＋脚注（产物随索引件）', () => {
  const base = { results: paletteResults('', TASKS, MESSAGES), onQueryChange: () => {}, onPick: () => {}, onClose: () => {} };
  assert.equal(renderToStaticMarkup(createElement(CommandPalette, { ...base, open: false, query: '' })), '');

  const hint = renderToStaticMarkup(createElement(CommandPalette, { ...base, open: true, query: '' }));
  assert.match(hint, /data-testid="palette-hint"/);

  const miss = renderToStaticMarkup(
    createElement(CommandPalette, { ...base, open: true, query: 'zzz', results: paletteResults('zzz', TASKS, MESSAGES) }),
  );
  assert.match(miss, /data-testid="palette-empty"[^>]*>没有匹配/);

  const hit = renderToStaticMarkup(
    createElement(CommandPalette, { ...base, open: true, query: 'T-1002', results: paletteResults('T-1002', TASKS, MESSAGES) }),
  );
  assert.match(hit, /data-testid="palette-group-task"/);
  assert.match(hit, /data-testid="palette-group-message"/);
  assert.match(hit, /data-testid="palette-row"[^>]*data-kind="task"[^>]*data-active="true"/, '首行默认选中');
  assert.match(hit, /↑↓ 选择 · Enter 打开 · Esc 关闭/, '操作提示在场');
  assert.equal(hit.includes('全局组＝跨项目'), false, '内部术语不再上屏');
});

test('M2 尾 G-D：跨项目结果按任务/消息/产物分组可搜可显；选中带 taskId', () => {
  const global = {
    tasks: [{ id: 7, shortId: 'T-2001', title: '跨项目任务', projectName: '甲项目' }],
    messages: [{ id: 21, taskId: 7, content: '跨项目消息正文', projectName: '甲项目' }],
    artifacts: [{ id: 31, taskId: 7, path: 'docs/跨项目报告.md', projectName: '甲项目' }],
  };
  const res = paletteResults('跨项目', TASKS, MESSAGES, global);
  assert.equal(res.global.length, 3, '任务/消息/产物各一条');
  assert.equal(res.global.every((g) => g.taskId === 7), true, '全局结果可定位到任务');
  const artifactHit = res.global.find((g) => g.source === 'artifact');
  assert.equal(artifactHit?.artifactId, 31, 'UG-05：产物命中保留真实 artifactId（选中后开预览）');
  const html = renderToStaticMarkup(
    createElement(CommandPalette, {
      open: true,
      query: '跨项目',
      results: res,
      onQueryChange: () => {},
      onPick: () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /data-testid="palette-group-task"/);
  assert.match(html, /data-testid="palette-group-message"/);
  assert.match(html, /data-testid="palette-group-artifact"/);
  assert.match(html, /docs\/跨项目报告\.md · 甲项目/);
  assert.equal(html.includes('[产物]'), false, '不再用方括号前缀冒充分组');
  assert.equal(paletteResults('跨项目', TASKS, MESSAGES, null).global.length, 0, '未接全局搜索 → 不摆假分组');
});

test('源码守门：Ctrl K 挂壳（防默认行为）；搜索盒可点；选中＝任务→详情 / 消息→频道', () => {
  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.ok(shell.includes("event.ctrlKey || event.metaKey"), 'Ctrl K 挂载');
  assert.ok(shell.includes('event.preventDefault()'), '防浏览器默认行为');
  assert.ok(shell.includes('openTaskDetail(item.id)'), '任务命中 → 详情');
  assert.ok(shell.includes('showChannel()'), '消息命中 → 频道');
  assert.ok(shell.includes('paletteResults('), '过滤走纯函数');
  assert.ok(shell.includes('searchGlobal'), 'M2 尾：全局搜索已接线（G-D）');
  assert.ok(shell.includes("item.kind === 'global'"), '全局结果有选中分支');
  const panel = readFileSync('src/renderer/components/CommandPalette.tsx', 'utf8');
  assert.match(panel, /placeholder="搜索任务 \/ 产物 \/ 消息…"/, '占位写明任务/产物/消息');
});
