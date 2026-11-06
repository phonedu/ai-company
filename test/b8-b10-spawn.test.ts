/**
 * B8（`renew` → 建新任务）+ B10（`verifying --verification_completed(fail)--> 建新 work item`）测试。
 *
 * 机制：spawn 分两段 —— ①事务内：迁移落事件 + 登记**幂等 spawn 动作**；
 * ②事务外：引擎内置处理器用 db 写入器真建对象（`createTask`/`insertWorkItem` 自开事务，
 * 短号必须独立提交，不能嵌套）。幂等由 `action_log` 键保证（重放/二次点击不重复建）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SqliteCounterStore,
  MAX_TASK_DEPTH,
  setProjectDefaultBudget,
  createTask,
  getAction,
  getTaskById,
  getWorkItem,
  insertTaskEvent,
  insertWorkItem,
  listTaskEvents,
  listWorkItemsByTask,
  openMemoryDatabase,
  runMigrations,
  updateTask,
  updateWorkItem,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function setup(): { db: SqliteDb; projectId: number; employeeId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db
      .prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/tmp/p', 1)")
      .run().lastInsertRowid,
  );
  const employeeId = Number(
    db.prepare("INSERT INTO employees(id, name, role, persona, created_at) VALUES(7, '小工', 'dev', 'x', 1)").run()
      .lastInsertRowid,
  );
  return { db, projectId, employeeId };
}

const renewables = (db: SqliteDb, oldId: number) =>
  db.prepare('SELECT * FROM tasks WHERE renewed_from = ?').all(oldId) as Array<{
    id: number;
    short_id: string;
    title: string;
    goal: string;
    acceptance: string;
    project_id: number;
    risk_level: number;
    priority: number;
    owner_id: number | null;
    origin: string;
  }>;

test('B8: `renew` 建续办任务 —— 继承语境（project/title(续)/goal/acceptance/risk/priority）、不继承承诺（deps/owner）', async () => {
  const { db, projectId } = setup();
  try {
    const old = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '对账单',
      goal: '把术语统一为「对账单」',
      acceptance: [{ text: '术语统一' }, { text: '回归绿' }],
      riskLevel: 2,
      priority: 5,
      ownerId: 7,
      state: 'done',
      now: 1,
    });
    // 旧任务挂了依赖（**不该**被续办继承）
    db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?, ?)').run(old.id, old.id);
    // v19：续办也是新任务，未显式预算时应继承项目默认
    setProjectDefaultBudget(db, { projectId, budgetTokens: 700 });

    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    await engine.dispatch({ scope: 'task', id: old.id, event: 'renew', actor: 'boss' });

    // ① 事务内：`task_renewed` 落旧任务（载荷 = 触发事件载荷；链路字段见下方新任务事件）
    const renewed = listTaskEvents(db, old.id).filter((e) => e.kind === 'task_renewed');
    assert.equal(renewed.length, 1, '事务内应落一条 task_renewed');
    assert.ok(getAction(db, `renew:task:${old.id}:0`), '幂等键 renew:task:<oldId>:0 必须登记（spawn 已执行→done）');

    // ② 事务外：真建了新任务，字段按 (c) 裁定
    const children = renewables(db, old.id);
    assert.equal(children.length, 1, '应恰有一个续办任务');
    const kid = children[0]!;
    assert.equal(kid.title, '对账单（续）');
    assert.equal(kid.project_id, projectId, '继承 project');
    assert.equal(kid.goal, '把术语统一为「对账单」', '继承 goal');
    assert.deepEqual(JSON.parse(kid.acceptance), [{ text: '术语统一' }, { text: '回归绿' }], '继承 acceptance');
    assert.equal(kid.risk_level, 2, '继承 risk_level');
    assert.equal(kid.priority, 5, '继承 priority');
    assert.equal(kid.origin, 'renew');
    assert.equal((kid as { budget_tokens?: number | null }).budget_tokens, 700, '续办继承项目默认预算');
    assert.equal(kid.owner_id, null, '**不继承 owner**（续办重走 triage/plan）');
    assert.match(kid.short_id, /^T-/, '新短号');
    assert.notEqual(kid.short_id, old.short_id, '短号不复用');
    // ②b 链路：新任务上补的 `task_renewed` 携带 parentTaskId / renewedFrom(S+F)，旧任务侧可反查
    const link = listTaskEvents(db, kid.id).filter((e) => e.kind === 'task_renewed');
    assert.equal(link.length, 1, '新任务应有链路事件');
    assert.deepEqual(JSON.parse(String(link[0]!.payload)), {
      renewedFrom: old.id,
      renewedFromShortId: old.short_id,
      parentTaskId: old.id,
    });
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM task_deps WHERE task_id = ?').get(kid.id) as { n: number }).n,
      0,
      '**不继承 task_deps**',
    );

    // ③ 幂等：再点一次续办 ⇒ 不得开出第二个续办任务
    await engine.dispatch({ scope: 'task', id: old.id, event: 'renew', actor: 'boss' });
    assert.equal(renewables(db, old.id).length, 1, '同一旧任务最多续办一次（第二次被 OR IGNORE 拦下）');

    // ③b 有牙（键层、确定性）：把幂等键删掉（模拟“守卫被拆”）⇒ 二次续办**真会**开出第二个
    db.prepare('DELETE FROM action_log WHERE action_key = ?').run(`renew:task:${old.id}:0`);
    await engine.dispatch({ scope: 'task', id: old.id, event: 'renew', actor: 'boss' });
    assert.equal(renewables(db, old.id).length, 2, '移除幂等键后确实会再建 ⇒ 幂等键是真正的守卫');
  } finally {
    db.close();
  }
});

test('B10: `verifying` 打回（verdict=fail）建新 work item（批注成 brief、owner=实现者、attempt=0、queued）；pass 不建', async () => {
  const { db, employeeId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId: 1,
      title: 'T',
      goal: 'g',
      riskLevel: 2,
      state: 'verifying',
      now: 1,
    });
    const src = insertWorkItem(db, { taskId: task.id, employeeId, title: '实现', brief: 'b', now: 1 });
    updateWorkItem(db, src.id, { state: 'submitted', finished_at: 2 });

    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'verification_completed',
      actor: 'employee:9',
      payload: { verdict: 'fail', workItemId: src.id, notes: '批注：按钮文案应为「对账单」' },
    });

    const items = listWorkItemsByTask(db, task.id);
    assert.equal(items.length, 2, '打回应生成一个新工作项');
    const rework = items.find((w) => w.id !== src.id)!;
    assert.equal(rework.state, 'queued');
    assert.equal(rework.employee_id, employeeId, 'owner = 实现者');
    assert.equal(rework.attempt, 0);
    assert.match(rework.brief, /按钮文案应为「对账单」/, 'brief = 验证者批注');
    // 幂等键
    assert.ok(getAction(db, `spawn_work_item:work_item:${src.id}:0`), 'spawn 幂等键');
    assert.equal(getTaskById(db, task.id)?.state, 'executing', '打回后任务回 executing');

    // 再打回同一个源工作项 ⇒ 不重复建（同键被拦）——打回后任务已回 executing，先置回 verifying
    updateTask(db, task.id, { state: 'verifying' }, 3);
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'verification_completed',
      actor: 'employee:9',
      payload: { verdict: 'fail', workItemId: src.id, notes: '重复打回' },
    });
    assert.equal(listWorkItemsByTask(db, task.id).length, 2, '同源工作项只生成一个返工项');

    // pass ⇒ 不建新 wi（guard 挡住另一条迁移行）
    const task2 = createTask(db, new SqliteCounterStore(db), {
      projectId: 1,
      title: 'T2',
      goal: 'g',
      riskLevel: 2,
      state: 'verifying',
      now: 1,
    });
    const src2 = insertWorkItem(db, { taskId: task2.id, employeeId, title: '实现2', brief: 'b', now: 1 });
    updateWorkItem(db, src2.id, { state: 'submitted', finished_at: 2 });
    await engine.dispatch({
      scope: 'task',
      id: task2.id,
      event: 'verification_completed',
      actor: 'employee:9',
      payload: { verdict: 'pass', workItemId: src2.id },
    });
    assert.equal(listWorkItemsByTask(db, task2.id).length, 1, 'pass 不得建返工项');
    assert.equal(getTaskById(db, task2.id)?.state, 'done');
  } finally {
    db.close();
  }
});

test('B10 有牙（键层）：清掉 spawn 幂等键后同源再打回 ⇒ 会再建一个（证明幂等键真在挡）', async () => {
  const { db, employeeId } = setup();
  try {
    const task = createTask(db, new SqliteCounterStore(db), {
      projectId: 1,
      title: 'T',
      goal: 'g',
      riskLevel: 2,
      state: 'verifying',
      now: 1,
    });
    const src = insertWorkItem(db, { taskId: task.id, employeeId, title: '实现', brief: 'b', now: 1 });
    updateWorkItem(db, src.id, { state: 'submitted', finished_at: 2 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    const fail = () =>
      engine.dispatch({
        scope: 'task',
        id: task.id,
        event: 'verification_completed',
        actor: 'employee:9',
        payload: { verdict: 'fail', workItemId: src.id, notes: 'x' },
      });
    await fail();
    assert.equal(listWorkItemsByTask(db, task.id).length, 2);
    // 把幂等键删掉（模拟"守卫被拆"）→ 同一源再打回必须能再建（否则说明测试没牙）
    db.prepare('DELETE FROM action_log WHERE action_key = ?').run(`spawn_work_item:work_item:${src.id}:0`);
    updateTask(db, task.id, { state: 'verifying' }, 3);
    await fail();
    assert.equal(listWorkItemsByTask(db, task.id).length, 3, '移除幂等键后确实会再建 ⇒ 幂等键是真正的守卫');
    void insertTaskEvent;
  } finally {
    db.close();
  }
});

// ── 件 B（P20 后半）：拆分深度上限 —— 子任务不再拆子任务 ──────────────────────────

test('件 B: 拆分深度上限 —— 根→子允许（深度 2）；子→孙 被拒（人话原因 ＆ action_failed 留痕 ＆ 不建行 ＆ 不烧短号）', async () => {
  const { db, projectId } = setup();
  try {
    const root = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '根任务',
      goal: 'g',
      state: 'done',
      now: 1,
    });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100, autoSchedule: false });
    await engine.dispatch({ scope: 'task', id: root.id, event: 'renew', actor: 'boss' });
    const child = renewables(db, root.id)[0]!;
    assert.equal(
      (db.prepare('SELECT parent_task_id p FROM tasks WHERE id = ?').get(child.id) as { p: number }).p,
      root.id,
      '深度 1→2 允许（根 → 子）',
    );

    // 库里先记下短号计数（拒绝不得烧号）
    const before = Number((db.prepare("SELECT value FROM counters WHERE name = 'task_short_id'").get() as { value: string }).value);

    // 子任务 done → 再续办 ⇒ 拒（深度上限）
    updateTask(db, child.id, { state: 'done' }, 2);
    await engine.dispatch({ scope: 'task', id: child.id, event: 'renew', actor: 'boss' });

    // ① 不建孙任务
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id = ?').get(child.id) as { n: number }).n,
      0,
      '子任务不得再拆子任务（深度上限 2）',
    );
    // ② 可见：拒在子任务上落 action_failed，携带人话原因（不静默）
    const failed = listTaskEvents(db, child.id).filter((e) => e.kind === 'action_failed');
    assert.equal(failed.length, 1, '拒绝必须留痕（action_failed）');
    const payload = JSON.parse(String(failed[0]!.payload)) as { error: string; kind: string };
    assert.equal(payload.kind, 'renew');
    assert.match(payload.error, /拆分深度上限/, `原因是人话（含规则名；实际：${payload.error}）`);
    assert.match(payload.error, new RegExp(child.short_id), '原因里点名是哪个子任务');
    // ③ 动作记为 failed（markActionFailed）→ 不重试、不反复抛
    assert.equal(getAction(db, `renew:task:${child.id}:0`)?.state, 'failed', '动作已置 failed（不重试）');
    // ④ 拒绝不烧短号（校验在分配前）
    const after = Number((db.prepare("SELECT value FROM counters WHERE name = 'task_short_id'").get() as { value: string }).value);
    assert.equal(after, before, '被拒的续办不得消耗短号');
    assert.equal(MAX_TASK_DEPTH, 2, '上限值是 2（根 → 子）');
  } finally {
    db.close();
  }
});

test('件 B 有牙：绕过 `createTask` 直接 SQL 插三代 ⇒ 库结构本身不拦（证明拒绝确来自显式校验，而非约束）', () => {
  const { db, projectId } = setup();
  try {
    const root = createTask(db, new SqliteCounterStore(db), { projectId, title: '根', goal: 'g', state: 'done', now: 1 });
    const child = createTask(db, new SqliteCounterStore(db), {
      projectId,
      title: '子',
      goal: 'g',
      state: 'done',
      parentTaskId: root.id,
      now: 2,
    });

    // 显式校验拦得住
    assert.throws(
      () => createTask(db, new SqliteCounterStore(db), { projectId, title: '孙', goal: 'g', parentTaskId: child.id, now: 3 }),
      /拆分深度上限/,
      'createTask 必须拒（深度 3）',
    );

    // 有牙：裸 SQL 插三代**成功** → 说明上面那次拒绝确实来自 createTask 的显式校验，不是 SQL 层的 CHECK/触发器
    db.prepare(
      `INSERT INTO tasks (short_id, project_id, title, goal, acceptance, state, priority, risk_level, created_at, updated_at, parent_task_id)
       VALUES ('T-9999', ?, '孙（裸插）', 'g', '[]', 'inbox', 0, 1, 4, 4, ?)`,
    ).run(projectId, child.id);
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id = ?').get(child.id) as { n: number }).n,
      1,
      '库结构不拦三代 ⇒ 唯一守门人＝createTask 的显式校验（本测试证明它有牙）',
    );
  } finally {
    db.close();
  }
});
