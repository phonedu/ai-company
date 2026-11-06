/**
 * S13-D 一致性：选项按钮不得重复「（推荐）」后缀（真机见「按评审意见再改（推荐）（推荐）」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const f of ['src/renderer/components/Card.tsx', 'src/renderer/components/InboxView.tsx']) {
  test(`${f} 推荐后缀去重`, () => {
    const src = readFileSync(f, 'utf8');
    const appends = [...src.matchAll(/option\.recommended[^\n]*'（推荐）'/g)].map((m) => m[0]);
    assert.ok(appends.length > 0, '应有推荐后缀渲染');
    for (const a of appends) assert.match(a, /includes\('（推荐）'\)/, '追加前必须检查标签是否已含推荐后缀');
  });
}
