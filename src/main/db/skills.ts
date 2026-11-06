/**
 * OPT-AI-9 · 技能库 DAO（`skills` 表；此前表在、零写入者）。
 *
 * 口径：
 *  - 技能条目＝`{name, description, source, path, version, enabled}`；`path` 指向 `SKILL.md`（本机文件）；
 *  - **不扫描目录**：注册由老板显式给路径（`skills:set`），避免 AI 自主读盘；
 *  - 员工勾选 `employees.skills`（id 或名字数组）；项目默认 `projects.default_skills`；
 *  - 会话装配时只读**启用**的技能，读 `path` 前 2000 字进 `[技能]` 层（读不到如实跳过，不编内容）。
 */
import type { SqliteDb } from './open.js';

export interface SkillRow {
  id: number;
  name: string;
  description: string;
  source: string;
  path: string;
  version: string | null;
  enabled: number;
  created_at: number;
}

const COLUMNS = 'id, name, description, source, path, version, enabled, created_at';

export function listSkills(db: SqliteDb, options: { includeDisabled?: boolean } = {}): SkillRow[] {
  const where = options.includeDisabled ? '' : ' WHERE enabled = 1';
  return db.prepare(`SELECT ${COLUMNS} FROM skills${where} ORDER BY name`).all() as SkillRow[];
}

export function getSkillById(db: SqliteDb, id: number): SkillRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM skills WHERE id = ?`).get(id) as SkillRow | undefined;
}

export function getSkillByName(db: SqliteDb, name: string): SkillRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM skills WHERE name = ?`).get(name) as SkillRow | undefined;
}

export interface UpsertSkillInput {
  name: string;
  description?: string;
  source?: string;
  path: string;
  version?: string | null;
  enabled?: boolean;
  now?: number;
}

/** 注册/更新一个技能（按 `name` 唯一）；返回行。 */
export function upsertSkill(db: SqliteDb, input: UpsertSkillInput): SkillRow {
  db.prepare(
    `INSERT INTO skills(name, description, source, path, version, enabled, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description, source = excluded.source, path = excluded.path,
       version = excluded.version, enabled = excluded.enabled`,
  ).run(
    input.name,
    input.description ?? '',
    input.source ?? 'local',
    input.path,
    input.version ?? null,
    input.enabled === false ? 0 : 1,
    input.now ?? Date.now(),
  );
  const row = getSkillByName(db, input.name);
  if (!row) throw new Error(`[db] upsertSkill 后读回失败：${input.name}`);
  return row;
}

/** GAP7：启停（内置也可停用；不可删由删除口拦）。 */
export function setSkillEnabled(db: SqliteDb, id: number, enabled: boolean): SkillRow | undefined {
  db.prepare('UPDATE skills SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getSkillById(db, id);
}

/** GAP7：被员工/项目引用次数（删除前提示；引用为 id 或名字两种写法都算）。 */
export function countSkillReferences(db: SqliteDb, name: string, id: number): number {
  const employees = db.prepare('SELECT skills FROM employees').all() as Array<{ skills: string | null }>;
  let n = 0;
  for (const row of employees) {
    try {
      const refs = JSON.parse(row.skills ?? '[]') as unknown;
      if (Array.isArray(refs) && refs.some((r) => String(r) === name || String(r) === String(id))) n += 1;
    } catch {
      /* 坏配置不算引用 */
    }
  }
  const projects = db.prepare('SELECT default_skills FROM projects').all() as Array<{ default_skills: string | null }>;
  for (const row of projects) {
    try {
      const refs = JSON.parse(row.default_skills ?? '[]') as unknown;
      if (Array.isArray(refs) && refs.some((r) => String(r) === name || String(r) === String(id))) n += 1;
    } catch {
      /* 坏配置不算引用 */
    }
  }
  return n;
}

/** GAP7：删除登记行（文件清理由 IPC 层按受管根判断；builtin 在 IPC 层先拒）。 */
export function deleteSkill(db: SqliteDb, id: number): SkillRow | undefined {
  const row = getSkillById(db, id);
  if (!row) return undefined;
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  return row;
}

/** 解析员工/项目勾选（id 或名字字符串）→ 启用中的技能行；未登记的条目忽略（不编名字）。 */
export function resolveEnabledSkills(db: SqliteDb, refs: readonly string[]): SkillRow[] {
  const out: SkillRow[] = [];
  const seen = new Set<number>();
  for (const ref of refs) {
    const row = /^\d+$/.test(ref) ? getSkillById(db, Number(ref)) : getSkillByName(db, ref);
    if (!row || row.enabled !== 1 || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
