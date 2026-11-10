/**
 * 左栏任务行＋频道批（2026-10-16，替换批·第二批）——判据：
 *   ① `task:list` 的执行员工 join（**最新一件**工作项；无件 ⇒ null；其余面不带该字段）；
 *   ② 卡片文案/读数纯逻辑（人话 chip／倒计时／键帽／kind 色点）；
 *   ③ 频道锚纯逻辑（日期锚／「新消息」锚＝本次进入后第一条）；
 *   ④ 源码/样式守门（左栏行 dot＋avatar；气泡终版 `.bubble--in`＝accent-strong 实底白字）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { insertWorkItem } from '../src/main/db/work_items.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { CARD_KIND_META, CARD_STATE_TEXT, isActionable, remainText } from '../src/renderer/components/cardCopy.js';
import { dayKey, dayLabel, streamAnchors } from '../src/renderer/components/channelStream.js';

const AT = 1_700_000_000_000; // 2023-11-14（固定基准，别用 now）
const DAY = 24 * 60 * 60 * 1000;

function setup(): ReturnType<typeof openMemoryDatabase> {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedProject(db: ReturnType<typeof openMemoryDatabase>): number {
  return Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/r', 1)").run().lastInsertRowid);
}

// ── ① 执行员工 join（task:list 面）─────────────────────────────────────────

test('task:list 执行员工 join：最新一件工作项的负责人（含名字）；无件 ⇒ null；task:get 不带该字段', () => {
  const db = setup();
  try {
    const projectId = seedProject(db);
    const counters = new SqliteCounterStore(db);
    const t1 = createTask(db, counters, { projectId, title: '有件', goal: 'g', riskLevel: 0 });
    const t2 = createTask(db, counters, { projectId, title: '无件', goal: 'g', riskLevel: 0 });
    const emp = insertEmployee(db, { name: '研究员', role: 'researcher', now: AT });
    // 两件：件1 归 emp，件2 归 emp（**最新一件**胜出——同一员工；再造一个改派场景）。
    insertWorkItem(db, { taskId: t1.id, employeeId: emp, title: 'w1', brief: 'b', now: AT });
    insertWorkItem(db, { taskId: t1.id, employeeId: emp, title: 'w2', brief: 'b', now: AT + 1 });

    const repo = createSqliteChatRepo(db);
    const rows = repo.listTasks();
    const row1 = rows.find((r) => r.id === t1.id);
    const row2 = rows.find((r) => r.id === t2.id);
    assert.deepEqual(row1?.executor, { id: emp, name: '研究员' }, '最新件负责人（含员工名）');
    assert.equal(row2?.executor, null, '无件 ⇒ null（渲染层不臆造）');

    const detail = repo.getTask(t1.id);
    assert.ok(detail != null);
    assert.equal('executor' in detail!, false, 'task:get 面**不带**该字段（不承诺）');
  } finally {
    db.close();
  }
});

// ── ② 卡片文案/读数 ────────────────────────────────────────────────────────

test('卡片文案：kind 语义色点（无 emoji）；state 人话 chip；可操作性＝pending/delivered', () => {
  assert.deepEqual(Object.keys(CARD_KIND_META).sort(), ['alert', 'ask', 'notification', 'report']);
  for (const [kind, meta] of Object.entries(CARD_KIND_META)) {
    assert.ok(typeof meta.tone === 'string' && meta.tone.length > 0, `${kind} 缺 tone`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(meta.label), `${kind} 标签不得含 emoji`);
  }
  assert.deepEqual(CARD_STATE_TEXT, { pending: '待你处理', delivered: '待阅', acknowledged: '已读', resolved: '已处理' });
  assert.equal(isActionable('pending'), true);
  assert.equal(isActionable('delivered'), true);
  assert.equal(isActionable('acknowledged'), false);
  assert.equal(isActionable('resolved'), false);
});

test('倒计时读秒：分钟 / 小时＋分 / 整小时 / 已到点（不写假读数）', () => {
  assert.equal(remainText(AT + 30 * 60_000, AT), '30 分钟');
  assert.equal(remainText(AT + (3 * 60 + 47) * 60_000, AT), '3 小时 47 分');
  assert.equal(remainText(AT + 5 * 3_600_000, AT), '5 小时');
  assert.equal(remainText(AT - 1, AT), '已到点');
  assert.equal(remainText(AT, AT), '已到点');
});

// ── ③ 频道锚 ───────────────────────────────────────────────────────────────

test('日期锚：今天 / 昨天 / M 月 D 日 / 跨年补年', () => {
  const now = new Date(2026, 9, 16, 12, 0, 0).getTime(); // 2026-10-16 本地
  assert.equal(dayLabel(now - 3_600_000, now), '今天');
  assert.equal(dayLabel(now - DAY, now), '昨天');
  assert.equal(dayLabel(now - 5 * DAY, now), '10 月 11 日');
  assert.equal(dayLabel(new Date(2025, 11, 31, 10, 0, 0).getTime(), now), '2025 年 12 月 31 日');
});

test('流锚：首条必带日期；跨日再出日期；「新消息」只在本次进入后第一条（且非首条）', () => {
  const openedAt = AT - 60_000;
  const items = [
    { at: AT - 3 * DAY }, // 首条：日期锚（跨年也在此）
    { at: AT - 3 * DAY + 1000 }, // 同日：无锚
    { at: AT - 2 * 60_000 }, // 跨日：日期锚
    { at: AT - 30_000 }, // 新消息（> openedAt 的第一条）
    { at: AT - 10_000 }, // 后续新消息：不再画锚
  ];
  const anchors = streamAnchors(items, openedAt, AT);
  assert.equal(anchors[0]!.showDate != null, true, '首条有日期锚');
  assert.equal(anchors[1]!.showDate, null, '同日不重复');
  assert.equal(anchors[2]!.showDate != null, true, '跨日再出');
  assert.deepEqual(
    anchors.map((a) => a.showNew),
    [false, false, false, true, false],
    '「新消息」锚恰在第一条到达项',
  );

  // 进入后**没有**新条 ⇒ 无锚；第一项即新条 ⇒ 也不画（首条位置由日期锚占据）。
  assert.deepEqual(streamAnchors([{ at: AT - DAY }], openedAt, AT).map((a) => a.showNew), [false]);
  assert.deepEqual(streamAnchors([{ at: AT + 1 }, { at: AT + 2 }], openedAt, AT).map((a) => a.showNew), [false, false]);
});

// ── ④ 源码/样式守门 ────────────────────────────────────────────────────────

test('任务行视觉（2026-10-17 左栏任务列表退役）：共享件仍在项目树/归档行；左栏不再列任务', () => {
  const rail = readFileSync('src/renderer/components/LeftRail.tsx', 'utf8');
  assert.equal(rail.includes('task-row__dot'), false, '左栏任务列表已退役（老板令）');
  assert.equal(rail.includes('task-row__avatar'), false, '左栏不再渲染任务行');
  const views = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
  assert.ok(views.includes('tlist__dot'), '缺状态点（项目树/归档行）');
  assert.ok(views.includes('tlist__avatar'), '缺头像（有执行员工才渲染）');
  assert.ok(views.includes('task.executor ?'), '头像必须条件渲染（无数据不臆造）');
  const visuals = readFileSync('src/renderer/components/taskVisuals.ts', 'utf8');
  assert.ok(visuals.includes('STATE_TONE'), '缺状态色映射（共享件）');
});

test('频道定位与发送回底：卡片可寻址；「在频道看」高亮；新老板消息滚到底', () => {
  const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
  assert.ok(card.includes('data-card-id={card.id}'), '卡片必须带可寻址 id');
  assert.ok(card.includes('data-testid="card-goto-task-ask"'), '决策卡必须能直接去处理');
  assert.ok(card.includes('data-testid="card-goto-task-alert"'), '异常卡必须能直接去查看');
  assert.ok(card.includes('需要你决策（${card.shortId'), '默认题面重复时必须识别并隐藏');
  const boss = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
  assert.ok(boss.includes('channelFocus'), '缺定位状态消费');
  assert.ok(boss.includes('[data-card-id="${cardId}"]'), '缺按卡 id 查找');
  assert.ok(boss.includes("setAttribute('data-focused', 'true')"), '缺定位高亮');
  assert.ok(boss.includes('stream.scrollTop = stream.scrollHeight'), '发送后必须回到底部');
  assert.ok(boss.includes("direction === 'in'"), '只在自己发消息时回底（不抢别人的滚动）');
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(css, /\.card\[data-focused='true'\]\s*\{[^}]*outline:/, '缺定位高亮样式');
  assert.ok(css.includes('.card__digest {'), '缺频道日报读数行样式');
});

test('样式守门：气泡终版（.bubble--in＝accent-strong 实底）；锚线/键帽/点/头像规则在场', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `缺规则 ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  const bubbleIn = rule('.bubble--in');
  assert.match(bubbleIn, /background:\s*var\(--accent-strong\)/, '老板气泡＝accent-strong 实底');
  assert.match(bubbleIn, /color:\s*var\(--on-accent\)/, '老板气泡＝白字');
  assert.ok(rule('.channel-date').length > 0, '缺日期锚样式');
  assert.ok(rule('.channel-new').length > 0, '缺新消息锚样式');
  // 卡片可读性批（2026-10-28）：英文 key 键帽退役（IM 序号独立生成）；多选 ☑/☐ 用 card__tick。
  assert.equal(css.includes('.card__key'), false, 'card__key 键帽应已退役');
  assert.ok(rule('.card__tick').length > 0, '缺多选勾选符样式');
  assert.ok(rule('.card__due').length > 0, '缺倒计时 chip 样式');
  assert.ok(rule('.task-row__dot').length > 0, '缺状态点样式');
  assert.ok(rule('.task-row__avatar').length > 0, '缺头像样式');
});

test('附件 chip 可点开：resolveAttachment + 预览抽屉（图片/PDF/文本/不支持四态）', () => {
  const boss = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
  const drawer = readFileSync('src/renderer/components/PreviewDrawer.tsx', 'utf8');
  assert.match(boss, /data-testid="attachment-chip"/, '附件 chip 必须是可点按钮');
  assert.match(boss, /resolveAttachment\(\{ messageId: message\.id, index \}\)/, '点击必须走 resolveAttachment');
  assert.match(boss, /<PreviewDrawer[\s\S]*?variant="attachment"/, '频道附件必须复用统一预览抽屉');
  assert.match(drawer, /artifact \? 'artifact-drawer-scrim' : 'attachment-preview'/, '缺预览抽屉');
  assert.match(drawer, /attachment-preview__image/, '缺图片预览');
  assert.match(drawer, /attachment-preview__frame/, '缺 PDF 预览');
  assert.match(drawer, /attachment-preview__text/, '缺文本预览');
  assert.match(drawer, /暂不支持在应用内预览/, '不支持类型必须如实说明');
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.ok(css.includes('.attachment-preview {'), '缺预览遮罩样式');
  assert.ok(css.includes('.chip--attachment'), '缺可点 chip 样式');
});

test('RM-2/4/7 守门：折叠/卡内回复/首屏滚底/分屏不再隐藏右栏开关', () => {
  const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  assert.ok(inbox.includes('inbox-reply-input'), 'RM-2：无选项卡必须能在卡片内输入');
  assert.ok(inbox.includes('inbox-plan-full'), 'RM-2：完整计划可展开');
  assert.ok(inbox.includes('FoldText'), 'RM-2：长内容折叠组件');
  const boss = readFileSync('src/renderer/components/BossChannel.tsx', 'utf8');
  assert.ok(boss.includes('initialScrollDoneRef'), 'RM-4：首屏/切回必须落到底部');
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.ok(css.includes('.inbox-row__foldtext'), 'RM-2：缺折叠样式');
  assert.ok(css.includes('.inbox-row__replyinput'), 'RM-2：缺卡内输入样式');
  assert.equal(css.includes("data-testid='rail-toggle-right']"), false, 'RM-7：窄窗不得隐藏右栏开关');
  const main = readFileSync('src/main/index.ts', 'utf8');
  assert.ok(main.includes('minWidth: 720'), 'RM-7：窗口最小宽度必须能进半屏');
});
