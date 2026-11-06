/**
 * B-1（M4）· 项目概览·定时：后端 `project:trigger-manage` 与 `TriggerService` 同源。
 *
 * 覆盖：list/create-cron/cancel、项目边界、非法调度、归档项目、事件触发源任务校验、
 * 重启保留（同库新 service 仍能列出）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTriggerCommand } from '../src/main/ipc/ipc.js';
import { handleProjectTriggerManage } from '../src/main/ipc/triggers.js';
import { createTriggerService, type TriggerService } from '../src/main/triggers/service.js';

const NOW = new Date(2026, 9, 22, 9, 0, 0).getTime();
const lastOut = (repo: ReturnType<typeof createSqliteChatRepo>): string => {
  const row = repo.listMessages({ limit: 1, latest: true })[0];
  return row && row.direction === 'out' ? row.content : '';
};

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; projectId: number; otherId: number; service: TriggerService } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: 'P', rootDir: 'D:/repo', accessMode: 'inplace', now: 1 });
  const other = repo.createProject({ name: 'Q', rootDir: 'D:/other', accessMode: 'inplace', now: 1 });
  const service = createTriggerService({
    db,
    materialize: async () => 1,
  });
  return { db, repo, projectId: project.id, otherId: other.id, service };
}

test('B-1: list 空 → 空数组；create-cron 后 list 可见且下次时间正确', () => {
  const { db, repo, projectId, service } = setup();
  try {
    const deps = { repo, triggerService: service };
    const empty = handleProjectTriggerManage(deps, { projectId, action: 'list' }, NOW);
    assert.equal(empty.ok, true);
    if (empty.ok && empty.action === 'list') assert.deepEqual(empty.triggers, []);

    const created = handleProjectTriggerManage(
      deps,
      { projectId, action: 'create-cron', goal: '每天对账', intervalMinutes: 30 },
      NOW,
    );
    assert.equal(created.ok, true);
    if (!created.ok || created.action !== 'create-cron') return assert.fail(JSON.stringify(created));
    assert.equal(created.trigger.kind, 'cron');
    assert.equal(created.trigger.goal, '每天对账');
    assert.equal(created.trigger.nextDueAt, NOW + 30 * 60_000);

    const listed = handleProjectTriggerManage(deps, { projectId, action: 'list' }, NOW);
    assert.equal(listed.ok, true);
    if (listed.ok && listed.action === 'list') {
      assert.equal(listed.triggers.length, 1);
      assert.equal(listed.triggers[0]!.id, created.trigger.id);
    }

    // 取消后不再出现在列表。
    const cancelled = handleProjectTriggerManage(deps, { projectId, action: 'cancel', id: created.trigger.id }, NOW);
    assert.equal(cancelled.ok, true);
    if (cancelled.ok && cancelled.action === 'cancel') assert.equal(cancelled.cancelled, true);
    const after = handleProjectTriggerManage(deps, { projectId, action: 'list' }, NOW);
    if (after.ok && after.action === 'list') assert.deepEqual(after.triggers, []);
  } finally {
    db.close();
  }
});

test('B-1: 与命令同源 —— 命令建出的触发在 UI list 可见；重启保留（新 service 同库仍可列出）', () => {
  const { db, repo, projectId, service } = setup();
  try {
    const commandRow = service.createCron({
      name: '命令触发',
      projectId,
      title: '命令触发',
      goal: '命令建的任务',
      riskLevel: 1,
      intervalMinutes: 60,
      now: NOW,
    });
    const deps = { repo, triggerService: service };
    const listed = handleProjectTriggerManage(deps, { projectId, action: 'list' }, NOW);
    assert.equal(listed.ok, true);
    if (listed.ok && listed.action === 'list') {
      assert.equal(listed.triggers.some((t) => t.id === commandRow.id), true, '命令建的触发必须在 UI 列表可见');
    }

    // 重启：同一 DB 新建 service（只从 timers 表重建），列表仍可见。
    const restarted = createTriggerService({ db, materialize: async () => 1 });
    const afterRestart = handleProjectTriggerManage({ repo, triggerService: restarted }, { projectId, action: 'list' }, NOW);
    assert.equal(afterRestart.ok, true);
    if (afterRestart.ok && afterRestart.action === 'list') {
      assert.equal(afterRestart.triggers.some((t) => t.id === commandRow.id), true, '触发必须重启保留');
    }
  } finally {
    db.close();
  }
});

test('B-1: 项目边界 —— list/cancel 不跨项目；别的项目 id 统一 not_found', () => {
  const { db, repo, projectId, otherId, service } = setup();
  try {
    const deps = { repo, triggerService: service };
    const a = handleProjectTriggerManage(deps, { projectId, action: 'create-cron', goal: 'A', intervalMinutes: 10 }, NOW);
    const b = handleProjectTriggerManage(deps, { projectId: otherId, action: 'create-cron', goal: 'B', intervalMinutes: 10 }, NOW);
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok || a.action !== 'create-cron' || b.action !== 'create-cron') return assert.fail('create failed');

    const listA = handleProjectTriggerManage(deps, { projectId, action: 'list' }, NOW);
    if (listA.ok && listA.action === 'list') {
      assert.deepEqual(listA.triggers.map((t) => t.id), [a.trigger.id], '只列本项目');
    }
    const cross = handleProjectTriggerManage(deps, { projectId, action: 'cancel', id: b.trigger.id }, NOW);
    assert.equal(cross.ok, false);
    if (!cross.ok) assert.equal(cross.code, 'not_found', '不得暴露/取消别的项目触发');
  } finally {
    db.close();
  }
});

test('B-1: 校验 —— 归档项目/调度二选一/非法时间/未知 action 都显式拒', () => {
  const { db, repo, projectId, service } = setup();
  try {
    const deps = { repo, triggerService: service };
    repo.archiveProject(projectId, 2);
    const archived = handleProjectTriggerManage(deps, { projectId, action: 'create-cron', goal: 'x', intervalMinutes: 10 }, NOW);
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.code, 'project_archived');

    const other = repo.createProject({ name: 'R', rootDir: 'D:/r', accessMode: 'inplace', now: 3 });
    const both = handleProjectTriggerManage(
      deps,
      { projectId: other.id, action: 'create-cron', goal: 'x', intervalMinutes: 10, dailyMinute: 60 },
      NOW,
    );
    assert.equal(both.ok, false);
    const none = handleProjectTriggerManage(deps, { projectId: other.id, action: 'create-cron', goal: 'x' }, NOW);
    assert.equal(none.ok, false);
    const badDaily = handleProjectTriggerManage(
      deps,
      { projectId: other.id, action: 'create-cron', goal: 'x', dailyMinute: 1440 },
      NOW,
    );
    assert.equal(badDaily.ok, false);
    const unknown = handleProjectTriggerManage(deps, { projectId: other.id, action: 'nope' }, NOW);
    assert.equal(unknown.ok, false);
  } finally {
    db.close();
  }
});

test('B-1: 事件触发 —— 源任务须同项目且非终态；创建后 nextDueAt=null', () => {
  const { db, repo, projectId, otherId, service } = setup();
  try {
    const deps = { repo, triggerService: service };
    const source = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '源任务',
      goal: 'g',
      riskLevel: 1,
      now: 1,
    });
    const wrong = handleProjectTriggerManage(
      deps,
      { projectId: otherId, action: 'create-event', goal: 'x', sourceTaskId: source.id },
      NOW,
    );
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, 'wrong_project');

    const created = handleProjectTriggerManage(
      deps,
      { projectId, action: 'create-event', goal: '源完成后建新任务', sourceTaskId: source.id },
      NOW,
    );
    assert.equal(created.ok, true);
    if (created.ok && created.action === 'create-event') {
      assert.equal(created.trigger.kind, 'event');
      assert.equal(created.trigger.nextDueAt, null);
      assert.equal(created.trigger.sourceTaskId, source.id);
    }

    // F-3：UI/命令常见写法 T1042 与 T-1042 等价（handler 归一，不再“找不到源任务”）。
    const normalized = handleProjectTriggerManage(
      deps,
      {
        projectId,
        action: 'create-event',
        goal: '短号无横线也要能找到源任务',
        sourceShortId: (source.short_id ?? 'T-1').replace('-', ''),
      },
      NOW,
    );
    assert.equal(normalized.ok, true);

    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(source.id);
    const terminal = handleProjectTriggerManage(
      deps,
      { projectId, action: 'create-event', goal: 'x', sourceTaskId: source.id },
      NOW,
    );
    assert.equal(terminal.ok, false);
    if (!terminal.ok) assert.equal(terminal.code, 'source_terminal');
  } finally {
    db.close();
  }
});

test('F-3 B-3：频道定时命令优先当前项目；列表/取消不跨项目', async () => {
  const { db, repo, projectId, otherId, service } = setup();
  try {
    repo.setSetting({ key: 'projects.default_id', value: projectId });
    const deps = { repo, triggerService: service };
    const created = await handleTriggerCommand(
      deps,
      { kind: 'cron', goal: '当前项目的对账', intervalMinutes: 5 },
      '定时 每5分钟 当前项目的对账',
      [],
      NOW,
      otherId,
    );
    assert.equal(created.ok, true);
    const rows = service.list();
    assert.equal(rows.filter((row) => row.projectId === otherId).length, 1, '必须写进当前项目');
    assert.equal(rows.filter((row) => row.projectId === projectId).length, 0, '不得写进默认项目');

    const list = await handleTriggerCommand(deps, { kind: 'list' }, '触发列表', [], NOW + 1, otherId);
    assert.equal(list.ok, true);
    assert.match(lastOut(repo), /当前项目的对账/);

    const otherTrigger = rows.find((row) => row.projectId === otherId);
    assert.ok(otherTrigger);
    await handleTriggerCommand(deps, { kind: 'cancel', id: otherTrigger.id }, `取消触发 ${otherTrigger.id}`, [], NOW + 2, projectId);
    assert.match(lastOut(repo), /当前项目没有触发/);
    assert.ok(service.list().some((row) => row.id === otherTrigger.id), '跨项目取消必须被拒');
  } finally {
    db.close();
  }
});

test('F-4 P-05：无当前项目时触发列表列全部并标注项目', async () => {
  const { db, repo, projectId, otherId, service } = setup();
  try {
    const deps = { repo, triggerService: service };
    await handleTriggerCommand(deps, { kind: 'cron', goal: 'P 的对账', intervalMinutes: 5 }, '定时 每5分钟 P 的对账', [], NOW, projectId);
    await handleTriggerCommand(deps, { kind: 'cron', goal: 'Q 的日报', intervalMinutes: 10 }, '定时 每10分钟 Q 的日报', [], NOW, otherId);
    const list = await handleTriggerCommand(deps, { kind: 'list' }, '触发列表', [], NOW + 1, null);
    assert.equal(list.ok, true);
    const text = lastOut(repo);
    assert.match(text, /P 的对账/);
    assert.match(text, /Q 的日报/);
    assert.match(text, /项目 P/);
    assert.match(text, /项目 Q/);
  } finally {
    db.close();
  }
});

test('F-3 B-3：归档项目里禁止新建触发（命令与 UI 同口径）', async () => {
  const { db, repo, projectId, service } = setup();
  try {
    repo.archiveProject(projectId, 2);
    const result = await handleTriggerCommand(
      { repo, triggerService: service },
      { kind: 'cron', goal: '归档后不该建', intervalMinutes: 5 },
      '定时 每5分钟 归档后不该建',
      [],
      NOW,
      projectId,
    );
    assert.equal(result.ok, true);
    assert.match(lastOut(repo), /项目已归档/);
    assert.equal(service.list().filter((row) => row.projectId === projectId).length, 0);
  } finally {
    db.close();
  }
});
