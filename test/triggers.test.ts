/**
 * cron + 事件触发 v1——真 timer 存储、幂等、取消、重启保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { listTimers, rebuildTimers } from '../src/main/engine/timers.js';
import { createTriggerService, nextTriggerDueAt } from '../src/main/triggers/service.js';
import { parseTriggerCommand } from '../src/main/ipc/ipc.js';

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const MIN = 60_000;

function setup(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',1)").run().lastInsertRowid,
  );
  return { db, projectId };
}

function service(db: SqliteDb, created: Array<{ kind: string; triggerId: number }>) {
  return createTriggerService({
    db,
    materialize: async (template) => {
      created.push({ kind: template.kind, triggerId: template.triggerId });
      return created.length;
    },
  });
}

test('GAP1 cron：到点才建；建后重排下一拍；重复 tick 不重复；取消后不再建', async () => {
  const { db, projectId } = setup();
  const created: Array<{ kind: string; triggerId: number }> = [];
  const svc = service(db, created);
  try {
    const trigger = svc.createCron({
      name: '对账',
      projectId,
      title: '对账',
      goal: '每天对账',
      riskLevel: 1,
      intervalMinutes: 30,
      now: NOW,
    });
    assert.equal(trigger.kind, 'cron');
    assert.equal(trigger.nextDueAt, NOW + 30 * MIN);
    assert.equal(svc.list().length, 1);

    await svc.tick(NOW);
    assert.equal(created.length, 0, '未到点不建');
    await svc.tick(NOW + 30 * MIN);
    assert.equal(created.length, 1, '到点建一次');
    const after = svc.list()[0]!;
    assert.equal(after.lastFiredAt, NOW + 30 * MIN);
    assert.equal(after.nextDueAt, NOW + 60 * MIN + 1, '同 dedupe_key 重排下一拍');
    assert.equal(after.lastTaskId, 1);

    await svc.tick(NOW + 30 * MIN);
    await svc.tick(NOW + 31 * MIN);
    assert.equal(created.length, 1, '同一拍重复 tick 不重复建');

    assert.equal(svc.cancel(after.id), true);
    assert.equal(svc.list().length, 0);
    await svc.tick(NOW + 100 * MIN);
    assert.equal(created.length, 1, '取消后不再建');
    assert.equal(svc.cancel(after.id), false, '重复取消返回 false');
  } finally {
    db.close();
  }
});

test('GAP1 事件触发：源任务完成→建一次；后续事件不重复；取消/重启保留', async () => {
  const { db, projectId } = setup();
  const created: Array<{ kind: string; triggerId: number }> = [];
  const svc = service(db, created);
  try {
    const source = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '源任务',
      goal: 'g',
      riskLevel: 1,
    });
    const trigger = svc.createEvent({
      name: '跟进',
      projectId,
      title: '自动跟进',
      goal: '源任务完成后跟进',
      riskLevel: 1,
      sourceTaskId: source.id,
      eventKind: 'task_completed',
      now: NOW,
    });
    assert.equal(trigger.kind, 'event');
    assert.equal(trigger.sourceTaskId, source.id);

    svc.onEngineEvent({ scope: 'task', id: source.id, event: 'task_updated' } as never);
    await svc.tick(NOW + 1);
    assert.equal(created.length, 0, '未完成不触发');

    //  修复：只有源任务**已落库终态**才物化；先模拟任务机把状态推到 done。
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(source.id);
    svc.onEngineEvent({ scope: 'task', id: source.id, event: 'finish_manual' });
    svc.onEngineEvent({ scope: 'task', id: source.id, event: 'finish_manual' });
    await svc.tick(NOW + 2);
    assert.equal(created.length, 1, '同事件队列去重；只建一次');
    assert.equal(created[0]?.kind, 'event');
    assert.equal(svc.list().length, 0, '一次性触发后删除');

    svc.onEngineEvent({ scope: 'task', id: source.id, event: 'finish_manual' });
    await svc.tick(NOW + 3);
    assert.equal(created.length, 1, '已消费的事件不再触发');

    // 重启保留：重建 timers 不能删除 cron/event 触发器。
    const cron = svc.createCron({
      name: '保留',
      projectId,
      title: '保留',
      goal: 'g',
      riskLevel: 1,
      intervalMinutes: 60,
      now: NOW,
    });
    const event = svc.createEvent({
      name: '保留事件',
      projectId,
      title: '保留事件',
      goal: 'g',
      riskLevel: 1,
      sourceTaskId: source.id,
      eventKind: 'task_completed',
      now: NOW,
    });
    assert.equal(svc.list().length, 2);
    rebuildTimers(db, [], NOW + 10);
    const kept = listTimers(db).filter((row) => row.kind === 'cron_fire' || row.kind === 'event_trigger');
    assert.deepEqual(kept.map((row) => row.id).sort((a, b) => a - b), [cron.id, event.id].sort((a, b) => a - b));
  } finally {
    db.close();
  }
});

test('GAP1 归档项目：到期 cron 删除、不建任务；事件触发同样删除', async () => {
  const { db, projectId } = setup();
  const created: Array<{ kind: string; triggerId: number }> = [];
  const svc = service(db, created);
  try {
    const cron = svc.createCron({
      name: '归档项目定时',
      projectId,
      title: '不该建',
      goal: 'g',
      riskLevel: 1,
      intervalMinutes: 5,
      now: NOW,
    });
    const source = createTask(db, new SqliteCounterStore(db), { projectId, title: '源', goal: 'g' });
    const event = svc.createEvent({
      name: '归档项目事件',
      projectId,
      title: '也不该建',
      goal: 'g',
      riskLevel: 1,
      sourceTaskId: source.id,
      eventKind: 'task_completed',
      now: NOW,
    });
    db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(projectId);
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(source.id);
    svc.onEngineEvent({ scope: 'task', id: source.id, event: 'finish_manual' });
    await svc.tick(NOW + 5 * MIN);
    assert.equal(created.length, 0, '归档项目不建任务');
    assert.equal(svc.list().length, 0, '归档项目的触发被删除');
    assert.ok(!svc.cancel(cron.id));
    assert.ok(!svc.cancel(event.id));
  } finally {
    db.close();
  }
});

test('GAP1 真库物化：cron 到点 createTask 真落行（不是只调回调）', async () => {
  const { db, projectId } = setup();
  const svc = createTriggerService({
    db,
    materialize: async (template) => {
      const task = createTask(db, new SqliteCounterStore(db), {
        projectId: template.projectId,
        title: template.title,
        goal: template.goal,
        riskLevel: template.riskLevel,
      });
      return task.id;
    },
  });
  try {
    const trigger = svc.createCron({
      name: '真任务',
      projectId,
      title: '定时真任务',
      goal: '到点新建',
      riskLevel: 1,
      intervalMinutes: 5,
      now: NOW,
    });
    await svc.tick(NOW + 5 * MIN);
    const tasks = db.prepare('SELECT id, title, goal FROM tasks ORDER BY id').all() as Array<{
      id: number;
      title: string;
      goal: string;
    }>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.title, '定时真任务');
    assert.equal(tasks[0]!.goal, '到点新建');
    assert.equal(svc.list()[0]!.lastTaskId, tasks[0]!.id);
    await svc.tick(NOW + 5 * MIN + 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1, '同拍幂等');
    assert.equal(svc.cancel(trigger.id), true);
  } finally {
    db.close();
  }
});

test('GAP1 命令解析：定时/每天/事件/列表/取消；非法不猜', () => {
  assert.deepEqual(parseTriggerCommand('定时 每30分钟 对账'), { kind: 'cron', goal: '对账', intervalMinutes: 30 });
  assert.deepEqual(parseTriggerCommand('定时 每天 09:30 写日报'), { kind: 'cron', goal: '写日报', dailyMinute: 570 });
  assert.deepEqual(parseTriggerCommand('当 T1042 完成 汇总结果'), {
    kind: 'event',
    goal: '汇总结果',
    sourceShortId: 'T-1042',
  });
  assert.deepEqual(parseTriggerCommand('触发列表'), { kind: 'list' });
  assert.deepEqual(parseTriggerCommand('取消触发 12'), { kind: 'cancel', id: 12 });
  assert.equal(parseTriggerCommand('定时 每天 25:00 x'), null);
  assert.equal(parseTriggerCommand('定时 每0分钟 x'), null);
  assert.equal(parseTriggerCommand('普通聊天'), null);
  assert.equal(
    nextTriggerDueAt({ dailyMinute: 570 }, new Date(2026, 9, 19, 8, 0).getTime()),
    new Date(2026, 9, 19, 9, 30).getTime(),
    '当天未到→当天',
  );
  assert.equal(nextTriggerDueAt({ dailyMinute: 570 }, new Date(2026, 9, 19, 10, 0).getTime()), new Date(2026, 9, 20, 9, 30).getTime(), '已过→次日');
});
