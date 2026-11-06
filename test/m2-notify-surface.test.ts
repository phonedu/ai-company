/**
 * 挂载 2「通知与待办面」测试（2026-10-15，C4 工单 `BRK9/BRK10/BRK14/BRK15`）——每条可弄红。
 *
 * - `BRK10`：引擎闸门 `ask` → 审批行＋`escalate` 升级事件（可见化）；重复 drain 不重建（幂等）；deny 不变；
 * - `BRK14`：三类任务级等待（no_slot / budget / employee_busy）经 `listDispatchHolds` → `task:get.waits` 上屏；
 * - `BRK15`：卡片落库回调 `onCard`（`evt:notify`/`evt:inbox` 的接线点）；
 * - `BRK9`：`#T-1001 要说的话` 插话直通 → steer 进行中员工会话；不在跑/未接线如实回执；查无落回常规。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, executePendingActions } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleChatSend, handleTaskGet, parseSteerCommand } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
  return { db, projectId };
}

const noopExecutor = { execute: async (): Promise<void> => undefined };
const newTask = (db: SqliteDb, projectId: number, title: string) =>
  createTask(db, new SqliteCounterStore(db), { projectId, title, goal: 'g', riskLevel: 0, ownerId: 7 });

// ── BRK10：闸门 ask → 权限卡可见 ＋ 任务升级；幂等 ──────────────────────────────

test('BRK10：闸门 ask → 审批行＋`escalate` 升级事件（approvalId 回挂/按行分卡）；重复 drain 不重建（幂等）；deny 路径不变', async () => {
  const { db, projectId } = setup();
  try {
    const task = newTask(db, projectId, 'T');
    const actionKey = `dispatch_planning:task:${task.id}:0`;
    db.prepare(
      "INSERT INTO action_log(action_key, kind, task_id, payload, state, created_at) VALUES(?,?,?,?, 'pending', ?)",
    ).run(actionKey, 'dispatch_planning', task.id, '{}', AT);
    const gate = (): { decision: 'ask'; reason: string; rule: string } => ({ decision: 'ask', reason: '需批准', rule: 'r1' });
    const enqueued: EngineEvent[] = [];
    const first = await executePendingActions(db, noopExecutor, AT, gate, undefined, (e) => void enqueued.push(e));
    assert.deepEqual(first.executed, [], 'ask 动作不得执行');
    assert.deepEqual(first.skipped, [actionKey], '保持 pending（批准后重放——G1 口径不变）');
    const approvals = db
      .prepare('SELECT id, question, options FROM approvals WHERE task_id=?')
      .all(task.id) as Array<{ id: number; question: string; options: string }>;
    assert.equal(approvals.length, 1, '必须建审批行（复用 approvals）');
    assert.ok(approvals[0]!.question.includes('[权限]') && approvals[0]!.question.includes(actionKey));
    assert.equal(JSON.parse(approvals[0]!.options).length, 2, 'approve/deny 两键');
    assert.equal(enqueued.length, 1, '必须派升级事件（BRK10：此前只建行、老板看不到）');
    const ev = enqueued[0]!;
    assert.equal(ev.event, 'escalate');
    const payload = ev.payload as { reason: string; approvalId: number; notifyRevision: number; options: unknown[] };
    assert.equal(payload.reason, 'permission_ask');
    assert.equal(payload.approvalId, approvals[0]!.id, '审批行回挂（批准按钮寻址）');
    assert.equal(payload.notifyRevision, approvals[0]!.id, '按行分卡（不同请求各自成卡）');
    assert.equal(payload.options.length, 2);

    // 幂等：同动作再 drain（仍 pending）→ 不重建行、不重升级（部署自查抓到的队列不收敛修复）
    await executePendingActions(db, noopExecutor, AT + 1, gate, undefined, (e) => void enqueued.push(e));
    assert.equal((db.prepare('SELECT COUNT(*) c FROM approvals WHERE task_id=?').get(task.id) as { c: number }).c, 1, '不重建');
    assert.equal(enqueued.length, 1, '不重升级');

    // deny：置 failed、不建行、不升级（回归锚）
    const denied = await executePendingActions(db, noopExecutor, AT + 2, () => ({ decision: 'deny', reason: 'no' }));
    assert.equal(denied.failed.length, 1, 'deny → 动作置 failed');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM approvals WHERE task_id=?').get(task.id) as { c: number }).c, 1, 'deny 不建行');
    assert.equal(enqueued.length, 1, 'deny 不升级');
  } finally {
    db.close();
  }
});

// ── BRK14：三类任务级等待上屏 ─────────────────────────────────────────────────

test('BRK14：三类任务级等待原因上屏 —— `task:get.waits` 带 {workItemId:null, detail}（no_slot / budget / employee_busy）', async () => {
  const { db, projectId } = setup();
  try {
    const repo = createSqliteChatRepo(db);
    // ① no_slot：槽位=0 ⇒ ready 任务 hold no_slot
    const engine = new Engine(db, noopExecutor, {
      autoSchedule: true,
      now: () => AT,
      scheduler: { maxActiveTasks: 0 },
    });
    const t1 = newTask(db, projectId, 'A');
    db.prepare("UPDATE tasks SET state='ready', ready_since=? WHERE id=?").run(AT, t1.id);
    await engine.schedulePass();
    const dto1 = handleTaskGet({ repo, engine }, { taskId: t1.id });
    assert.ok(
      dto1?.waits?.some((w) => w.reason === 'no_slot' && w.workItemId === null && w.detail === '无可用槽位'),
      `no_slot 必须上屏：${JSON.stringify(dto1?.waits)}`,
    );

    // ② budget：超预算 ⇒ ready 任务 hold budget（**独立引擎**：槽位充足——scheduler 先查 no_slot 再查 budget）
    const engine3 = new Engine(db, noopExecutor, { autoSchedule: true, now: () => AT });
    const t2 = newTask(db, projectId, 'B');
    db.prepare("UPDATE tasks SET state='ready', ready_since=?, budget_tokens=1, cost_tokens=5 WHERE id=?").run(AT, t2.id);
    await engine3.schedulePass();
    const dto2 = handleTaskGet({ repo, engine: engine3 }, { taskId: t2.id });
    assert.ok(
      dto2?.waits?.some((w) => w.reason === 'budget' && w.workItemId === null && w.detail === '超预算（budget_tokens）'),
      `budget 必须上屏：${JSON.stringify(dto2?.waits)}`,
    );

    // ③ employee_busy：占位感知开 ＋ 员工已忙（另一件 running）
    const engine2 = new Engine(db, noopExecutor, { autoSchedule: true, now: () => AT, scheduler: { occupancyAware: true } });
    const t3 = newTask(db, projectId, 'C');
    db.prepare("UPDATE tasks SET state='ready', ready_since=? WHERE id=?").run(AT, t3.id);
    insertWorkItem(db, { taskId: t3.id, employeeId: 7, title: 'w3', brief: 'b', now: AT });
    const t4 = newTask(db, projectId, 'D');
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(t4.id);
    const wi4 = insertWorkItem(db, { taskId: t4.id, employeeId: 7, title: 'w4', brief: 'b', now: AT });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wi4.id);
    await engine2.schedulePass();
    const dto3 = handleTaskGet({ repo, engine: engine2 }, { taskId: t3.id });
    assert.ok(
      dto3?.waits?.some((w) => w.reason === 'employee_busy' && w.workItemId === null && w.detail === '员工正忙'),
      `employee_busy 必须上屏：${JSON.stringify(dto3?.waits)}`,
    );
    // MP1-3：占用任务可指认——waits 带占用 work item 与其任务短号（@T-xxxx）
    const busyWait = dto3?.waits?.find((w) => w.reason === 'employee_busy');
    assert.ok(busyWait?.conflictsWith?.includes(wi4.id), `employee_busy 必须带占用件：${JSON.stringify(busyWait)}`);
    assert.ok(
      busyWait?.conflictsWithShortIds?.some((sid) => /^T-\d+$/.test(sid)),
      `employee_busy 必须带占用任务短号：${JSON.stringify(busyWait)}`,
    );
  } finally {
    db.close();
  }
});

// ── BRK15：卡片回调 ───────────────────────────────────────────────────────────

test('BRK15：卡片回调 `onCard` —— 每次落卡恰回调一次（`evt:notify`/`evt:inbox` 的接线点）', async () => {
  const { db, projectId } = setup();
  try {
    const cards: Array<{ taskId: number | null; kind: string; card: string }> = [];
    const engine = new Engine(db, noopExecutor, {
      autoSchedule: false,
      now: () => AT,
      onCard: (info) => void cards.push(info),
    });
    const task = newTask(db, projectId, 'E');
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'escalate',
      actor: 'system',
      payload: { question: 'q1', notifyRevision: 1 },
    });
    assert.deepEqual(cards, [{ taskId: task.id, kind: 'ask', card: 'decision' }], '落卡必须回调（实时推送的数据源）');
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'escalate',
      actor: 'system',
      payload: { question: 'q2', notifyRevision: 2 },
    });
    assert.equal(cards.length, 2, '每张卡一次（按版次分卡）');
  } finally {
    db.close();
  }
});

// ── BRK9：插话直通 ────────────────────────────────────────────────────────────

test('BRK9：`#T-1001 要说的话` 插话直通 —— steer 到进行中员工会话（`#T1042` 简写归一）；不在跑/查无 如实处置', async () => {
  const { db, projectId } = setup();
  try {
    const repo = createSqliteChatRepo(db);
    const task = newTask(db, projectId, 'F');
    assert.equal(task.short_id, 'T-1001');
    const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: AT });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wi.id);
    const calls: Array<{ key: string; text: string }> = [];
    const deps = {
      repo,
      steerEmployee: (key: string, text: string): boolean => {
        calls.push({ key, text });
        return true;
      },
    };

    const r1 = await handleChatSend(deps, { text: '#T-1001 对账口径改成含手续费' }, AT);
    assert.equal(r1.ok, true);
    assert.equal(calls.length, 1, '在跑 ⇒ 必须真 steer');
    assert.equal(calls[0]!.key, `employee:7:task:${task.id}:wi:${wi.id}`, '会话键＝员工×任务×工作项（与执行器同款）');
    assert.equal(calls[0]!.text, '对账口径改成含手续费');
    assert.ok(
      repo.listMessages({ taskId: task.id }).some((m) => m.direction === 'out' && m.content.includes('已插话到 T-1001')),
      '送达须有回执（不静默）',
    );

    // 命令解析：简写归一＋非插话命令不吞
    assert.deepEqual(parseSteerCommand('#T1042 你好'), { shortId: 'T-1042', body: '你好' });
    assert.equal(parseSteerCommand('暂停 T1042'), null, '非 `#T` 开头的命令不得被吞');
    assert.equal(parseSteerCommand('#T-1001   '), null, '空正文不算命令');

    // 不在跑（件已 done）：**不拦截**——落回既有 `task_message` 寻址（消息挂任务），steer 不得调用
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wi.id);
    const r2 = await handleChatSend(deps, { text: '#T-1001 再补一句' }, AT + 1);
    assert.equal(calls.length, 1, '不在跑不得调用 steer');
    assert.equal(r2.resolution.kind, 'task_message', '不在跑 ⇒ 原语义不动（task_message 寻址）');
    assert.ok(
      repo.listMessages({ taskId: task.id }).some((m) => m.direction === 'in' && m.content === '#T-1001 再补一句'),
      '消息挂到任务（task_message 寻址）',
    );

    // 查无短号：落回常规路径（消息照落，绝不丢输入）
    const r3 = await handleChatSend(deps, { text: '#T-9999 有人吗' }, AT + 2);
    assert.equal(r3.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(
      repo.listMessages({}).some((m) => m.direction === 'in' && m.content === '#T-9999 有人吗'),
      '查无短号的消息也必须落库',
    );
  } finally {
    db.close();
  }
});
