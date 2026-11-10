/**
 * 会话事件 → `task_events` 落库（事件映射表）。
 *
 *
 *  - `tool_call`（start / end）→ `task_events.kind='tool_call'`（员工墙 / 行为日志数据源）；
 *  - `report_progress` 工具 → 额外落 `progress_reported` 并投影 `plan_steps`；
 *  - `message_update`（text_delta）**不落库**（推送即忘）。
 */
import { insertTaskEvent } from '../db/task_events.js';
import { updatePlanStepState, PLAN_STEP_STATES, type PlanStepState } from '../db/plan_steps.js';
import type { SqliteDb } from '../db/open.js';

/**
 * RET-：员工 `tool_call_start` 落库时只保留**找路/审计需要**的字段（command/path/pattern…），
 * 不上传 content/body/任意大字段；每个值截断到 500 字符。原始工具结果仍在归档/会话里。
 */
export const TOOL_INPUT_EVENT_KEYS = ['command', 'path', 'file_path', 'pattern', 'glob', 'query', 'name', 'url', 'timeout'] as const;
export const TOOL_INPUT_EVENT_MAX_CHARS = 500;

export function sanitizeToolInput(input: unknown): Record<string, string> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of TOOL_INPUT_EVENT_KEYS) {
    const value = src[key];
    if (typeof value === 'string') out[key] = value.slice(0, TOOL_INPUT_EVENT_MAX_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

export interface ToolCallContext {
  taskId: number | null;
  workItemId?: number | null;
  actor: string;
}

export interface ToolCallEventInput {
  toolCallId: string;
  toolName: string;
  phase: 'start' | 'end';
  input?: Record<string, unknown>;
  isError?: boolean;
  /** end 阶段可带的错误说明（如投影校验失败）。 */
  error?: string;
}

/** 落一条 `tool_call` task_event（taskId 为空则不落，避免无主事件）。返回事件 id 或 null。 */
export function persistToolCallEvent(
  db: SqliteDb,
  ctx: ToolCallContext,
  event: ToolCallEventInput,
  at: number,
): number | null {
  if (ctx.taskId == null) return null;
  return insertTaskEvent(db, {
    taskId: ctx.taskId,
    workItemId: ctx.workItemId ?? null,
    ts: at,
    kind: 'tool_call',
    actor: ctx.actor,
    payload: {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      phase: event.phase,
      ...(event.phase === 'start' ? { input: event.input ?? {} } : {}),
      ...(event.phase === 'end' ? { isError: event.isError ?? false } : {}),
      ...(event.error ? { error: event.error } : {}),
    },
  });
}

export interface ProgressReportedInput {
  taskId: number;
  stepIdx: number;
  state: PlanStepState;
  note?: string;
  evidenceRef?: string | null;
  workItemId?: number | null;
  actor?: string;
  at?: number;
}

/**
 * `report_progress` 的落库投影：写 `progress_reported` 事件 + 更新 `plan_steps`。
 * 校验：`state` 必须是 `pending|running|done|skipped|failed`（否则抛错，不静默吞）。
 */
export function projectProgressReported(db: SqliteDb, input: ProgressReportedInput): { eventId: number; stepUpdated: boolean } {
  if (!Number.isInteger(input.stepIdx) || input.stepIdx < 1) {
    throw new Error(`[agent] report_progress.stepIdx 必须为 >=1 的整数，收到 ${String(input.stepIdx)}`);
  }
  if (!PLAN_STEP_STATES.includes(input.state)) {
    throw new Error(`[agent] report_progress.state 非法：${String(input.state)}（应为 ${PLAN_STEP_STATES.join('|')}）`);
  }
  const at = input.at ?? Date.now();
  const actor = input.actor ?? 'assistant';
  const eventId = insertTaskEvent(db, {
    taskId: input.taskId,
    workItemId: input.workItemId ?? null,
    ts: at,
    kind: 'progress_reported',
    actor,
    payload: { stepIdx: input.stepIdx, state: input.state, ...(input.note ? { note: input.note } : {}) },
  });
  const stepUpdated = updatePlanStepState(db, {
    taskId: input.taskId,
    stepIdx: input.stepIdx,
    state: input.state,
    workItemId: input.workItemId ?? null,
    evidenceRef: input.evidenceRef ?? null,
    now: at,
  });
  return { eventId, stepUpdated };
}
