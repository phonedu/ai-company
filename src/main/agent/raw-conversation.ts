/**
 *  · `rawConversation` 读模型（**派生投影，只读**；契约见 ``/` M1`）。
 *
 * 存储（不新增表）：
 *  - 员工发言 → `task_events.kind='agent_message'`（payload `{employeeId, text, mentions?:number[]}`）
 *  - 员工思考 → `task_events.kind='agent_thinking'`（payload `{employeeId, text}`）【 不采集】
 *  - 工具调用 → 既有 `tool_call`（start 带 `input`、end 带 `isError`；按 `toolCallId` 配对）
 *  - 老板原话 → 既有 `human_messages`（`direction='in'`）
 *
 * 口径：`text`/`thinking` 各自成条；`mentions` 显式数组；`argsDigest` 主进程截断 ≤120 且**脱敏**；
 * 排序 `at` 升序、同 `at` 按 `id`；缺数据 → **空数组**（UI 显式空态，绝不臆造）。
 */
import { listHumanMessages } from '../db/human_messages.js';
import type { SqliteDb } from '../db/open.js';

export interface RawItem {
  id: string;
  role: 'boss' | 'employee' | 'system';
  employeeId?: number;
  name?: string;
  at: number;
  text?: string;
  thinking?: string;
  toolCall?: { name: string; argsDigest?: string; ok: boolean; error?: string; durationMs?: number };
  mentions?: number[];
}

export const ARGS_DIGEST_MAX = 120;

const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|bearer|cookie)/i;
const INLINE_SECRET = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,}|eyJ[A-Za-z0-9._-]{10,})/g;

/** 脱敏：按敏感键名替换值 + 抹掉行内疑似密钥；再截断到 ≤max（越界加 `…`）。 */
export function redactArgsDigest(value: unknown, max: number = ARGS_DIGEST_MAX): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  } catch {
    text = String(value);
  }
  text = text.replace(INLINE_SECRET, '«redacted»');
  // 整个 "<敏感键>": <值> 替换为 "<敏感键>":"«redacted»"（**非捕获分组包裹**，避免 | 优先级把别处也吞了）。
  const keyRe = new RegExp(
    `("(?:[^"]*?)(?:${SENSITIVE_KEY.source.slice(1, -1)})(?:[^"]*?)"\\s*:\\s*)("[^"]*"|[^,}\\s]+)`,
    'gi',
  );
  text = text.replace(keyRe, '$1"«redacted»"');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload: string;
}

/** 员工展示名（缺失则不臆造：省略 `name`，UI 降级为 `员工#<id>`）。 */
function employeeName(db: SqliteDb, id: number): string | undefined {
  const row = db.prepare('SELECT name FROM employees WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name;
}

export interface ProjectRawConversationOptions {
  /** 只取最近 N 条（默认 500）。 */
  limit?: number;
}

export function projectRawConversation(db: SqliteDb, taskId: number, options: ProjectRawConversationOptions = {}): RawItem[] {
  const limit = options.limit ?? 500;
  const items: RawItem[] = [];

  // ① 老板原话（human_messages in 方向）
  for (const m of listHumanMessages(db, { taskId })) {
    if (m.direction !== 'in') continue;
    items.push({ id: `human_msg:${m.id}`, role: 'boss', at: m.created_at, text: m.content });
  }

  // ② 员工事件（agent_message / agent_thinking / tool_call）
  const rows = db
    .prepare(
      "SELECT id, ts, kind, payload FROM task_events WHERE task_id = ? AND kind IN ('agent_message','agent_thinking','tool_call') ORDER BY ts, id",
    )
    .all(taskId) as EventRow[];

  const starts = new Map<string, { name: string; argsDigest: string; at: number; id: number }>();
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (r.kind === 'agent_message') {
      const employeeId = Number(payload.employeeId);
      const text = String(payload.text ?? '');
      if (!text) continue; // 不用空串兜底
      const mentions = Array.isArray(payload.mentions) ? (payload.mentions as number[]) : undefined;
      items.push({
        id: `task_event:${r.id}`,
        role: 'employee',
        employeeId: Number.isInteger(employeeId) ? employeeId : undefined,
        name: Number.isInteger(employeeId) ? employeeName(db, employeeId) : undefined,
        at: r.ts,
        text,
        ...(mentions ? { mentions } : {}),
      });
    } else if (r.kind === 'agent_thinking') {
      const text = String(payload.text ?? '');
      if (!text) continue;
      const employeeId = Number(payload.employeeId);
      items.push({
        id: `task_event:${r.id}`,
        role: 'employee',
        employeeId: Number.isInteger(employeeId) ? employeeId : undefined,
        name: Number.isInteger(employeeId) ? employeeName(db, employeeId) : undefined,
        at: r.ts,
        thinking: text,
      });
    } else {
      // tool_call：
      //  - G3 耗时行（自含 `durationMs`，无 start 配对）→ **直接成条**（否则时长永远看不到）；
      //  - 否则：start 记 name+args、end 记 ok/error，按 toolCallId 配对。
      const toolCallId = String(payload.toolCallId ?? '');
      if (typeof payload.durationMs === 'number') {
        items.push({
          id: `task_event:${r.id}`,
          role: 'system',
          at: r.ts,
          toolCall: {
            name: String(payload.toolName ?? ''),
            ok: payload.ok !== false,
            durationMs: payload.durationMs,
          },
        });
      } else if (payload.phase === 'start') {
        starts.set(toolCallId, {
          name: String(payload.toolName ?? ''),
          argsDigest: redactArgsDigest(payload.input ?? {}),
          at: r.ts,
          id: r.id,
        });
      } else {
        const s = starts.get(toolCallId);
        if (!s) continue; // 只有 end 的孤儿条目跳过（不臆造 name）
        const isError = payload.isError === true;
        items.push({
          id: `task_event:${s.id}`,
          role: 'system',
          at: s.at,
          toolCall: { name: s.name, argsDigest: s.argsDigest, ok: !isError, ...(isError && payload.error ? { error: String(payload.error) } : {}) },
        });
        starts.delete(toolCallId);
      }
    }
  }

  items.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items.slice(-limit);
}
