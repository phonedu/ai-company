/**
 * （真机带回，2026-10-27 老板指认）· 暂停入口位置问题。
 *
 * 真机事实：任务普遍 1–3 分钟完成，「暂停」只藏在任务详情页操作条——老板批准后还来不及
 * 切到详情页任务就 done 了，暂停功能实际上不可达（两批实测）。
 * 修复口径：**把暂停放到批准后第一眼的位置**——项目概览（项目树选中项目页）的执行中任务行
 * 直接给「暂停」按钮（paused 行给「恢复」），走既有 `task:transition` 通路（同归档按钮模式）。
 * 源锚定测试防漂移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const overviewSrc = readFileSync(join(root, 'src', 'renderer', 'components', 'ProjectOverview.tsx'), 'utf8');
const storeSrc = readFileSync(join(root, 'src', 'renderer', 'store.ts'), 'utf8');

test('RW-13①: 项目概览执行中任务行有「暂停」按钮（project-task-pause），paused 行有「恢复」', () => {
  assert.match(overviewSrc, /data-testid="project-task-pause"/, '暂停按钮 testid 必须在项目概览任务行');
  assert.match(overviewSrc, /data-testid="project-task-resume"/, '恢复按钮 testid 必须在项目概览任务行');
  assert.match(overviewSrc, /task\.state === 'executing'/, '暂停按钮必须挂在 executing 态');
  assert.match(overviewSrc, /task\.state === 'paused'/, '恢复按钮必须挂在 paused 态');
});

test('RW-13②: store 提供 pauseResumeTask（走 task:transition 通路，回执进 tasks.notice 不静默）', () => {
  assert.match(storeSrc, /export async function pauseResumeTask/, 'store 必须导出 pauseResumeTask');
  assert.match(storeSrc, /event: 'pause' \| 'resume'/, '通路限定 pause/resume 两种事件');
  assert.match(storeSrc, /api\.task\.transition\(\{ taskId, event \}\)/, '走既有 task:transition 通路（同归档按钮）');
  assert.match(storeSrc, /暂停失败：|恢复失败：/, '失败回执必须可见（不静默）');
});

test('RW-13③: 按钮语义提示在位（title 说明真中止与恢复语义）', () => {
  assert.match(overviewSrc, /员工会话真中止/, '暂停 title 必须说明真中止语义');
});
