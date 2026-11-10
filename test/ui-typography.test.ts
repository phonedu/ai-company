/**
 * 排版节奏门（2026-10-22 要求：「文字的间距、段落之间的间距和排版要重规划，
 * 反正各个页面都是不同的数据」）。
 *
 * 判据（按内容形态分四类，不搞全站一个值）：
 *   ① 长文：15/1.7、段间 8px、行宽 ≤64ch；段落由 `ProseText` 按空行切分
 *      （纯文本仍保留段内换行，不解析 markdown/HTML）；
 *   ② 概览卡：区块标题 15/600 主色，说明 12/1.65 次色，块内 8、卡间 12、页区块 16；
 *   ③ 列表：行 15、元信息 12（元信息不得升格为说明正文）；
 *   ④ 空态：标题 15/600、说明 12/1.65，内边距 4，不再用 17 标题＋大片 padding 撑空。
 *
 * 有牙：`ProseText` 对双换行必须切两段；单换行不得误切。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProseText } from '../src/renderer/components/ProseText.js';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');

function rule(source: string, selector: string): string {
  // 取**最后一条**同名规则：排版重规划块追加在文件尾部，靠级联覆盖旧值。
  const start = source.lastIndexOf(`\n${selector} {`);
  assert.ok(start > -1, `缺规则 ${selector}`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('节奏令牌：--text-note / --leading-prose / --para-gap / --measure 在场', () => {
  for (const token of ['--text-note', '--leading-title', '--leading-ui', '--leading-prose', '--para-gap', '--measure']) {
    assert.match(css, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`), `缺令牌 ${token}`);
  }
  assert.match(css, /--text-note:\s*12px/, '字阶收口后说明文字并入 12（20/15/12 三档）');
  assert.match(css, /--leading-prose:\s*1\.7/, '长文行高应为 1.7');
  assert.match(css, /--para-gap:\s*8px/, '段间距应为 8');
  assert.match(css, /--measure:\s*64ch/, '长文行宽应 ≤64ch');
});

test('ProseText：空行切段（双换行两段、单换行一段），保留纯文本不解析', () => {
  const two = renderToStaticMarkup(createElement(ProseText, { text: '第一段。\n\n第二段。' }));
  assert.equal((two.match(/class="prose__p"/g) ?? []).length, 2, '双换行必须切成两段');
  assert.match(two, /第一段。/);
  assert.match(two, /第二段。/);

  const one = renderToStaticMarkup(createElement(ProseText, { text: '第一行\n第二行' }));
  assert.equal((one.match(/class="prose__p"/g) ?? []).length, 1, '单换行是段内换行，不得误切成两段');

  const empty = renderToStaticMarkup(createElement(ProseText, { text: ' \n\n ' }));
  assert.equal(empty, '', '空文本不渲染空壳');
});

test('长文样式：prose 15/1.7、段间 8、行宽 64ch；频道气泡与卡片正文走同一套', () => {
  const prose = rule(css, '.prose');
  assert.match(prose, /font-size:\s*var\(--text-body\)/);
  assert.match(prose, /line-height:\s*var\(--leading-prose\)/);
  const gap = rule(css, '.prose__p + .prose__p');
  assert.match(gap, /margin-top:\s*var\(--para-gap\)/);
  assert.match(rule(css, '.bubble__content'), /max-width:\s*var\(--measure\)/);
  assert.match(css, /\.card__tldr,\s*\.card__summary\s*\{[^}]*line-height:\s*var\(--leading-prose\)/s);
  assert.match(rule(css, '.card__notes'), /font-size:\s*var\(--text-note\)/);
});

test('概览卡：区块标题 15/600 主色；说明 12/1.65；块间距 12', () => {
  for (const selector of ['.project-view__state-title', '.employee-view__grid h3']) {
    const r = rule(css, selector);
    assert.match(r, /font-size:\s*var\(--text-body\)/, `${selector} 标题应 15`);
    assert.match(r, /color:\s*var\(--text\)/, `${selector} 标题应用主色，不用 12 号 dim 冒充标题`);
  }
  const docs = rule(css, '.project-view__docs-text');
  assert.match(docs, /font-size:\s*var\(--text-note\)/);
  assert.match(docs, /line-height:\s*1\.65/);
  assert.match(rule(css, '.project-pane__card'), /gap:\s*12px/);
});

test('任务详情空态：标题 15/600、说明 12，不再用 17 标题＋大 padding 撑空', () => {
  assert.match(detail, /\.td__emptytitle\{font-size:var\(--text-body\);font-weight:600/);
  assert.match(detail, /\.td__empty\{[^}]*padding:4px 0/);
  assert.match(detail, /\.td__empty span\{font-size:var\(--text-note\)/);
});
