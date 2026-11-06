/**
 * M3-P-3（GAP3 收口）：托盘状态点真读数 + OS 通知点击回任务/失败如实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { trayStatusView } from '../src/main/tray/status.js';
import {
  deliverDesktopNotification,
  desktopNotificationText,
  type DesktopNotificationLike,
  type DesktopNotifyDeps,
} from '../src/main/notify/desktop.js';
import type { NotifyDelivery } from '../src/main/notify/index.js';
import {
  SqliteCounterStore,
  createTask,
  getApproval,
  getReport,
  insertApproval,
  insertReport,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleInboxAnswer, handleTaskTransition, type IpcDeps } from '../src/main/ipc/ipc.js';

test('GAP3 托盘状态：pending 优先橙、running 次之绿、空为 idle；tooltip 两个真读数都保留', () => {
  assert.deepEqual(trayStatusView({ pending: 0, running: 0 }), {
    state: 'idle',
    pending: 0,
    running: 0,
    tooltip: 'AI 一人公司',
    menuLabel: null,
  });
  const working = trayStatusView({ pending: 0, running: 2 });
  assert.equal(working.state, 'working');
  assert.equal(working.tooltip, 'AI 一人公司 · 正在干活 2');
  assert.equal(working.menuLabel, '正在干活（2）');
  const waiting = trayStatusView({ pending: 1, running: 3 });
  assert.equal(waiting.state, 'waiting', '有事等你优先于正在干活');
  assert.equal(waiting.tooltip, 'AI 一人公司 · 待我处理 1 · 正在干活 3', '两个读数都如实给出');
  assert.equal(waiting.menuLabel, '待我处理（1）');
  assert.equal(trayStatusView({ pending: -1, running: Number.NaN }).state, 'idle', '非法读数按 0（不臆造）');
});

function delivery(over: Partial<NotifyDelivery> = {}): NotifyDelivery {
  return {
    reportId: 3,
    taskId: 42,
    dedupeKey: 'card:report:42',
    channel: 'desktop',
    payload: { title: '完成：T-1001', text: '任务已完成' },
    urgent: false,
    now: 1,
    ...over,
  };
}

function setup(over: Partial<DesktopNotifyDeps> = {}): {
  deps: DesktopNotifyDeps;
  toasts: unknown[];
  opened: unknown[];
  logs: string[];
  shown: { count: number };
  clickRef: { current: () => void };
  notified: { count: number };
} {
  const state = {
    toasts: [] as unknown[],
    opened: [] as unknown[],
    logs: [] as string[],
    shown: { count: 0 },
    clickRef: { current: () => undefined as void },
    notified: { count: 0 },
  };
  const deps: DesktopNotifyDeps = {
    isSupported: () => true,
    createNotification: ({ title, body }): DesktopNotificationLike => {
      state.notified.count += 1;
      return {
        on: (event, listener) => {
          assert.equal(event, 'click');
          state.clickRef.current = listener;
        },
        show: () => {
          state.shown.count += 1;
          assert.ok(title.includes('完成') || title.includes('AI'), '标题不得为空');
          assert.ok(body.length > 0, '正文不得为空');
        },
      };
    },
    pushToast: (input) => state.toasts.push(input),
    openView: (target) => state.opened.push(target),
    logError: (message) => state.logs.push(message),
    ...over,
  };
  return { deps, ...state };
}

test('GAP3 桌面通知：desktop 通道推浮层＋弹 OS 通知；点击回到对应任务', () => {
  const s = setup();
  const result = deliverDesktopNotification(delivery(), s.deps);
  assert.equal(result.status, 'shown');
  assert.equal(s.toasts.length, 1);
  assert.deepEqual(s.toasts[0], { title: '完成：T-1001', text: '任务已完成', reportId: 3 });
  assert.equal(s.shown.count, 1);
  s.clickRef.current();
  assert.deepEqual(s.opened, [{ taskId: 42 }], '点击带 taskId 回任务详情');
});

test('GAP3 桌面通知：全局卡点击回频道；digest 通道不弹也不推浮层', () => {
  const s = setup();
  const result = deliverDesktopNotification(delivery({ taskId: null }), s.deps);
  assert.equal(result.status, 'shown');
  s.clickRef.current();
  assert.deepEqual(s.opened, [{ view: 'channel' }]);

  const quiet = setup();
  const skipped = deliverDesktopNotification(delivery({ channel: 'digest' }), quiet.deps);
  assert.equal(skipped.status, 'skipped');
  assert.equal(quiet.toasts.length, 0, '静默期不弹浮层');
  assert.equal(quiet.notified.count, 0, '静默期不构造 OS 通知');
});

test('GAP3 失败如实：系统不支持/构造异常 → 浮层仍可见、日志点名、不抛', () => {
  const unsupported = setup({ isSupported: () => false });
  const r1 = deliverDesktopNotification(delivery(), unsupported.deps);
  assert.equal(r1.status, 'unsupported');
  assert.equal(unsupported.toasts.length, 1, 'OS 不可用不影响应用内浮层');
  assert.match(unsupported.logs.join('\n'), /系统通知不可用/);

  const boom = setup({
    createNotification: () => {
      throw new Error('Notification ctor failed');
    },
  });
  const r2 = deliverDesktopNotification(delivery(), boom.deps);
  assert.equal(r2.status, 'failed');
  assert.equal(boom.toasts.length, 1);
  assert.match(boom.logs.join('\n'), /系统通知失败/);
});

test('GAP3 文案：question/text/title 形态都有兜底，长度受限', () => {
  assert.deepEqual(desktopNotificationText({ question: '批准吗？' }), { title: '需要你处理', body: '批准吗？' });
  assert.deepEqual(desktopNotificationText({ title: 'A', body: 'B' }), { title: 'A', body: 'B' });
  const long = desktopNotificationText({ title: 'T'.repeat(200), text: 'X'.repeat(500) });
  assert.equal(long.title.length, 80);
  assert.equal(long.body.length, 200);
});

test('GAP3 待办读数：inbox 已阅回调 / 详情批准一并作答待批卡（防托盘橙点悬挂）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  const repo = createSqliteChatRepo(db);
  let changed = 0;
  const deps: IpcDeps = {
    repo,
    engine: new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1_800_000_000_000 }),
    onInboxChanged: () => {
      changed += 1;
    },
  };
  try {
    const global = insertReport(db, { taskId: null, kind: 'notification', payload: { title: '待阅' }, now: 1 });
    handleInboxAnswer(deps, { id: global.id }, 2);
    assert.equal(changed, 1, '标记已阅 → 托盘刷新');
    assert.equal(getReport(db, global.id)?.state, 'acknowledged');

    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1 });
    db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
    const report = insertReport(db, { taskId: task.id, kind: 'ask', payload: { question: '批准计划？' }, now: 3 });
    const approval = insertApproval(db, {
      taskId: task.id,
      reportId: report.id,
      question: '批准计划？',
      options: [{ key: 'approve' }, { key: 'revise' }],
      defaultAction: null,
    });
    const result = await handleTaskTransition(deps, { taskId: task.id, event: 'plan_approved', payload: {} });
    assert.equal(result.ok, true);
    assert.equal(getReport(db, report.id)?.state, 'resolved', '详情操作条批准后卡必须 resolved');
    assert.equal(getApproval(db, approval.id)?.chosen, 'approve', '审批台账同步作答');
    assert.equal(changed, 2, '详情推进 → 托盘刷新');
  } finally {
    db.close();
  }
});
