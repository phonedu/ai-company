/**
 * RW-20 回归守卫（M5 真实项目测试 S9 批，2026-10-28）：频道范围唯一真源＝settings。
 *
 * 缺陷：范围选择器只走「UI→settings」单程写（setChannelScope/showProject 落库
 * `channel.scope_project_id`），启动装载（restoreSession）不回读——启动期默认 null 的
 * 会话态经 persistSession 反写 localStorage，UI 显示「公司（全部项目）」而库里仍是项目 id：
 * 主进程 note_write 等按 settings 落 review-site，老板看到的却是公司范围（口径分叉）。
 *
 * 判据（源码层守卫，仿 company-hall.test.ts）：restoreSession 函数体内必须回读
 * `channel.scope_project_id`；setChannelScope／showProject 必须写库（既有接线不许退化）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storeSrc = readFileSync('src/renderer/store.ts', 'utf8');

function functionBody(src: string, marker: string, len = 2400): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `找不到 ${marker}`);
  return src.slice(i, i + len);
}

test('RW-20① restoreSession 启动回读 channel.scope_project_id', () => {
  // 切片止于下一个导出函数，防止越过函数尾误配后续接线（vacuous pass）
  const from = storeSrc.indexOf('export async function restoreSession');
  const to = storeSrc.indexOf('export function showNotes');
  assert.ok(from >= 0 && to > from, '找不到 restoreSession／showNotes 边界');
  const body = storeSrc.slice(from, to);
  assert.match(body, /channel\.scope_project_id/);
});

test('RW-20② setChannelScope／showProject 写库接线仍在（不许退化成只改内存）', () => {
  const a = functionBody(storeSrc, 'export function setChannelScope', 700);
  assert.match(a, /channel\.scope_project_id/);
  const b = functionBody(storeSrc, 'export function showProject', 700);
  assert.match(b, /channel\.scope_project_id/);
});
