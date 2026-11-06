/**
 * M4-C 体验打磨的代码锚（C-1/C-2/C-3/C-4）：
 *  - C-1 字体/字阶：Noto Sans SC 资产＋OFL 记录＋字阶 token；
 *  - C-2 折叠：大厅活动流默认 8 条＋展开/收起＋显示读数；
 *  - C-3 夜间：暗色令牌块在场；不再有裸 `color: #fff`（收编到 `--on-accent`）；
 *  - C-4 四态：待我处理首载/失败/空态可辨，不把加载中伪装成“没有事”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const styles = readFileSync('src/renderer/styles.css', 'utf8');
const hall = readFileSync('src/renderer/components/CompanyHallView.tsx', 'utf8');
const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');

test('C-1 字体/字阶：Noto Sans SC 资产、OFL 记录、字阶 token 在场（系统字体优先，Noto 兜底）', () => {
  const dir = 'src/renderer/assets/noto-sans-sc';
  assert.ok(existsSync(join(dir, 'NOTICE.md')), '字体 NOTICE 必须在');
  const notice = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
  assert.match(notice, /SIL Open Font License/);
  assert.match(notice, /Coverage/);
  const woff2 = readdirSync(dir).filter((f) => f.endsWith('.woff2'));
  assert.ok(woff2.length > 0, '字体子集必须随仓库');
  const bytes = woff2.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  assert.ok(bytes > 100_000, `字体资产异常偏小：${bytes}`);
  assert.match(styles, /font:\s*15px\/1\.5 system-ui,[\s\S]*?"Noto Sans SC", sans-serif/);
  for (const token of ['--text-micro', '--text-meta', '--text-body', '--text-section', '--text-title', '--text-display']) {
    assert.ok(styles.includes(token), `缺字阶 token ${token}`);
  }
});

test('C-2 大厅活动流：默认 8 条＋显示读数＋展开/收起（不统一全站密度）', () => {
  assert.match(hall, /activityAll\.slice\(0, 8\)/);
  assert.match(hall, /activityExpanded/);
  assert.match(hall, /hall-activity-more/);
  assert.match(hall, /显示 \{activityShown\.length\}\/\{activityAll\.length\} 条/);
  assert.match(hall, /activityExpanded \? '收起' : `展开全部/);
});

test('C-3 夜间/令牌：暗色块在场；裸 #fff 已收编到 --on-accent', () => {
  assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
  // 老板 2026-10-28 真机：深色中间区纯黑过生硬 → --bg 改近黑 #101013（令牌守卫同步）
  assert.match(styles, /--bg:\s*#16161a/);
  assert.match(styles, /--panel:\s*#202024/, 'S13-F F2：深色面板提亮');
  assert.match(styles, /--text:\s*#ffffff/);
  assert.equal(/color:\s*#fff\b/i.test(styles), false, '不应再有裸 color: #fff');
  assert.match(styles, /color:\s*var\(--on-accent\)/);
});

test('C-4 待我处理四态：首载/失败/空态可辨；加载中不显示假空态', () => {
  assert.match(store, /loading: false,/);
  assert.match(store, /error: null as string \| null/);
  assert.match(store, /cards\.loading = true/);
  assert.match(store, /cards\.error =/);
  assert.match(inbox, /inbox-loading/);
  assert.match(inbox, /inbox-error/);
  assert.match(inbox, /inbox-empty/);
  assert.match(inbox, /initialLoading/);
  assert.match(inbox, /cardsSnap\.error \? null :/);
});
