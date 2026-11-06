/**
 * 公司大厅批（2026-10-16，替换批·第五批）——判据：
 *   ① 员工级聚合（主进程 `buildEmployeeActivity` 经 `buildHallState` 出）：执行中/等你/空闲三态、
 *      当前动作人话（等你裁定→问题；空闲→上一件）、今日产出/时长（真读数：0 是有源的 0）；
 *   ② 视图（纯组件）：页头状态图例真计数、员工卡状态角标/两行/动作/读数/卡尾「›」、
 *      「＋招募」NI ⇒ disabled＋理由；标题去 emoji。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { insertWorkItem } from '../src/main/db/work_items.js';
import { insertReport } from '../src/main/db/reports.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';
import { buildHallState } from '../src/main/ipc/hall.js';
import { CompanyHallView, statusCounts } from '../src/renderer/components/CompanyHallView.js';
import type { HallStateDTO } from '../src/renderer/types.js';

const NOW = new Date(2026, 9, 16, 12, 0, 0).getTime(); // 本地 2026-10-16 正午（今日窗口可预期）
const HOUR = 3_600_000;

function setup(): ReturnType<typeof openMemoryDatabase> {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedProject(db: ReturnType<typeof openMemoryDatabase>): number {
  return Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/r', 1)").run().lastInsertRowid);
}

// ── ① 主进程聚合 ────────────────────────────────────────────────────────────

test('大厅聚合：执行中/等你/空闲三态 ＋ 当前动作人话 ＋ 今日产出/时长（真读数）', () => {
  const db = setup();
  try {
    const projectId = seedProject(db);
    const counters = new SqliteCounterStore(db);
    const a = insertEmployee(db, { name: '研究员', role: 'researcher', now: NOW });
    const b = insertEmployee(db, { name: '幕僚长', role: '编排', isAssistant: true, now: NOW });
    const c = insertEmployee(db, { name: '写手', role: 'writer', now: NOW });
    const d = insertEmployee(db, { name: '测试', role: 'qa', now: NOW });

    // a：running 件、任务正常执行 → 执行中，动作＝件标题。
    const t1 = createTask(db, counters, { projectId, title: '对账脚本', goal: 'g', riskLevel: 1 });
    db.prepare("UPDATE tasks SET state = 'executing' WHERE id = ?").run(t1.id);
    insertWorkItem(db, { taskId: t1.id, employeeId: a, title: '写出对账脚本 compare.py', brief: 'b', now: NOW - HOUR });
    db.prepare("UPDATE work_items SET state = 'running', started_at = ? WHERE employee_id = ?").run(NOW - HOUR, a);

    // b：running 件、任务在 needs_decision 且有未结 ask → 等你裁定：<问题>。
    const t2 = createTask(db, counters, { projectId, title: '方案决策', goal: 'g', riskLevel: 1 });
    db.prepare("UPDATE tasks SET state = 'needs_decision' WHERE id = ?").run(t2.id);
    insertWorkItem(db, { taskId: t2.id, employeeId: b, title: '等待口径确认', brief: 'b', now: NOW - HOUR });
    db.prepare("UPDATE work_items SET state = 'running', started_at = ? WHERE employee_id = ?").run(NOW - HOUR, b);
    insertReport(db, { taskId: t2.id, kind: 'ask', payload: { question: '对账脚本用 Python 还是 Node？' }, state: 'pending', now: NOW });

    // c：无 running；今日完成一件（30 分钟）→ 空闲＋上一件＋今日 1 件 · 30 分钟。
    const t3 = createTask(db, counters, { projectId, title: '官网文案', goal: 'g', riskLevel: 0 });
    insertWorkItem(db, { taskId: t3.id, employeeId: c, title: '官网首页改版文案', brief: 'b', now: NOW - 2 * HOUR });
    db.prepare(
      "UPDATE work_items SET state = 'done', started_at = ?, finished_at = ? WHERE employee_id = ?",
    ).run(NOW - 90 * 60_000, NOW - 60 * 60_000, c);

    const hall = buildHallState(db, undefined, { now: NOW });
    const by = (id: number): NonNullable<(typeof hall.employees)[number]['activity']> => {
      const employee = hall.employees.find((e) => e.id === id);
      assert.ok(employee?.activity != null, `员工 ${id} 缺 activity`);
      return employee!.activity!;
    };

    assert.equal(by(a).status, 'running');
    assert.equal(by(a).currentAction, '写出对账脚本 compare.py');
    assert.equal(by(a).taskShortId, 'T-1001');

    assert.equal(by(b).status, 'waiting');
    assert.equal(by(b).currentAction, '等你裁定：对账脚本用 Python 还是 Node？');

    assert.equal(by(c).status, 'idle');
    assert.equal(by(c).currentAction, '上一件：官网首页改版文案');
    assert.equal(by(c).todayOutput, 1);
    assert.equal(by(c).todayMinutes, 30);

    assert.equal(by(d).status, 'idle');
    assert.equal(by(d).currentAction, null, '无件 ⇒ 不摆假动作');
    assert.equal(by(d).todayOutput, 0, '真 0 是有源的 0');
    assert.equal(by(d).todayMinutes, 0);
  } finally {
    db.close();
  }
});

test('M3-P-5 卡住：最近一件 failed/interrupted（任务未结束）→ stuck＋原因；活动流来自 task_events 真投影', () => {
  const db = setup();
  try {
    const projectId = seedProject(db);
    const counters = new SqliteCounterStore(db);
    const e = insertEmployee(db, { name: '卡住的人', role: 'dev', now: NOW });
    const task = createTask(db, counters, { projectId, title: '失败任务', goal: 'g', riskLevel: 1 });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(task.id);
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: e, title: '写实现', brief: 'b', now: NOW - HOUR });
    db.prepare("UPDATE work_items SET state='failed', started_at=?, finished_at=? WHERE id=?").run(NOW - HOUR, NOW - 30 * 60_000, wi.id);
    insertTaskEvent(db, {
      taskId: task.id,
      ts: NOW - 10 * 60_000,
      kind: 'task_completed',
      actor: `employee:${e}`,
      payload: { notes: '交付说明' },
    });

    const hall = buildHallState(db, undefined, { now: NOW });
    const activity = hall.employees.find((x) => x.id === e)?.activity;
    assert.equal(activity?.status, 'stuck');
    assert.match(String(activity?.currentAction), /卡住：写实现/);
    assert.equal(activity?.taskShortId, task.short_id);
    assert.equal(hall.activityLog.length, 1);
    assert.equal(hall.activityLog[0]!.kind, 'task_completed');
    assert.match(hall.activityLog[0]!.text, /完成：失败任务/);
    assert.equal(hall.activityLog[0]!.actorName, '卡住的人');
    assert.equal(hall.activityLog[0]!.taskShortId, task.short_id);
    assert.equal(hall.activityLog[0]!.detail, '交付说明');
  } finally {
    db.close();
  }
});

// ── ② 视图（纯组件）─────────────────────────────────────────────────────────

const DATA: HallStateDTO = {
  employees: [
    {
      id: 1,
      name: '林悦',
      role: '产品负责人',
      activity: {
        status: 'running',
        currentAction: '写出对账脚本 compare.py',
        taskShortId: 'T-1042',
        taskId: 42,
        currentMinutes: 46,
        todayOutput: 2,
        todayMinutes: 46,
        todayArtifacts: 1,
      },
    },
    {
      id: 2,
      name: '苏然',
      role: '运营',
      activity: {
        status: 'waiting',
        currentAction: '等你裁定：对账脚本用 Python 还是 Node？',
        taskShortId: 'T-1042',
        taskId: 42,
        currentMinutes: 12,
        todayOutput: 1,
        todayMinutes: 12,
      },
    },
    {
      id: 0,
      name: '幕僚长',
      role: '编排',
      isAssistant: true,
      activity: { status: 'idle', currentAction: null, taskShortId: null, todayOutput: 0, todayMinutes: 0 },
    },
  ],
  departments: [
    { id: 'product', name: '产品部', memberIds: [1] },
    { id: 'ops', name: '运营部', memberIds: [2] },
  ],
  collab: [{ from: 'product', to: 'ops', count: 12 }],
  activityLog: [
    {
      id: 9,
      ts: NOW,
      kind: 'task_completed',
      actor: 'employee:1',
      actorName: '林悦',
      taskId: 42,
      taskShortId: 'T-1042',
      taskTitle: '对账脚本',
      text: '完成：对账脚本',
      detail: '12 项测试一次全过',
      tone: 'ok',
    },
  ],
  windowDays: 7,
};

function render(data: HallStateDTO | null, onSelect?: (id: number) => void): string {
  return renderToStaticMarkup(createElement(CompanyHallView, { data, onSelectEmployee: onSelect }));
}

test('页头：在岗/在忙真计数（不再摆 0 图例）；「＋招募」可见；标题去 emoji', () => {
  const html = render(DATA, () => {});
  assert.match(html, /data-testid="hall-on-duty"[^>]*>3 人在岗/, '在岗计数');
  assert.match(html, /data-testid="hall-busy"[^>]*>2 人在忙/, '在忙＝running+waiting+stuck');
  assert.equal(html.includes('data-testid="hall-status-stuck"'), false, '不再摆 0 状态图例');
  // 2026-10-19（RM-1）：招募＝大厅内对话框，不再跳老板频道；title 明示可填名字/角色/模型。
  assert.equal(/data-testid="hall-recruit"[^>]*disabled/.test(html), false, '招募按钮可点');
  assert.match(html, /title="招募一名员工（名字\/角色\/偏好模型）"/);
  assert.equal(html.includes('🏢'), false, '标题不得再带 emoji');
});

test('员工行（双栏批）：状态点（三色）＋名/角色两行；看活读数在右栏', () => {
  const html = render(DATA, () => {});
  assert.match(html, /data-testid="hall-employee"[^>]*data-status="running"/);
  assert.match(html, /data-testid="hall-employee"[^>]*data-status="waiting"/);
  assert.match(html, /data-testid="hall-emp-status"[^>]*data-tone="warn"/, '等你＝warn 点');
  assert.match(html, /hall-row__name/);
  assert.match(html, /hall-row__role/);
  assert.match(html, /data-testid="hall-emp-task"[^>]*data-task-id="42"/, '当前任务短号可点');
  assert.match(html, /46 分钟/, '当前件已运行时长');
  assert.match(html, /今日 2 件/, '今日完成数');
  assert.match(html, /1 产出/, '今日产数');
});

test('M3-P-5 活动流：右栏分区渲染真实事件（文字/批注/演员/时间），可点任务', () => {
  const html = renderToStaticMarkup(
    createElement(CompanyHallView, {
      data: DATA,
      pane: 'activity',
      onOpenTask: () => undefined,
    }),
  );
  assert.match(html, /data-testid="hall-activity"/);
  assert.match(html, /data-testid="hall-activity-item"[^>]*data-kind="task_completed"/);
  assert.match(html, /完成：对账脚本/);
  assert.match(html, /12 项测试一次全过/);
  assert.match(html, /林悦 ·/);
  assert.match(html, /data-testid="hall-open-activity"[^>]*aria-pressed="true"/);
});

test('statusCounts：真计数（缺 activity ⇒ 按空闲，不摆假状态）', () => {
  assert.deepEqual(statusCounts(DATA.employees), { running: 1, waiting: 1, stuck: 0, idle: 1 });
  assert.deepEqual(statusCounts([{ id: 9, name: 'x', role: 'y' }]), { running: 0, waiting: 0, stuck: 0, idle: 1 });
  assert.deepEqual(
    statusCounts([
      {
        id: 8,
        name: '卡住的人',
        role: 'dev',
        activity: { status: 'stuck', currentAction: '卡住：x', taskShortId: 'T-9', todayOutput: 0, todayMinutes: 0 },
      },
    ]),
    { running: 0, waiting: 0, stuck: 1, idle: 0 },
  );
});

test('RM-8 密度：活动流默认只显示最近 8 条，可展开全部', () => {
  const base = DATA.activityLog![0]!;
  const data: HallStateDTO = {
    ...DATA,
    activityLog: Array.from({ length: 10 }, (_, i) => ({ ...base, id: 100 + i, text: `动态 ${i + 1}` })),
  };
  const html = renderToStaticMarkup(createElement(CompanyHallView, { data, pane: 'activity' }));
  assert.equal((html.match(/data-testid="hall-activity-item"/g) ?? []).length, 8, '默认只渲染 8 条');
  assert.match(html, /data-testid="hall-activity-more"/, '超过 8 条必须有展开入口');
  assert.match(html, /展开全部（10）/);
});
