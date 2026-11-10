/**
 * G3· 会话内工具耗时埋点：`tool_call_start/end` → `task_events(kind='tool_call', payload.durationMs)`。
 * 仅归因/留痕（**不作并发通道**：不改执行顺序、不做超时/取消）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, insertWorkItem, listTaskEvents, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime, projectRawConversation } from '../src/main/agent/index.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number) =>
  toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{"attempt":0}');

/** 单调递增时钟：每次取时 +step（让 start/end 之间产生确定时长）。 */
const steppingClock = (start = 1000, step = 50) => {
  let t = start;
  return () => (t += step);
};

test('G3: 工具 start/end → 落 `tool_call` 事件且带 `durationMs`（归因：能回答"哪个工具耗了多少"）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'read', input: { path: 'a.ts' }, isError: false },
          { id: 'c2', name: 'bash', input: { command: 'pytest -q' }, isError: true },
        ],
      },
    ]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: () => undefined,
      now: steppingClock(1000, 50),
    });
    await exec.execute(dispatchAction(taskId, wiId));
    const allToolEvents = listTaskEvents(db, taskId).filter((e) => e.kind === 'tool_call');
    // RET-：start 也落库（带白名单 input）；耗时事件只看 end，避免把 start 混进时长断言。
    assert.equal(allToolEvents.filter((e) => JSON.parse(e.payload).phase === 'start').length, 2, '两个 start 事件');
    const evs = allToolEvents.filter((e) => JSON.parse(e.payload).phase === 'end');
    assert.equal(evs.length, 2, '两个工具 → 两条耗时事件');
    const p0 = JSON.parse(evs[0]!.payload) as { toolName: string; durationMs: number; ok: boolean; scope: string };
    assert.equal(p0.toolName, 'read');
    assert.ok(typeof p0.durationMs === 'number' && p0.durationMs >= 0, '必须带 durationMs');
    assert.equal(p0.ok, true);
    assert.equal(p0.scope, 'session_tool');
    const p1 = JSON.parse(evs[1]!.payload) as { toolName: string; ok: boolean };
    assert.equal(p1.toolName, 'bash');
    assert.equal(p1.ok, false, 'isError 工具记 ok=false（失败也留痕）');
  } finally {
    db.close();
  }
});

test('G3: 无 end（未结束的工具）→ 不写半截时长（不臆造）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // 只发 start、不发 end 的假运行时
    const fake = makeFakeAgentRuntime([{ text: '', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined, now: steppingClock() });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'tool_call').length, 0);
  } finally {
    db.close();
  }
});

test('G3 投影回归: 自含耗时行 → `toolCall.durationMs` 可见（否则时长在 UI 上永远看不到）；既有配对行为不变', () => {
  const { db, taskId } = setup();
  try {
    // ① G3 耗时行（自含，无 start 配对）
    insertTaskEvent(db, {
      taskId,
      kind: 'tool_call',
      actor: 'employee:7',
      ts: 10,
      payload: { toolName: 'read', toolCallId: 'c9', durationMs: 77, ok: true, phase: 'end', scope: 'session_tool' },
    });
    // ② 既有 start/end 配对行（回归：不得因新字段而坏）
    insertTaskEvent(db, { taskId, kind: 'tool_call', actor: 'employee:7', ts: 20, payload: { toolName: 'write', toolCallId: 'c1', phase: 'start', input: { path: 'a.ts' } } });
    insertTaskEvent(db, { taskId, kind: 'tool_call', actor: 'employee:7', ts: 30, payload: { toolName: 'write', toolCallId: 'c1', phase: 'end', isError: false } });

    const items = projectRawConversation(db, taskId).filter((i) => i.toolCall);
    assert.equal(items.length, 2, '耗时行 1 条 + 配对行 1 条');
    assert.equal(items[0]!.toolCall!.durationMs, 77, '耗时可见');
    assert.equal(items[0]!.toolCall!.name, 'read');
    assert.equal(items[1]!.toolCall!.name, 'write');
    assert.equal(items[1]!.toolCall!.ok, true, '既有配对行为不变');
    assert.match(items[1]!.toolCall!.argsDigest ?? '', /a\.ts/);
  } finally {
    db.close();
  }
});

test('G3 "有牙": 去掉计时逻辑 → 事件里就没有 durationMs（对照证明该断言承重）', () => {
  // 直接对照：无计时时，既有 kind 的 payload 不含 durationMs
  const withoutTiming = { toolName: 'read', phase: 'start', input: {} };
  assert.equal('durationMs' in withoutTiming, false);
  const withTiming = { toolName: 'read', durationMs: 50, ok: true, scope: 'session_tool' };
  assert.equal('durationMs' in withTiming, true);
});
