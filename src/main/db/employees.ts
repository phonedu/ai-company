/**
 * `employees` 表 DAO（M1 公司大厅 B0；M2 尾补齐写入口）。
 * 读：列表 / 单员工全字段；写：招募插入 / 改档更新（校验在这里，白名单拦点在 IPC 层）。
 */
import type { SqliteDb } from './open.js';

export interface EmployeeRow {
  id: number;
  name: string;
  role: string;
  avatar: string | null;
  is_assistant: number;
  active: number;
  /** GAP6：MCP 分配 refs（JSON 字符串；大厅/分配矩阵只读展示用）。 */
  mcps: string;
}

/** 单员工全字段（写入口/详情用；不返回给 UI 的原始 JSON 由 `ipc/employee.ts` 解析）。 */
export interface EmployeeWriteRow {
  id: number;
  name: string;
  role: string;
  persona: string;
  model: string | null;
  thinking: string | null;
  skills: string;
  mcps: string;
  capability_tier: string;
  avatar: string | null;
  is_assistant: number;
  active: number;
  created_at: number;
}

const WRITE_COLUMNS =
  'id, name, role, persona, model, thinking, skills, mcps, capability_tier, avatar, is_assistant, active, created_at';

export function getEmployeeById(db: SqliteDb, id: number): EmployeeWriteRow | undefined {
  return db.prepare(`SELECT ${WRITE_COLUMNS} FROM employees WHERE id = ?`).get(id) as EmployeeWriteRow | undefined;
}

/** 在职员工列表（`active=1`，按 id 升序）。 */
export function listEmployees(db: SqliteDb): EmployeeRow[] {
  return db
    .prepare(`SELECT id, name, role, avatar, is_assistant, active, mcps FROM employees WHERE active = 1 ORDER BY id`)
    .all() as EmployeeRow[];
}

/** 0 号员工（幕僚长）的固定 id（`schema.sql`：0 号员工）。 */
export const ASSISTANT_EMPLOYEE_ID = 0;

/**
 * 读取员工能力档（`employees.capability_tier`：`sandbox|standard|trusted`）。
 * 找不到员工时返回 `null`（**不自造**；调用方自行决定缺省）。OPT-M9-1 默认引擎路径接线用。
 */
export function getCapabilityTier(db: SqliteDb, employeeId: number): string | null {
  const row = db.prepare('SELECT capability_tier FROM employees WHERE id = ?').get(employeeId) as
    | { capability_tier: string }
    | undefined;
  return row ? row.capability_tier : null;
}

/** N5（`R3-3`）：员工档案的模型偏好（`model` NULL＝跟随档位解析；`thinking` 同）。找不到员工 → 双 null（不臆造）。 */
export function getEmployeeModelPref(db: SqliteDb, employeeId: number): { model: string | null; thinking: string | null } {
  const row = db.prepare('SELECT model, thinking FROM employees WHERE id = ?').get(employeeId) as
    | { model: string | null; thinking: string | null }
    | undefined;
  return { model: row?.model ?? null, thinking: row?.thinking ?? null };
}

export interface InsertEmployeeInput {
  /** 幕僚长用 `id=0`；缺省则由 SQLite 自增。 */
  id?: number;
  name: string;
  role: string;
  persona?: string;
  /** `null` = 跟随全局默认（不得硬编码模型名——模型目录以运行时拉取为准）。 */
  model?: string | null;
  thinking?: string | null;
  /** 技能/MCP 库 id 或名字（存 JSON 数组；解析不到由读面如实显 null）。 */
  skills?: Array<string | number>;
  mcps?: Array<string | number>;
  /** 能力档：sandbox | standard | trusted（缺省 standard）。 */
  capabilityTier?: string;
  avatar?: string | null;
  isAssistant?: boolean;
  active?: boolean;
  now?: number;
}

/** 插入一名员工，返回其 id（**纯 DAO**；白名单/校验在 IPC 层，本层只做列形状）。 */
export function insertEmployee(db: SqliteDb, input: InsertEmployeeInput): number {
  const row = db
    .prepare(
      `INSERT INTO employees (id, name, role, persona, model, thinking, skills, mcps, capability_tier, avatar, is_assistant, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      input.id ?? null,
      input.name,
      input.role,
      input.persona ?? '',
      input.model ?? null,
      input.thinking ?? null,
      JSON.stringify(input.skills ?? []),
      JSON.stringify(input.mcps ?? []),
      input.capabilityTier ?? 'standard',
      input.avatar ?? null,
      input.isAssistant ? 1 : 0,
      input.active === false ? 0 : 1,
      input.now ?? Date.now(),
    ) as { id: number };
  return row.id;
}

export interface UpdateEmployeeInput {
  name?: string;
  role?: string;
  persona?: string;
  model?: string | null;
  thinking?: string | null;
  skills?: Array<string | number>;
  mcps?: Array<string | number>;
  capabilityTier?: string;
  avatar?: string | null;
  active?: boolean;
}

export type EmployeeWriteResult =
  | { ok: true; row: EmployeeWriteRow }
  | { ok: false; code: 'not_found' | 'bad_value' | 'busy'; message: string };

const THINKING_VALUES = ['off', 'low', 'medium', 'high'] as const;
const CAPABILITY_VALUES = ['sandbox', 'standard', 'trusted'] as const;

/**
 * 改员工档案（**唯一写入口**；招募后的改档面走这里）。
 * 校验：名字/角色非空；thinking/capability 枚举；停用前不得有在跑/排队件（先转派再停用）；
 * 幕僚长（id=0）不得停用。**非法拒且不落库**。
 */
export function updateEmployee(db: SqliteDb, employeeId: number, patch: UpdateEmployeeInput): EmployeeWriteResult {
  const row = getEmployeeById(db, employeeId);
  if (!row) return { ok: false, code: 'not_found', message: `员工不存在：${employeeId}` };

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) return { ok: false, code: 'bad_value', message: '员工名字不能为空' };
    set('name', name);
  }
  if (patch.role !== undefined) {
    const role = patch.role.trim();
    if (role.length === 0) return { ok: false, code: 'bad_value', message: '员工角色不能为空' };
    set('role', role);
  }
  if (patch.persona !== undefined) set('persona', patch.persona);
  if (patch.model !== undefined) {
    const model = typeof patch.model === 'string' ? patch.model.trim() : '';
    set('model', model.length > 0 ? model : null);
  }
  if (patch.thinking !== undefined) {
    if (patch.thinking != null && !(THINKING_VALUES as readonly string[]).includes(patch.thinking)) {
      return { ok: false, code: 'bad_value', message: `思考强度需为 ${THINKING_VALUES.join(' / ')} 或清空` };
    }
    set('thinking', patch.thinking ?? null);
  }
  if (patch.skills !== undefined) set('skills', JSON.stringify(patch.skills));
  if (patch.mcps !== undefined) set('mcps', JSON.stringify(patch.mcps));
  if (patch.capabilityTier !== undefined) {
    if (!(CAPABILITY_VALUES as readonly string[]).includes(patch.capabilityTier)) {
      return { ok: false, code: 'bad_value', message: `能力档需为 ${CAPABILITY_VALUES.join(' / ')}` };
    }
    set('capability_tier', patch.capabilityTier);
  }
  if (patch.avatar !== undefined) set('avatar', patch.avatar);
  if (patch.active !== undefined) {
    if (!patch.active && employeeId === ASSISTANT_EMPLOYEE_ID) {
      return { ok: false, code: 'bad_value', message: '幕僚长不能停用（0 号员工是编排兜底）' };
    }
    if (!patch.active) {
      const open = db
        .prepare(
          "SELECT COUNT(*) AS n FROM work_items WHERE employee_id = ? AND state IN ('queued','running','submitted','rejected')",
        )
        .get(employeeId) as { n: number };
      if (Number(open.n) > 0) {
        return { ok: false, code: 'busy', message: `员工还有 ${open.n} 件在跑/排队——先转派或等它结束，再停用` };
      }
    }
    set('active', patch.active ? 1 : 0);
  }

  if (sets.length === 0) return { ok: true, row };
  db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...params, employeeId);
  const updated = getEmployeeById(db, employeeId);
  if (!updated) throw new Error(`[db] updateEmployee 后读回失败：id=${employeeId}`);
  return { ok: true, row: updated };
}

/**
 * （A）生产首启引导名册：**仅当 `employees` 表为空时，只补幕僚长一人**（`id=0`, `is_assistant=1`）。
 * 口径：**幂等**（重复调用不重复插）；**非空绝不插**；**绝不出任何其它员工**。
 * `persona/model/thinking` **不臆造**（用列默认：model=NULL=跟随全局，遵守“模型不得硬编码”）。
 */
export function ensureAssistantSeeded(db: SqliteDb, now: number = Date.now()): { seeded: boolean } {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n;
  if (count > 0) return { seeded: false };
  insertEmployee(db, {
    id: ASSISTANT_EMPLOYEE_ID,
    name: '幕僚长',
    role: 'assistant',
    isAssistant: true,
    now,
  });
  return { seeded: true };
}
