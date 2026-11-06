/**
 * RW-11 加固守卫（M5 真机 S6 批登记的偶发缺陷，2026-10-28 收尾）：
 * 首启向导偶发「已完成还重弹」——`loadOnboarding` 读 `onboarding.completed` 失败时旧口径
 * 直接 `state='show'`（注释还写着「宁可多问一次」）＝已完成用户遇一次 IPC 抖动就被打回向导。
 *
 * 加固口径：读失败**重试一次**；仍失败保持 `unknown`（本启动不弹向导，下次启动自然再读）。
 * 只有**确证未完成**（读到 false）才弹向导。
 *
 * 判据（源码层守卫）：loadOnboarding 不得在 catch 里直接置 'show'；必须存在重试与 unknown 兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/renderer/store.ts', 'utf8');
const from = src.indexOf('export async function loadOnboarding');
const to = src.indexOf('export async function finishOnboarding');
assert.ok(from >= 0 && to > from, '找不到 loadOnboarding 边界');

test('RW-11① 读失败不得直接弹向导（catch 里不许置 show）', () => {
  const body = src.slice(from, to);
  // 旧实现的特征：catch 块里 onboarding.state = 'show'
  assert.doesNotMatch(body, /catch[\s\S]*?onboarding\.state = 'show'/, '读失败直接 show＝已完成用户被打回向导（RW-11）');
});

test('RW-11② 存在重试一次 + unknown 兜底', () => {
  const body = src.slice(from, to);
  assert.match(body, /completed === null.*readOnboardingCompleted|readOnboardingCompleted\(\)[\s\S]*?=== null/s, '读失败必须重试一次');
  assert.match(body, /'unknown'/, '仍失败保持 unknown（本启动不弹向导）');
  assert.match(body, /completed === false \? 'show'/, '只有确证未完成才弹向导');
});
