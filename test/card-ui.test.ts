/**
 * 卡片头部/可读性（2026-10-24 老板反馈）：
 *  - 无头像的卡片也要显示时间（HH:MM；悬停完整日期）；
 *  - 每张卡可折叠（默认展开；collapsed 时保留头部）；
 *  - 正文/批注/计划用 15px 正文档，时间/状态用 12px 元信息档。
 *
 * 说明：Card.tsx 依赖 store（renderer 图），node 测试直接 import 会拉入 web 侧
 * 模块解析；这里用纯函数 + 源码/样式守门（与既有 Card 测试同手法）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { formatCardClock } from '../src/renderer/components/cardCopy.js';

const AT = new Date(2026, 9, 24, 14, 31).getTime();
const cardSrc = readFileSync('src/renderer/components/Card.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('卡片时间：HH:MM；无有效时间用 —；头部已接线', () => {
  assert.equal(formatCardClock(AT), '14:31');
  assert.equal(formatCardClock(0), '—', '无有效时间不写假 0');
  assert.match(cardSrc, /data-testid="card-time"/, '卡片头必须有时间节点');
  assert.match(cardSrc, /formatCardClock\(card\.createdAt\)/, '时间必须取真实 createdAt');
  assert.match(cardSrc, /toLocaleString\('zh-CN'\)/, '悬停/标题给完整日期');
});

test('卡片折叠：默认展开；折叠后只保留头部；每张卡都有折叠按钮', () => {
  assert.match(cardSrc, /useState\(initialCollapsed\)/, '折叠状态由卡片持有');
  assert.match(cardSrc, /data-testid="card-collapse"/, '每张卡必须有折叠按钮');
  assert.match(cardSrc, /aria-expanded=\{!collapsed\}/, '折叠按钮必须有可访问状态');
  assert.match(cardSrc, /data-testid="card-body"/, '展开态正文容器');
  assert.match(cardSrc, /collapsed \? null :/, '折叠态不得渲染正文');
});

test('卡片可读性 CSS：正文 15px、时间 12px、折叠按钮样式在场', () => {
  assert.match(
    css,
    /\.card__notes,\s*\n\.card__plan,\s*\n\.card__planlist,\s*\n\.card__fallback\s*\{[^}]*font-size:\s*var\(--text-body\)/s,
    '批注/计划/fallback 必须用 15px 正文档',
  );
  assert.match(css, /\.card__time\s*\{[^}]*font-size:\s*var\(--text-meta\)/s, '时间用 12px 元信息档');
  assert.match(css, /\.card__collapse\s*\{[^}]*cursor:\s*pointer/s, '折叠按钮必须可点');
});
