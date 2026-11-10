/**
 * 频道范围选择器（2026-10-26 提案， 复核期间设计定稿）：
 * 把「绑定项目」从隐式点选升级为老板频道里的显式下拉——范围＝助手的工作范围。
 *
 * 设计规则（docs/a、docs/06 同步）：
 * ① 下拉常驻输入框上方：首项「公司（全部项目）」（null）＋各项目＋尾项「＋新建项目…」（就地小表单）；
 * ② 与项目树点选写同一状态（session.selectedProjectId），两处互同步；只改范围不改视图；
 * ③ 会话恢复保留范围（项目仍存在才有效；失效回落公司）；
 * ④ 建任务对话框默认跟随范围、仍可改选（最后一道落点确认）；
 * ⑤ 两态说明：公司＝可聊天/查任意任务状态、命令与读写需选项目；项目＝该项目内可执行、跨项目读用任务号、写先切范围。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const channel = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');
const viewCursor = readFileSync('src/renderer/components/viewCursor.ts', 'utf8');

test('① 自定义菜单常驻且选项结构齐全（公司/各项目/＋新建项目）；朝上展开、样式跟应用', () => {
  assert.ok(channel.includes('data-testid="channel-scope-select"'), '缺范围按钮（aria-haspopup=listbox）');
  assert.ok(channel.includes('data-testid="channel-scope-menu"'), '缺自定义菜单（老板 2026-10-26：不用原生 select）');
  assert.ok(channel.includes("bottom: 'calc(100% + 6px)'"), '菜单必须朝上展开（在输入框上方）');
  assert.ok(channel.includes('data-testid="channel-scope-scrim"'), '缺点外关闭 scrim');
  assert.ok(channel.includes('公司（全部项目）'), '缺公司首项');
  assert.ok(channel.includes('scopeProjects.map'), '项目选项按 project:list 渲染');
  assert.ok(channel.includes('＋新建项目…'), '缺尾项新建入口');
  assert.ok(channel.includes('data-testid="channel-scope-create"'), '缺就地新建表单');
  assert.ok(channel.includes('data-testid="channel-scope-hint"'), '缺两态说明');
  assert.ok(!channel.includes('<select'), '不得用原生 select（样式/方向都不可控）');
  assert.ok(channel.includes('var(--panel)') && channel.includes('var(--radius-lg)'), '菜单样式须跟应用设计变量');
  assert.ok(channel.includes("role=\"option\"") || channel.includes("'option'"), '选项须可访问（listbox/option）');
  assert.ok(channel.includes("e.key === 'Escape'"), 'Esc 关闭');
});

test('② 与项目树同状态互同步；setChannelScope 只改范围不改视图', () => {
  assert.ok(store.includes('export function setChannelScope(projectId: number | null)'), '缺 setChannelScope');
  const fn = store.slice(store.indexOf('export function setChannelScope'), store.indexOf('}', store.indexOf('export function setChannelScope')) + 1);
  assert.ok(!fn.includes('.view'), 'setChannelScope 不得改视图');
  assert.ok(channel.includes('setChannelScope(null)') && channel.includes('setChannelScope(p.id)'), '菜单两处写入口接 setChannelScope（公司/项目）');
  const showChannel = store.slice(store.indexOf('export function showChannel'), store.indexOf('}', store.indexOf('export function showChannel')) + 1);
  assert.ok(!showChannel.includes('selectedProjectId'), 'showChannel 不得改范围');
});

test('③ 会话恢复保留范围（项目仍存在才有效；失效回落公司）', () => {
  assert.ok(viewCursor.includes('existingProjectIds.has(saved.selectedProjectId)'), '恢复须按现存项目校验');
  assert.ok(!store.includes("resolved.view === 'projects' ? resolved.selectedProjectId : null"), '旧的按视图清空口径必须移除');
});

test('④ 建任务对话框默认跟随范围、仍可改选', () => {
  assert.ok(channel.includes('projectId={scopeId}'), '频道对话框默认项目须跟范围');
  assert.ok(channel.includes('projectName={scopeName_}'), '对话框预填项目名');
});

test('⑤ 两态说明文案（公司/项目）', () => {
  assert.ok(channel.includes('公司范围：可聊天、用任务号查任意项目状态'), '公司态说明缺失');
  assert.ok(channel.includes('范围：助手可执行命令与读写该项目'), '项目态说明缺失');
  assert.ok(channel.includes('动其他项目先切换范围'), '跨项目写须提示先切范围');
});
