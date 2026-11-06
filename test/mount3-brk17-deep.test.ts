/**
 * BRK17 深件（挂载 3 余）：resolver 侧三件生产方 —— `ask_owner` / `reopen_reply` / `confirm` 执行器。
 *
 * 口径：
 *  - `reopen_reply`（05 §3.1.1「提议续办，口头一次确认」）：回复链打到**已归档终态**任务 →
 *    派事件（needs_decision ＋决策卡；`resume_state=done`）；终态未归档不打扰（普通消息照落）。
 *  - `confirm` 执行器：归属拿不准 → **登记待问清单**（`pending_lists`）＋问题 out 消息上屏；
 *    回序号＝第 2 步精确解析（选项带 `then` 时直通该决议——「新建任务/闲聊」也能被序号命中，「只问一次」不落空）。
 *  - `ask_owner`（PLAN「无法判断时落默认项目**或问你一次**」；`projects.ts`「未设置 → 由 resolver 走'模糊时问你一次'」）：
 *    未显式给项目 ＋ 未设默认项目 ＋ 多个项目可选 ⇒ **不自动分诊**，派 `ask_owner`（卡问一次；`resume_state=inbox`，
 *    答后回左栏「待分诊」用既有 [确认为任务] 分流）。
 *
 * 真库（内存）＋真引擎；只断事实（状态/事件/卡/清单/消息）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { Engine } from '../src/main/engine/index.js';
import { handleChatSend, handleTaskCreate } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import type { SemanticSignal } from '../src/core/resolver.js';

const AT = 1_800_000_000_000;
const noopExecutor = { execute: async (): Promise<void> => undefined };
type Db = ReturnType<typeof openMemoryDatabase>;

function fixture(): { db: Db; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => AT });
  return { db, deps: { repo, engine } };
}

/** 低置信度新任务意图（走 buildConfirm——归属拿不准的典型信号）。 */
const lowConfidenceWork = async (): Promise<SemanticSignal> => ({ intent: 'new_task', confidence: 0.4 });

// ─────────────────────────── reopen_reply ───────────────────────────

test('reopen_reply：回复已归档终态任务 → needs_decision＋提议卡（resume_state=done；卡带现成指令）', async () => {
  const f = fixture();
  try {
    const task = f.deps.repo.createTask({ title: '旧任务', goal: 'g' });
    f.db
      .prepare("UPDATE tasks SET state='done', archived=1, closed_at=? WHERE id=?")
      .run(AT - 3_600_000, task.id);
    f.db
      .prepare(
        "INSERT INTO outbound_refs(channel, conversation_ref, platform_msg_id, task_id, report_id, sent_at) VALUES('desktop','desktop:boss','m-done-card',?,NULL,?)",
      )
      .run(task.id, AT - 3_600_000);

    const res = await handleChatSend(f.deps, { text: '这个还能接着弄吗', replyTo: 'm-done-card' }, AT + 1);
    assert.equal(res.resolution.kind, 'task_message', '回复链归位照常（task_message via reply）');
    const row = f.db.prepare('SELECT state, resume_state FROM tasks WHERE id=?').get(task.id) as {
      state: string;
      resume_state: string | null;
    };
    assert.equal(row.state, 'needs_decision', '归档任务的回复 → 提议续办（不是被静默当普通消息）');
    assert.equal(row.resume_state, 'done', '答完回 done（FLOWS：resume_state=done）');
    const cards = f.deps.repo.listReports({ taskId: task.id });
    assert.ok(cards.some((c) => c.kind === 'ask'), '提议续办卡落库');
    assert.ok(
      cards.some((c) => JSON.stringify(c.payload).includes('续办')),
      '卡文案带现成指令（回复「续办 T-xxxx」）',
    );
    const inMsg = f.deps.repo.listMessages({ taskId: task.id }).find((m) => m.direction === 'in');
    assert.ok(inMsg, '老板消息照落并挂在原任务上');
  } finally {
    f.db.close();
  }
});

test('reopen_reply：终态但**未归档** → 不打扰（不派发、任务状态不动、无卡）', async () => {
  const f = fixture();
  try {
    const task = f.deps.repo.createTask({ title: '刚完成', goal: 'g' });
    f.db.prepare("UPDATE tasks SET state='done', closed_at=? WHERE id=?").run(AT - 60_000, task.id);
    f.db
      .prepare(
        "INSERT INTO outbound_refs(channel, conversation_ref, platform_msg_id, task_id, report_id, sent_at) VALUES('desktop','desktop:boss','m-open-card',?,NULL,?)",
      )
      .run(task.id, AT - 60_000);

    await handleChatSend(f.deps, { text: '收尾卡收到', replyTo: 'm-open-card' }, AT + 1);
    const row = f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as { state: string };
    assert.equal(row.state, 'done', '未归档不触发续办提议（窗口内该走 [撤销结束]，那是另一个入口）');
    assert.equal(f.deps.repo.listReports({ taskId: task.id }).filter((c) => c.kind === 'ask').length, 0, '不产卡');
  } finally {
    f.db.close();
  }
});

// ─────────────────────────── confirm 执行器 ───────────────────────────

test('confirm 执行器：登记清单＋问题上屏；回「1」（新建任务）→ 直通 then 且目标=原话；答复后清单清空', async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(1,'甲','D:/a',1)").run();
    f.db.prepare("INSERT INTO settings(key, value) VALUES('projects.default_id', '1')").run();
    const deps: IpcDeps = { ...f.deps, classify: lowConfidenceWork };

    const first = await handleChatSend(deps, { text: '嗯，你看看整一下那边' }, AT);
    assert.equal(first.resolution.kind, 'confirm', '低置信度 → confirm 裁定');
    const list = deps.repo.resolverStore.getPendingList('desktop', 'desktop:boss');
    assert.ok(list && list.items.length >= 2, '待问清单已登记（此前零执行方——BRK17 深件）');
    assert.equal(list.items[0]?.index, 1);
    assert.ok(list.items.some((i) => i.then?.kind === 'new_task'), '「新建任务」选项带完整决议');
    assert.ok(
      deps.repo.listMessages().some((m) => m.direction === 'out' && m.content.includes('回序号')),
      '问题上屏（编号选项）',
    );
    const before = deps.repo.listTasks().length;

    const second = await handleChatSend(deps, { text: '1' }, AT + 1);
    assert.equal(second.resolution.kind, 'new_task', '序号回复 = 第 2 步精确解析（直通该选项决议）');
    const after = deps.repo.listTasks();
    assert.equal(after.length, before + 1, '新任务真建');
    const newest = after.reduce((a, b) => (a.id > b.id ? a : b));
    const goal = (f.db.prepare('SELECT goal FROM tasks WHERE id=?').get(newest.id) as { goal: string }).goal;
    assert.equal(goal, '嗯，你看看整一下那边', '目标=原话（不是序号「1」本身）');
    assert.equal(deps.repo.resolverStore.getPendingList('desktop', 'desktop:boss'), null, '答复后清单清掉（只问一次）');
  } finally {
    f.db.close();
  }
});

test('confirm 执行器：任务选项回序号 → 归位该任务（pending_answer 语义保留）', async () => {
  const f = fixture();
  try {
    const task = f.deps.repo.createTask({ title: '在办任务', goal: 'g' });
    f.db
      .prepare(
        "INSERT INTO im_conversations(channel, conversation_ref, kind, project_id, focus_task_id, focus_updated_at, last_active_at) VALUES('desktop','desktop:boss','private',NULL,?,?,?)",
      )
      .run(task.id, AT - 1000, AT - 1000);
    const deps: IpcDeps = { ...f.deps, classify: lowConfidenceWork };

    const first = await handleChatSend(deps, { text: '顺便看一下这个' }, AT);
    assert.equal(first.resolution.kind, 'confirm');
    const second = await handleChatSend(deps, { text: '1' }, AT + 1);
    assert.equal(second.resolution.kind, 'pending_answer', '任务归属选项仍走 pending_answer（report 关联语义不变）');
    if (second.resolution.kind === 'pending_answer') {
      assert.equal(second.resolution.taskId, task.id);
    }
    const lastIn = deps.repo
      .listMessages({ taskId: task.id })
      .filter((m) => m.direction === 'in')
      .at(-1);
    assert.equal(lastIn?.content, '1', '回复消息挂在所选任务上');
  } finally {
    f.db.close();
  }
});

// ─────────────────────────── ask_owner ───────────────────────────

test('ask_owner：未设默认＋多项目 → 不自动分诊、问一次归属（卡＋resume_state=inbox）；设默认后回归 triage', async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(1,'甲','D:/a',1),(2,'乙','D:/b',1)").run();

    const created = await handleTaskCreate(f.deps, { goal: '归属待定任务' });
    const row = f.db.prepare('SELECT state, resume_state, project_id FROM tasks WHERE id=?').get(created.id) as {
      state: string;
      resume_state: string | null;
      project_id: number;
    };
    assert.equal(row.state, 'needs_decision', '归属拿不准 → 问一次（不是静默分诊）');
    assert.equal(row.resume_state, 'inbox', '答完回「待分诊」（[确认为任务]/[丢弃] 分流既有）');
    const cards = f.deps.repo.listReports({ taskId: created.id });
    assert.ok(cards.some((c) => c.kind === 'ask'), '归属确认卡落库');
    assert.ok(
      cards.some((c) => JSON.stringify(c.payload).includes('默认项目')),
      '卡如实指出暂挂归属（不假装已归到某项目）',
    );
    const proj = f.db.prepare('SELECT name FROM projects WHERE id=?').get(row.project_id) as { name: string };
    assert.equal(proj.name, '默认项目', '行锚在「默认项目」（tasks.project_id NOT NULL）');

    await handleTaskCreate(f.deps, { goal: '第二个' });
    const dup = f.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name='默认项目'").get() as { n: number };
    assert.equal(dup.n, 1, '未设默认时**复用**同一「默认项目」行（旧实现每次 INSERT 会堆积同名项目）');

    f.db.prepare("INSERT INTO settings(key, value) VALUES('projects.default_id', '1')").run();
    const settled = await handleTaskCreate(f.deps, { goal: '有默认了' });
    const settledRow = f.db.prepare('SELECT state FROM tasks WHERE id=?').get(settled.id) as { state: string };
    assert.equal(settledRow.state, 'planning', '设了默认项目 → 回归自动分诊（零摩擦）');
  } finally {
    f.db.close();
  }
});
