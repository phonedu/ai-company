/**
 * CTX-1 P2 · CTX1-3 压缩后交接块：确定性重建 + 审计事件 + 钩子接线（fake pi）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertTaskEvent,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  replacePlanSteps,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { insertArtifact } from '../src/main/db/artifacts.js';
import { insertEmployee } from '../src/main/db/employees.js';
import {
  buildCompactionHandoffText,
  createCompactionHandoffProvider,
  roleFromSessionKey,
  taskIdFromSessionKey,
} from '../src/main/agent/compaction-handoff.js';
import { registerCompactionHandoff } from '../src/main/agent/pi-runtime.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: AT });
  const projectId = Number(
    db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?)').run('P', 'D:/repo', AT).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '交付对账单',
    goal: '把 10 月对账单整理成 PDF',
    riskLevel: 1,
    ownerId: 7,
    acceptance: ['PDF 有 10 月数据', '合计与源表一致'],
    budgetTokens: 50_000,
    now: AT,
  });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '整理数据', brief: 'do it', now: AT });
  return { db, taskId: task.id, wiId: wi.id };
}

test('CTX1-3: 会话键解析（employee/planner/critic/verifier/非法）', () => {
  assert.equal(taskIdFromSessionKey('employee:7:task:12:wi:3'), 12);
  assert.equal(taskIdFromSessionKey('role:planner:task:12'), 12);
  assert.equal(taskIdFromSessionKey('role:verifier:task:12:wi:3'), 12);
  assert.equal(taskIdFromSessionKey('boss-channel:assistant'), null);
  assert.equal(taskIdFromSessionKey('employee:7:task:abc'), null);
  assert.equal(roleFromSessionKey('role:critic:task:12'), 'critic');
  assert.equal(roleFromSessionKey('employee:7:task:12:wi:3'), 'employee');
  assert.equal(roleFromSessionKey('boss-channel:assistant'), 'unknown');
});

test('CTX1-3: 交接块含目标/验收/计划/已完成/产物/最近打回/下一步；无任务 → null', () => {
  const { db, taskId, wiId } = setup();
  try {
    replacePlanSteps(db, taskId, ['整理数据', '生成 PDF', '自检合计'], AT);
    db.prepare("UPDATE plan_steps SET state = 'done' WHERE task_id = ? AND idx = 1").run(taskId);
    db.prepare("UPDATE plan_steps SET state = 'running' WHERE task_id = ? AND idx = 2").run(taskId);
    db.prepare("UPDATE work_items SET state = 'submitted' WHERE id = ?").run(wiId);
    insertArtifact(db, { taskId, workItemId: wiId, kind: 'file', path: 'reports/oct.pdf', sha256: 'a'.repeat(64), now: AT });
    insertTaskEvent(db, {
      taskId,
      workItemId: wiId,
      ts: AT + 1,
      kind: 'revise',
      actor: 'boss',
      payload: { notes: '合计对不上，先查第 3 页' },
    });

    const text = buildCompactionHandoffText(db, taskId)!;
    assert.match(text, /【压缩后交接/);
    assert.match(text, /交付对账单/);
    assert.match(text, /把 10 月对账单整理成 PDF/);
    assert.match(text, /验收：PDF 有 10 月数据；合计与源表一致/);
    assert.match(text, /计划（1\/3 已完）/);
    assert.match(text, /\[running\] 生成 PDF/);
    assert.match(text, /已完成工作项：#\d+ 整理数据（submitted）/);
    assert.match(text, /产物：reports\/oct\.pdf/);
    assert.match(text, /最近失败\/打回：revise：合计对不上/);
    assert.match(text, /下一步：无排队\/在跑工作项/);

    assert.equal(buildCompactionHandoffText(db, 9999), null, '任务不存在 → null（不发空块）');
  } finally {
    db.close();
  }
});

test('CTX1-3: provider 落 compaction_handoff 审计事件（role/chars）；无键/无任务不写', () => {
  const { db, taskId } = setup();
  try {
    const provider = createCompactionHandoffProvider(db, () => AT + 10);
    const text = provider('role:planner:task:' + taskId);
    assert.ok(text && text.length > 0);
    const events = listTaskEvents(db, taskId).filter((e) => e.kind === 'compaction_handoff');
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0]!.payload) as { role: string; chars: number; sessionKey: string };
    assert.equal(payload.role, 'planner');
    assert.equal(payload.chars, text!.length);
    assert.equal(payload.sessionKey, `role:planner:task:${taskId}`);

    assert.equal(provider('boss-channel:assistant'), null, '无任务键 → null（不写事件）');
    assert.equal(provider(`role:planner:task:9999`), null, '任务不存在 → null（不写事件）');
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'compaction_handoff').length, 1, '不得多写');
  } finally {
    db.close();
  }
});

test('CTX1-3: 钩子接线——压缩成功才注入 custom message（nextTurn），失败/空不炸', () => {
  const handlers = new Map<string, (ev: unknown) => unknown>();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(event: string, handler: (ev: unknown) => unknown): () => void {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    sendMessage(message: unknown, options?: unknown): void {
      sent.push({ message, options });
    },
  };
  let calls = 0;
  registerCompactionHandoff(pi, {
    sessionKey: 'role:planner:task:5',
    build: () => {
      calls += 1;
      return '【压缩后交接】内容';
    },
  });
  assert.ok(handlers.has('session_compact'), '必须订阅 session_compact');
  handlers.get('session_compact')!({ type: 'session_compact', reason: 'threshold' });
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.options, { deliverAs: 'nextTurn' });
  const message = sent[0]!.message as { customType: string; display: boolean; content: Array<{ text: string }> };
  assert.equal(message.customType, 'compaction_handoff');
  assert.equal(message.display, true);
  assert.match(message.content[0]!.text, /压缩后交接/);

  // 返回 null → 不发送
  registerCompactionHandoff(pi, { sessionKey: 's', build: () => null });
  handlers.get('session_compact')!({});
  assert.equal(sent.length, 1);

  // 构建抛错 → 不炸、不发送
  registerCompactionHandoff(pi, {
    sessionKey: 's',
    build: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => handlers.get('session_compact')!({}));
  assert.equal(sent.length, 1);

  // 底座无 sendMessage → 不炸（如实日志）
  const noSend = { on: pi.on };
  assert.doesNotThrow(() => registerCompactionHandoff(noSend, { sessionKey: 's', build: () => 'x' }));
});
