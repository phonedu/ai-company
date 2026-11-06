import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleTaskGet } from '../src/main/ipc/ipc.js';

// ── OPT-AI-1：`task:get` 暴露派生投影 `rawConversation`（只读；老板/员工/工具；按 at 升序） ──

test('AI-1: task:get.rawConversation 由真存储派生（boss + agent_message + tool_call）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const task = repo.createTask({ title: 't', goal: 'g' });

  repo.insertMessage({ direction: 'in', taskId: task.id, content: '老板原话', now: 10 });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: 20,
    kind: 'agent_message',
    actor: 'employee:2',
    payload: { employeeId: 2, text: '员工发言' },
  });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: 30,
    kind: 'tool_call',
    actor: 'employee:2',
    payload: { toolName: 'write', toolCallId: 'c1', phase: 'start' },
  });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: 31,
    kind: 'tool_call',
    actor: 'employee:2',
    payload: { toolName: 'write', toolCallId: 'c1', phase: 'end', ok: true },
  });

  const dto = handleTaskGet({ repo }, { taskId: task.id });
  assert.ok(dto);
  const rc = dto!.rawConversation ?? [];
  assert.ok(rc.length >= 3, `至少 3 条，实际 ${rc.length}`);
  assert.ok(rc.some((i) => i.role === 'boss' && i.text === '老板原话'), '含老板原话');
  assert.ok(rc.some((i) => i.role === 'employee' && i.text === '员工发言'), '含员工发言');
  assert.ok(rc.some((i) => i.toolCall?.name === 'write'), '含工具调用');
  for (let i = 1; i < rc.length; i += 1) {
    assert.ok(rc[i - 1].at <= rc[i].at, '按 at 升序');
  }
  db.close();
});

test('AI-1: 空任务 → rawConversation 为 []（不臆造）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const task = repo.createTask({ title: 't', goal: 'g' });
  const dto = handleTaskGet({ repo }, { taskId: task.id });
  assert.deepEqual(dto?.rawConversation, []);
  db.close();
});
