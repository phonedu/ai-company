/**
 * M2 尾（D4 依赖写入面 ＋ deadline 透传）——真库断言：
 *  - 建任务可带 deadline（DTO/DB 同源）；
 *  - 建任务可带 dependsOn（同事务落 `task_deps` ＋ `dependency_added` 审计）；
 *  - 加依赖判环（A→B 后 B→A 被拒，不落库）、幂等、依赖不存在拒绝；
 *  - 频道命令 `依赖 T1042 T1001` / `移除依赖 …` 走同一守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listTaskEvents,
  listTaskSnapshots,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { planScheduling } from '../src/core/scheduler.js';
import { listTaskDependencies, wouldCreateDependencyCycle } from '../src/main/db/task_deps.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  handleDependencyCommand,
  handleTaskCreate,
  parseDependencyCommand,
  type IpcDeps,
} from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(0, '幕僚长', 'assistant', 1)").run();
  return { db, deps: { repo: createSqliteChatRepo(db) } };
}

test('M2 尾：建任务 deadline 透传（DB ＋ DTO 同源）', async () => {
  const { db, deps } = setup();
  const created = await handleTaskCreate(deps, { goal: '带截止时间的任务', deadline: AT + 86_400_000 });
  assert.equal(created.deadline, AT + 86_400_000);
  const row = db.prepare('SELECT deadline FROM tasks WHERE id = ?').get(created.id) as { deadline: number | null };
  assert.equal(row.deadline, AT + 86_400_000);
  db.close();
});

test('M2 尾：建任务可带依赖（task_deps ＋ dependency_added 审计）', async () => {
  const { db, deps } = setup();
  const first = await handleTaskCreate(deps, { goal: '前置任务' });
  const second = await handleTaskCreate(deps, { goal: '后续任务', dependsOn: [first.id] });
  assert.deepEqual(listTaskDependencies(db, second.id), [first.id]);
  const events = listTaskEvents(db, second.id).filter((e) => e.kind === 'dependency_added');
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(String(events[0]?.payload)), { taskId: second.id, dependsOn: first.id });
  db.close();
});

test('M2 尾：依赖判环（A→B 后 B→A 被拒，不落库）＋ 幂等', async () => {
  const { db, deps } = setup();
  const a = await handleTaskCreate(deps, { goal: 'A' });
  const b = await handleTaskCreate(deps, { goal: 'B', dependsOn: [a.id] });
  assert.equal(wouldCreateDependencyCycle(db, a.id, b.id), true, 'B 已依赖 A ⇒ A 再依赖 B 成环');

  const cycle = deps.repo.addTaskDependency({ taskId: a.id, dependsOn: b.id, actor: 'boss', now: AT });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'cycle');
  assert.deepEqual(listTaskDependencies(db, a.id), [], '环被拒后不落库');
  assert.equal(
    listTaskEvents(db, a.id).filter((e) => e.kind === 'dependency_added').length,
    0,
    '环被拒后不留审计假事件',
  );

  const again = deps.repo.addTaskDependency({ taskId: b.id, dependsOn: a.id, actor: 'boss', now: AT + 1 });
  assert.equal(again.ok, true);
  assert.equal(again.added, false, '重复依赖幂等（不重复写）');
  assert.equal(
    listTaskEvents(db, b.id).filter((e) => e.kind === 'dependency_added').length,
    1,
    '幂等不重复审计',
  );
  db.close();
});

test('M2 尾：依赖任务不存在 → 建任务响亮拒且不落行', async () => {
  const { db, deps } = setup();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  await assert.rejects(() => handleTaskCreate(deps, { goal: '依赖幽灵任务', dependsOn: [9999] }), /依赖任务不存在/);
  const after = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  assert.equal(after, before, '拒绝后不落任务行');
  db.close();
});

test('M2 尾：频道命令解析与执行（依赖 / 移除依赖）', async () => {
  const { db, deps } = setup();
  const a = await handleTaskCreate(deps, { goal: 'A' });
  const b = await handleTaskCreate(deps, { goal: 'B' });
  const parsed = parseDependencyCommand('依赖 T1002 T1001, T1003');
  assert.deepEqual(parsed, { shortId: 'T-1002', dependsOn: ['T-1001', 'T-1003'], remove: false });
  assert.equal(parseDependencyCommand('移除依赖 T1002 T1001')?.remove, true);

  const addCmd = parseDependencyCommand(`依赖 ${b.shortId} ${a.shortId}`);
  assert.ok(addCmd);
  const addRes = handleDependencyCommand(deps, addCmd, `依赖 ${b.shortId} ${a.shortId}`, [], AT);
  assert.ok(addRes);
  assert.deepEqual(listTaskDependencies(db, b.id), [a.id]);
  const out = deps.repo
    .listMessages({ taskId: b.id, limit: 10 })
    .find((m) => m.direction === 'out' && m.content.includes('已加上依赖'));
  assert.ok(out, '回执点名已加上依赖');

  const rmCmd = parseDependencyCommand(`移除依赖 ${b.shortId} ${a.shortId}`);
  assert.ok(rmCmd);
  handleDependencyCommand(deps, rmCmd, `移除依赖 ${b.shortId} ${a.shortId}`, [], AT + 1);
  assert.deepEqual(listTaskDependencies(db, b.id), []);
  db.close();
});

test('M2 尾：依赖未满足的 ready 任务被调度器真阻塞；依赖完成后激活', async () => {
  const { db, deps } = setup();
  const a = await handleTaskCreate(deps, { goal: 'A 前置' });
  const b = await handleTaskCreate(deps, { goal: 'B 后置', dependsOn: [a.id] });
  db.prepare("UPDATE tasks SET state = 'ready' WHERE id IN (?, ?)").run(a.id, b.id);
  const input = () => ({
    now: AT,
    tasks: listTaskSnapshots(db),
    workItems: [],
    deps: new Map([[b.id, [a.id]]]),
    runningByEmployee: new Map(),
  });
  const first = planScheduling(input());
  assert.ok(
    first.some((x) => x.type === 'block_task' && x.taskId === b.id),
    'B 依赖 A 未完成 → 调度器必须发 block_task（ready→blocked）',
  );
  assert.equal(
    first.some((x) => x.type === 'start_task' && x.taskId === b.id),
    false,
    '依赖未满足不得开工（有牙）',
  );

  db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(a.id);
  db.prepare("UPDATE tasks SET state = 'blocked' WHERE id = ?").run(b.id);
  const second = planScheduling(input());
  assert.ok(
    second.some((x) => x.type === 'activate_task' && x.taskId === b.id),
    '依赖完成 → B 被激活回 ready',
  );
  db.close();
});
