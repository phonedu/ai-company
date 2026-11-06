/**
 * tasks 表最小 DAO（T0.2 范围：**只做建任务**需要的插入 / 查询 + 短号同流程分配）。
 *
 * 边界（DEV §8 T0.2）：不提前实现 M1 —— 不写 task_events / inbox_items / 状态机；
 * 那些属编排器（T0.3）。短号分配与任务 INSERT 的关系见 counters.ts 顶部说明。
 */
import { allocateTaskShortId, type CounterStore } from '../../core/short-id.js';
import type { TaskSnapshot } from '../../core/types.js';
import { insertTaskEvent } from './task_events.js';
import { addTaskDependency } from './task_deps.js';
import type { SqliteDb } from './open.js';

/** tasks 行（列名与 schema.sql 一致，snake_case）。 */
export interface TaskRow {
  id: number;
  short_id: string | null;
  project_id: number;
  title: string;
  goal: string;
  acceptance: string;
  state: string;
  resume_state: string | null;
  /** paused 来源（v15）：manual | task_budget | company_budget；NULL＝老行/未知。 */
  pause_reason: string | null;
  state_before_close: string | null;
  risk_level: number;
  priority: number;
  ready_since: number | null;
  deadline: number | null;
  owner_id: number | null;
  parent_task_id: number | null;
  renewed_from: number | null;
  budget_tokens: number | null;
  cost_tokens: number;
  /** 009（N5 余账）：任务级模型（指派链最高档）；NULL = 未指派。 */
  model: string | null;
  origin: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  archived: number;
  archived_at: number | null;
}

const TASK_COLUMNS = `id, short_id, project_id, title, goal, acceptance, state, resume_state,
  pause_reason, state_before_close, risk_level, priority, ready_since, deadline, owner_id, parent_task_id,
  renewed_from, budget_tokens, cost_tokens, model, origin, created_at, updated_at, closed_at, archived, archived_at`;

export interface CreateTaskInput {
  projectId: number;
  title: string;
  goal: string;
  /** 验收项 JSON（默认 []）；M0 阶段可先为空。 */
  acceptance?: unknown[];
  /** 初始状态（默认 inbox，与 schema 默认一致）。 */
  state?: string;
  priority?: number;
  riskLevel?: number;
  ownerId?: number | null;
  origin?: string;
  /** 截止时刻（epoch ms；调度次级排序键；C6·D5）。 */
  deadline?: number | null;
  /** 预算 token（NULL = 不限；B3）。 */
  budgetTokens?: number | null;
  /** 009（N5 余账）：任务级模型（指派链最高档）；NULL/缺省 = 未指派（回落到既有链）。 */
  model?: string | null;
  /** B8 续办：父任务 id（列已存在，非新增列）。 */
  parentTaskId?: number | null;
  /** B8 续办：来源任务 id（`tasks.renewed_from`，列已存在）。 */
  renewedFrom?: number | null;
  /**
   * D4（依赖写入面）：本任务依赖的既有任务 id（全部 done → 自动 ready）。
   * **同事务**写入 `task_deps` ＋ `dependency_added` 审计事件；建任务前先校验存在性（拒绝不烧短号）。
   */
  dependsOn?: number[];
  /** 时间戳（epoch ms）；默认 Date.now()。 */
  now?: number;
}

/**
 * 拆分深度上限（P20 后半，**数据不变量**）：`parent_task_id` 链**最多两层**（根任务 → 子任务）；
 * **子任务不再拆子任务**——防无界递归拆分/续办链（每个新任务都是新成本，见
 * `docs/work/research-multi-agent-cost.md` P20「拆分不再递归」）。
 * 违反 → **抛错（人话原因）**；引擎侧由 `engine/actions.ts` 既有失败路径落 `action_failed` 留痕。
 * 校验点选在 `createTask`（`parent_task_id` 的**唯一写者**）→ 续办（今天）与将来任何拆分路径都同一道闸。
 */
export const MAX_TASK_DEPTH = 2;

/** 见 `MAX_TASK_DEPTH`：**先于短号分配**校验（拒绝不烧短号）。 */
function assertDepthAllowsChild(db: SqliteDb, parentTaskId: number): void {
  const parent = db.prepare('SELECT id, short_id, parent_task_id FROM tasks WHERE id = ?').get(parentTaskId) as
    | { id: number; short_id: string; parent_task_id: number | null }
    | undefined;
  if (!parent) throw new Error(`父任务 #${parentTaskId} 不存在——不能建子任务`);
  if (parent.parent_task_id != null) {
    throw new Error(
      `拆分深度上限 ${MAX_TASK_DEPTH}：子任务不再拆子任务（${parent.short_id} 自身已是子任务）——请对根任务提新需求或另建任务`,
    );
  }
}

/**
 * 建任务：**先分配短号（独立提交），再在同一事务内插入 tasks 行**。
 *
 * - 短号先于 INSERT 事务提交，保证「事务回滚后序号不回收」（T0.2 断言③）；
 *   若 INSERT 失败，则形成一次跳号（空洞），该短号永不复用。
 * - 调用方不要把这个函数嵌进更大的事务里，否则短号分配会随之回滚。
 * - 带 `parentTaskId` 时先过 **拆分深度上限**（`MAX_TASK_DEPTH`）。
 */
export function createTask(db: SqliteDb, counters: CounterStore, input: CreateTaskInput): TaskRow {
  const now = input.now ?? Date.now();
  if (input.parentTaskId != null) assertDepthAllowsChild(db, input.parentTaskId);
  // D4：依赖先校验存在性（**先于短号分配**，拒绝不烧号）；新任务尚无入边，不可能成环。
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  for (const dependsOnId of dependsOn) {
    if (!Number.isInteger(dependsOnId) || dependsOnId <= 0) {
      throw new Error(`依赖任务 id 非法：${String(dependsOnId)}（需正整数）`);
    }
    const exists = db.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(dependsOnId);
    if (!exists) throw new Error(`依赖任务不存在：#${dependsOnId}`);
  }
  // D5 复核崩溃修复（2026-10-26）：种子/历史行直接插 tasks 而未推进 counters 时，首次分配会撞
  // 已占用短号（UNIQUE constraint failed: tasks.short_id 曾裸抛到 IPC）。计数器只进不回，
  // 撞号＝计数器落后——有界重试到下一个空闲短号（空洞允许，永不回收不变式不变）。
  const insert = db.prepare(`INSERT INTO tasks
    (short_id, project_id, title, goal, acceptance, state, priority, risk_level, owner_id, origin, deadline, budget_tokens, model, parent_task_id, renewed_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let shortId = '';
  let id = 0;
  for (let attempt = 0; ; attempt += 1) {
    shortId = allocateTaskShortId(counters);
    db.exec('BEGIN');
    try {
      const info = insert.run(
        shortId,
        input.projectId,
        input.title,
        input.goal,
        JSON.stringify(input.acceptance ?? []),
        input.state ?? 'inbox',
        input.priority ?? 0,
        input.riskLevel ?? 1,
        input.ownerId ?? null,
        input.origin ?? 'boss',
        input.deadline ?? null,
        input.budgetTokens ?? null,
        input.model ?? null,
        input.parentTaskId ?? null,
        input.renewedFrom ?? null,
        now,
        now,
      );
      id = Number(info.lastInsertRowid);
      // FLOWS §3.1.1 首行：建任务在同一事务内写 task_created（DEV §4.2 一个状态变更=一个事务）
      insertTaskEvent(db, {
        taskId: id,
        ts: now,
        kind: 'task_created',
        actor: input.origin === 'boss' ? 'boss' : 'system',
        payload: { shortId, origin: input.origin ?? 'boss' },
      });
      // D4：依赖边与任务同事务落库（重放/失败整体回滚；审计事件逐条记）。
      for (const dependsOnId of dependsOn) {
        if (!addTaskDependency(db, id, dependsOnId)) continue;
        insertTaskEvent(db, {
          taskId: id,
          ts: now,
          kind: 'dependency_added',
          actor: input.origin === 'boss' ? 'boss' : 'system',
          payload: { taskId: id, dependsOn: dependsOnId },
        });
      }
      db.exec('COMMIT');
      break;
    } catch (error) {
      db.exec('ROLLBACK');
      if (isShortIdUniqueConflict(error) && attempt < 8) continue;
      throw error;
    }
  }

  const row = getTaskById(db, id);
  if (!row) throw new Error(`[db] createTask 后读回失败：id=${id}`);
  return row;
}

/** better-sqlite3 的 UNIQUE 冲突是否落在 tasks.short_id 上（只认这一个，别的冲突照抛）。 */
function isShortIdUniqueConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: tasks\.short_id/.test(error.message);
}

export function getTaskById(db: SqliteDb, id: number): TaskRow | undefined {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

/** 更新截止时刻（C6·D5：调度次级排序键的写入点）。 */
export function setTaskDeadline(db: SqliteDb, id: number, deadline: number | null, now: number = Date.now()): void {
  updateTask(db, id, { deadline }, now);
}

export function getTaskByShortId(db: SqliteDb, shortId: string): TaskRow | undefined {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE short_id = ?`).get(shortId) as TaskRow | undefined;
}

export interface ListTasksOptions {
  /** 默认 false = 排除已归档（`tasks.archived = 1`）——归档改为"筛选开关"（照 `projects.listProjects`）。 */
  includeArchived?: boolean;
  /**
   * 列表长度策略（`UI §515`）：**只对"终态任务"**（`done`/`cancelled`/`failed`）限 `updated_at >= since`，
   * **活态任务不受限**（= 活跃 + 最近 N 天完成的）。
   */
  since?: number;
  /** 上限（**无缺省**；调用方必须显式给，防无界查询）。 */
  limit?: number;
}

export function listTasks(db: SqliteDb, options: ListTasksOptions = {}): TaskRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!options.includeArchived) where.push('archived = 0');
  if (options.since !== undefined) {
    where.push("(state NOT IN ('done', 'cancelled', 'failed') OR updated_at >= ?)");
    params.push(options.since);
  }
  let sql = `SELECT ${TASK_COLUMNS} FROM tasks${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  if (options.limit != null) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  return db.prepare(sql).all(...params) as TaskRow[];
}

/** 供 `src/core/scheduler` 消费的只读快照（budgetLeftTokens 为派生值）。 */
export function toTaskSnapshot(row: TaskRow): TaskSnapshot {
  return {
    id: row.id,
    shortId: row.short_id ?? '',
    title: row.title,
    projectId: row.project_id,
    state: row.state as TaskSnapshot['state'],
    priority: row.priority,
    riskLevel: row.risk_level as TaskSnapshot['riskLevel'],
    createdAt: row.created_at,
    readySince: row.ready_since,
    deadline: row.deadline,
    budgetLeftTokens: row.budget_tokens == null ? null : row.budget_tokens - row.cost_tokens,
    parentTaskId: row.parent_task_id,
  };
}

export function getTaskSnapshot(db: SqliteDb, id: number): TaskSnapshot | undefined {
  const row = getTaskById(db, id);
  return row ? toTaskSnapshot(row) : undefined;
}

export function listTaskSnapshots(db: SqliteDb): TaskSnapshot[] {
  // 保持既有行为（调度看全量任务，含归档）——传 `includeArchived: true`。
  return listTasks(db, { includeArchived: true }).map(toTaskSnapshot);
}

/** 引擎可更新的列白名单（防止把任意列名拼进 SQL）。 */
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'state'
    | 'resume_state'
    | 'pause_reason'
    | 'state_before_close'
    | 'risk_level'
    | 'priority'
    | 'ready_since'
    | 'deadline'
    | 'owner_id'
    | 'parent_task_id'
    | 'renewed_from'
    | 'budget_tokens'
    | 'cost_tokens'
    | 'closed_at'
    | 'archived'
    | 'archived_at'
  >
>;

/** 更新 tasks 的允许列；未列出的字段不动；总会刷新 updated_at。 */
export function updateTask(db: SqliteDb, id: number, patch: TaskPatch, now: number = Date.now()): void {
  const keys = Object.keys(patch) as (keyof TaskPatch)[];
  const sets = keys.map((k) => `${k} = ?`);
  sets.push('updated_at = ?');
  const values = [...keys.map((k) => patch[k] as unknown), now, id];
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}
