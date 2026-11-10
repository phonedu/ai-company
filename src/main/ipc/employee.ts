/**
 * 员工工位页数据面（`docs/` §2/§9；D-5 补位 ①）——`employee:get`。
 *
 * 口径：
 *  - **只读 v1**：员工招募/编辑属 M1+ 未实现（`docs/` §7.4 员工写入口径 A/B 两处）
 *    → UI 侧未实现项如实 `disabled`，本文件**不写库**；
 *  - **不臆造**：成本无行 → `usd:null`（UI 显 `—`，不写假 0）；`employees.skills/mcps` 引用的
 *    `skills`/`mcp_servers` 表**尚无写入者**（/MCP 属）→ 解析不到名字就 `name:null`
 *    （UI 如实标注，不编名字）；记忆无行 → 空数组；
 *  - **记忆分区**：读 `employee_memory` 真行（v1 只有项目分区会被写；`project_id=0` 通用分区由
 *    后续"显式提升"动作负责，见 `src/main/db/memory.ts` 头注）。
 */
import type { SqliteDb } from '../db/open.js';

export interface EmployeeRefItem {
  /** 原样保留 `employees.skills|mcps` JSON 里的条目（id 或名字，字符串化）。 */
  id: string;
  /** 从 `skills`/`mcp_servers` 表解析出的名字；解析不到 → null（如实，不编）。 */
  name: string | null;
}

export interface EmployeeMemoryBlock {
  projectId: number;
  /** `projects.name`；`project_id=0`（通用分区）无 projects 行 → null（UI 显「通用记忆」）。 */
  projectName: string | null;
  memory: string;
  updatedAt: number;
}

export interface EmployeeWorkItemRef {
  workItemId: number;
  taskId: number;
  taskShortId: string | null;
  taskTitle: string;
  state: string;
}

export interface EmployeeRecentTask {
  id: number;
  shortId: string | null;
  title: string;
  state: string;
  updatedAt: number;
}

export interface EmployeeDetailDTO {
  employee: {
    id: number;
    name: string;
    role: string;
    avatar: string | null;
    persona: string;
    /** `NULL` = 跟随全局默认（装配期解析）——UI 如实显「跟随全局默认」。 */
    model: string | null;
    thinking: string | null;
    skills: EmployeeRefItem[];
    mcps: EmployeeRefItem[];
    capabilityTier: string;
    isAssistant: boolean;
    active: boolean;
    createdAt: number;
  };
  memory: EmployeeMemoryBlock[];
  currentWork: EmployeeWorkItemRef[];
  recentTasks: EmployeeRecentTask[];
  cost: { usd: number | null; tokensIn: number; tokensOut: number; rows: number };
}

/** 「在跑」＝**未终结**的工作项状态（`src/core/types.ts` 的 `WorkItemState`）。 */
export const OPEN_WORK_ITEM_STATES = ['queued', 'running', 'blocked', 'submitted', 'rejected', 'interrupted'] as const;

function parseRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map((v) => String(v));
  } catch {
    return [];
  }
}

/** 解析 `skills`/`mcp_servers` 表里的名字（按 id 或按 name 都试；找不到 → null）。 */
function resolveRefs(db: SqliteDb, table: 'skills' | 'mcp_servers', refs: readonly string[]): EmployeeRefItem[] {
  return refs.map((id) => {
    const byId = /^\d+$/.test(id)
      ? (db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(Number(id)) as { name: string } | undefined)
      : undefined;
    const row = byId || (db.prepare(`SELECT name FROM ${table} WHERE name = ?`).get(id) as { name: string } | undefined);
    return { id, name: row?.name ?? null };
  });
}

/** 单员工工位页数据；不存在 → `null`（不抛，不臆造）。 */
export function buildEmployeeDetail(db: SqliteDb, employeeId: number): EmployeeDetailDTO | null {
  const row = db
    .prepare(
      `SELECT id, name, role, avatar, persona, model, thinking, skills, mcps, capability_tier, is_assistant, active, created_at
       FROM employees WHERE id = ?`,
    )
    .get(employeeId) as
    | {
        id: number;
        name: string;
        role: string;
        avatar: string | null;
        persona: string;
        model: string | null;
        thinking: string | null;
        skills: string;
        mcps: string;
        capability_tier: string;
        is_assistant: number;
        active: number;
        created_at: number;
      }
    | undefined;
  if (!row) return null;

  const memory = db
    .prepare(
      `SELECT m.project_id AS projectId, p.name AS projectName, m.memory AS memory, m.updated_at AS updatedAt
       FROM employee_memory m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.employee_id = ? AND m.memory <> ''
       ORDER BY m.updated_at DESC`,
    )
    .all(employeeId) as EmployeeMemoryBlock[];

  const marks = OPEN_WORK_ITEM_STATES.map(() => '?').join(', ');
  const currentWork = db
    .prepare(
      `SELECT w.id AS workItemId, w.state AS state, t.id AS taskId, t.short_id AS taskShortId, t.title AS taskTitle
       FROM work_items w JOIN tasks t ON t.id = w.task_id
       WHERE w.employee_id = ? AND w.state IN (${marks})
       ORDER BY w.id DESC LIMIT 20`,
    )
    .all(employeeId, ...OPEN_WORK_ITEM_STATES) as EmployeeWorkItemRef[];

  const recentTasks = (
    db
      .prepare(
        `SELECT id, short_id, title, state, updated_at FROM tasks
         WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10`,
      )
      .all(employeeId) as Array<{ id: number; short_id: string | null; title: string; state: string; updated_at: number }>
  ).map((t) => ({ id: t.id, shortId: t.short_id, title: t.title, state: t.state, updatedAt: t.updated_at }));

  const cost = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout
       FROM costs WHERE employee_id = ?`,
    )
    .get(employeeId) as { n: number; usd: number; tin: number; tout: number };

  return {
    employee: {
      id: row.id,
      name: row.name,
      role: row.role,
      avatar: row.avatar,
      persona: row.persona,
      model: row.model,
      thinking: row.thinking,
      skills: resolveRefs(db, 'skills', parseRefs(row.skills)),
      mcps: resolveRefs(db, 'mcp_servers', parseRefs(row.mcps)),
      capabilityTier: row.capability_tier,
      isAssistant: row.is_assistant === 1,
      active: row.active === 1,
      createdAt: row.created_at,
    },
    memory,
    currentWork,
    recentTasks,
    cost: {
      usd: cost.n > 0 ? Number(cost.usd) : null,
      tokensIn: Number(cost.tin),
      tokensOut: Number(cost.tout),
      rows: Number(cost.n),
    },
  };
}
