/**
 * 编制 v1· 渲染侧口径（纯函数 ＋ 源码级结构守卫，repo 既有手法同 `task-create-entry`）。
 *
 * 口径（设计件 `docs/work/design-project-staffing.md` §4/§7）：
 *  - 未设置＝**显式**读法「未设置——按缺省链」（不臆造人名/档）；部分设置只把未设置项写「未设置」；
 *  - 概览「编制」卡＝只读摘要 ＋ 设置入口 ＋ 就地编辑三控件（负责人/默认执行员工/默认档）＋ 保存；
 *  - 建任务对话框（老板频道/项目树页两入口）＝编制·默认档/默认负责人预填（本任务可改）；**用户改过不回写**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STAFFING_TIER_LABEL,
  STAFFING_UNSET_TEXT,
  resolveStaffingProject,
  staffingFromProject,
  staffingSummary,
} from '../src/renderer/components/projectView.js';

const overview = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');

test('staffingFromProject：缺字段/坏值 → null（未设置，不臆造）；DTO 三字段如实取', () => {
  assert.deepEqual(staffingFromProject(null), { ownerEmployeeId: null, defaultEmployeeId: null, defaultRiskTier: null });
  assert.deepEqual(staffingFromProject({ defaultOwnerId: 7, defaultEmployeeIds: [9], defaultRiskTier: 1 }), {
    ownerEmployeeId: 7,
    defaultEmployeeId: 9,
    defaultRiskTier: 1,
  });
  assert.equal(staffingFromProject({ defaultRiskTier: 9 }).defaultRiskTier, null, '坏档位 → null（不回显、不臆造）');
  assert.equal(staffingFromProject({ defaultEmployeeIds: [] }).defaultEmployeeId, null);
  assert.equal(staffingFromProject(undefined).ownerEmployeeId, null);
});

test('预填落点（多项目，D4 复核补）：显式 B 胜默认 A；无显式只看 active 默认，不猜唯一项目', () => {
  const projects = [
    { id: 1, archived: 0, defaultOwnerId: 7, defaultRiskTier: 0 as const },
    { id: 2, archived: 0, defaultOwnerId: 9, defaultRiskTier: 2 as const },
  ];
  assert.deepEqual(resolveStaffingProject(projects, 2, 1), { projectId: 2, project: projects[1] });
  assert.deepEqual(resolveStaffingProject(projects, null, 1), { projectId: 1, project: projects[0] });
  assert.deepEqual(resolveStaffingProject([projects[0]], null, null), { projectId: null, project: null }, '无默认 + 唯一项目 → 不预填（主进程会新建默认项目）');
  assert.deepEqual(resolveStaffingProject([{ ...projects[0], archived: 1 }], null, 1), { projectId: null, project: null }, '默认项目已归档 → 不预填');
  assert.deepEqual(resolveStaffingProject(projects, null, null), { projectId: null, project: null }, '多个项目且无默认 → 不预填');
  assert.deepEqual(resolveStaffingProject([projects[0]], 2, 1), { projectId: 2, project: null }, '显式项目不在快照 → 交给 project:get 真读');
});

test('staffingSummary：全未设置＝显式「未设置——按项目默认」；部分设置只把未设置项写「未设置」', () => {
  const none = staffingSummary(staffingFromProject(null), () => '张三');
  assert.equal(none.unset, true);
  assert.equal(none.text, STAFFING_UNSET_TEXT);

  const part = staffingSummary({ ownerEmployeeId: 7, defaultEmployeeId: null, defaultRiskTier: 2 }, (id) =>
    id === 7 ? '小研' : null,
  );
  assert.equal(part.unset, false);
  assert.ok(part.text.includes('负责人：小研'));
  assert.ok(part.text.includes('默认执行：未设置'), '未设置项显式「未设置」');
  assert.ok(part.text.includes(`默认档：${STAFFING_TIER_LABEL[2]}`));

  const ghost = staffingSummary({ ownerEmployeeId: 42, defaultEmployeeId: null, defaultRiskTier: null }, () => null);
  assert.ok(ghost.text.includes('负责人：#42'), '查不到名字 → 如实 #id（不臆造）');
});

test('概览「编制」卡结构：摘要＋入口＋三控件＋保存（真源锚在场，缺即红）', () => {
  for (const anchor of [
    'project-staffing',
    'staffing-summary',
    'staffing-edit',
    'staffing-form',
    'staffing-owner',
    'staffing-default-employee',
    'staffing-tier',
    'staffing-save',
    'staffing-error',
  ]) {
    assert.ok(overview.includes(anchor), `ProjectOverview 缺 testid：${anchor}`);
  }
  assert.ok(overview.includes('staffingSummary('), '摘要走纯函数（唯一口径）');
  assert.ok(overview.includes('saveProjectStaffing('), '保存走 store 动作（写 project:staffing-set）');
});

test('建任务对话框（2026-10-17 入口迁移）：负责人控件＋编制预填（带"用户改过"守卫）＋提交随行 ownerId', () => {
  const dialog = readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8');
  assert.ok(dialog.includes('data-testid="taskdlg-owner"'), '对话框缺负责人控件');
  assert.ok(dialog.includes('loadStaffingDefaults(selectedProjectId)'), '对话框须按选中项目拉编制预填源（多项目不串）');
  assert.ok(dialog.includes('result.projectId !== selectedProjectId'), '对话框须校验预填结果属于选中项目（拒绝上一个项目残留）');
  assert.ok(dialog.includes('setPrefill(null)'), '切项目/重开须先清旧预填');
  assert.ok(dialog.includes('setRiskLevel(1)') && dialog.includes('setOwnerId(null)'), '切项目须重置档位/负责人');
  assert.ok(store.includes('resolveStaffingProject('), '预填源须走显式项目优先的纯口径');
  assert.ok(dialog.includes('tierTouched') && dialog.includes('ownerTouched'), '预填须带"用户改过"守卫（不被回写）');
  assert.ok(dialog.includes('ownerId != null ? { ownerId }'), '提交须随行 ownerId');
  assert.ok(store.includes('ownerId?: number'), 'store.createTask 须支持 ownerId');
  assert.ok(store.includes('saveProjectStaffing') && store.includes('staffingDefaults'), 'store 缺编制动作/预填源');
});
