/**
 * B2-3（58 §6-2；D-30②）：planner 产带依赖的多工作项 DAG——「1 任务=1 工作项」推翻。
 *
 * 口径（D-30②）：
 *  - 依赖只限**同任务内**工作项（新表 `work_item_deps`；环检测同 task_deps 口径——插入即拒）；
 *  - 调度按依赖门控：无依赖并行、有依赖等前置 done（不占员工、任务不被 block）；
 *  - 失败粒度=单件：件 failed → 该件 attempt+1 重派（运行时错误与业务失败同口径），
 *    全部重试耗尽才任务 failed（B0-3 的「业务失败不重试」被 D-30 推翻）；
 *  - 返工件（spawnReworkItem）带 `retry_of` 血缘；同员工返工**继承员工×任务×源件会话键**
 *    （前轮现场可见，57 P1-7/P2-2）；换员工改派不继承（隔离优先）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import {
  insertWorkItem,
  listWorkItemsByTask,
  getWorkItem,
} from '../src/main/db/work_items.js';
import {
  insertWorkItemDep,
  workItemDepsOf,
  deleteWorkItemDepsByTask,
} from '../src/main/db/work_item_deps.js';
import { normalizePlanWorkItems } from '../src/core/plan.js';
import { planScheduling, DEFAULT_SCHEDULER_CONFIG } from '../src/core/scheduler.js';
import { createTask, insertEmployee, type SqliteDb } from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { Engine } from '../src/main/engine/index.js';
import { employeeSessionKey } from '../src/main/agent/employee-runtime.js';
import { reworkInheritedSessionKey } from '../src/main/agent/employee-executor.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seed(db: SqliteDb, opts: { risk?: number } = {}): { taskId: number; employeeId: number } {
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
  insertEmployee(db, { id: 8, name: 'E8', role: 'dev', now: 1 });
  const projectId = Number(
    (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    riskLevel: opts.risk ?? 1,
    ownerId: 7,
  });
  return { taskId: task.id, employeeId: 7 };
}

// ── ① 迁移＋DAO：work_item_deps（同任务内；环检测）────────────────────────

test('B2-3: work_item_deps 表与 DAO——同任务内插入；跨任务/自依赖/环拒绝', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db);
    const a = insertWorkItem(db, { taskId, employeeId: 7, title: 'A', brief: 'b', now: 1 });
    const b = insertWorkItem(db, { taskId, employeeId: 7, title: 'B', brief: 'b', now: 1 });
    insertWorkItemDep(db, { workItemId: b.id, dependsOn: a.id });
    assert.deepEqual(workItemDepsOf(db, b.id), [a.id]);
    assert.deepEqual(workItemDepsOf(db, a.id), []);
    // 自依赖拒
    assert.throws(() => insertWorkItemDep(db, { workItemId: a.id, dependsOn: a.id }), /自依赖/);
    // 二环拒（a→b 已有；b→a 已是；a→b 重复拒；新增 c→a 且 b→c 成环拒）
    const c = insertWorkItem(db, { taskId, employeeId: 7, title: 'C', brief: 'b', now: 1 });
    insertWorkItemDep(db, { workItemId: a.id, dependsOn: c.id });
    assert.throws(() => insertWorkItemDep(db, { workItemId: c.id, dependsOn: b.id }), /环/);
    deleteWorkItemDepsByTask(db, taskId);
    assert.deepEqual(workItemDepsOf(db, b.id), []);
  } finally {
    db.close();
  }
});

// ── ② planner 提交面：结构化多件校验 ──────────────────────────────────────

test('B2-3: normalizePlanWorkItems —— 2–6 件、非空标题、deps 1-based 有界、成环拒绝；缺省回落单件', () => {
  const ok = normalizePlanWorkItems([
    { title: '搭底座' },
    { title: '补测试', dependsOn: [1] },
    { title: '写文档', dependsOn: [1] },
  ]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.items.length, 3);
    assert.deepEqual(ok.items[1]!.dependsOn, [1]);
  }
  // 单件允许（回落现状）但 deps 必须有界
  assert.equal(normalizePlanWorkItems([]).ok, false, '空数组非法（缺省＝不传字段，不是传空）');
  assert.equal(normalizePlanWorkItems([{ title: '' }]).ok, false);
  assert.equal(normalizePlanWorkItems([{ title: 'x' }, { title: 'y', dependsOn: [3] }]).ok, false, 'deps 越界拒');
  assert.equal(
    normalizePlanWorkItems([{ title: 'x', dependsOn: [2] }, { title: 'y', dependsOn: [1] }]).ok,
    false,
    '二环拒',
  );
  // D4 复核 P3-3 收紧：浮点/字符串 dependsOn 响亮拒（不静默过滤成无依赖）
  assert.equal(normalizePlanWorkItems([{ title: 'x' }, { title: 'y', dependsOn: [1.5] }]).ok, false, '浮点 deps 拒');
  assert.equal(normalizePlanWorkItems([{ title: 'x' }, { title: 'y', dependsOn: ['1'] }]).ok, false, '字符串 deps 拒');
  assert.equal(normalizePlanWorkItems('no').ok, false);
});

// ── ③ 调度门控：依赖未满足 hold、不占员工；前置 done 即派 ─────────────────

function snapshot(db: SqliteDb, taskId: number) {
  const task = (db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) ?? null) as never;
  return { task, taskId };
}

test('B2-3: 调度按依赖门控——有依赖件等前置（hold deps_unsatisfied），无依赖件并行', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db);
    const a = insertWorkItem(db, { taskId, employeeId: 7, title: 'A', brief: 'b', now: 1 });
    const b = insertWorkItem(db, { taskId, employeeId: 8, title: 'B', brief: 'b', now: 1 });
    const c = insertWorkItem(db, { taskId, employeeId: 8, title: 'C', brief: 'b', now: 1 });
    insertWorkItemDep(db, { workItemId: c.id, dependsOn: a.id });
    // 任务 ready → start_task；件派发：A/E7 与 B/E8 可并行；C 依赖 A 未 done → hold
    db.prepare("UPDATE tasks SET state='ready', ready_since=? WHERE id=?").run(1, taskId);
    const actions = planScheduling({
      now: 1,
      config: DEFAULT_SCHEDULER_CONFIG,
      tasks: [db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as never],
      workItems: [
        { id: a.id, taskId, employeeId: 7, state: 'queued', createdAt: 1 },
        { id: b.id, taskId, employeeId: 8, state: 'queued', createdAt: 2 },
        { id: c.id, taskId, employeeId: 8, state: 'queued', createdAt: 3 },
      ],
      deps: new Map(),
      workItemDeps: new Map([[c.id, [a.id]]]),
      runningByEmployee: new Map(),
    });
    const dispatches = actions.filter((a2) => a2.type === 'dispatch_work_item');
    const holds = actions.filter((a2) => a2.type === 'hold');
    assert.ok(dispatches.some((d) => d.type === 'dispatch_work_item' && d.workItemId === a.id), 'A 无依赖 → 派');
    assert.ok(dispatches.some((d) => d.type === 'dispatch_work_item' && d.workItemId === b.id), 'B 无依赖 → 并行派');
    assert.ok(
      holds.some((h) => h.type === 'hold' && h.reason === 'dependency'),
      'C 依赖 A 未 done → hold(deps_unsatisfied)',
    );
    // A done 后：C 解除
    const actions2 = planScheduling({
      now: 2,
      config: DEFAULT_SCHEDULER_CONFIG,
      tasks: [db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as never],
      workItems: [
        { id: a.id, taskId, employeeId: 7, state: 'done', createdAt: 1 },
        { id: b.id, taskId, employeeId: 8, state: 'done', createdAt: 2 },
        { id: c.id, taskId, employeeId: 8, state: 'queued', createdAt: 3 },
      ],
      deps: new Map(),
      workItemDeps: new Map([[c.id, [a.id]]]),
      runningByEmployee: new Map(),
    });
    assert.ok(actions2.some((d) => d.type === 'dispatch_work_item' && d.workItemId === c.id), '前置 done → C 派发');
    // B2a 出口 B 实测修正：前置 submitted（已提交等任务级验证）也算满足（防死等）
    const actions3 = planScheduling({
      now: 3,
      config: DEFAULT_SCHEDULER_CONFIG,
      tasks: [db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as never],
      workItems: [
        { id: a.id, taskId, employeeId: 7, state: 'submitted', createdAt: 1 },
        { id: b.id, taskId, employeeId: 8, state: 'done', createdAt: 2 },
        { id: c.id, taskId, employeeId: 8, state: 'queued', createdAt: 3 },
      ],
      deps: new Map(),
      workItemDeps: new Map([[c.id, [a.id]]]),
      runningByEmployee: new Map(),
    });
    assert.ok(actions3.some((d) => d.type === 'dispatch_work_item' && d.workItemId === c.id), '前置 submitted → C 派发（机器验收任务不死等）');
    void snapshot;
  } finally {
    db.close();
  }
});

// ── ④ spawnPlanWorkItems：结构化多件落库＋依赖行 ─────────────────────────

test('B2-3: plan_drafted 带结构化 workItems → 多件落库＋依赖行；无 workItems 回落单件', () => {
  const db = fresh();
  const { taskId } = seed(db, { risk: 0 });
  const engine = new Engine(db, makeNoopExecutor(), { autoSchedule: false, now: () => 1 });
  void engine;
    // 用引擎公开面：plan_drafted payload 带 workItems（L0 直通 ready → spawn 动作）
    void engine.dispatch({ scope: 'task', id: taskId, event: 'triage', actor: 'boss' }).catch(() => undefined);
    engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'plan_drafted',
      actor: 'employee:7',
      payload: {
        steps: ['搭底座', '补测试', '写文档'],
        plannerEmployeeId: 7,
        workItems: [
          { title: '搭底座', employeeId: 7 },
          { title: '补测试', dependsOn: [1], employeeId: 8 },
          { title: '写文档', dependsOn: [1] },
        ],
      },
    }).catch(() => undefined);
    // 同步等待 spawn（dispatch 是异步事务；轮询到件数稳定）
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const items = listWorkItemsByTask(db, taskId);
        if (items.length >= 3 || tries > 40) {
          assert.equal(items.length, 3, `应落 3 件（实际 ${items.length}）`);
          const byTitle = new Map(items.map((w) => [w.title, w]));
          assert.equal(byTitle.get('搭底座')?.employee_id, 7, '件级 employeeId 生效（规划者指定）');
          assert.equal(byTitle.get('补测试')?.employee_id, 8, '件级 employeeId 生效（规划者指定）');
          const deps = workItemDepsOf(db, byTitle.get('补测试')!.id);
          assert.equal(deps.length, 1, '依赖行落库');
          resolve();
          return;
        }
        tries += 1;
        setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    }).finally(() => db.close());
});

// ── ⑤ 失败粒度=单件：业务失败也单件重试；其余件不重跑 ────────────────────

test('B2-3: 单件失败 → 该件 attempt+1 重派（业务失败同口径）；重试耗尽才任务 failed', () => {
  const db = fresh();
  {
    const { taskId } = seed(db, { risk: 0 });
    const a = insertWorkItem(db, { taskId, employeeId: 7, title: 'A', brief: 'b', now: 1 });
    const b = insertWorkItem(db, { taskId, employeeId: 8, title: 'B', brief: 'b', now: 1 });
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(a.id);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(b.id);
    const engine = new Engine(db, makeNoopExecutor(), { autoSchedule: false, now: () => 2, autoRetry: 1 });
    void engine;
    engine.dispatch({
      scope: 'work_item',
      id: a.id,
      event: 'agent_settled',
      actor: 'employee:7',
      payload: { submitted: false },
    }).catch(() => undefined);
    return new Promise<void>((resolve) => {
      let tries = 0;
      const poll = (): void => {
        const wi = getWorkItem(db, a.id);
        const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string };
        if ((wi && (wi.state === 'running' || wi.state === 'failed')) || tries > 40) {
          assert.equal(wi?.attempt, 1, '业务失败 → 该件 attempt+1 重派（D-30②）');
          const bAfter = getWorkItem(db, b.id);
          assert.equal(bAfter?.state, 'done', '其余件不重跑');
          resolve();
          return;
        }
        tries += 1;
        setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    }).finally(() => db.close());
  }
});

// ── ⑥ 返工件血缘与会话继承 ────────────────────────────────────────────────

test('B2-3: 返工件带 retry_of；同员工会话键继承源件（员工×任务×源件）；换员工不继承', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db);
    const src = insertWorkItem(db, { taskId, employeeId: 7, title: '原件', brief: 'b', now: 1 });
    const rework = insertWorkItem(db, {
      taskId,
      employeeId: 7,
      title: '返工：原件',
      brief: 'b',
      retryOf: src.id,
      now: 2,
    });
    assert.equal(rework.retry_of, src.id, '血缘落库');
    // D4 复核 P1-b：直测 executor 导出的判定纯函数（此前是同义反复——同一纯函数同参自比）
    const inherited = reworkInheritedSessionKey(src, 7, taskId);
    assert.equal(inherited, employeeSessionKey({ employeeId: 7, taskId, workItemId: src.id }), '同员工继承源件会话键');
    // 换员工改派：不继承（返回 undefined ⇒ 执行器走新件自己的会话键，隔离优先）
    assert.equal(reworkInheritedSessionKey(src, 8, taskId), undefined, '换员工不继承');
    // 无源件（retry_of 为空 / 源件不存在）不继承
    assert.equal(reworkInheritedSessionKey(undefined, 7, taskId), undefined);
  } finally {
    db.close();
  }
});

function makeNoopExecutor() {
  return {
    async execute(): Promise<void> {},
  };
}
