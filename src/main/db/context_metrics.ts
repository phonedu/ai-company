/**
 * `context_metrics` DAO（CTX-1 P0 / CTX1-2）—— 上下文遥测落库（每会话每轮一行）。
 *
 * 口径：
 *  - **只写读数，不写审计事件**（任务状态仍以 `task_events` 为准；本表只服务查询/聚合/A-B）。
 *  - 未知一律 NULL（`context_window`/`utilization`/`compaction_count`/`cache_*`），**不写假 0**。
 *  - 先 insert（会话开始、真正吃 token 之前），跑完再 update 用量与压缩读数——崩溃也留得下"当时装了什么"。
 */
import type { SqliteDb } from './open.js';

/** 与 `agent/context-telemetry.ts` 的 `ContextLayerMetric` 结构一致（只存值，不依赖 agent 层）。 */
export interface ContextMetricLayer {
  name: string;
  chars: number;
  estTokens: number;
  truncated: boolean;
  tokensBeforeCap: number;
}

export interface InsertContextMetricInput {
  taskId: number | null;
  workItemId?: number | null;
  employeeId?: number | null;
  projectId?: number | null;
  sessionKey: string;
  ts: number;
  totalTokens: number;
  systemTokens: number;
  userTokens: number;
  /** null = 未知窗口（渲染层显 `—`）。 */
  contextWindow: number | null;
  utilization: number | null;
  truncated: boolean;
  layers: readonly ContextMetricLayer[];
  /** null = 尚未观测压缩（不写假 0）。 */
  compactionCount: number | null;
  tokensBeforeCompaction: number | null;
  /** CTX1-9：本轮模型（provider/modelId）；null = 未提供（不写假值）。 */
  model?: string | null;
  /** CTX1-9：sha256(systemPrompt)；null/缺省 = 旧行或未提供。 */
  systemPromptHash?: string | null;
}

export interface UpdateContextMetricInput {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  compactionCount?: number | null;
  tokensBeforeCompaction?: number | null;
}

export interface ContextMetricRow {
  id: number;
  taskId: number | null;
  workItemId: number | null;
  employeeId: number | null;
  projectId: number | null;
  sessionKey: string;
  ts: number;
  totalTokens: number;
  systemTokens: number;
  userTokens: number;
  contextWindow: number | null;
  utilization: number | null;
  truncated: boolean;
  layers: ContextMetricLayer[];
  compactionCount: number | null;
  tokensBeforeCompaction: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  model: string | null;
  systemPromptHash: string | null;
}

/** 写一行遥测；返回行 id（调用方在会话结束后用它补用量/压缩读数）。 */
export function insertContextMetric(db: SqliteDb, input: InsertContextMetricInput): number {
  const info = db
    .prepare(
      `INSERT INTO context_metrics(
        task_id, work_item_id, employee_id, project_id, session_key, ts,
        total_tokens, system_tokens, user_tokens, context_window, utilization, truncated, layers_json,
        compaction_count, tokens_before_compaction, model, system_prompt_hash
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.workItemId ?? null,
      input.employeeId ?? null,
      input.projectId ?? null,
      input.sessionKey,
      input.ts,
      input.totalTokens,
      input.systemTokens,
      input.userTokens,
      input.contextWindow,
      input.utilization,
      input.truncated ? 1 : 0,
      JSON.stringify(input.layers),
      input.compactionCount,
      input.tokensBeforeCompaction,
      input.model ?? null,
      input.systemPromptHash ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** 会话结束回填：cache 读写、本会话压缩次数与最近一次压缩前 token（缺项不动）。 */
export function updateContextMetricAfterRun(db: SqliteDb, id: number, input: UpdateContextMetricInput): void {
  const sets: string[] = [];
  const values: (number | null)[] = [];
  const put = (column: string, value: number | null | undefined): void => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  put('cache_read_tokens', input.cacheReadTokens);
  put('cache_write_tokens', input.cacheWriteTokens);
  put('compaction_count', input.compactionCount);
  put('tokens_before_compaction', input.tokensBeforeCompaction);
  if (sets.length === 0) return;
  db.prepare(`UPDATE context_metrics SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

interface RawRow {
  id: number;
  task_id: number | null;
  work_item_id: number | null;
  employee_id: number | null;
  project_id: number | null;
  session_key: string;
  ts: number;
  total_tokens: number;
  system_tokens: number;
  user_tokens: number;
  context_window: number | null;
  utilization: number | null;
  truncated: number;
  layers_json: string;
  compaction_count: number | null;
  tokens_before_compaction: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  model: string | null;
  system_prompt_hash: string | null;
}

function parseLayers(json: string): ContextMetricLayer[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (row == null || typeof row !== 'object') return [];
      const r = row as Record<string, unknown>;
      if (typeof r.name !== 'string' || typeof r.estTokens !== 'number') return [];
      return [
        {
          name: r.name,
          chars: typeof r.chars === 'number' ? r.chars : 0,
          estTokens: r.estTokens,
          truncated: r.truncated === true,
          tokensBeforeCap: typeof r.tokensBeforeCap === 'number' ? r.tokensBeforeCap : r.estTokens,
        },
      ];
    });
  } catch {
    return [];
  }
}

function toRow(raw: RawRow): ContextMetricRow {
  return {
    id: raw.id,
    taskId: raw.task_id,
    workItemId: raw.work_item_id,
    employeeId: raw.employee_id,
    projectId: raw.project_id,
    sessionKey: raw.session_key,
    ts: raw.ts,
    totalTokens: raw.total_tokens,
    systemTokens: raw.system_tokens,
    userTokens: raw.user_tokens,
    contextWindow: raw.context_window,
    utilization: raw.utilization,
    truncated: raw.truncated === 1,
    layers: parseLayers(raw.layers_json),
    compactionCount: raw.compaction_count,
    tokensBeforeCompaction: raw.tokens_before_compaction,
    cacheReadTokens: raw.cache_read_tokens,
    cacheWriteTokens: raw.cache_write_tokens,
    model: raw.model,
    systemPromptHash: raw.system_prompt_hash,
  };
}

/** 任务最近 N 轮遥测（新的在前；UI/审计读）。 */
export function listContextMetricsByTask(db: SqliteDb, taskId: number, limit = 20): ContextMetricRow[] {
  const rows = db
    .prepare('SELECT * FROM context_metrics WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(taskId, limit) as RawRow[];
  return rows.map(toRow);
}
