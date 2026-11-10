/**
 * 间距刻度门（2026-10-17 逐页审查批；老板「按钮之间 / 卡片之间的距离感觉都是乱弄的」）——判据：
 *   ① 全仓 `gap:` 只用设计件 `design-ui-system §3` 的 **4 的倍数**（4/8/12/16/20/24/32；0 允许），
 *      不允许 2/3/5/6/7/9/10/11/13/14/15 之类杂值再回潮；
 *   ② 页面容器内边距＝20（设计件：中栏内边距 20）——五页＋项目树/归档/工位；
 *   ③ 待我处理卡片**不得再有左色条**（2026-10-17 要求「卡片左边那条绿竖线去掉」）。
 *
 * 改动提示：确实需要新间距常量时，先改设计件 §3 的 7 档再改本门——不要只改实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCALE = new Set([0, 4, 8, 12, 16, 20, 24, 32]);

function rendererFiles(): string[] {
  const out: string[] = ['src/renderer/styles.css'];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx')) out.push(path);
    }
  };
  walk('src/renderer/components');
  return out;
}

test('间距刻度：全仓 gap 只用 4 的倍数（设计件 §3 的 7 档）', () => {
  const bad: string[] = [];
  for (const file of rendererFiles()) {
    const text = readFileSync(file, 'utf8');
    // CSS 的 `gap: 10px;` 与内联样式的 `gap: 10,` / `gap: 10 }` 两种形态都收。
    for (const match of text.matchAll(/\bgap:\s*(\d+)(?:px)?\s*[;,\n}]/g)) {
      const value = Number(match[1]);
      if (!SCALE.has(value)) bad.push(`${file}: gap ${value}`);
    }
  }
  assert.deepEqual(bad, [], `发现不在 4 倍数刻度上的 gap：\n${bad.join('\n')}`);
});

test('页面容器内边距＝20（中栏统一；left/right rail 同为 20）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start > -1, `缺规则 ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
  };
  for (const selector of ['.hall', '.inbox-view', '.project-view', '.employee-view', '.tlist', '.right-rail']) {
    assert.match(rule(selector), /padding:\s*20px;/, `${selector} 的页内边距应为 20px`);
  }
});

test('待我处理卡片：无左侧色条（老板 2026-10-17「绿色竖线去掉」）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const inboxRow = css.slice(css.indexOf('\n.inbox-row {'), css.indexOf('}', css.indexOf('\n.inbox-row {')) + 1);
  assert.equal(/border-left-width/.test(inboxRow), false, '.inbox-row 不得再带加宽的左边框');
  assert.equal(/\.inbox-row\[data-kind='ask'\]\s*\{\s*border-left-color/.test(css), false, '语义左色条已撤');
});
