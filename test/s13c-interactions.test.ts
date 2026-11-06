/**
 * S13-C 交互专项守卫（2026-10-28 真机）：
 * ① 新建笔记弹层必须支持 Esc 关闭（与建任务弹层一致）；
 * ② 频道底部跟随：程序化钉底后显式回到 atBottom，防长回复排版把状态打掉后失跟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const knowledge = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const channel = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');

test('S13-C① 新建笔记弹层 Esc 关闭', () => {
  assert.match(knowledge, /if \(event\.key === 'Escape'\) setCreating\(false\)/, '缺少 Esc 处理');
  assert.match(knowledge, /document\.addEventListener\('keydown', onKey\)/, '需挂 keydown');
});

test('S13-C② 钉底后重置 atBottom（长回复不失跟）', () => {
  const pins = [...channel.matchAll(/stream\.scrollTop = stream\.scrollHeight;\s*\n\s*atBottomRef\.current = true;/g)];
  assert.ok(pins.length >= 2, `两处钉底（items 变化 + MutationObserver）都要重置 atBottom，实际 ${pins.length}`);
});
