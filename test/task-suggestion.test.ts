/**
 * B-7（M4）· N5 建议档：项目默认档优先；无默认档才启发式；不覆盖手选。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { suggestTaskTier, taskRiskTierLabel } from '../src/renderer/components/taskSuggestion.js';

test('B-7：项目默认档优先（0/1/2 都认）；理由明说来源', () => {
  for (const tier of [0, 1, 2] as const) {
    const s = suggestTaskTier({ goal: '随便写点什么', projectDefaultTier: tier });
    assert.equal(s.tier, tier);
    assert.equal(s.source, 'project-default');
    assert.match(s.reason, /项目默认档/);
  }
  assert.equal(suggestTaskTier({ goal: '发布上线', projectDefaultTier: 0 }).tier, 0, '项目默认档不被目标关键词改掉');
});

test('B-7：无项目默认档 → 启发式（高风险 L2 / 只读整理 L0 / 常规 L1）', () => {
  assert.equal(suggestTaskTier({ goal: '把服务发布上线并删除旧数据', projectDefaultTier: null }).tier, 2);
  assert.equal(suggestTaskTier({ goal: '整理一下竞品动态，写个简报', projectDefaultTier: null }).tier, 0);
  assert.equal(suggestTaskTier({ goal: '实现一个导出功能', projectDefaultTier: null }).tier, 1);
  assert.equal(taskRiskTierLabel(0), '直接执行');
  assert.equal(taskRiskTierLabel(1), '先审计划');
  assert.equal(taskRiskTierLabel(2), '全流程（严格）');
});

test('B-7 接线：对话框显示建议/采用按钮；手选标记参与预填不覆盖', () => {
  const dialog = readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8');
  assert.match(dialog, /data-testid="taskdlg-suggestion"/);
  assert.match(dialog, /data-testid="taskdlg-adopt-suggestion"/);
  assert.match(dialog, /suggestTaskTier\(/);
  assert.match(dialog, /if \(!prefill \|\| tierTouched\) return;/, '手选后不再自动预填');
  assert.match(dialog, /setTierTouched\(true\);\s*setRiskLevel\(suggestion\.tier\)/s, '采用建议是显式用户动作');
});
