/**
 * 任务动作回执门（2026-10-23 真机抓到的回归）：
 * 合并/丢弃/回滚成功后，`openTaskDetail` 会按「换任务清旧回执」清空 notice；
 * 若之后不补回，界面状态已变（已合并/已回滚）却没有回执。真机配方曾因此失败。
 *
 * 判据：同一任务刷新（`await openTaskDetail(taskId)`）之后，必须再写一次本次回执。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = readFileSync('src/renderer/store.ts', 'utf8');

function bodyOf(name: string): string {
  const start = store.indexOf(`export async function ${name}(`);
  assert.ok(start > -1, `缺函数 ${name}`);
  const next = store.indexOf('\nexport async function ', start + 1);
  return store.slice(start, next === -1 ? store.length : next);
}

for (const [fn, notice] of [
  ['mergeTaskChangeset', 'mergeNotice'],
  ['discardTaskChangeset', 'discardNotice'],
  ['rollbackTaskChangeset', 'rollbackNotice'],
] as const) {
  test(`${fn}：刷新后回执不被清空`, () => {
    const body = bodyOf(fn);
    const reload = body.indexOf('await openTaskDetail(taskId)');
    assert.ok(reload > -1, `${fn} 应在成功后重载详情`);
    const after = body.indexOf(`taskDetail.${notice} = notice`, reload);
    assert.ok(after > reload, `${fn} 在 openTaskDetail 之后必须补回 ${notice}`);
  });
}
