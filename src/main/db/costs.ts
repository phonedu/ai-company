/**
 * `costs` DAO（触发链）—— 成本写入点（审计：此前 `costs` 无写入触发点）。
 *
 * 一次结算 = 一个事务：写 `costs` 行 + 写 `task_events.kind='cost_recorded'`（payload 带 usage）
 * + 回写 `tasks.cost_tokens`（`budgetLeft = budget_tokens - cost_tokens` 的派生来源）。可审计（事件为准）。
 */
import { insertTaskEvent } from './task_events.js';
import type { SqliteDb } from './open.js';

export interface RecordCostInput {
  /** **可空**（C2）：null = **公司级开销**（无任务可回写，也无 task_events 落点——成本行本身即可查）。 */
  taskId: number | null;
  workItemId?: number | null;
  employeeId?: number | null;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  /** 004：缓存命中/写入输入（**不计入预算 tokens**，只入账与可视）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usd?: number;
  /** 004：项目归属（免 join；调用方从 work_item → task 解析）。 */
  projectId?: number | null;
  /** 可选来源标记（如 `assistant_selection`）；只进 `cost_recorded` 事件，不改成本口径。 */
  source?: string;
  now: number;
}

/** 记一笔成本；返回该任务累计 cost_tokens（**公司级 ⇒ null**，不假报 0）。 */
export function recordCost(db: SqliteDb, input: RecordCostInput): { costTotal: number | null } {
  // 安全复核 S15（2026-11-09）：usd 非法值不静默入库（负数会冲抵成本、Infinity 存成 NULL）。
  // 非有限数或负数 → 按 0 记并响亮报错（不阻断会话）。
  if (input.usd != null && (!Number.isFinite(input.usd) || input.usd < 0)) {
    console.error(`[costs] 非法 usd（${String(input.usd)}）→ 按 0 记（source=${input.source ?? '-'}）`);
    input = { ...input, usd: 0 };
  }
  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;
  const cacheRead = input.cacheReadTokens ?? 0;
  const cacheWrite = input.cacheWriteTokens ?? 0;
  const insertRow = (): void => {
    db.prepare(
      'INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, usd, project_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.taskId, input.workItemId ?? null, input.employeeId ?? null, input.model,
      tokensIn, tokensOut, cacheRead, cacheWrite, input.usd ?? 0, input.projectId ?? null, input.now,
    );
  };
  // C2：公司级开销——不碰 tasks.cost_tokens、不写 task_events（没有任务可挂）；成本行本身即可查。
  if (input.taskId == null) {
    insertRow();
    return { costTotal: null };
  }
  db.exec('BEGIN');
  try {
    insertRow();
    insertTaskEvent(db, {
      taskId: input.taskId,
      workItemId: input.workItemId ?? null,
      ts: input.now,
      kind: 'cost_recorded',
      actor: 'system',
      payload: {
        model: input.model,
        tokensIn,
        tokensOut,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        usd: input.usd ?? 0,
        ...(input.source ? { source: input.source } : {}),
      },
    });
    db.prepare('UPDATE tasks SET cost_tokens = cost_tokens + ?, updated_at = ? WHERE id = ?').run(
      tokensIn + tokensOut,
      input.now,
      input.taskId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const row = db.prepare('SELECT cost_tokens FROM tasks WHERE id = ?').get(input.taskId) as { cost_tokens: number };
  return { costTotal: row.cost_tokens };
}

export function listCosts(db: SqliteDb, taskId: number): Array<{ model: string; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_write_tokens: number; usd: number }> {
  return db
    .prepare('SELECT model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, usd FROM costs WHERE task_id = ? ORDER BY id')
    .all(taskId) as Array<{ model: string; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_write_tokens: number; usd: number }>;
}

/** ``「用量可视」：成本聚合（`cost:summary` 的数据源）。 */
export interface CostSummary {
  /** 计入的成本行数（**0 ⇒ 调用方显 `—`，不写假 0**）。 */
  costRows: number;
  tokens: number;
  usd: number;
  /** 004：缓存命中/写入输入（可见即可省；**不计入 `tokens`**）。 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。
   * **分母 0 ⇒ `null`（不写假 0）**——渲染层显 `—`。
   */
  cacheHitRate: number | null;
  /** **$/h 滚动窗**（最近 1 小时）：花钱如流水看的是**速率**，不是总额。 */
  usdPerHour: number;
  /** C2：**公司级开销**（task_id IS NULL）——无任务的共享成本单列，不混进任务成本。 */
  companyUsd: number;
  /** （挂载 3）：**按员工归因**（任务级/全局同口径；"这次为什么贵"的数据面）。 */
  byEmployee: EmployeeCost[];
}

/** 按员工归因行（`null`=公司级/无归属，如实成组，不臆造）。 */
export interface EmployeeCost {
  employeeId: number | null;
  /** 员工名（已删/无归属 ⇒ null）。 */
  name: string | null;
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

function summarizeByEmployee(db: SqliteDb, where: string, params: unknown[]): EmployeeCost[] {
  // 限定 `c.created_at`（employees 也有 created_at，不限定会 ambiguous）
  const whereC = where.replace('created_at', 'c.created_at');
  return db
    .prepare(
      `SELECT c.employee_id AS employeeId, e.name AS name, COALESCE(SUM(c.usd), 0) AS usd,
              COALESCE(SUM(c.tokens_in), 0) AS tokensIn, COALESCE(SUM(c.tokens_out), 0) AS tokensOut
       FROM costs c LEFT JOIN employees e ON e.id = c.employee_id${whereC}
       GROUP BY c.employee_id ORDER BY usd DESC, c.employee_id`,
    )
    .all(...params) as EmployeeCost[];
}

/** 速率窗常量（1 小时）；`usdPerHour` 一律按它计算。 */
export const RATE_WINDOW_MS = 3_600_000;

function hitRate(tokensIn: number, cacheRead: number, cacheWrite: number): number | null {
  const denom = tokensIn + cacheRead + cacheWrite;
  return denom === 0 ? null : cacheRead / denom;
}

function summarizeRow(
  db: SqliteDb,
  where: string,
  params: unknown[],
  now: number,
): CostSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS costRows, COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd,
              COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite
       FROM costs${where}`,
    )
    .get(...params) as { costRows: number; tokens: number; usd: number; tokensIn: number; cacheRead: number; cacheWrite: number };
  // $/h 滚动窗：同一过滤条件 + 最近 1 小时（速率与总额同源，避免两套口径）
  const winWhere = where ? `${where} AND created_at >= ?` : ' WHERE created_at >= ?';
  const win = db
    .prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM costs${winWhere}`)
    .get(...params, now - RATE_WINDOW_MS) as { usd: number };
  const company = db
    .prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM costs WHERE task_id IS NULL")
    .get() as { usd: number };
  const byEmployee = summarizeByEmployee(db, where, params);
  return {
    costRows: row.costRows,
    tokens: row.tokens,
    usd: row.usd,
    cacheReadTokens: row.cacheRead,
    cacheWriteTokens: row.cacheWrite,
    byEmployee,
    cacheHitRate: hitRate(row.tokensIn, row.cacheRead, row.cacheWrite),
    usdPerHour: win.usd,
    companyUsd: company.usd,
  };
}

/**
 * 聚合 `costs`：给 `since`（epoch ms）则只算 `created_at >= since`（默认全部）。
 * 空表 → `{costRows:0,tokens:0,usd:0}`（**由调用方决定显 `—` 还是 0**，本层不伪装）。
 */
/** N2：窗口内美元额（**引擎派发前的速率读数**；瘦查询，不做聚合展开）。 */
export function usdInWindow(db: SqliteDb, options: { windowMs: number; now: number; taskId?: number }): number {
  const where = options.taskId === undefined ? ' WHERE created_at >= ?' : ' WHERE task_id = ? AND created_at >= ?';
  const params: unknown[] = options.taskId === undefined ? [options.now - options.windowMs] : [options.taskId, options.now - options.windowMs];
  const row = db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM costs${where}`).get(...params) as { usd: number };
  return row.usd;
}

export function summarizeCosts(db: SqliteDb, options: { since?: number; now?: number } = {}): CostSummary {
  const where = options.since !== undefined ? ' WHERE created_at >= ?' : '';
  const params: unknown[] = options.since !== undefined ? [options.since] : [];
  return summarizeRow(db, where, params, options.now ?? Date.now());
}

/** 按模型的成本拆分（成本 tab 用）。 */
export interface ModelCost {
  model: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export interface TaskCost extends CostSummary {
  byModel: ModelCost[];
}

/** `` 成本 tab：单任务成本汇总 + 按模型拆分。无行 → `{costRows:0,tokens:0,usd:0,byModel:[]}`。 */
export function summarizeTaskCosts(db: SqliteDb, taskId: number, options: { now?: number } = {}): TaskCost {
  const total = summarizeRow(db, ' WHERE task_id = ?', [taskId], options.now ?? Date.now());
  const byModel = db
    .prepare(
      'SELECT model, COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut, COALESCE(SUM(usd), 0) AS usd FROM costs WHERE task_id = ? GROUP BY model ORDER BY model',
    )
    .all(taskId) as ModelCost[];
  return { ...total, byModel };
}
