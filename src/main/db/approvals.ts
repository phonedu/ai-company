/**
 * `approvals` DAO —— AskCard 的答案（含超时默认动作，schema.sql）。
 * 权限审批复用同表（report_id 为空、question 前缀标识）。
 */
import type { SqliteDb } from './open.js';

export interface ApprovalRow {
  id: number;
  task_id: number | null;
  report_id: number | null;
  question: string;
  options: string;
  default_action: string | null;
  timeout_at: number | null;
  chosen: string | null;
  decided_by: string | null;
  decided_at: number | null;
}

export interface InsertApprovalInput {
  taskId?: number | null;
  reportId?: number | null;
  question: string;
  options?: unknown[];
  defaultAction?: string | null;
  timeoutAt?: number | null;
}

const COLUMNS =
  'id, task_id, report_id, question, options, default_action, timeout_at, chosen, decided_by, decided_at';

/** 权限审批复用 `approvals`：`question` 以此前缀标识为**权限请求**（`PLAN §16.4`，微信里也能批）。 */
export const PERMISSION_QUESTION_PREFIX = '[权限] ';

export function isPermissionApproval(question: string): boolean {
  return question.startsWith(PERMISSION_QUESTION_PREFIX);
}

export function insertApproval(db: SqliteDb, input: InsertApprovalInput): ApprovalRow {
  return db
    .prepare(
      `INSERT INTO approvals(task_id, report_id, question, options, default_action, timeout_at)
       VALUES(?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      input.taskId ?? null,
      input.reportId ?? null,
      input.question,
      JSON.stringify(input.options ?? []),
      input.defaultAction ?? null,
      input.timeoutAt ?? null,
    ) as ApprovalRow;
}

export function getApproval(db: SqliteDb, id: number): ApprovalRow | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined) ?? null;
}

/**
 * 该任务**最新一条未决**审批卡（`chosen IS NULL`）；无则 `null`。
 * B6：超时消费端用它取**真实** `options` + `default_action`（不再硬编码 `approve` = 替老板做决定）。
 */
export function latestPendingApproval(db: SqliteDb, taskId: number): ApprovalRow | null {
  return (
    (db
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE task_id = ? AND chosen IS NULL ORDER BY id DESC LIMIT 1`)
      .get(taskId) as ApprovalRow | undefined) ?? null
  );
}

/**
 * V3 修：审批行**回挂真卡**（`report_id`）——`enrichReport` 靠它给卡 `approvalId`（按钮寻址），
 * `answerApproval` 靠它联动把卡置 `resolved`（「一处处理、两处消除」）。幂等：只补空、不覆盖。
 */
export function linkApprovalReport(db: SqliteDb, approvalId: number, reportId: number): void {
  db.prepare('UPDATE approvals SET report_id = ? WHERE id = ? AND report_id IS NULL').run(reportId, approvalId);
}

export interface AnswerApprovalInput {
  approvalId: number;
  chosen: string;
  decidedBy: 'boss' | 'timeout';
  now?: number;
}

/**
 * 回答 AskCard。**幂等**：已 decided 的再调**不覆盖**，直接返回现状
 * （`task:approve` 的「只发一条 IPC / 不重复触发」靠它兜底）。
 * 联动：把对应的决策卡 `reports.state` 置 `'resolved'`（docs/UI.md §4.1「一处处理、两处消除」；
 * 数据不变量归 DB 层单一写者，1132 裁决）；同样幂等。
 */
export function answerApproval(db: SqliteDb, input: AnswerApprovalInput): ApprovalRow {
  const now = input.now ?? Date.now();
  db.prepare('UPDATE approvals SET chosen = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decided_at IS NULL').run(
    input.chosen,
    input.decidedBy,
    now,
    input.approvalId,
  );
  // 联动决策卡状态（幂等：已 resolved 无变化；report_id 为空 / 不存在则无行改动）
  db.prepare(
    "UPDATE reports SET state = 'resolved' WHERE id = (SELECT report_id FROM approvals WHERE id = ?) AND state <> 'resolved'",
  ).run(input.approvalId);
  const row = getApproval(db, input.approvalId);
  if (!row) throw new Error(`[db] answerApproval: 审批不存在 id=${input.approvalId}`);
  return row;
}
