/**
 * UI 体系 v1（2026-10-17 细节优化批）——令牌与交互状态的可执行锚。
 *
 * 断言：
 *   ① 字阶 / 圆角 / 动效 / 浮层阴影令牌在场（设计件 §3.2 的实现锚）；
 *   ② 全局 focus-visible / active / disabled 三件套有规则（键盘可辨、按压有反馈、禁用可辨）；
 *   ③ 浮层 240ms 进场 + `@starting-style`；
 *   ④ 滚动条收编为细轨 + 令牌色；
 *   ⑤ 浮层阴影只用 `--shadow-overlay`，旧硬编码不得回潮。
 *
 * 本门只锁“地基”；字阶/圆角的逐选择器收编由的扩门负责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');

const TOKENS = [
  'text-micro',
  'text-meta',
  'text-body',
  'text-section',
  'text-title',
  'text-display',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-pill',
  'motion-fast',
  'motion-slow',
  'ease-standard',
  'shadow-overlay',
] as const;

test('B1 令牌：字阶 / 圆角 / 动效 / 浮层阴影齐全', () => {
  for (const name of TOKENS) assert.match(css, new RegExp(`--${name}\\s*:`), `缺 --${name}`);
  assert.match(css, /--motion-fast:\s*120ms/, '--motion-fast 应为 120ms');
  assert.match(css, /--motion-slow:\s*300ms/, '--motion-slow 应为 300ms（Cupertino slow）');
  assert.match(
    css,
    /--ease-standard:\s*cubic-bezier\(\.25,\s*\.1,\s*\.25,\s*1\)/,
    '--ease-standard 应为 cubic-bezier(.25,.1,.25,1)（Cupertino standard）',
  );
});

test('B1 交互状态：focus-visible / active / disabled 三件套有规则（取最终生效规则）', () => {
  const focusRules = [...css.matchAll(/(?:button|input):focus-visible[^{]*\{([^}]*)\}/g)];
  const focus = focusRules.at(-1);
  assert.ok(focus, '缺 :focus-visible 规则');
  assert.match(focus[1], /outline:\s*3px solid var\(--accent\)/, '焦点环应使用 3px --accent（Cupertino tint ring）');
  assert.match(focus[1], /outline-offset:\s*[12]px/, '焦点环应有 offset');

  const activeRules = [...css.matchAll(/button:active:not\(:disabled\)\s*\{([^}]*)\}/g)];
  const active = activeRules.at(-1);
  assert.ok(active, '缺 button:active:not(:disabled) 规则');
  assert.match(active[1], /opacity:\s*\.72/, '按压反馈应为透明度 .72（Cupertino pressed）');

  const disabledRules = [...css.matchAll(/button:disabled\s*\{([^}]*)\}/g)];
  const disabled = disabledRules.at(-1);
  assert.ok(disabled, '缺 button:disabled 规则');
  assert.match(disabled[1], /opacity:\s*\.4/, '禁用态应有可辨透明度（Cupertino 40%）');
  assert.match(disabled[1], /cursor:\s*not-allowed/, '禁用态应为 not-allowed');
});

test('B1 浮层：240ms 进场 + @starting-style', () => {
  assert.match(css, /@starting-style\s*\{/, '浮层进场缺 @starting-style');
  assert.match(
    css,
    /\.palette[\s\S]*?transition:[^;]*var\(--motion-slow\)/,
    '命令面板进场应使用 --motion-slow',
  );
});

test('B1 滚动条：细轨 + 令牌色', () => {
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/, '滚动条 thumb 应使用 --border');
  assert.match(css, /scrollbar-color:\s*var\(--border\)\s+transparent/, '应设置 scrollbar-color 令牌色');
});

test('B1 阴影：只用 --shadow-overlay，旧硬编码不得回潮', () => {
  assert.match(css, /box-shadow:\s*var\(--shadow-overlay\)/, '浮层阴影应使用 --shadow-overlay');
  assert.equal(
    css.includes('0 10px 30px rgba(0, 0, 0, 0.12)'),
    false,
    '旧硬编码浮层阴影回潮：请改用 var(--shadow-overlay)',
  );
});

test('B3 字阶收编：全站 20/15/12 三档；无 raw 10/11px', () => {
  assert.equal(/font-size:\s*10px/.test(css), false, '不得再有 10px 字');
  assert.equal(/font-size:\s*11px/.test(css), false, '11px 只能走 --text-micro（禁止 raw 值）');
  assert.match(css, /--text-micro:\s*12px/);

  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at > -1, `缺规则 ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
  };
  for (const selector of [
    '.hall__title',
    '.tlist__title',
    '.employee-view__title',
    '.inbox-view__title',
    '.project-view__title',
    '.hall-page__title',
    '.taskdlg__title',
  ]) {
    assert.match(rule(selector), /font-size:\s*var\(--text-title\)/, `${selector} 应使用 --text-title`);
  }

  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /\.td__title\{font-size:var\(--text-title\)/, '任务标题应用 --text-title');
  assert.match(detail, /\.td__grouptitle\{[^}]*font-size:var\(--text-section\)/, '分组标题应用 --text-section');
});

test('B3 圆角收编：styles.css / TaskDetail 内联样式不再有 3/4/5/9/10px 散值', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  for (const source of [css, detail]) {
    assert.equal(/border-radius:\s*(3|4|5|9|10)px/.test(source), false, '仍有散圆角（3/4/5/9/10px）');
  }
});

test('B3 选中态：局部列表与通知浮层不再用绿色左条 + 决策卡推荐主按钮', () => {
  assert.equal(css.includes('inset 2px 0 0 var(--accent)'), false, '老板令：绿色左条已撤');
  assert.equal(
    /\.toast\s*\{[^}]*border-left:\s*3px solid var\(--accent-strong\)/s.test(css),
    false,
    '通知浮层不得再用绿色左竖线',
  );
  for (const selector of ['.settings-view__nav-item', '.projects-page__item', '.hall-row']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [...css.matchAll(new RegExp(`${escaped}\\[aria-current='page'\\][\\s\\S]*?\\{([^}]*)\\}`, 'g'))];
    assert.ok(rules.length > 0, `${selector} 缺选中态规则`);
    // 选中态必须有一条使用 Cupertino tint 底；深色主题可另有只改字色的覆盖规则（U-N02）。
    const tinted = rules.some((r) => /background:\s*var\(--tint-soft\)/.test(r[1]));
    assert.ok(tinted, `${selector} 选中态应使用 Cupertino tint 底`);
  }
  const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
  assert.match(card, /option\.recommended \? ' card__btn--primary'/, '频道决策卡推荐项应使用主按钮样式');
  assert.match(
    css,
    /\.card__options \.card__btn--primary\s*\{[^}]*background:\s*var\(--tint-soft\)/s,
    '决策推荐项应浅色选中，不与「去验收」抢实心主按钮',
  );
  const genui = readFileSync('src/renderer/components/genui/ControlledRenderer.tsx', 'utf8');
  assert.match(
    genui,
    /BTN_PRIMARY_STYLE[^;]*background:\s*'var\(--tint-soft\)'/s,
    'GenUI 卡片推荐项也应浅色选中',
  );
});
