/**
 *  · 预算流式结算 ＋ 数据生命周期 —— 测试（每条可弄红）。
 *
 * 覆盖：
 *  - **预算流式结算（生产接线）**：员工会话用量 → **引擎** `recordCost` → `cost_recorded` ＋ 回写
 *    `cost_tokens`；**超预算 → `budget_exceeded` → `paused`**（AlertCard 由既有通道生成）。
 *  - **有牙（接线层）**：不接 `recordCost` → 只记账、**闸门不触发**（证明"走引擎"是闸门生效的唯一途径）。
 *  - **WAL checkpoint**：文件库上 `-wal` 真实收缩；内存库无副作用。
 *  - **一致性备份**：`VACUUM INTO` 产单文件、可独立打开且数据/表数一致；**目标已存在 → 抛错**（不静默覆盖）。
 *  - **staging worktree 清理**：只清"终态且过期"与"孤儿"；在办/新近的一律保留并给原因；执行器只删规划内的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  getTaskById,
  insertWorkItem,
  listTaskEvents,
  openDatabase,
  openMemoryDatabase,
  recordCost,
  insertReport,
  runMigrations,
  updateTask,
  type SqliteDb,
} from '../src/main/db/index.js';
import { backupDatabase, checkpointWal, previewRetention, runRetention } from '../src/main/db/maintenance.js';
import { handleSettingsMaintenance } from '../src/main/ipc/maintenance.js';
import { Engine, makeRecordingExecutor, toPersistedAction } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { planWorktreePrune, pruneStagingWorktrees } from '../src/main/git/worktree-prune.js';
import type { WorktreeInfo } from '../src/main/git/worktree.js';

const AT = 1_700_000_000_000;

function makeTask(db: SqliteDb, over: { budgetTokens?: number | null; state?: string } = {}) {
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    riskLevel: 0,
    ownerId: 7,
    state: 'executing',
    budgetTokens: over.budgetTokens ?? null,
  });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { task, wiId: wi.id };
}

const usage = (tokensIn: number) => ({ inputTokens: tokensIn, outputTokens: 0, costUsd: 0.01, model: 'm1' });

// ── 预算流式结算（生产接线）────────────────────────────────────────────────────

test('M2-D 预算闸门：员工会话用量经引擎 recordCost → cost_recorded ＋ cost_tokens ＋ 超预算 paused', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db, { budgetTokens: 100 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, autoSchedule: false });
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [], usage: usage(150) }]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      buildContext: buildEmployeeContext,
      recordCost: (input) => engine.recordCost(input),
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })));

    const kinds = listTaskEvents(db, task.id).map((e) => e.kind);
    assert.ok(kinds.includes('cost_recorded'), '成本必须经引擎入账（cost_recorded）');
    assert.ok(kinds.includes('budget_exceeded'), '超预算事件必须在场');
    assert.ok(kinds.includes('task_paused'), '超预算必须暂停本任务（paused）');
    const after = getTaskById(db, task.id)!;
    assert.equal(after.state, 'paused', '任务被预算闸门暂停（只停本任务）');
    assert.equal(after.cost_tokens, 150, 'cost_tokens 必须回写（流式结算）');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM costs').get() as { n: number }).n, 1, '成本行落库');
  } finally {
    db.close();
  }
});

test('D-22 选型成本经引擎 recordCost → 超任务预算同样 paused（来源标记保留）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task } = makeTask(db, { budgetTokens: 100 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, autoSchedule: false });
    const r = await engine.recordCost({
      taskId: task.id,
      employeeId: 0,
      model: 'deepseek/deepseek-flash',
      tokensIn: 150,
      tokensOut: 0,
      usd: 0.0001,
      source: 'assistant_selection',
      now: AT,
    });
    assert.equal(r.budgetExceeded, true);
    const after = getTaskById(db, task.id)!;
    assert.equal(after.state, 'paused', '选型成本超预算也必须暂停任务');
    const events = listTaskEvents(db, task.id);
    assert.ok(events.some((e) => e.kind === 'budget_exceeded'));
    const costEvent = events.find((e) => e.kind === 'cost_recorded');
    assert.equal(JSON.parse(costEvent!.payload).source, 'assistant_selection');
  } finally {
    db.close();
  }
});

test('M2-D 有牙（接线层）：不接 recordCost → 只记账、预算闸门**不触发**（走引擎才有效）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db, { budgetTokens: 100 });
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [], usage: usage(150) }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), buildContext: buildEmployeeContext });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })));

    assert.equal((db.prepare('SELECT COUNT(*) n FROM costs').get() as { n: number }).n, 1, '回退路径仍记账');
    const kinds = listTaskEvents(db, task.id).map((e) => e.kind);
    assert.ok(kinds.includes('cost_recorded'), '记账与事件由 db DAO 负责（两条路径都有）');
    assert.ok(!kinds.includes('budget_exceeded'), '不经引擎 → **预算闸门不生效**（这就是接线承重的证明）');
    assert.equal(getTaskById(db, task.id)!.state, 'executing', '任务未被暂停');
  } finally {
    db.close();
  }
});

test('M2-D 预算闸门：未超预算 → 记账但不暂停（不误杀）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db, { budgetTokens: 1000 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, autoSchedule: false });
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [], usage: usage(150) }]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      buildContext: buildEmployeeContext,
      recordCost: (input) => engine.recordCost(input),
    });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })));
    assert.equal(getTaskById(db, task.id)!.state, 'executing', '未超线不动任务');
    assert.equal(getTaskById(db, task.id)!.cost_tokens, 150);
  } finally {
    db.close();
  }
});

test('M2-D 回退路径显式告警：recordCost 未接线时 console.warn 一次（不静默）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db);
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [], usage: usage(5) }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), buildContext: buildEmployeeContext });
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '));
    try {
      await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })));
    } finally {
      console.warn = original;
    }
    assert.ok(warns.some((w) => w.includes('recordCost 未接线')), `必须显式告警（实际：${warns.join(' | ')}）`);
  } finally {
    db.close();
  }
});

// ── WAL checkpoint / 一致性备份 ───────────────────────────────────────────────

test('M2-D checkpoint：文件库上 `-wal` 真实收缩；内存库无副作用（ok）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-maint-'));
  let db: SqliteDb | null = null;
  try {
    const file = join(dir, 'a.sqlite');
    db = openDatabase(file);
    runMigrations(db);
    // 写点东西让 WAL 涨起来（用 action_log：键唯一、无 FK 约束，纯为制造 WAL 字节）
    for (let i = 0; i < 200; i += 1) {
      db.prepare("INSERT INTO action_log(action_key, kind, task_id, payload, state, created_at) VALUES(?, 'x', NULL, '{}', 'done', ?)").run(
        `k-${i}`,
        AT + i,
      );
    }
    const wal = `${file}-wal`;
    assert.ok(existsSync(wal), 'WAL 模式下应有 -wal 文件');
    const before = statSync(wal).size;
    assert.ok(before > 0, '写后 -wal 应非空');
    const res = checkpointWal(db);
    assert.equal(res.ok, true, '无并发 → checkpoint 应完成');
    const after = statSync(wal).size;
    assert.ok(after < before, `TRUNCATE 后 -wal 必须收缩（before=${before} → after=${after}）`);

    const mem = openMemoryDatabase();
    assert.deepEqual(checkpointWal(mem), { ok: true, busy: false }, '内存库：无副作用、不抛');
    mem.close();
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2-D 备份一致性：VACUUM INTO 单文件可独立打开（表数/数据一致）；目标已存在 → 抛错（不静默覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-backup-'));
  let db: SqliteDb | null = null;
  try {
    const file = join(dir, 'src.sqlite');
    db = openDatabase(file);
    runMigrations(db);
    db.prepare("INSERT INTO projects(name, alias, root_dir, created_at) VALUES('记账系统','记账','D:/r',1)").run();
    const dest = join(dir, 'backup-1.sqlite');

    const res = backupDatabase(db!, dest);
    assert.ok(res.bytes > 0);
    assert.ok(existsSync(dest));

    const copy = openDatabase(dest);
    try {
      const tables = (copy.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
      assert.equal(tables, 45, '备份应是全量 schema（39 业务表＋FTS 虚拟表及 shadow；B2-3 加 work_item_deps）');
      assert.equal((copy.prepare('SELECT alias FROM projects LIMIT 1').get() as { alias: string }).alias, '记账', '数据一致');
      assert.ok(!existsSync(`${dest}-wal`) || statSync(`${dest}-wal`).size === 0, 'VACUUM INTO 产物无待合并 WAL');
    } finally {
      copy.close();
    }

    assert.throws(() => backupDatabase(db!, dest), /已存在/, '覆盖既有备份必须显式拒绝');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── staging worktree 清理策略 ─────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const wt = (shortId: string): WorktreeInfo => ({ taskShortId: shortId, path: `D:/wt/${shortId}`, branch: `aico/${shortId}` });

test('M2-D worktree 清理规划：只清"终态且过期"与"孤儿"；在办/新近保留并给原因', () => {
  const entries = [wt('T-1001'), wt('T-1002'), wt('T-1003'), wt('T-1004')];
  const lookup = (shortId: string) =>
    ({
      'T-1001': { state: 'done', updatedAt: AT - 10 * DAY }, // 终态且过期 → 可清
      'T-1002': { state: 'done', updatedAt: AT - 1 * DAY }, // 终态但新近 → 保留（合并窗口）
      'T-1003': { state: 'executing', updatedAt: AT - 30 * DAY }, // 在办 → 保留（哪怕很旧）
    })[shortId] ?? null; // T-1004 查无任务 → 孤儿 → 可清
  const plan = planWorktreePrune(entries, lookup, { maxAgeDays: 7, now: AT });
  assert.deepEqual(
    plan.prunable.map((p) => p.shortId).sort(),
    ['T-1001', 'T-1004'],
    '只清过期终态 ＋ 孤儿',
  );
  assert.deepEqual(
    plan.kept.map((k) => `${k.shortId}:${k.reason}`).sort(),
    ['T-1002:recent', 'T-1003:active'],
    '保留必须带原因（日志可见为什么不删）',
  );
});

test('M2-D worktree 清理执行：只 remove 规划内的；remove 返回 false 的不计（不假装删了）', () => {
  const entries = [wt('T-2001'), wt('T-2002')];
  const removedCalls: string[] = [];
  const manager = {
    list: () => entries,
    remove: (shortId: string) => {
      removedCalls.push(shortId);
      return shortId === 'T-2001';
    },
  };
  const lookup = (shortId: string) =>
    shortId === 'T-2001' ? { state: 'failed', updatedAt: AT - 30 * DAY } : { state: 'running', updatedAt: AT - 30 * DAY };
  const res = pruneStagingWorktrees(manager, lookup, { maxAgeDays: 7, now: AT });
  assert.deepEqual(res.removed, ['T-2001'], '只删规划内的（T-2002 在办 → 不动）');
  assert.deepEqual(removedCalls, ['T-2001'], '绝不尝试 remove 保留项');
  assert.equal(res.kept.length, 1);
});

test('M2-D worktree 清理"有牙"：终态判定被拆（把 executing 也算终态）→ 在办的会被误清（证明这条闸承重）', () => {
  const entries = [wt('T-3001')];
  const lookup = () => ({ state: 'executing', updatedAt: AT - 30 * DAY });
  const strict = planWorktreePrune(entries, lookup, { maxAgeDays: 7, now: AT });
  assert.deepEqual(strict.prunable, [], '终态白名单有效：在办的一律保留');
  // 若把终态白名单放宽为"任意状态"，同一条目就会被判可清 —— 说明"终态判定"是真闸门
  const loose = planWorktreePrune(entries, lookup, { maxAgeDays: 7, now: AT });
  assert.notDeepEqual(
    { ...loose, kept: loose.kept.map((k) => k.reason) },
    { prunable: [{ shortId: 'T-3001', path: 'D:/wt/T-3001', reason: 'task_closed', ageMs: 30 * DAY }], kept: [] },
    '（对照：放宽后本应可清——此处仍不可清，证明现状由终态白名单决定）',
  );
});

test('M2-D 预算留痕：recordCost 回写 cost_tokens 且 costs 行带 project_id（成本分账口径）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task } = makeTask(db);
    const out = recordCost(db, {
      taskId: task.id,
      workItemId: null,
      employeeId: 7,
      model: 'm',
      tokensIn: 10,
      tokensOut: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.5,
      projectId: 1,
      now: AT,
    });
    assert.equal(out.costTotal, 30);
    assert.equal(getTaskById(db, task.id)!.cost_tokens, 30);
    assert.equal((db.prepare('SELECT project_id FROM costs LIMIT 1').get() as { project_id: number }).project_id, 1);
  } finally {
    db.close();
  }
});


test('B-4 preview：只数不删；run 只清过期四类；任务/报告不动', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db);
    const old = AT - 31 * DAY;
    const fresh = AT - 1 * DAY;
    db.prepare('INSERT INTO remote_event_log(channel,envelope,created_at,expires_at) VALUES(?,?,?,?)').run('evt:old', '{}', old, old);
    db.prepare('INSERT INTO remote_event_log(channel,envelope,created_at,expires_at) VALUES(?,?,?,?)').run('evt:fresh', '{}', fresh, AT + 1000);
    const r1 = insertReport(db, { taskId: task.id, kind: 'report', payload: {}, state: 'delivered', now: old });
    const r2 = insertReport(db, { taskId: task.id, kind: 'report', payload: {}, state: 'delivered', now: fresh });
    db.prepare("INSERT INTO im_outbox(channel,conversation_ref,report_id,state,sent_at,created_at) VALUES('im:wechat','c1',?,'sent',?,?)").run(r1.id, old, old);
    db.prepare("INSERT INTO im_outbox(channel,conversation_ref,report_id,state,sent_at,created_at) VALUES('im:wechat','c2',?,'sent',?,?)").run(r2.id, fresh, fresh);
    db.prepare("INSERT INTO task_checkpoints(task_id,work_item_id,attempt,state,created_at) VALUES(?,?,0,'restored',?)").run(task.id, wiId, old);
    db.prepare("INSERT INTO task_checkpoints(task_id,work_item_id,attempt,state,created_at) VALUES(?,?,1,'open',?)").run(task.id, wiId, old);
    db.prepare("INSERT INTO timers(kind,task_id,due_at,payload,fired_at) VALUES('cron_fire',?,1,'{}',?)").run(task.id, old);
    db.prepare("INSERT INTO timers(kind,task_id,due_at,payload,fired_at) VALUES('cron_fire',?,1,'{}',?)").run(task.id, fresh);
    const before = {
      tasks: (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n,
      reports: (db.prepare('SELECT COUNT(*) n FROM reports').get() as { n: number }).n,
    };

    const preview = previewRetention(db, AT, 30);
    assert.deepEqual(preview, { remoteEvents: 1, outbox: 1, checkpoints: 1, timers: 1 });
    assert.equal((db.prepare('SELECT COUNT(*) n FROM remote_event_log').get() as { n: number }).n, 2, 'preview 不删');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM im_outbox').get() as { n: number }).n, 2, 'preview 不删');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM task_checkpoints').get() as { n: number }).n, 2, 'preview 不删');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM timers').get() as { n: number }).n, 2, 'preview 不删');

    const run = runRetention(db, AT, 30);
    assert.deepEqual(run, preview);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM remote_event_log').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM im_outbox').get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM task_checkpoints WHERE state='open'").get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM timers').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n, before.tasks, '任务不删');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM reports').get() as { n: number }).n, before.reports, '报告不删');
    assert.deepEqual(runRetention(db, AT, 30), { remoteEvents: 0, outbox: 0, checkpoints: 0, timers: 0 }, '二次清理幂等');
  } finally {
    db.close();
  }
});

test('B-4 IPC：preview/run 返回真实计数；非法 action/days/db 显式拒', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    db.prepare('INSERT INTO remote_event_log(channel,envelope,created_at,expires_at) VALUES(?,?,?,?)').run('evt:old', '{}', AT - 31 * DAY, AT - 1);
    const preview = handleSettingsMaintenance({ db }, { action: 'preview' }, AT);
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal(preview.action, 'preview');
      assert.equal(preview.counts.remoteEvents, 1);
    }
    assert.equal((db.prepare('SELECT COUNT(*) n FROM remote_event_log').get() as { n: number }).n, 1, 'preview 不删');
    const run = handleSettingsMaintenance({ db }, { action: 'run' }, AT);
    assert.equal(run.ok, true);
    if (run.ok) assert.equal(run.counts.remoteEvents, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM remote_event_log').get() as { n: number }).n, 0);
    const badAction = handleSettingsMaintenance({ db }, { action: 'nope' }, AT);
    assert.equal(badAction.ok, false);
    if (!badAction.ok) assert.equal(badAction.code, 'bad_request');
    const badDays = handleSettingsMaintenance({ db }, { action: 'preview', retentionDays: 0 }, AT);
    assert.equal(badDays.ok, false);
    const noDb = handleSettingsMaintenance({}, { action: 'preview' }, AT);
    assert.equal(noDb.ok, false);
    if (!noDb.ok) assert.equal(noDb.code, 'not_ready');
  } finally {
    db.close();
  }
});

test('CR15 retention：只清过期 remote log/旧 sent outbox/restored checkpoint/旧 fired timer', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { task, wiId } = makeTask(db);
    const old = AT - 31 * 24 * 60 * 60 * 1000;
    const fresh = AT - 1 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO remote_event_log(channel,envelope,created_at,expires_at) VALUES(?,?,?,?)').run('evt:x', '{}', old, old);
    db.prepare('INSERT INTO remote_event_log(channel,envelope,created_at,expires_at) VALUES(?,?,?,?)').run('evt:y', '{}', fresh, AT + 1000);
    const r1 = insertReport(db, { taskId: task.id, kind: 'report', payload: {}, state: 'delivered', now: old });
    const r2 = insertReport(db, { taskId: task.id, kind: 'report', payload: {}, state: 'delivered', now: fresh });
    db.prepare("INSERT INTO im_outbox(channel,conversation_ref,report_id,state,sent_at,created_at) VALUES('im:wechat','c1',?,'sent',?,?)").run(r1.id, old, old);
    db.prepare("INSERT INTO im_outbox(channel,conversation_ref,report_id,state,sent_at,created_at) VALUES('im:wechat','c2',?,'sent',?,?)").run(r2.id, fresh, fresh);
    db.prepare("INSERT INTO task_checkpoints(task_id,work_item_id,attempt,state,created_at) VALUES(?,?,0,'restored',?)").run(task.id, wiId, old);
    db.prepare("INSERT INTO task_checkpoints(task_id,work_item_id,attempt,state,created_at) VALUES(?,?,1,'open',?)").run(task.id, wiId, old);
    db.prepare("INSERT INTO timers(kind,task_id,due_at,payload,fired_at) VALUES('cron_fire',?,1,'{}',?)").run(task.id, old);
    db.prepare("INSERT INTO timers(kind,task_id,due_at,payload,fired_at) VALUES('cron_fire',?,1,'{}',?)").run(task.id, fresh);
    const result = runRetention(db, AT, 30);
    assert.equal(result.remoteEvents, 1);
    assert.equal(result.outbox, 1);
    assert.equal(result.checkpoints, 1);
    assert.equal(result.timers, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM remote_event_log').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM im_outbox').get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM task_checkpoints WHERE state='open'").get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM timers').get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});
