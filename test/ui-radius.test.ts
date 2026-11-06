/**
 * 圆角收编门（2026-10-22 第二轮）：所有组件圆角必须走 `--radius-*` 令牌。
 *
 * 背景：第一轮 Cupertino 化后，仓库仍残留 6/8/12/18/999 的裸圆角与内联
 * `borderRadius: 6`，同一个按钮/输入在不同页面会出现不同圆角。本门把
 * 「圆角只用令牌」变成会红的断言。
 *
 * 允许：
 *   - `var(--radius-sm|md|lg|xl|pill|bubble|inner)`
 *   - `50%`（圆点 / 头像）、`0`、`inherit` / `unset`
 * 禁止：任何裸 px 或数字圆角（含 `border-top-left-radius` 等单角写法）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/renderer';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(css|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const radiusDecl = /border(?:-(?:top|bottom|left|right))?(?:-(?:left|right))?-radius\s*:\s*([^;}\n]+)/g;
const inlineDecl = /borderRadius\s*:\s*([^,}\n]+)/g;

function allowed(value: string): boolean {
  const v = value.trim().replace(/^['"]|['"]$/g, '');
  return v === '0' || v === '50%' || v === 'inherit' || v === 'unset' || v.startsWith('var(--radius-');
}

test('圆角只用 --radius-* 令牌（禁止裸 px / 数字）', () => {
  const raw: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(radiusDecl)) {
      if (!allowed(m[1])) raw.push(`${file}: ${m[1].trim()}`);
    }
    for (const m of text.matchAll(inlineDecl)) {
      if (!allowed(m[1])) raw.push(`${file}: borderRadius ${m[1].trim()}`);
    }
  }
  assert.deepEqual(raw, [], `发现裸圆角（请改用 var(--radius-*）)：\n${raw.join('\n')}`);
});

test('圆角令牌齐全（6/10/14/20/999 + bubble/inner）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  for (const name of [
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-pill',
    '--radius-bubble',
    '--radius-inner',
  ]) {
    assert.match(css, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`), `缺令牌 ${name}`);
  }
});
