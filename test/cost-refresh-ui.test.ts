/**
 * F-07（2026-10-24）：今日成本只在挂载时拉一次会让老板看到旧读数。
 * 守门：30s 轮询 + 回到前台立即刷新 + 卸载清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('成本读数：挂载后 30s 轮询、可见性恢复刷新、卸载清理', () => {
  const src = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.match(src, /const COST_REFRESH_MS = 30_000;/, '必须声明 30s 刷新间隔');
  assert.match(
    src,
    /setInterval\(\(\) => \{\s*void loadCostSummary\(\);\s*\}, COST_REFRESH_MS\)/s,
    '必须定时重拉 cost:summary',
  );
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisibility\)/, '回到前台必须刷新');
  assert.match(src, /window\.clearInterval\(costTimer\)/, '卸载时必须清理定时器');
});
