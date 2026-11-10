/**
 * OPT- · 员工间结构化 mailbox（`` 决定）。
 *
 * 口径：
 *  - **不新增表**：投递记录落 `notifications`（`channel='employee:<to>'`），消息主体落 `task_events`
 *    （`kind='question_asked'` / `'question_answered'`）；
 *  - **默认不进人类频道、不生成新聊天对象**（不写 `human_messages`、不用 `im:*`/`desktop`）；
 *  - **未实现通道返回明确错误码**（`im:*` → `E_CHANNEL_NOT_IMPLEMENTED`；其它 → `E_CHANNEL_UNKNOWN`）。
 *
 * `dedupe_key='ask:<from>:<to>:<work_item|task>:<seq>'`（`UNIQUE` → 重放幂等，不重复投递）。
 */
import { insertTaskEvent, listTaskEventsByKind } from '../db/task_events.js';
import {
  getNotificationByDedupeKey,
  insertNotification,
  listNotifications,
  markNotificationsRead,
  type NotificationRow,
} from '../db/notifications.js';
import { insertWorkItem } from '../db/work_items.js';
import type { SqliteDb } from '../db/open.js';

export interface ChannelRouteOk {
  ok: true;
  kind: 'desktop' | 'employee';
  employeeId?: number;
}
export interface ChannelRouteErr {
  ok: false;
  code: (typeof MAILBOX_ERROR)[keyof typeof MAILBOX_ERROR];
  reason: string;
}
export type ChannelRoute = ChannelRouteOk | ChannelRouteErr;

/** 错误码集中定义（测试直接引用常量，避免字符串漂移）。 */
export const MAILBOX_ERROR = {
  /** 通道已识别但本里程碑未实现（如 IM 投递）。 */
  CHANNEL_NOT_IMPLEMENTED: 'E_CHANNEL_NOT_IMPLEMENTED',
  /** 完全不认识的通道。 */
  CHANNEL_UNKNOWN: 'E_CHANNEL_UNKNOWN',
  /** 阻塞式提问（本里程碑仅支持非阻塞）。 */
  BLOCKING_NOT_IMPLEMENTED: 'E_BLOCKING_NOT_IMPLEMENTED',
  /** R2-2：答复找不到对应提问（孤儿答复）。 */
  ASK_NOT_FOUND: 'E_ASK_NOT_FOUND',
  /** 不能问自己。 */
  SELF_ASK: 'E_SELF_ASK',
  /** 对端已有未结的互问（A↔B 互相提问）——先答再问，防互问死循环。 */
  MUTUAL_ASK: 'E_MUTUAL_ASK',
} as const;

/** 带明确错误码的 mailbox 错误。 */
export class MailboxError extends Error {
  constructor(
    readonly code: (typeof MAILBOX_ERROR)[keyof typeof MAILBOX_ERROR],
    message: string,
  ) {
    super(`[mailbox] ${code}: ${message}`);
    this.name = 'MailboxError';
  }
}

/** 通道解析（投递前先判「这个通道我们实现了吗」——未实现返回明确错误码，不静默丢弃）。 */
export function routeChannel(target: string): ChannelRoute {
  if (target === 'desktop') return { ok: true, kind: 'desktop' };
  const m = /^employee:(\d+)$/.exec(target);
  if (m) return { ok: true, kind: 'employee', employeeId: Number(m[1]) };
  if (/^im:/.test(target)) {
    return { ok: false, code: MAILBOX_ERROR.CHANNEL_NOT_IMPLEMENTED, reason: `IM 通道未实现（M1）：${target}` };
  }
  return { ok: false, code: MAILBOX_ERROR.CHANNEL_UNKNOWN, reason: `未知通道：${target}` };
}

export interface RequestAskInput {
  taskId: number;
  workItemId?: number | null;
  from: number;
  to: number;
  question: string;
  /** true = 阻塞式：宿主把件置 `blocked`，答复到达后自动回队重派（尾）。 */
  blocking?: boolean;
  /**
   * 同一 (from,to,work_item) 下的轮次序号（默认 0），用于构造幂等键。
   * **必须跨轮唯一**：生产传「动作版本＋本轮下标」（如 `r2-0`），否则返工/重试轮的第一条提问
   * 会与上一轮撞键、被幂等静默丢弃（ADV-1 P0-1）。数字形式保留给单测/手写调用。
   */
  seq?: number | string;
  now: number;
}

export interface AskRecord {
  dedupeKey: string;
  channel: string;
  blocking: boolean;
  /** 本次是否新投递（false = 幂等重放）。 */
  delivered: boolean;
}

/**
 * /：员工唤醒——ask 送达后给**空闲**目标员工派轻量 reply 工作项。
 *
 * 口径：目标**忙**（有 running 件，全局员工并发=1）→ 'busy'（问题留在 mailbox，下次会话
 * 可见——现状不变）；同 askKey 已有 reply 件（任意未结/已结态）→ 'exists'（幂等，重放不重派）；
 * 否则在**提问方任务**里落 reply 件（成本与聚合归属提问方任务；brief 带问题＋dedupeKey＋
 * `answer_colleague` 作答指引；`work_item_created` 事件 payload 带 askKey 供审计）。
 */
export type ReplySpawnOutcome = 'spawned' | 'busy' | 'exists';

export function spawnReplyWorkItem(
  db: SqliteDb,
  input: { taskId: number; askDedupeKey: string; from: number; to: number; question: string; now: number },
): ReplySpawnOutcome {
  // 忙：目标员工有 running 件（员工并发=1 硬守卫的同源事实）
  const busy = db.prepare("SELECT 1 FROM work_items WHERE employee_id = ? AND state = 'running' LIMIT 1").get(input.to);
  if (busy) return 'busy';
  // 幂等：同 askKey 的 reply 件已存在（brief JSON 内嵌 askKey）
  const marker = `"askKey":"${input.askDedupeKey}"`;
  const exists = db
    .prepare("SELECT 1 FROM work_items WHERE task_id = ? AND brief LIKE ? LIMIT 1")
    .get(input.taskId, `%${marker}%`);
  if (exists) return 'exists';
  const briefText =
    `【同事提问回复】员工#${input.from} 问你：${input.question}
` +
    `请调用 answer_colleague（askDedupeKey="${input.askDedupeKey}"）作答；作答要点同时用 submit_work_item 提交（summary=答复要点）收口本件。`;
  insertWorkItem(db, {
    taskId: input.taskId,
    employeeId: input.to,
    title: `回复员工#${input.from} 的提问`,
    brief: JSON.stringify({ text: briefText, askKey: input.askDedupeKey }),
    now: input.now,
    actor: 'system',
    eventExtra: { askKey: input.askDedupeKey, replyWake: true },
  });
  return 'spawned';
}

/** 员工向同事实体提问：写「消息主体」事件 + 「投递」记录（同一调用内两步，供事务包裹）。 */
export function requestAsk(db: SqliteDb, input: RequestAskInput): AskRecord {
  if (input.from === input.to) {
    throw new MailboxError(MAILBOX_ERROR.SELF_ASK, `不能向自己提问（employee ${input.from}）`);
  }
  // A↔B 已有一条未结互问时拒绝反向新问——先答再问，防止两个员工互相提问无限挂起。
  const mutual = listOpenAsks(db).some((a) => a.from === input.to && a.to === input.from);
  if (mutual) {
    throw new MailboxError(
      MAILBOX_ERROR.MUTUAL_ASK,
      `员工 ${input.to} 已有未结问题问 ${input.from}——先回答再提问（防互问死循环）`,
    );
  }
  const seq = String(input.seq ?? 0);
  const subject = input.workItemId != null ? `wi${input.workItemId}` : `task${input.taskId}`;
  const dedupeKey = `ask:${input.from}:${input.to}:${subject}:${seq}`;
  const channel = `employee:${input.to}`;

  // 阻塞式提问（尾）：不再抛错——照常投递；宿主（employee-executor）据 `blocking` 把件置 `blocked`，
  // 答复到达后由 `mailbox:answer` 派发 `answer_received` 回队（见 `handleMailboxAnswer`）。

  // 幂等：已投递过同键（重放/重试）→ 不再重复写事件与投递行（副作用整体幂等）。
  if (getNotificationByDedupeKey(db, dedupeKey)) {
    return { dedupeKey, channel, blocking: input.blocking ?? false, delivered: false };
  }

  // ① 消息主体（单一事实来源）
  insertTaskEvent(db, {
    taskId: input.taskId,
    workItemId: input.workItemId ?? null,
    ts: input.now,
    kind: 'question_asked',
    actor: `employee:${input.from}`,
    payload: { from: input.from, to: input.to, question: input.question, blocking: input.blocking ?? false, dedupeKey },
  });
  // ② 投递记录（幂等；不落人类频道）
  const delivered = insertNotification(db, {
    channel,
    conversationRef: `employee:${input.from}`,
    dedupeKey,
    sentAt: input.now,
  });
  return { dedupeKey, channel, blocking: input.blocking ?? false, delivered };
}

export interface AnswerAskInput {
  taskId: number;
  workItemId?: number | null;
  /** 作答者（= 原提问的 `to`）。 */
  from: number;
  /** 原提问者（= 原 `to` 收到答案）。 */
  to: number;
  /** 原提问的幂等键（定位对应问题）。 */
  askDedupeKey: string;
  answer: string;
  /**
   * R2-2：答复来源——`'employee'`（同事自答，缺省）或 `'boss'`（老板在「待我处理」代答）。
   * 事件 `actor` 与 payload `via` 如实记录（**不把老板的话记到员工名下**）。
   */
  via?: 'employee' | 'boss';
  now: number;
}

export interface AnswerRecord {
  dedupeKey: string;
  /** 本次是否新作答（false = 重复作答同一条 ask，已幂等忽略）。 */
  delivered: boolean;
}

/** 定位一条 ask（按幂等键）；不存在 → undefined（`answerAsk` 据此拒绝孤儿答复）。 */
export function getAskByDedupeKey(db: SqliteDb, askDedupeKey: string): AskRecord | undefined {
  if (!getNotificationByDedupeKey(db, askDedupeKey)) return undefined;
  return { dedupeKey: askDedupeKey, channel: '', blocking: false, delivered: true };
}

/**
 * 同事作答：写「消息主体」事件（`question_answered`）并落一条投递记录。
 * **幂等**：同一条 ask 重复作答 → 不重复写事件/投递（`delivered=false`）。
 * **孤儿答复拒绝**：`askDedupeKey` 无对应 ask（或不是 ask 键）→ 抛 `E_ASK_NOT_FOUND`（不静默落一条没人配得上的答复）。
 */
export function answerAsk(db: SqliteDb, input: AnswerAskInput): AnswerRecord {
  const dedupeKey = `${input.askDedupeKey}:answer`;
  if (getNotificationByDedupeKey(db, dedupeKey)) {
    return { dedupeKey, delivered: false };
  }
  if (!/^ask:/.test(input.askDedupeKey) || !getNotificationByDedupeKey(db, input.askDedupeKey)) {
    throw new MailboxError(MAILBOX_ERROR.ASK_NOT_FOUND, `找不到对应的提问：${input.askDedupeKey}`);
  }
  const via = input.via ?? 'employee';
  insertTaskEvent(db, {
    taskId: input.taskId,
    workItemId: input.workItemId ?? null,
    ts: input.now,
    kind: 'question_answered',
    actor: via === 'boss' ? 'boss' : `employee:${input.from}`,
    payload: { from: input.from, to: input.to, answer: input.answer, askDedupeKey: input.askDedupeKey, via },
  });
  insertNotification(db, {
    channel: `employee:${input.to}`,
    conversationRef: `employee:${input.from}`,
    dedupeKey,
    sentAt: input.now,
  });
  return { dedupeKey, delivered: true };
}

/** 某员工的收件箱（投递到 `employee:<id>` 的记录）。 */
export function listMailbox(db: SqliteDb, employeeId: number): NotificationRow[] {
  return listNotifications(db, { channel: `employee:${employeeId}` });
}

// ── R2-2（G7 回灌）：开放提问 / 未读答复 / 已读标记 ─────────────────────────────

export interface OpenAsk {
  askDedupeKey: string;
  taskId: number;
  workItemId: number | null;
  from: number;
  to: number;
  question: string;
  /** 阻塞式（作答后宿主把件从 `blocked` 回队）。 */
  blocking: boolean;
  at: number;
}

interface AskPayload {
  /** `question_asked` 事件用 `dedupeKey` 记本条 ask 的幂等键（`answerAsk` 侧字段名是 `askDedupeKey`）。 */
  dedupeKey?: unknown;
  from?: unknown;
  to?: unknown;
  question?: unknown;
  answer?: unknown;
  askDedupeKey?: unknown;
  blocking?: unknown;
}

function parsePayload(raw: string): AskPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AskPayload) : {};
  } catch {
    return {};
  }
}

/**
 * 未结提问（全库）：`question_asked` 且尚无对应 `question_answered`（按 askDedupeKey 配对）。
 * 供「待我处理」面列出、由老板作答（`answerAsk` with `via:'boss'`）。
 */
export function listOpenAsks(db: SqliteDb): OpenAsk[] {
  const answered = new Set(
    listTaskEventsByKind(db, 'question_answered')
      .map((e) => parsePayload(String(e.payload)).askDedupeKey)
      .filter((k): k is string => typeof k === 'string'),
  );
  const out: OpenAsk[] = [];
  for (const e of listTaskEventsByKind(db, 'question_asked')) {
    const p = parsePayload(String(e.payload));
    const askDedupeKey =
      typeof p.dedupeKey === 'string' ? p.dedupeKey : typeof p.askDedupeKey === 'string' ? p.askDedupeKey : null;
    const question = typeof p.question === 'string' ? p.question : '';
    if (!askDedupeKey || !question || answered.has(askDedupeKey)) continue;
    out.push({
      askDedupeKey,
      taskId: e.task_id,
      workItemId: e.work_item_id,
      from: typeof p.from === 'number' ? p.from : 0,
      to: typeof p.to === 'number' ? p.to : 0,
      question,
      blocking: p.blocking === true,
      at: e.ts,
    });
  }
  return out;
}

/** 发给某员工的未结提问（：被问员工在下次会话看到点名问，可用 `answer_colleague` 作答）。 */
export function listOpenAsksForEmployee(db: SqliteDb, employeeId: number, taskId?: number | null): OpenAsk[] {
  return listOpenAsks(db).filter((a) => a.to === employeeId && (taskId == null || a.taskId === taskId));
}

/** 按幂等键取一条**提问**（不论已否作答）；不存在 → undefined。 */
export function getAsk(db: SqliteDb, askDedupeKey: string): OpenAsk | undefined {
  for (const e of listTaskEventsByKind(db, 'question_asked')) {
    const p = parsePayload(String(e.payload));
    const key = typeof p.dedupeKey === 'string' ? p.dedupeKey : typeof p.askDedupeKey === 'string' ? p.askDedupeKey : null;
    const question = typeof p.question === 'string' ? p.question : '';
    if (key !== askDedupeKey || !question) continue;
    return {
      askDedupeKey: key,
      taskId: e.task_id,
      workItemId: e.work_item_id,
      from: typeof p.from === 'number' ? p.from : 0,
      to: typeof p.to === 'number' ? p.to : 0,
      question,
      blocking: p.blocking === true,
      at: e.ts,
    };
  }
  return undefined;
}

/** 按幂等键取一条**未结**提问（`mailbox:answer` 用）；已答/不存在 → undefined。 */
export function getOpenAsk(db: SqliteDb, askDedupeKey: string): OpenAsk | undefined {
  return listOpenAsks(db).find((a) => a.askDedupeKey === askDedupeKey);
}

export interface UnreadAnswer {
  /** 答复的投递幂等键（=`<askDedupeKey>:answer`）——标读用。 */
  dedupeKey: string;
  from: number;
  answer: string;
  at: number;
}

/**
 * 发给某员工、**尚未被其会话消费**的答复（回灌用）。
 * 口径：答复事件（`question_answered`）且 payload.to = 员工 id、同任务；
 *      对应投递行（`<askDedupeKey>:answer`）`read_at IS NULL` ⇒ 未读。
 */
export function listUnreadAnswers(db: SqliteDb, input: { taskId: number; employeeId: number }): UnreadAnswer[] {
  const unreadKeys = new Set(
    listNotifications(db, { channel: `employee:${input.employeeId}` })
      .filter((n) => n.read_at == null && n.dedupe_key.endsWith(':answer'))
      .map((n) => n.dedupe_key),
  );
  if (unreadKeys.size === 0) return [];
  const out: UnreadAnswer[] = [];
  for (const e of listTaskEventsByKind(db, 'question_answered')) {
    if (e.task_id !== input.taskId) continue; // 答复随提问所在任务回流（提问者在该任务上下文里提问）
    const p = parsePayload(String(e.payload));
    if (typeof p.to !== 'number' || p.to !== input.employeeId) continue;
    const askDedupeKey = typeof p.askDedupeKey === 'string' ? p.askDedupeKey : null;
    const answer = typeof p.answer === 'string' ? p.answer : '';
    if (!askDedupeKey || !answer) continue;
    const dedupeKey = `${askDedupeKey}:answer`;
    if (!unreadKeys.has(dedupeKey)) continue;
    out.push({ dedupeKey, from: typeof p.from === 'number' ? p.from : 0, answer, at: e.ts });
  }
  return out;
}

/** 把答复标为已读（post-run 调用；幂等——已读的不覆盖时刻）。返回标读行数。 */
export function markAnswersRead(db: SqliteDb, dedupeKeys: readonly string[], readAt: number): number {
  return markNotificationsRead(db, dedupeKeys, readAt);
}
