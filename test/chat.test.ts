import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { writeSetting } from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask, type TaskRow } from '../src/main/db/tasks.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  handleChatSend,
  handleChatList,
  handleInboxList,
  handleInboxAnswer,
  handleTaskApprove,
  handleTaskList,
  type IpcDeps,
} from '../src/main/ipc/ipc.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

// ───────────────────────── T0.5 · 老板频道 IPC 测试 ─────────────────────────
// 用**真实 SQLite 内存库 + 真迁移**，走 `handle*` 纯函数（与 ipcMain 同一实现）。

const AT = 1_700_000_000_000;

function setup(): { db: SqliteDb; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, deps: { repo } };
}

function seedProject(db: SqliteDb): number {
  const row = db
    .prepare(`INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?,?,?,?) RETURNING id`)
    .get('记账系统', '记账', 'D:/proj', AT) as { id: number };
  return row.id;
}

function seedTask(db: SqliteDb): TaskRow {
  const projectId = seedProject(db);
  return createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '竞品对账脚本',
    goal: '调研并实现',
    now: AT,
  });
}

test('T0.5 chat:send：普通文本 → 归属裁定 chat，且落 human_messages', async () => {
  const { deps } = setup();
  const result = await handleChatSend(deps, { text: '你好，介绍下自己' }, AT);

  assert.equal(result.ok, true);
  assert.equal(result.resolution.kind, 'chat');
  assert.ok(result.messageId > 0);

  const rows = handleChatList(deps, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.messageId);
  assert.equal(rows[0].content, '你好，介绍下自己');
  assert.equal(rows[0].direction, 'in');
  assert.equal(rows[0].taskId, null);
  assert.equal(rows[0].createdAt, AT);
});

test('T0.5 chat:send：命令「列表」直通 → 裁定 command(list)', async () => {
  const { deps } = setup();
  const result = await handleChatSend(deps, { text: '列表' }, AT);
  assert.equal(result.resolution.kind, 'command');
  if (result.resolution.kind === 'command') {
    assert.equal(result.resolution.name, 'list');
  }
});

test('T0.5 chat:send：#T-1001 任务寻址 → 裁定 task_message，消息带 taskId', async () => {
  const { db, deps } = setup();
  const task = seedTask(db);

  const result = await handleChatSend(deps, { text: '#T-1001 补充一个边界用例' }, AT);
  assert.equal(result.resolution.kind, 'task_message');
  if (result.resolution.kind === 'task_message') {
    assert.equal(result.resolution.taskId, task.id);
  }

  const rows = handleChatList(deps, { taskId: task.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, task.id);
});

test('T0.5 chat:send 附件：丢弃 path、保留 fileToken 与元信息（D1）', async () => {
  const { deps } = setup();
  await handleChatSend(
    deps,
    {
      text: '看图',
      attachments: [
        { name: 'a.png', size: 12, type: 'image/png', path: 'C:/Windows/win.ini', fileToken: 'tok-1' },
      ],
    },
    AT,
  );

  const rows = handleChatList(deps, {});
  assert.deepEqual(rows[0].attachments, [
    { name: 'a.png', size: 12, type: 'image/png', fileToken: 'tok-1' },
  ]);
  assert.equal((rows[0].attachments[0] as Record<string, unknown>).path, undefined);
});

test('T0.5 inbox:list 渲染字段：卡片带 state 与 options；inbox:answer 幂等', async () => {
  const { db, deps } = setup();
  const task = seedTask(db);
  const report = db
    .prepare(
      `INSERT INTO reports (task_id, kind, payload, state, created_at) VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(
      task.id,
      'ask',
      JSON.stringify({ question: '用 Python 还是 Node？', options: [{ key: '1', label: 'Python' }] }),
      'pending',
      AT,
    ) as { id: number };

  const cards = handleInboxList(deps, {});
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'ask');
  assert.equal(cards[0].state, 'pending');
  assert.equal(cards[0].shortId, 'T-1001');
  // MP1-9：待办卡必须带项目归属（多项目下可辨）
  assert.equal(cards[0].projectName, '记账系统');
  assert.equal(typeof cards[0].projectId, 'number');

  const first = handleInboxAnswer(deps, { id: report.id }, AT + 1);
  assert.equal(first.ok, true);
  const second = handleInboxAnswer(deps, { id: report.id }, AT + 2);
  assert.equal(second.ok, true);
  // 二次调用不产生额外副作用（state 仍为 acknowledged）
  assert.equal(handleInboxList(deps, {})[0].state, 'acknowledged');
});

test('T0.5 task:approve 幂等：重复选择不覆盖首次决定（防按钮重复触发）', async () => {
  const { db, deps } = setup();
  const task = seedTask(db);
  const report = db
    .prepare(
      `INSERT INTO reports (task_id, kind, payload, state, created_at) VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(task.id, 'ask', JSON.stringify({ question: 'q', options: [] }), 'pending', AT) as {
    id: number;
  };
  const approval = db
    .prepare(
      `INSERT INTO approvals (task_id, report_id, question, options, default_action) VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(task.id, report.id, 'q', JSON.stringify([{ key: '1' }, { key: '2' }]), '1') as { id: number };

  const first = await handleTaskApprove(deps, { approvalId: approval.id, chosen: '1' }, AT);
  assert.equal(first.ok, true);
  if (first.ok) {
    const a = first.approval as { chosen: string; decidedBy: string };
    assert.equal(a.chosen, '1');
    assert.equal(a.decidedBy, 'boss');
  }

  const second = await handleTaskApprove(deps, { approvalId: approval.id, chosen: '2' }, AT + 5000);
  assert.equal(second.ok, true);
  if (second.ok) {
    const a = second.approval as { chosen: string };
    assert.equal(a.chosen, '1', '重复调用不得覆盖首次决定');
  }

  // 决策卡随之 resolved
  const reports = handleInboxList(deps, {});
  assert.equal(reports[0].state, 'resolved');
});

test('T0.4 接线：chat:send 触发幕僚长 runTurn（fire-and-forget，用假 runtime 不联网）', async () => {
  const { deps } = setup();
  const calls: Array<{ text: string; taskId?: number | null; projectId?: number | null }> = [];
  deps.assistant = {
    runTurn: async (input) => {
      calls.push(input);
      return { replyMessageId: 99 };
    },
  };

  const result = await handleChatSend(deps, { text: '你好' }, AT);
  assert.equal(result.ok, true);
  // fire-and-forget：不阻塞返回；等一拍微任务后应已调用
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ text: '你好', taskId: null, projectId: null }]);

  // D-19：桌面当前项目随 chat:send 传入（无任务时作为助手项目上下文）
  await handleChatSend(deps, { text: '项目内', projectId: 7 }, AT);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[1]?.projectId, 7);

  // 无 assistant（缺 key）时 chat:send 仍成功落库（不崩、不 mock）
  const withoutAssistant = setup();
  const res2 = await handleChatSend(withoutAssistant.deps, { text: '你好' }, AT);
  assert.equal(res2.ok, true);
  assert.equal(handleChatList(withoutAssistant.deps, {}).length, 1);
});

test('D0 对话→建任务：`new_task` 裁定**被执行**（建任务 ＋ 消息挂到新任务上）；有引擎时随 D1 进 planning', async () => {
  const { db, deps } = setup();
  writeSetting(db, 'projects.default_id', seedProject(db)); // 归属明确（无默认项目 ⇒ resolver 落"先确认"，不是本测要验的）
  const classify = async (): Promise<{ intent: 'new_task'; confidence: number; titleGuess: string }> => ({
    intent: 'new_task',
    confidence: 0.95,
    titleGuess: '竞品简报',
  });

  // ① 无引擎：建任务（D1 需要引擎才分诊）——如实停在 inbox，不假装已分诊
  const result = await handleChatSend({ ...deps, classify, triageMode: 'classifier' }, { text: '把这周的竞品动态整理成一页简报' }, AT);
  assert.equal(result.resolution.kind, 'new_task');
  const tasks = handleTaskList({ ...deps }, {});
  assert.equal(tasks.length, 1, 'D0：裁定被执行 ⇒ 任务真的建了（修前：无声无息）');
  assert.equal(tasks[0]!.state, 'inbox', '无引擎 ⇒ 保持 inbox（不假装已分诊）');
  const rows = handleChatList({ ...deps }, {});
  assert.equal(rows.length, 2, '入站原话 + 受理回执（建任务后不再跑频道幕僚长）');
  const inbound = rows.find((r) => r.direction === 'in');
  const receipt = rows.find((r) => r.direction === 'out');
  assert.equal(inbound?.taskId, tasks[0]!.id, '老板原话挂到新任务上（＝任务的第一个输入）');
  assert.match(String(receipt?.content), /已受理 T-\d+/);
  assert.equal(receipt?.taskId, tasks[0]!.id, '受理回执也挂到任务上');

  // ② 有引擎：D1 自动分诊 → 直接进 planning
  const db2 = openMemoryDatabase();
  runMigrations(db2);
  const repo2 = createSqliteChatRepo(db2);
  db2.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(0,'幕僚长','assistant',1)").run();
  writeSetting(db2, 'projects.default_id', seedProject(db2));
  const engine2 = new Engine(db2, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  const result2 = await handleChatSend({ repo: repo2, engine: { dispatch: (e: unknown) => engine2.dispatch(e as never) }, classify, triageMode: 'classifier' } as unknown as IpcDeps, { text: '再整一页竞品简报' }, AT + 1);
  assert.equal(result2.ok, true);
  const tasks2 = handleTaskList({ repo: repo2 }, {});
  assert.equal(tasks2.length, 1);
  assert.equal(tasks2[0]!.state, 'planning', 'D0＋D1：一句话 → 任务 → 自动分诊进 planning');
  db2.close();
  db.close();
});
