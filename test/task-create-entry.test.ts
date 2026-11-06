/**
 * 建任务入口批（2026-10-17 老板「就按你的建议来」）——判据：
 *   ① 左栏＝**纯导航**（建任务区与任务列表均已退役；源码无 task-create 控件）；
 *   ② 两个上下文入口：频道 composer 旁「＋建任务」＋项目树页右栏页头「＋建任务」（预填项目）；
 *   ③ 对话框字段/校验：目标必填、档位/负责人/验收/预算；写入走 store.createTask（同一写入口径）；
 *   ④ store.createTask 透传 projectId（项目上下文建任务）；样式门在场。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');
const rail = read('src/renderer/components/LeftRail.tsx');
const composer = read('src/renderer/components/Composer.tsx');
const channel = read('src/renderer/components/BossChannel.tsx');
const project = read('src/renderer/components/ProjectOverview.tsx');
const dialog = read('src/renderer/components/TaskCreateDialog.tsx');
const store = read('src/renderer/store.ts');
const css = read('src/renderer/styles.css');

test('左栏＝纯导航：建任务区与任务列表均已退役', () => {
  assert.equal(rail.includes('task-create'), false, '左栏不再有建任务控件');
  assert.equal(rail.includes('left-rail__create'), false, '旧卡容器已撤');
  assert.ok(rail.includes('left-rail__nav'), '导航仍在');
  for (const id of [
    'leftrail-inbox',
    'leftrail-channel',
    'leftrail-hall',
    'leftrail-projects',
    'leftrail-archive',
    'leftrail-settings',
  ]) {
    assert.ok(rail.includes(id), `缺导航 ${id}`);
  }
});

test('频道入口：composer 旁「＋建任务」→ 对话框；成功回执一行', () => {
  assert.ok(composer.includes('data-testid="composer-new-task"'), '缺 composer 建任务按钮');
  assert.ok(composer.includes('onCreateTask'), '缺回调口');
  assert.ok(channel.includes('<TaskCreateDialog'), '频道未挂对话框');
  assert.ok(channel.includes('data-testid="channel-create-notice"'), '成功后缺回执行');
});

test('项目入口：项目树右栏页头「＋建任务」→ 对话框（预填当前项目）', () => {
  assert.ok(project.includes('data-testid="project-create-task"'), '缺项目页建任务按钮');
  assert.ok(project.includes('projectId={sessionSnap.selectedProjectId}'), '对话框未传项目');
  assert.ok(project.includes('data-testid="project-create-notice"'), '成功后缺回执行');
});

test('对话框：字段齐全；目标必填；Esc/遮罩可关；写入走 createTask', () => {
  for (const id of [
    'taskdlg-goal',
    'taskdlg-risk',
    'taskdlg-owner',
    'taskdlg-acceptance',
    'taskdlg-budget',
    'taskdlg-submit',
    'taskdlg-cancel',
    'taskdlg-error',
    'taskdlg-project',
    'taskdlg-project-select',
  ]) {
    assert.ok(dialog.includes(id), `缺 ${id}`);
  }
  assert.ok(dialog.includes('goal.trim().length === 0'), '目标必填（空稿禁用提交）');
  assert.ok(dialog.includes('createTask('), '写入走 store.createTask（单一写入口径）');
  assert.ok(dialog.includes('预算需为正整数 token'), '非法预算必须在对话框内报错，不能静默继承');
  assert.ok(dialog.includes('riskLevel') && dialog.includes('acceptance') && dialog.includes('budgetTokens'), '字段随提交');
  assert.ok(dialog.includes('projectId: selectedProjectId'), '项目上下文随选中项目提交');
  assert.ok(dialog.includes("event.key === 'Escape'"), 'Esc 关闭');
  assert.ok(dialog.includes('event.target === event.currentTarget'), '遮罩点击关闭');
});

test('store.createTask 透传 projectId；样式门在场', () => {
  assert.ok(store.includes('projectId?: number'), 'createTask 缺 projectId 入参');
  assert.ok(store.includes("typeof opts?.projectId === 'number' ? { projectId: opts.projectId }"), 'projectId 未透传');
  for (const sel of ['.composer__newtask', '.taskdlg-scrim', '.taskdlg', '.taskdlg__input', '.taskdlg__btn--primary', '.project-pane__btn--primary']) {
    assert.ok(css.includes(sel), `缺样式 ${sel}`);
  }
});
