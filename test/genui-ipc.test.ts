import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { listTaskEvents } from '../src/main/db/task_events.js';
import { getReport } from '../src/main/db/reports.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleCardAction, type IpcDeps } from '../src/main/ipc/ipc.js';

// ─────────────── M1-5 · GenUI 卡片意图 IPC（`chat:card-action`，`06 §4.7`）───────────────
// 验收：AC8（回写 human_messages + task_events 可审计）、AC3（非白名单 action 被拒）、恰好一次。
// 用真内存库 + 真迁移 + 真 repo（与 ipcMain 同一实现）。

const AT = 1_700_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  return { db, deps: { repo: createSqliteChatRepo(db) } };
}

function seedTask(db: SqliteDb): { taskId: number; reportId: number; approvalId: number } {
  const project = db
    .prepare(`INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?,?,?,?) RETURNING id`)
    .get('记账系统', '记账', 'D:/proj', AT) as { id: number };
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId: project.id,
    title: '对账脚本',
    goal: 'g',
    now: AT,
  });
  const report = db
    .prepare(`INSERT INTO reports (task_id, kind, payload, state, created_at) VALUES (?,?,?,?,?) RETURNING id`)
    .get(task.id, 'ask', JSON.stringify({ question: '用 Python 还是 Node？' }), 'pending', AT) as { id: number };
  const approval = db
    .prepare(
      `INSERT INTO approvals (task_id, report_id, question, options, default_action) VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(task.id, report.id, '用 Python 还是 Node？', JSON.stringify([{ key: '1' }, { key: '2' }]), '1') as {
    id: number;
  };
  return { taskId: task.id, reportId: report.id, approvalId: approval.id };
}

test('AC8：卡片意图落 `human_messages(in)` + `task_events(decision_made)`，并路由审批', () => {
  const { db, deps } = setup();
  const { taskId, reportId, approvalId } = seedTask(db);

  const res = handleCardAction(
    deps,
    { schemaId: 'sch_1', componentId: 'b1', action: 'select', payload: { key: '1', taskId, reportId, approvalId } },
    AT,
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.result.answeredApproval, true, '审批被路由');
  assert.equal(res.result.wroteTaskEvent, true);
  assert.ok(res.result.humanMessageId > 0);

  const msgs = deps.repo.listMessages({ taskId });
  assert.equal(msgs.length, 1, '**恰好一条** human_message');
  assert.match(msgs[0].content, /卡片操作：select/);
  assert.equal(msgs[0].direction, 'in');
  assert.equal(msgs[0].taskId, taskId);

  const events = listTaskEvents(db, taskId).filter((e) => e.kind === 'decision_made');
  assert.equal(events.length, 1, '**恰好一条** decision_made 事件');
  assert.match(events[0].payload, /sch_1/);
});

test('AC8：`ack` 意图 → 报告置 acknowledged（可审计）', () => {
  const { db, deps } = setup();
  const { taskId, reportId } = seedTask(db);

  const res = handleCardAction(deps, { schemaId: 'sch_2', componentId: 'b2', action: 'ack', payload: { taskId, reportId } }, AT);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.result.acknowledgedReport, true);
  assert.equal(getReport(db, reportId)?.state, 'acknowledged');
});

test('AC3：非白名单 action（shell/merge/http…）→ 拒绝且**不产生任何回写**', () => {
  const { db, deps } = setup();
  const { taskId, reportId, approvalId } = seedTask(db);

  for (const action of ['shell', 'exec', 'merge', 'http', 'write-file', 'delete']) {
    const res = handleCardAction(deps, { schemaId: 'sch_1', componentId: 'b1', action, payload: { taskId, reportId, approvalId } }, AT);
    assert.equal(res.ok, false, `${action} 必须被拒`);
    if (!res.ok) assert.equal(res.code, 'action_not_allowed');
  }
  assert.equal(deps.repo.listMessages({ taskId }).length, 0, '被拒的意图不得落库');
  assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'decision_made').length, 0);
});

test('入参校验：缺 schemaId/componentId/action → bad_request', () => {
  const { deps } = setup();
  for (const raw of [{}, { schemaId: 's' }, { schemaId: 's', componentId: 'c' }, { schemaId: 's', componentId: 'c', action: '' }]) {
    const res = handleCardAction(deps, raw, AT);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'bad_request');
  }
});
