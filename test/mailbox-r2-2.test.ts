/**
 * R2-2（G7 回灌 ＋ G9 升级）测试 —— 问答闭环 ＋ 升级到老板。
 *
 * 覆盖（每条可弄红）：
 *  - mailbox 域：开放提问列表 / 老板代答（`via='boss'` 如实入账）/ 孤儿答复拒 / 未读答复 ＋ 标读幂等；
 *  - IPC：`mailbox:list/answer`（非法入参、找不到提问 → 明确错误码，不静默）；
 *  - 执行器回灌：pre-run 简报带答复 → post-run 标读（第二轮不再带）；
 *  - `escalate_to_boss`：AskCard（`reports.kind='ask'`）＋ `escalate` 事件派发（复用同一条人话通道）；
 *  - 「同事提问」纯组件（有提问才渲染 / 草稿回显 / 错误与回执如实显示）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listNotifications,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { listReports } from '../src/main/db/reports.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMailboxAnswer, handleMailboxList } from '../src/main/ipc/ipc.js';
import {
  MAILBOX_ERROR,
  MailboxError,
  answerAsk,
  listOpenAsks,
  listUnreadAnswers,
  markAnswersRead,
  requestAsk,
} from '../src/main/engine/mailbox.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import { Engine } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { MailboxQuestions } from '../src/renderer/components/MailboxQuestions.js';
import type { MailboxAskDTO } from '../src/renderer/types.js';

const AT = 1_700_000_000_000;

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(9,'E9','ops',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number, attempt = 0) =>
  toPersistedAction(`dispatch:work_item:${wiId}:${attempt}`, 'dispatch', taskId, JSON.stringify({ attempt }));

// ── mailbox 域 ───────────────────────────────────────────────────────────────

test('R2-2 mailbox：开放提问列表 —— 问了未答=开放；答后=关闭（按 askDedupeKey 配对）', () => {
  const { db, taskId, wiId } = setup();
  try {
    assert.deepEqual(listOpenAsks(db), [], '空库 → 无开放提问（不臆造）');
    const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '术语用「对账单」还是「对账表」？', now: AT });
    const open = listOpenAsks(db);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.askDedupeKey, ask.dedupeKey);
    assert.equal(open[0]!.from, 7);
    assert.equal(open[0]!.to, 9);
    assert.equal(open[0]!.question, '术语用「对账单」还是「对账表」？');
    assert.equal(open[0]!.taskId, taskId);

    answerAsk(db, { taskId, workItemId: wiId, from: 9, to: 7, askDedupeKey: ask.dedupeKey, answer: '用「对账单」。', now: AT + 1 });
    assert.deepEqual(listOpenAsks(db), [], '答后不再列（无重复打扰）');
  } finally {
    db.close();
  }
});

test('R2-2 mailbox：老板代答 —— via=boss 如实入 actor 与 payload（不把老板的话记到员工名下）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '要哪个？', now: AT });
    const deps = { repo: createSqliteChatRepo(db) };

    // 老板作答前：列表可见（「待我处理」面）
    const listed = handleMailboxList(deps) as MailboxAskDTO[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.askDedupeKey, ask.dedupeKey);

    const res = await handleMailboxAnswer(deps, { askDedupeKey: ask.dedupeKey, answer: '走 A 方案。' }, AT + 2);
    assert.deepEqual(res, { ok: true, delivered: true });

    const answered = listTaskEvents(db, taskId).filter((e) => e.kind === 'question_answered');
    assert.equal(answered.length, 1);
    assert.equal(answered[0]!.actor, 'boss', 'actor 必须是 boss（老板代答，不冒充员工）');
    const payload = JSON.parse(String(answered[0]!.payload)) as { via: string; answer: string; to: number };
    assert.equal(payload.via, 'boss');
    assert.equal(payload.answer, '走 A 方案。');
    assert.equal(payload.to, 7, '答复发给提问者');

    // 重复作答 → 幂等（delivered:false，不叠加）
    assert.deepEqual(await handleMailboxAnswer(deps, { askDedupeKey: ask.dedupeKey, answer: '再答一遍' }, AT + 3), {
      ok: true,
      delivered: false,
    });
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'question_answered').length, 1);
    assert.deepEqual(handleMailboxList(deps), [], '答完即从「待我处理」消失');
  } finally {
    db.close();
  }
});

test('R2-2 mailbox：孤儿答复 / 非法入参 —— 明确错误码（不静默落一条没人配得上的答复）', async () => {
  const { db, taskId } = setup();
  try {
    assert.throws(
      () => answerAsk(db, { taskId, from: 9, to: 7, askDedupeKey: 'ask:7:9:task0:0', answer: 'x', now: AT }),
      (error: unknown) => error instanceof MailboxError && error.code === MAILBOX_ERROR.ASK_NOT_FOUND,
      '找不到提问的答复必须抛 E_ASK_NOT_FOUND',
    );
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'question_answered').length, 0, '被拒的答复不得落库');

    const deps = { repo: createSqliteChatRepo(db) };
    assert.equal((await handleMailboxAnswer(deps, { answer: 'x' }, AT) as { ok: false; code: string }).code, 'bad_request');
    assert.equal((await handleMailboxAnswer(deps, { askDedupeKey: 'k', answer: '  ' }, AT) as { ok: false; code: string }).code, 'bad_request');
    const orphan = (await handleMailboxAnswer(deps, { askDedupeKey: 'ask:1:2:task0:0', answer: 'x' }, AT)) as {
      ok: false;
      code: string;
    };
    assert.equal(orphan.code, MAILBOX_ERROR.ASK_NOT_FOUND);
  } finally {
    db.close();
  }
});

test('R2-2 mailbox：未读答复查询 ＋ 标读（幂等；已读的不覆盖时刻）', () => {
  const { db, taskId, wiId } = setup();
  try {
    const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: 'Q', now: AT });
    assert.deepEqual(listUnreadAnswers(db, { taskId, employeeId: 7 }), [], '还没答复 → 未读为空（不臆造）');
    answerAsk(db, { taskId, workItemId: wiId, from: 9, to: 7, askDedupeKey: ask.dedupeKey, answer: 'A', now: AT + 1 });

    const unread = listUnreadAnswers(db, { taskId, employeeId: 7 });
    assert.equal(unread.length, 1, '答复给员工 7 → 未读 1 条');
    assert.equal(unread[0]!.from, 9);
    assert.equal(unread[0]!.answer, 'A');
    assert.equal(unread[0]!.dedupeKey, `${ask.dedupeKey}:answer`);
    assert.deepEqual(listUnreadAnswers(db, { taskId, employeeId: 9 }), [], '别人（员工 9）的未读里没有它');

    assert.equal(markAnswersRead(db, [unread[0]!.dedupeKey], AT + 2), 1, '首次标读：1 行');
    assert.deepEqual(listUnreadAnswers(db, { taskId, employeeId: 7 }), [], '标读后不再列');
    assert.equal(markAnswersRead(db, [unread[0]!.dedupeKey], AT + 3), 0, '重复标读不改时刻（幂等）');
    const row = listNotifications(db, { channel: 'employee:7' }).find((n) => n.dedupe_key.endsWith(':answer'));
    assert.equal(row?.read_at, AT + 2, 'read_at = 首次标读时刻（未被第二次覆盖）');
  } finally {
    db.close();
  }
});

// ── 执行器：回灌 ＋ 升级 ───────────────────────────────────────────────────────

test('R2-2 回灌：pre-run 未读答复进简报；post-run 标读（第二轮不再带）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // 员工 7 先问同事 9；同事作答
    const ask = requestAsk(db, { taskId, workItemId: wiId, from: 7, to: 9, question: '用哪个术语？', now: AT });
    answerAsk(db, { taskId, workItemId: wiId, from: 9, to: 7, askDedupeKey: ask.dedupeKey, answer: '用「对账单」。', now: AT + 1 });

    const fake = makeFakeAgentRuntime([{ text: '收到', toolCalls: [] }, { text: '再跑一次', toolCalls: [] }]);
    const runtime = new EmployeeSessionRuntime(fake);
    const exec = createEmployeeExecutor({ db, runtime, buildContext: buildEmployeeContext, dispatch: () => undefined });

    await exec.execute(dispatchAction(taskId, wiId, 0));
    assert.match(fake.runs[0]!.prompt, /【同事答复】/, '第一轮简报必须带同事答复层');
    assert.match(fake.runs[0]!.prompt, /来自 员工#9：用「对账单」。/, '答复内容原样进简报');
    assert.deepEqual(listUnreadAnswers(db, { taskId, employeeId: 7 }), [], '会话收尾后已标读');

    await exec.execute(dispatchAction(taskId, wiId, 1));
    assert.doesNotMatch(fake.runs[1]!.prompt, /【同事答复】/, '第二轮不再重复带（已消费）');
  } finally {
    db.close();
  }
});

test('R2-2 回灌：无未读答复时简报不含该层（不写空占位）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([{ text: 'ok', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId, 0));
    assert.doesNotMatch(fake.runs[0]!.prompt, /【同事答复】/);
  } finally {
    db.close();
  }
});

test('R2-2 升级（BRK11 单卡口径，2026-10-15）：escalate_to_boss → **一张**决策卡（含提问原文）＋ escalate 派发；同键幂等且不覆盖 resume_state', async () => {
  const { db, taskId, wiId } = setup();
  try {
    // WI 置 running（直接投 escalate：不走提交路径——L0 提交后任务可能已 done、失败聚合后任务已 failed，
    // 那两种时序下 `*`escalate 拒终态 ⇒ 卡出不来；「升级竞态」边界已登记报备，随批 R/真机）
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wiId);
    const events: Array<{ scope: string; event: string }> = [];
    let engine: Engine | undefined;
    const fake = makeFakeAgentRuntime([
      { text: '需要拍板', toolCalls: [{ id: 'e1', name: 'escalate_to_boss', input: { question: '要删旧数据吗？' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(fake),
      dispatch: (e) => {
        events.push({ scope: e.scope, event: e.event });
        return engine!.dispatch(e);
      },
    });
    engine = new Engine(db, exec, { autoSchedule: false, now: () => AT });
    await exec.execute(dispatchAction(taskId, wiId, 0));

    assert.ok(
      events.some((e) => e.scope === 'task' && e.event === 'escalate'),
      '必须派发 task 级 escalate（复用同一条人话通道）',
    );
    const state = (db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as { state: string }).state;
    assert.equal(state, 'needs_decision', '任务必须进 needs_decision（BRK11：卡与状态一体）');
    const asks = listReports(db, { kind: 'ask' }).filter((r) => r.task_id === taskId);
    assert.equal(asks.length, 1, '升级必须落**一张**老板可见的 AskCard（BRK11：此前内联卡＋状态机卡两张）');
    const payload = JSON.parse(String(asks[0]!.payload)) as { question: string; via: string; card: string };
    assert.equal(payload.question, '要删旧数据吗？', '提问原文必须进卡（不再被泛化文案顶掉）');
    assert.equal(payload.via, 'escalate_to_boss');
    assert.equal(payload.card, 'decision');
    const resumeOf = (): string | null =>
      (db.prepare('SELECT resume_state FROM tasks WHERE id=?').get(taskId) as { resume_state: string | null })
        .resume_state;
    assert.equal(resumeOf(), 'inbox', '恢复目标＝进 needs_decision 前的状态（setup：inbox）');

    // 幂等（引擎层再投同 revision=employeeId*1000+0=7000）：不叠第二张、不覆盖 resume_state
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: { question: '要删旧数据吗？', notifyRevision: 7000 },
    });
    assert.equal(listReports(db, { kind: 'ask' }).filter((r) => r.task_id === taskId).length, 1, '同键重放不叠加');
    assert.equal(resumeOf(), 'inbox', '重复升级不得把 resume_state 覆盖成 needs_decision（BRK10/11 保护）');

    // 不同 revision（另一员工/序号）：该升级出**自己的**卡（问题原文各自保留）
    await engine.dispatch({
      scope: 'task',
      id: taskId,
      event: 'escalate',
      actor: 'system',
      payload: { question: '另一个问题', notifyRevision: 9001 },
    });
    assert.equal(listReports(db, { kind: 'ask' }).filter((r) => r.task_id === taskId).length, 2, '不同升级各自成卡');
  } finally {
    db.close();
  }
});

// ── 纯组件：「同事提问」面板 ────────────────────────────────────────────────────

test('R2-2 组件：无提问 → 不渲染（空就不占版面）；有提问 → 行/输入/按钮齐全 ＋ 草稿/错误/回执如实', () => {
  const base = {
    questions: [] as MailboxAskDTO[],
    drafts: {},
    error: null,
    saved: null,
    loading: false,
    onDraftChange: () => undefined,
    onAnswer: () => undefined,
  };
  assert.equal(renderToStaticMarkup(createElement(MailboxQuestions, base)), '', '空 → 渲染为空（不造占位）');

  const questions: MailboxAskDTO[] = [
    { askDedupeKey: 'ask:7:9:task1:0', taskId: 1, workItemId: 2, from: 7, to: 9, question: '用哪个术语？', at: AT },
  ];
  const html = renderToStaticMarkup(
    createElement(MailboxQuestions, { ...base, questions, drafts: { 'ask:7:9:task1:0': '对账单' }, error: '保存失败：x', saved: '已作答（答复将在该员工下一轮会话带回）' }),
  );
  assert.ok(html.includes('data-testid="inbox-question"'), '提问行在场');
  assert.ok(html.includes('员工#7 问 员工#9：用哪个术语？'), '问答双方与问题原文如实显示');
  assert.ok(html.includes('data-testid="inbox-question-input"'), '代答输入框在场');
  assert.ok(html.includes('data-testid="inbox-question-answer"'), '代答按钮在场');
  assert.ok(html.includes('value="对账单"'), '草稿回显（受控）');
  assert.ok(html.includes('data-testid="inbox-questions-error"') && html.includes('保存失败：x'), '错误如实显示（不静默）');
  assert.ok(html.includes('data-testid="inbox-questions-saved"'), '回执如实显示');
});
