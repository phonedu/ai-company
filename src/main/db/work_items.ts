/**
 * `work_items` DAO —— 派给员工的原子工作单元（schema.sql）。
 * 本模块只做行的读写；状态迁移语义在 `engine/statemachine.ts`。
 */
import type { WorkItemSnapshot, WorkItemState } from '../../core/types.js';
import { insertTaskEvent } from './task_events.js';
import type { SqliteDb } from './open.js';

export interface WorkItemRow {
  id: number;
  task_id: number;
  employee_id: number;
  verifier_employee_id: number | null;
  title: string;
  brief: string;
  state: WorkItemState;
  attempt: number;
  result: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** /：返工血缘（spawnReworkItem 指向源件；同员工返工继承源件会话键）。 */
  retry_of: number | null;
}

export interface InsertWorkItemInput {
  taskId: number;
  employeeId: number;
  title: string;
  brief: string;
  attempt?: number;
  now: number;
  actor?: string;
  /** 返工血缘（spawnReworkItem）；DAO 不校验任务归属（引擎侧保证同任务）。 */
  retryOf?: number;
  /** 附加事件 payload（work_item_created 审计字段，如 reply 件的 askKey）。 */
  eventExtra?: Record<string, unknown>;
  /** 规划期落定：本次工作项会触碰的路径（相对 `projects.root_dir`）→ 存进 `brief` JSON。 */
  touchedPaths?: string[];
}

const COLUMNS =
  'id, task_id, employee_id, verifier_employee_id, title, brief, state, attempt, result, retry_of, created_at, started_at, finished_at';

export function toWorkItemSnapshot(row: WorkItemRow): WorkItemSnapshot {
  return {
    id: row.id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    state: row.state,
    createdAt: row.created_at,
  };
}

export function insertWorkItem(db: SqliteDb, input: InsertWorkItemInput): WorkItemRow {
  const briefText = input.touchedPaths
    ? JSON.stringify({ text: input.brief, touchedPaths: input.touchedPaths })
    : input.brief;
  db.exec('BEGIN');
  let id: number;
  try {
    const info = db
      .prepare(
        "INSERT INTO work_items(task_id, employee_id, title, brief, state, attempt, retry_of, created_at) VALUES(?, ?, ?, ?, 'queued', ?, ?, ?)",
      )
      .run(input.taskId, input.employeeId, input.title, briefText, input.attempt ?? 0, input.retryOf ?? null, input.now);
    id = Number(info.lastInsertRowid);
    //  首行：派发/产出 work item 时写 work_item_created（同一事务）
    insertTaskEvent(db, {
      taskId: input.taskId,
      workItemId: id,
      ts: input.now,
      kind: 'work_item_created',
      actor: input.actor ?? 'system',
      payload: {
        employeeId: input.employeeId,
        attempt: input.attempt ?? 0,
        ...(input.touchedPaths ? { touchedPaths: input.touchedPaths } : {}),
        ...(input.eventExtra ?? {}),
      },
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const row = getWorkItem(db, id);
  if (!row) throw new Error(`[db] insertWorkItem 后读回失败：id=${id}`);
  return row;
}

export function getWorkItem(db: SqliteDb, id: number): WorkItemRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM work_items WHERE id = ?`).get(id) as WorkItemRow | undefined;
}

export type WorkItemPatch = Partial<
  Pick<WorkItemRow, 'state' | 'attempt' | 'result' | 'started_at' | 'finished_at' | 'employee_id' | 'brief' | 'title'>
>;

/** 更新 work_items 的允许列；未列出的字段不动。 */
export function updateWorkItem(db: SqliteDb, id: number, patch: WorkItemPatch): void {
  const keys = Object.keys(patch) as (keyof WorkItemPatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(`UPDATE work_items SET ${sets} WHERE id = ?`).run(...values, id);
}

/**
 * OPT-：指派验证者（应用层断言：**验证者 ≠ 实现者**； 复用员工 id，不新增角色/表）。
 */
export function assignWorkItemVerifier(db: SqliteDb, workItemId: number, verifierEmployeeId: number): WorkItemRow {
  const row = getWorkItem(db, workItemId);
  if (!row) throw new Error(`[db] assignWorkItemVerifier: 工作项不存在 id=${workItemId}`);
  if (row.employee_id === verifierEmployeeId) {
    throw new Error(`[db] 验证者不得与实现者同一人（employee ${verifierEmployeeId}）`);
  }
  db.prepare('UPDATE work_items SET verifier_employee_id = ? WHERE id = ?').run(verifierEmployeeId, workItemId);
  return getWorkItem(db, workItemId) as WorkItemRow;
}

export function listWorkItemsByTask(db: SqliteDb, taskId: number): WorkItemRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM work_items WHERE task_id = ? ORDER BY id`).all(taskId) as WorkItemRow[];
}

export function listWorkItems(db: SqliteDb): WorkItemRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM work_items ORDER BY id`).all() as WorkItemRow[];
}

/**
 * 每个任务**最新一件**工作项的负责人（左栏任务行头像用；`task:list` 的零新通道 join）。
 * 名字经 `LEFT JOIN employees`；查无（员工被删等）⇒ `name=null`——**渲染层不臆造**。
 */
export function latestWorkersByTask(db: SqliteDb): Map<number, { employeeId: number; name: string | null }> {
  const rows = db
    .prepare(
      `SELECT w.task_id AS task_id, w.employee_id AS employee_id, e.name AS name
         FROM work_items w
         JOIN (SELECT task_id, MAX(id) AS max_id FROM work_items GROUP BY task_id) m ON m.max_id = w.id
         LEFT JOIN employees e ON e.id = w.employee_id`,
    )
    .all() as Array<{ task_id: number; employee_id: number; name: string | null }>;
  return new Map(rows.map((row) => [row.task_id, { employeeId: row.employee_id, name: row.name }]));
}

/**
 * employeeId -> 正在运行的 work item id（员工并发 = 1，scheduler 输入）。
 *
 * ⚠️ **静默折叠风险（加固，见附录 B-5）**：`Map` 对同一 employeeId 的多个值只保留
 * 最后一个 —— 若「员工并发=1」不变量被打破（历史数据 / 旁路写入 / 恢复），这里会**静默**丢掉多余
 * running 而不报错。当前依赖：(1) 调度器占用队列；(2) 引擎 `findOtherRunningWorkItem` 硬守卫。
 *  计划：DB 部分唯一索引 `ux_wi_running_emp` + 会话池 `acquire` 断言 + 派发前去重 +
 * `concurrency_conflict_detected` 事件。** 不顺手改结构**（可控范围内的已知风险）。
 */
/** N3(P20/P22)：**正在跑的 work item 数**（公司级；给 taskId 则该任务内）。闸门用它判并发上限。 */
export function countRunningWorkItems(db: SqliteDb, opts: { taskId?: number } = {}): number {
  const where = opts.taskId === undefined ? " WHERE state = 'running'" : " WHERE state = 'running' AND task_id = ?";
  const params: unknown[] = opts.taskId === undefined ? [] : [opts.taskId];
  const row = db.prepare("SELECT COUNT(*) AS n FROM work_items" + where).get(...params) as { n: number };
  return row.n;
}

export function runningByEmployee(db: SqliteDb): Map<number, number> {
  const rows = db
    .prepare("SELECT id, employee_id FROM work_items WHERE state = 'running'")
    .all() as { id: number; employee_id: number }[];
  return new Map(rows.map((r) => [r.employee_id, r.id]));
}

// ───────────────────── · 文件所有权（touched_paths）─────────────────────

export interface PathClaim {
  workItemId: number;
  taskId: number;
  /** 项目根（隔离边界：不同 root_dir 不互相约束）。 */
  rootDir: string;
  /** 相对 root_dir 的路径集合。 */
  paths: string[];
}

/** 解析 `work_items.brief`：结构化 JSON `{text, touchedPaths}`（也接受 `touched_paths`）；普通文本 → []。 */
export function parseTouchedPaths(brief: string): string[] {
  try {
    const parsed = JSON.parse(brief) as { touchedPaths?: unknown; touched_paths?: unknown } | null;
    const arr = parsed?.touchedPaths ?? parsed?.touched_paths;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    /* 普通文本 brief */
  }
  return [];
}

/** 运行期补正/事后归因：把 touched_paths 合并进 brief JSON（保留原 text）。 */
export function setWorkItemTouchedPaths(db: SqliteDb, workItemId: number, paths: string[]): void {
  const row = getWorkItem(db, workItemId);
  if (!row) throw new Error(`[db] setWorkItemTouchedPaths: 工作项不存在 id=${workItemId}`);
  let text = row.brief;
  const existing = parseTouchedPaths(row.brief);
  try {
    const parsed = JSON.parse(row.brief) as { text?: unknown } | null;
    if (parsed && typeof parsed.text === 'string') text = parsed.text;
  } catch {
    /* 保持原文本 */
  }
  const merged = [...new Set([...existing, ...paths])];
  db.prepare('UPDATE work_items SET brief = ? WHERE id = ?').run(
    JSON.stringify({ text, touchedPaths: merged }),
    workItemId,
  );
}

const CLAIM_COLUMNS = 'w.id AS work_item_id, w.task_id AS task_id, w.brief AS brief, p.root_dir AS root_dir';

/** 单个工作项的路径声明（含项目根）。 */
export function getWorkItemPathClaim(db: SqliteDb, workItemId: number): PathClaim | null {
  const row = db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM work_items w
         JOIN tasks t ON t.id = w.task_id
         JOIN projects p ON p.id = t.project_id
       WHERE w.id = ?`,
    )
    .get(workItemId) as { work_item_id: number; task_id: number; brief: string; root_dir: string } | undefined;
  if (!row) return null;
  return { workItemId: row.work_item_id, taskId: row.task_id, rootDir: row.root_dir, paths: parseTouchedPaths(row.brief) };
}

/** 所有 `running` 工作项的路径声明（派发前相交去重的"已占用"集合）。 */
export function listRunningPathClaims(db: SqliteDb): PathClaim[] {
  const rows = db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM work_items w
         JOIN tasks t ON t.id = w.task_id
         JOIN projects p ON p.id = t.project_id
       WHERE w.state = 'running'`,
    )
    .all() as { work_item_id: number; task_id: number; brief: string; root_dir: string }[];
  return rows.map((r) => ({
    workItemId: r.work_item_id,
    taskId: r.task_id,
    rootDir: r.root_dir,
    paths: parseTouchedPaths(r.brief),
  }));
}

/**
 * 查找某员工**另一个**正在运行的 work item（排除 `excludeWorkItemId`）。
 *
 * 用于「员工并发=1」硬守卫（第4条 / §3.1.2）：任何 → `running` 的迁移前若已有
 * running，则拒绝。**不得复用 `runningByEmployee`**——它建的是 Map，同一员工若出现多条
 * running 会**静默折叠**只留一条，正是要防的不可观测失效。
 */
export function findOtherRunningWorkItem(
  db: SqliteDb,
  employeeId: number,
  excludeWorkItemId: number,
): WorkItemRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM work_items WHERE employee_id = ? AND state = 'running' AND id <> ? ORDER BY id LIMIT 1`,
    )
    .get(employeeId, excludeWorkItemId) as WorkItemRow | undefined;
}
