/**
 *  P2 批次 A（2026-10-29，老板「现在做 p2」）：
 * F-N12 日报口径、 项目第二读数、U-N10 输入宽度、U-N11 清 Key/删技能确认、
 * P-N02 Ctrl+1/2/3、F-N09 打回并列。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { taskStats } from '../src/renderer/components/projectView.js';
import { isExecutionRole } from '../src/main/engine/loop.js';
import type { TaskDTO } from '../src/renderer/types.js';

const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
const list = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
const settings = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
const view = readFileSync('src/renderer/components/SettingsView.tsx', 'utf8');
const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');

test('P2/D-N10：项目第二读数按状态派生，且与任务数同源', () => {
  const make = (state: string): TaskDTO => ({ state }) as TaskDTO;
  const stats = taskStats([make('executing'), make('planning'), make('needs_decision'), make('awaiting_approval'), make('failed'), make('done')] as TaskDTO[]);
  assert.deepEqual(stats, { runningCount: 2, waitingCount: 2, failedCount: 1 });
  assert.match(list, /runningCount \?\? 0/, '项目行必须渲染第二读数');
  assert.match(list, /待你处理 \$\{group\.waitingCount\}/);
});

test('P2/P-N02：Ctrl+1/2/3 接到频道/待我处理/大厅，输入区不抢键', () => {
  assert.match(shell, /event\.key === '1' \|\| event\.key === '2' \|\| event\.key === '3'/);
  assert.match(shell, /if \(event\.key === '1'\) showChannel\(\);/);
  assert.match(shell, /else if \(event\.key === '2'\) showInbox\(\);/);
  assert.match(shell, /else showHall\(\);/);
  assert.match(shell, /target\.tagName === 'INPUT' \|\| target\.tagName === 'TEXTAREA' \|\| target\.isContentEditable/);
});

test('P2/U-N11：清 Key 与删技能都有二次确认', () => {
  assert.match(view, /confirm\(`清除 \$\{provider\} 的本机 Key/);
  assert.match(view, /confirm\('删除该技能/);
});

test('P2/U-N10：公司日预算输入不再用会裁字的宽度', () => {
  assert.match(settings, /placeholder="未设置（如 5 = \$5\/日）"/);
  assert.match(settings, /style=\{\{ width: 220 \}\}/);
});

test('P2/F-N09：打回与主按钮并列，不再只在 ⋯ 里', () => {
  assert.match(detail, /inlineSecondaryIds = new Set\(\['revise', 'reject'\]\)/);
  assert.match(detail, /\{inlineSecondary\.map\(\(action\) => renderActionButton\(action\)\)\}/);
});

// ── 批次 B（卡片/频道/计划草稿）────────────────────────────────────────────

const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
const loop = readFileSync('src/main/engine/loop.ts', 'utf8');
const channel = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
const boss = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');

test('P2/F-N05：无选项决策卡有真实题面；有选项的卡也能去任务详情', () => {
  for (const reason of ['no_plan', 'no_verdict', 'no_credential']) {
    assert.ok(loop.includes(`reason === '${reason}'`), `缺少 ${reason} 的人话题面`);
  }
  assert.match(loop, /任务需要你决策（\$\{shortId\}：\$\{task\?\.title \?\? ''\}）/);
  assert.match(card, /data-testid="card-goto-task-ask-inline"/);
});

test('P2/F-N06：批准卡 payload 带人话摘要（目标/验收条数/风险）', () => {
  assert.match(loop, /approvalTldr = `\$\{goal\.length > 0 \? `目标：\$\{goal\.slice\(0, 140\)\}` : '目标：—'\} · 验收 \$\{acceptanceCount\} 条 · 风险：\$\{risk\}`/);
  assert.match(loop, /\.\.\.\(approvalTldr != null \? \{ tldr: approvalTldr \} : \{\}\)/);
});

test('P2/F-N01：空频道给幕僚长引导（不是空白）', () => {
  assert.match(boss, /data-testid="boss-channel-guide"/);
  assert.match(boss, /我是幕僚长/);
});

test('P2/U-N08：频道有加载中/失败+重试，不再一律空态', () => {
  assert.match(channel, /data-testid="boss-channel-loading"/);
  assert.match(channel, /data-testid="boss-channel-error"/);
  assert.match(channel, /data-testid="boss-channel-retry"/);
  assert.match(channel, /void loadChannel\(\)/);
});

test('P2/U-N09：计划草稿按任务存 sessionStorage，切 tab 回来能续', () => {
  assert.match(detail, /aico:plan-draft:\$\{task\.id\}/);
  assert.match(detail, /sessionStorage\.getItem\(draftKey\)/);
  assert.match(detail, /sessionStorage\.setItem\(draftKey, JSON\.stringify\(draft\)\)/);
  assert.match(detail, /clearDraft\(\)/);
});


// ── 批次 C（选人/招募/消息操作/批量）──────────────────────────────────────

const recruit = readFileSync('src/renderer/components/RecruitDialog.tsx', 'utf8');
const channelUi = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
const archive = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
const projectOverview = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');

test('P2/F-N04：评审/验证角色不能当执行者；只有评审时交给自动招募', () => {
  assert.equal(isExecutionRole('执行'), true);
  assert.equal(isExecutionRole('dev'), true);
  assert.equal(isExecutionRole('评审'), false);
  assert.equal(isExecutionRole('验证'), false);
  assert.equal(isExecutionRole('review'), false);
  assert.equal(isExecutionRole('verifier'), false);
  assert.match(readFileSync('src/main/engine/loop.ts', 'utf8'), /rows\.find\(\(row\) => isExecutionRole\(row\.role\)\)/);
});

test('P2/F-N11：招募角色有预设下拉，模型有目录候选', () => {
  assert.match(recruit, /data-testid="recruit-role"[\s\S]{0,200}<option/);
  assert.match(recruit, /data-testid="recruit-role-custom"/);
  assert.match(recruit, /list="recruit-model-options"/);
  assert.match(recruit, /<datalist id="recruit-model-options">/);
});

test('P2/P-N01：消息有复制/转任务，转任务预填目标', () => {
  assert.match(channelUi, /data-testid="message-copy"/);
  assert.match(channelUi, /data-testid="message-to-task"/);
  assert.match(channelUi, /initialGoal=\{createGoal\}/);
  assert.match(readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8'), /initialGoal = ''/);
});

test('P2/D-N08：归档页批量续办 + 项目页批量归档已结束任务', () => {
  assert.match(archive, /data-testid="archive-batch-renew"/);
  assert.match(archive, /data-testid="archive-select-all"/);
  assert.match(archive, /selectable/);
  assert.match(projectOverview, /data-testid="project-batch-archive"/);
  assert.match(projectOverview, /归档已结束（\{terminal\.length\}）/);
});

test('P2/P-N05：通用页补语言/开机自启（自启有真读者），未实现项如实标注', () => {
  assert.match(settings, /data-testid="settings-open-at-login"/);
  assert.match(settings, /简体中文（当前仅此一种，暂不提供多语言切换）/);
  assert.match(settings, /data-testid="settings-app-version"/);
  assert.match(settings, /data-testid="settings-data-dir"/);
  assert.match(settings, /data-testid="settings-open-data-dir"/);
  const dbSettings = readFileSync('src/main/db/settings.ts', 'utf8');
  assert.match(dbSettings, /'app\.openAtLogin'/);
  assert.match(readFileSync('src/main/index.ts', 'utf8'), /app\.setLoginItemSettings\(\{ openAtLogin \}\)/);
  assert.match(view, /saveSetting\('app\.openAtLogin', enabled\)/);
});

test('P2 收尾：首启去 L1/L2 术语；建任务显示落点目录/默认项目警告', () => {
  const wizard = readFileSync('src/renderer/components/OnboardingWizard.tsx', 'utf8');
  const gate = readFileSync('src/renderer/components/OnboardingGate.tsx', 'utf8');
  assert.doesNotMatch(wizard, /L1\/L2/);
  assert.match(wizard, /中\/高风险任务/);
  assert.doesNotMatch(gate, /L1\/L2/);
  const dialog = readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8');
  assert.match(dialog, /data-testid="taskdlg-project-path"/);
  assert.match(dialog, /落点：\$\{selectedProject\.rootDir\}/);
  assert.match(dialog, /会落到默认项目；建议先在上方选择具体项目/);
});
