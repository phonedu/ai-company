/**
 * M2 尾 · 阻塞式 mailbox：`ask_colleague{blocking:true}` → 件 `running→blocked`；
 * 老板/同事作答 → `blocked→queued`（`answer_received`）＋答复走未读回灌。
 * 断言：不再抛 E_BLOCKING_NOT_IMPLEMENTED；作答幂等不重复派发；过渡表可达。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMailboxAnswer } from '../src/main/ipc/ipc.js';
import { listOpenAsks, requestAsk } from '../src/main/engine/mailbox.js';
import { planWorkItemTransition } from '../src/main/engine/statemachine.js';
import type { EngineEvent } from '../src/main/engine/types.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(9,'E9','ops',1)").run();
  const taskId = Number(
    (
      db
        .prepare(
          "INSERT INTO tasks(short_id, project_id, title, goal, state, created_at, updated_at) VALUES('T-1', ?, 't', 'g', 'executing', 1, 1) RETURNING id",
        )
        .get(projectId) as { id: number }
    ).id,
  );
  const wiId = Number(
    (
      db
        .prepare(
          "INSERT INTO work_items(task_id, employee_id, title, brief, state, created_at) VALUES(?, 7, 'w', 'b', 'running', 1) RETURNING id",
        )
        .get(taskId) as { id: number }
    ).id,
  );
  return { db, taskId, wiId };
}

test('M2 尾：blocking=true 不再抛错；开放提问如实带 blocking', () => {
  const { db, taskId, wiId } = setup();
  const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '等你确认', blocking: true, now: AT });
  assert.equal(ask.blocking, true);
  const open = listOpenAsks(db);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.blocking, true);
  db.close();
});

test('M2 尾：工作项机可达 running→blocked→queued（ask_blocked / answer_received）', () => {
  const base = {
    workItemId: 1,
    taskId: 1,
    attempt: 0,
    now: AT,
    actor: 'system',
    payload: {} as Record<string, unknown>,
    taskState: 'executing' as const,
  };
  const blocked = planWorkItemTransition({ ...base, from: 'running' }, 'ask_blocked');
  assert.equal(blocked.to, 'blocked');
  assert.deepEqual(blocked.kinds, ['work_item_blocked']);
  const queued = planWorkItemTransition({ ...base, from: 'blocked' }, 'answer_received');
  assert.equal(queued.to, 'queued');
  assert.deepEqual(queued.kinds, ['work_item_unblocked']);
});

test('M2 尾：老板作答 → 派 answer_received 回队；重复作答不重复派发', async () => {
  const { db, taskId, wiId } = setup();
  const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '等你确认', blocking: true, now: AT });
  const events: EngineEvent[] = [];
  const deps = {
    repo: createSqliteChatRepo(db),
    engine: {
      async dispatch(event: EngineEvent): Promise<void> {
        events.push(event);
      },
    },
  };

  const first = await handleMailboxAnswer(deps, { askDedupeKey: ask.dedupeKey, answer: '可以' }, AT + 1);
  assert.deepEqual(first, { ok: true, delivered: true });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    scope: 'work_item',
    id: wiId,
    event: 'answer_received',
    actor: 'system',
    payload: { askDedupeKey: ask.dedupeKey },
  });

  const second = await handleMailboxAnswer(deps, { askDedupeKey: ask.dedupeKey, answer: '再答一遍' }, AT + 2);
  assert.deepEqual(second, { ok: true, delivered: false });
  assert.equal(events.length, 1, '重复作答不再派发（幂等）');
  db.close();
});

test('M2 尾：非阻塞提问作答不派 answer_received（不误动件状态）', async () => {
  const { db, taskId, wiId } = setup();
  const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '异步问', now: AT });
  const events: EngineEvent[] = [];
  const deps = {
    repo: createSqliteChatRepo(db),
    engine: {
      async dispatch(event: EngineEvent): Promise<void> {
        events.push(event);
      },
    },
  };
  await handleMailboxAnswer(deps, { askDedupeKey: ask.dedupeKey, answer: '收到' }, AT + 1);
  assert.equal(events.length, 0);
  db.close();
});
