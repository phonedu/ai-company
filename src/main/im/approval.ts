/**
 * IM 拍板回复归位（1:1）。
 *
 * 两种路径：
 *  ① 老板「引用卡片」回复 → `outbound_refs.platform_msg_id` → report_id → 未决 approval；
 *  ② 老板直接回「1/2」→ 取该私聊最近一张未决卡片（同一时刻只保留最近一份语义）。
 *
 * 只接受**显式选项**（数字/选项 key/选项 label/批准类同义词）；自然语言不猜、不代答。
 * 作答复用 `handleTaskApprove`（内部 `answerApproval` + `approvalAnswerEvent`，幂等）。
 */
import type { SqliteDb } from '../db/open.js';
import { cancelImOutboxForReport } from '../db/im_outbox.js';
import { handleTaskApprove, type IpcDeps } from '../ipc/ipc.js';
import type { ImInbound } from './types.js';
import type { CardOption } from './format.js';

export interface PendingApprovalForReply {
  approvalId: number;
  taskId: number | null;
  reportId: number | null;
  question: string;
  options: CardOption[];
}

interface ApprovalQueryRow {
  id: number;
  task_id: number | null;
  report_id: number | null;
  question: string;
  options: string;
}

function parseOptions(raw: string): CardOption[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): CardOption | null => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const key = typeof o.key === 'string' && o.key.length > 0 ? o.key : undefined;
        const label = typeof o.label === 'string' && o.label.length > 0 ? o.label : undefined;
        if (!key && !label) return null;
        return { ...(key ? { key } : {}), ...(label ? { label } : {}), recommended: o.recommended === true };
      })
      .filter((o): o is CardOption => o != null);
  } catch {
    return [];
  }
}

function rowToPending(row: ApprovalQueryRow): PendingApprovalForReply {
  return {
    approvalId: row.id,
    taskId: row.task_id,
    reportId: row.report_id,
    question: row.question,
    options: parseOptions(row.options),
  };
}

const SELECT_PENDING = `SELECT a.id, a.task_id, a.report_id, a.question, a.options
  FROM approvals a`;

/** 该入站消息对应的未决审批（引用链优先；否则最近一张）。 */
export function findPendingApprovalForInbound(
  db: SqliteDb,
  inbound: ImInbound,
): PendingApprovalForReply | null {
  if (inbound.replyToMsgId) {
    const byQuote = db
      .prepare(
        `${SELECT_PENDING}
         JOIN outbound_refs o ON o.report_id = a.report_id
         WHERE o.channel = ? AND o.platform_msg_id = ? AND a.chosen IS NULL
         ORDER BY a.id DESC LIMIT 1`,
      )
      .get(inbound.channel, inbound.replyToMsgId) as ApprovalQueryRow | undefined;
    if (byQuote) return rowToPending(byQuote);
  }
  // 不引用卡片时：先取该私聊**最近一张带 report 的出站卡**（忽略普通回执），
  // 再只看这张卡自己的未决审批——最近一张是完成汇报时，绝不去误答更早的审批。
  const latestRef = db
    .prepare(
      `SELECT report_id FROM outbound_refs
       WHERE channel = ? AND conversation_ref = ? AND report_id IS NOT NULL
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .get(inbound.channel, inbound.conversationRef) as { report_id: number | null } | undefined;
  if (!latestRef?.report_id) return null;
  const latest = db
    .prepare(
      `${SELECT_PENDING} WHERE a.report_id = ? AND a.chosen IS NULL ORDER BY a.id DESC LIMIT 1`,
    )
    .get(latestRef.report_id) as ApprovalQueryRow | undefined;
  return latest ? rowToPending(latest) : null;
}

function normalize(text: string): string {
  return text.trim().replace(/[。！!，,]+$/u, '').trim();
}

/**
 * 解析显式选项；解析不出 → null（让普通消息路径处理，不猜）。
 * 数字按 1-based 序号；也接受选项 key / label 精确匹配与少量批准类同义词。
 */
export function parseApprovalChoice(text: string, options: readonly CardOption[]): string | null {
  const value = normalize(text);
  if (value.length === 0 || options.length === 0) return null;

  const ordinal = /^(\d{1,2})\s*[.、)）]?$/.exec(value);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    const option = options[index];
    return option?.key ?? null;
  }

  // （真机）：接受老板自然写法——剥掉任务号前缀（T-1020／#T1020）与语气助词后
  // 再做精确词匹配；「不批准」「先不批准，等我看下计划」剥完仍不是精确词 → null（不猜，走普通消息）。
  const bare = value
    .replace(/^#?\s*t\s*-?\s*\d{1,6}\s*[:：,，、-]?\s*/iu, '')
    .replace(/[了吧呀嘛哦的啦啊]+$/u, '')
    .trim();
  const lower = bare.toLowerCase();
  for (const option of options) {
    if (option.key && option.key.toLowerCase() === lower) return option.key;
    if (option.label && normalize(option.label).toLowerCase() === lower) return option.key ?? option.label ?? null;
  }

  const approveWords = new Set(['批准', '同意', '通过', '可以', 'ok', 'approve', 'yes']);
  const rejectWords = new Set(['打回', '拒绝', '不行', '驳回', 'revise', 'reject', 'no']);
  if (approveWords.has(lower)) {
    const option = options.find(
      (o) => o.key === 'approve' || (o.label ?? '').includes('批准') || (o.label ?? '').includes('同意'),
    );
    if (option) return option.key ?? option.label ?? null;
  }
  if (rejectWords.has(lower)) {
    const option = options.find(
      (o) => o.key === 'revise' || o.key === 'reject' || (o.label ?? '').includes('打回') || (o.label ?? '').includes('拒绝'),
    );
    if (option) return option.key ?? option.label ?? null;
  }
  return null;
}

function optionLabel(options: readonly CardOption[], chosen: string): string {
  const option = options.find((o) => o.key === chosen || o.label === chosen);
  return option?.label ?? chosen;
}

export interface ApprovalReplyResult {
  handled: boolean;
  reply?: string;
  approvalId?: number;
  /** 对应任务（用于把手机回复落进老板频道同一任务线程；权限审批可空）。 */
  taskId?: number | null;
}

/**
 * 若本条入站是对未决审批卡的显式作答，则作答并返回确认文案；否则 `{handled:false}`。
 * 注意：不在这里发消息（由 manager 统一发），只返回文案。
 */
export async function handleImApprovalReply(
  deps: IpcDeps,
  inbound: ImInbound,
  at: number,
): Promise<ApprovalReplyResult> {
  if (!deps.db) return { handled: false };
  const pending = findPendingApprovalForInbound(deps.db, inbound);
  if (!pending) return { handled: false };
  const chosen = parseApprovalChoice(inbound.text, pending.options);
  if (!chosen) return { handled: false };

  const result = await handleTaskApprove(deps, { approvalId: pending.approvalId, chosen }, at);
  if (!result.ok) {
    return { handled: true, approvalId: pending.approvalId, taskId: pending.taskId, reply: `处理失败：${result.message}` };
  }
  if (pending.reportId != null) {
    cancelImOutboxForReport(deps.db, pending.reportId, 'answered_via_im');
  }
  const label = optionLabel(pending.options, chosen);
  const reply =
    chosen === 'approve'
      ? `已批准：${label}。任务会继续。`
      : chosen === 'revise' || chosen === 'reject'
        ? `已记录：${label}。幕僚长会按你的意见处理。`
        : `已记录：${label}。`;
  return { handled: true, approvalId: pending.approvalId, taskId: pending.taskId, reply };
}
