/**
 * 2026-10-25 老板反馈：
 *  - 老板频道「＋建任务」必须能在对话框里选择软件内项目（不再只能默认项目）；
 *  - 待验收卡可批量标记已阅，但只处理 report，不动决策/异常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dialog = readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8');
const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('建任务对话框：有项目选择器；列未归档项目；提交用选中项目', () => {
  assert.match(dialog, /data-testid="taskdlg-project-select"/, '缺项目选择器');
  assert.match(dialog, /loadProjectsForOverview/, '对话框必须拉项目列表');
  assert.match(dialog, /p\.archived === 0/, '只列未归档项目');
  assert.match(dialog, /selectedProjectId/, '项目状态必须可选择');
  assert.match(dialog, /projectId: selectedProjectId/, '提交必须用选中的项目');
  assert.match(dialog, /默认项目（设置 · 项目里可改）/, '默认项目选项必须在');
});

test('待验收卡：有批量标记已阅；只针对 report；逐张 ack 后统一刷新', () => {
  assert.match(inbox, /data-testid="inbox-ack-all"/, '缺批量标记已阅入口');
  assert.match(inbox, /acknowledgeCards\(reportTargets\)/, '批量动作必须只传 report 目标');
  assert.match(inbox, /card\.state === 'pending' \|\| card\.state === 'delivered'/, '只处理待处理/待阅卡');
  // 2026-11-04 老板：频道解决决策后卡不清——「全部清除」兜底（含决策/异常/通知，确认后逐张 ack）
  assert.match(inbox, /data-testid="inbox-clear-all"/, '缺全部清除入口');
  assert.match(inbox, /acknowledgeCards\(allTargets\)/, '全部清除必须覆盖所有待办卡');
  assert.match(inbox, /const allTargets = entries/, '全部清除目标＝全部待办条目');
  assert.match(inbox, /确定清除全部/, '全部清除必须先确认');
  assert.match(inbox, /卡片消失≠已解决/, '决策后果必须如实提示');
  assert.match(store, /export async function acknowledgeCards/, '缺批量 ack 实现');
  assert.match(store, /api\.inbox\.answer\(\{ id: card\.id, answer: 'ack' \}\)/, '批量 ack 必须走同一条后端动作');
  assert.match(css, /\.inbox-ack-all\s*\{/, '缺批量按钮样式');
});
