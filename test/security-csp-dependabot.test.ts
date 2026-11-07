/**
 * B0-10 起步（58 §3.3）：CSP 收紧 + Dependabot 登记的守门。
 *
 * 口径：渲染层不需要任意 ws/wss（provider 调用在主进程）；仅开发 HMR 需要本机 ws。
 * 供应链更新走 Dependabot 周更；audit 硬门要等依赖升级落地后再加（不做假门）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync('src/renderer/index.html', 'utf8');

test('B0-10：渲染层 CSP 不再放行任意 ws/wss（只允许本机 HMR 端口）', () => {
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)?.[1] ?? '';
  assert.ok(csp.includes("default-src 'self'"), 'CSP 必须保留 default-src self');
  assert.ok(csp.includes('ws://localhost:*'), '开发 HMR 需要本机 ws');
  assert.ok(csp.includes('ws://127.0.0.1:*'));
  assert.equal(/(^|[\s;])ws:([\s;]|$)/.test(csp), false, '不得放行任意 ws: 源');
  assert.equal(/(^|[\s;])wss:([\s;]|$)/.test(csp), false, '不得放行任意 wss: 源');
});

test('B0-10：Dependabot 已登记（npm + github-actions，周更）', () => {
  const path = '.github/dependabot.yml';
  assert.ok(existsSync(path), '必须有 .github/dependabot.yml（供应链更新的唯一入口）');
  const yml = readFileSync(path, 'utf8');
  assert.match(yml, /package-ecosystem:\s*npm/);
  assert.match(yml, /package-ecosystem:\s*github-actions/);
  assert.match(yml, /interval:\s*weekly/);
});

test('B0-10：技能 URL 安装前必须出确认块（不静默安装）', () => {
  const pane = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
  assert.match(pane, /data-testid="settings-skill-url-confirm"/, '确认块必须存在');
  assert.match(pane, /data-testid="settings-skill-url-confirm-yes"/);
  assert.match(pane, /data-testid="settings-skill-url-confirm-cancel"/);
  assert.equal(
    /onClick=\{\(\) => props\.onInstallSkillUrl\?\./.test(pane),
    false,
    '「从 URL 安装」按钮不得直接安装（必须先确认）',
  );
});
