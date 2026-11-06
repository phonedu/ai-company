/**
 * M3 联动修复 P1：桌面与 IM 共用命令执行器。
 * 覆盖 `列表/日报/暂停/继续` 的真执行（不再只把 command 裁定落消息）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertReport } from '../src/main/db/reports.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleChatSend, type IpcDeps } from '../src/main/ipc/ipc.js';
import type { EngineEvent } from '../src/main/engine/types.js';

const AT = 1_700_000_000_000;

function setup(): { deps: IpcDeps; db: ReturnType<typeof openMemoryDatabase>; dispatched: EngineEvent[] } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const dispatched: EngineEvent[] = [];
  const deps: IpcDeps = {
    repo: createSqliteChatRepo(db),
    db,
    engine: {
      dispatch: async (event: EngineEvent) => {
        dispatched.push(event);
      },
    },
  };
  return { deps, db, dispatched };
}

test('列表：返回待处理卡（含短号/标题），并落 in+out 两条消息', async () => {
  const { deps } = setup();
  insertReport(deps.db!, {
    taskId: null,
    kind: 'ask',
    payload: { title: '要不要继续', question: '要不要继续？' },
    state: 'pending',
    now: AT,
  });
  const result = await handleChatSend(deps, { text: '列表' }, AT);
  assert.equal(result.resolution.kind, 'command');
  assert.match(String(result.reply), /待你处理（1）/);
  assert.match(String(result.reply), /要不要继续/);
  const rows = deps.repo.listMessages({ limit: 10 });
  assert.equal(rows.filter((r) => r.direction === 'out').length, 1);
});

test('暂停/继续：真派引擎事件，不是只回执', async () => {
  const { deps, db, dispatched } = setup();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/p', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: AT });
  db.prepare("UPDATE tasks SET state = 'executing' WHERE id = ?").run(task.id);
  const short = task.short_id ?? `T-${task.id}`;

  const paused = await handleChatSend(deps, { text: `暂停 ${short}` }, AT);
  assert.equal(paused.resolution.kind, 'command');
  assert.equal(dispatched[0]?.event, 'pause');
  assert.match(String(paused.reply), /已暂停/);

  db.prepare("UPDATE tasks SET state = 'paused' WHERE id = ?").run(task.id);
  const resumed = await handleChatSend(deps, { text: `继续 ${short}` }, AT);
  assert.equal(resumed.resolution.kind, 'command');
  assert.equal(dispatched[1]?.event, 'resume');
  assert.match(String(resumed.reply), /已继续/);
});

test('加预算：task_budget 自动继续；company_budget/manual 不自动继续', async () => {
  const { deps, db, dispatched } = setup();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/p', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: AT });
  const short = task.short_id ?? `T-${task.id}`;
  db.prepare("UPDATE tasks SET state='paused', pause_reason='company_budget' WHERE id=?").run(task.id);

  const company = await handleChatSend(deps, { text: `加预算 ${short} 5000` }, AT);
  assert.equal(dispatched.length, 0, '公司预算来源不自动继续');
  assert.match(String(company.reply), /未自动继续/);

  db.prepare("UPDATE tasks SET pause_reason='task_budget' WHERE id=?").run(task.id);
  const taskBudget = await handleChatSend(deps, { text: `加预算 ${short} 6000` }, AT);
  assert.equal(dispatched[0]?.event, 'resume', '任务预算来源自动继续');
  assert.match(String(taskBudget.reply), /并继续执行/);
});

test('日报：走 emitDailyDigest，回执是真日报文本（不是“已交给幕僚长”）', async () => {
  const { deps } = setup();
  const result = await handleChatSend(deps, { text: '日报' }, AT);
  assert.equal(result.resolution.kind, 'command');
  assert.match(String(result.reply), /今天/);
  const cards = deps.repo.listReports({ kind: 'notification', limit: 10 });
  assert.equal(cards.length, 1, '日报卡落库');
});

test('UG-03：任务设置命令被拒 → `rejected` 结构化回传（预算非正数 / 白名单外模型 / 未登记技能）', async () => {
  const { deps, db } = setup();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'C:/p', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: AT });
  const short = task.short_id ?? `T-${task.id}`;

  // 预算非正数 → rejected 带人话原因；回执照落频道。
  const badBudget = await handleChatSend(deps, { text: `加预算 ${short} 0` }, AT);
  assert.equal(badBudget.ok, true);
  assert.match(String(badBudget.rejected ?? ''), /预算必须是正整数/);

  // 白名单外模型 → rejected（项目显式 allowed_providers=['local']，openai 被拦）。
  db.prepare("UPDATE projects SET allowed_providers = '[\"local\"]' WHERE id = ?").run(projectId);
  const badModel = await handleChatSend(deps, { text: `模型 ${short} openai/gpt-x` }, AT);
  assert.equal(badModel.ok, true);
  assert.ok(badModel.rejected != null && badModel.rejected.length > 0, '白名单外模型必须带 rejected');

  // 未登记技能 → rejected。
  const badSkill = await handleChatSend(deps, { text: `用技能 no-such-skill ${short}` }, AT);
  assert.equal(badSkill.ok, true);
  assert.match(String(badSkill.rejected ?? ''), /没有这个技能/);

  // 成功路径不写 rejected（预算合法）。
  const okBudget = await handleChatSend(deps, { text: `加预算 ${short} 1000` }, AT);
  assert.equal(okBudget.ok, true);
  assert.equal(okBudget.rejected ?? null, null, '成功路径不得带 rejected');
});
