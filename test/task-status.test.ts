/**
 * MP1-F18：幕僚长只读任务状态查询（`task_status` 的数据面）。
 *
 * 背景（2026-10-26 S6 包发现）：老板问「T-xxxx 什么状态」是高频路径，但幕僚长没有任务状态查询
 * 工具、strict 又拦 bash ⇒ 只能如实答「查不到」。修法：给幕僚长一个**只读**快照工具，
 * 直读真库（与 task:get 同源数据），不臆造、不写任何数据。
 *
 * 判据：
 * ① 短号/纯数字/id 三种引用都能查；查无 → null（工具层转「没找到」话术）；
 * ② 快照含：状态（码＋中文）、项目/负责人、计划进度、最近汇报 TL;DR、成本、等待原因；
 * ③ 等待原因从真库算（排队件×员工占用 → 「等员工空闲 @占用任务短号」——与调度器同源输入）；
 * ④ 空字段一律 —（不摆假 0）；已归档任务标注「已归档」；
 * ⑤ 只读：查询前后 task_events/human_messages 零新增。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { normalizeTaskRef, taskStatusSnapshot } from '../src/main/agent/task-status.js';

const AT = 1_790_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(0,'幕僚长','assistant',1,1,?)").run(AT);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(7,'员工七','dev',0,1,?)").run(AT);
  let pi = 0;
  for (const [name, dir] of [['项目A', 'D:/r/a'], ['项目B', 'D:/r/b']] as const) {
    db.prepare('INSERT INTO projects(id,name,root_dir,created_at) VALUES(?,?,?,?)').run(100 + pi, name, dir, AT);
    pi += 1;
  }
  const task = (id: number, shortId: string, projectId: number, title: string, state: string, risk = 0, archived = 0) =>
    db
      .prepare(
        `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, owner_id, origin, archived, created_at, updated_at)
         VALUES(?,?,?,?,'g','[]',?,0,?,7,'boss',?,?,?)`,
      )
      .run(id, shortId, projectId, title, state, risk, archived, AT, AT);
  task(1, 'T-1001', 100, 'A 已完成任务', 'done');
  task(2, 'T-1002', 101, 'B 排队中的任务', 'executing', 2);
  task(3, 'T-1003', 100, 'A 占用员工的任务', 'executing');
  task(4, 'T-1004', 100, '已归档任务', 'done', 0, 1);
  // 计划步骤（T-1001 全完；T-1002 一步进行中）
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(1,1,?,?,?,?)').run('计算 3+4', 'done', AT, AT);
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(1,2,?,?,?,?)').run('汇报结论', 'done', AT, AT);
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(2,1,?,?,?,?)').run('核对输入', 'running', AT, AT);
  // 最近汇报（T-1001）
  db.prepare("INSERT INTO reports(task_id,kind,payload,state,dedupe_key,created_at) VALUES(1,'report',?,'delivered','t:1',?)").run(
    JSON.stringify({ title: 'A 已完成任务完成', tldr: '产物已交付；结论 7。', summary: '完成。' }),
    AT + 1000,
  );
  // 成本（T-1001 两笔）
  db.prepare('INSERT INTO costs(task_id, project_id, employee_id, model, usd, tokens_in, tokens_out, created_at) VALUES(1,100,7,?,0.001,100,10,?)').run('m', AT);
  db.prepare('INSERT INTO costs(task_id, project_id, employee_id, model, usd, tokens_in, tokens_out, created_at) VALUES(1,100,7,?,0.002,200,20,?)').run('m', AT);
  // 工作项：T-1003 的件在员工 7 上 running；T-1002 的件 queued（同一员工 → 等 employee_busy）
  db.prepare('INSERT INTO work_items(task_id, employee_id, title, brief, state, attempt, created_at, started_at) VALUES(3,7,?,?,?,0,?,?)').run('w3', 'b', 'running', AT, AT);
  db.prepare('INSERT INTO work_items(task_id, employee_id, title, brief, state, attempt, created_at) VALUES(2,7,?,?,?,0,?)').run('w2', 'b', 'queued', AT);
  return db;
}

test('task-status：normalizeTaskRef 接受 T-1002 / t1002 / 1002 三种引用', () => {
  assert.deepEqual(normalizeTaskRef(' T-1002 '), { shortId: 'T-1002' });
  assert.deepEqual(normalizeTaskRef('t1002'), { shortId: 'T-1002' });
  assert.deepEqual(normalizeTaskRef('1002'), { id: 1002 });
  assert.equal(normalizeTaskRef('随便说'), null);
});

test('task-status：已完成任务快照（状态/项目/计划/汇报/成本齐全，空字段 —）', () => {
  const db = setup();
  try {
    const snap = taskStatusSnapshot(db, 'T-1001');
    assert.ok(snap, 'T-1001 应命中');
    assert.equal(snap.shortId, 'T-1001');
    assert.match(snap.text, /T-1001/);
    assert.match(snap.text, /done（已完成）/);
    assert.match(snap.text, /项目A/);
    assert.match(snap.text, /员工七/);
    assert.match(snap.text, /2\/2 已完/);
    assert.match(snap.text, /产物已交付；结论 7。/);
    assert.match(snap.text, /\$0\.0030（2 笔）/);
    assert.match(snap.text, /等待：—/);
  } finally {
    db.close();
  }
});

test('task-status：排队任务带等待原因（等员工空闲＠占用任务短号，真库推导）', () => {
  const db = setup();
  try {
    const snap = taskStatusSnapshot(db, 't1002');
    assert.ok(snap);
    assert.match(snap.text, /executing（进行中）/);
    assert.match(snap.text, /项目B/);
    assert.match(snap.text, /0\/1 已完/);
    assert.match(snap.text, /等员工空闲 @T-1003/);
  } finally {
    db.close();
  }
});

test('task-status：查无 → null；已归档 → 标注；纯数字 id 引用可用', () => {
  const db = setup();
  try {
    assert.equal(taskStatusSnapshot(db, 'T-9999'), null);
    const byId = taskStatusSnapshot(db, '2');
    assert.ok(byId && byId.shortId === 'T-1002', '纯数字按任务 id 查');
    const archived = taskStatusSnapshot(db, 'T-1004');
    assert.match(archived?.text ?? '', /已归档/);
  } finally {
    db.close();
  }
});

test('task-status：只读——查询前后事件/消息零新增', () => {
  const db = setup();
  try {
    const before = {
      events: db.prepare('SELECT COUNT(*) n FROM task_events').get() as { n: number },
      messages: db.prepare('SELECT COUNT(*) n FROM human_messages').get() as { n: number },
    };
    for (const ref of ['T-1001', 'T-1002', 'T-9999']) taskStatusSnapshot(db, ref);
    const after = {
      events: db.prepare('SELECT COUNT(*) n FROM task_events').get() as { n: number },
      messages: db.prepare('SELECT COUNT(*) n FROM human_messages').get() as { n: number },
    };
    assert.equal(after.events.n, before.events.n, 'task_events 不得新增');
    assert.equal(after.messages.n, before.messages.n, 'human_messages 不得新增');
  } finally {
    db.close();
  }
});

test('task-status 工具壳：名称与查无话术（注册契约）', async () => {
  const { createTaskStatusTool } = await import('../src/main/agent/task-status-tool.js');
  const db = setup();
  try {
    const tool = (await createTaskStatusTool(db)) as unknown as {
      name: string;
      execute(id: string, params: { task: string }): Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    assert.equal(tool.name, 'task_status');
    const miss = await tool.execute('x', { task: 'T-9999' });
    assert.match(miss.content[0]!.text, /没找到任务 T-9999/);
    const hit = await tool.execute('x', { task: 'T-1001' });
    assert.match(hit.content[0]!.text, /done（已完成）/);
  } finally {
    db.close();
  }
});

// ── RW-15（M5 真机带回）：done 快照与计划步骤口径矛盾必须写明，防止读快照的模型误判 ──

test('RW-15: done 但计划未全执行 → 快照带口径说明（不再自相矛盾）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(0,'幕僚长','assistant',1,1,?)").run(AT);
  db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(?,?,?,?)").run(100, 'P', 'D:/p', AT);
  db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, owner_id, origin, archived, created_at, updated_at)
     VALUES(20,'T-1020',100,'合并模型任务','g','[]','done',0,1,0,'boss',0,?,?)`,
  ).run(AT, AT);
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(20,1,?, ?, ?, ?)').run('第一步', 'done', AT, AT);
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(20,2,?, ?, ?, ?)').run('第二步', 'pending', AT, AT);
  db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(20,3,?, ?, ?, ?)').run('第三步', 'pending', AT, AT);

  const snap = taskStatusSnapshot(db, 'T-1020');
  assert.ok(snap);
  assert.match(snap!.text, /口径说明/, 'done＋未全执行时必须带口径说明');
  assert.match(snap!.text, /合并模型/, '口径说明必须点明合并模型语义');
  assert.match(snap!.text, /剩余 2 步/, '必须写明剩余步数');

  // 反例：全部步骤已完成的 done 不加说明
  db.prepare('UPDATE plan_steps SET state = ? WHERE task_id = 20 AND idx = 2').run('done');
  db.prepare('UPDATE plan_steps SET state = ? WHERE task_id = 20 AND idx = 3').run('done');
  const full = taskStatusSnapshot(db, 'T-1020');
  assert.doesNotMatch(full!.text, /口径说明/, '全执行完成的 done 不需要口径说明');
  db.close();
});
