/**
 * · 公司配置版本化（`.aico/company.json`）。
 *
 * 口径：
 *  - **文件随仓库走**：员工（角色/人设/模型/思考/能力档/技能/MCP 引用）＋公司级模型与调度设置；
 *  - **不含凭据/项目私有数据**：不导出 API Key、MCP env 值、项目路径、通知/向导偏好；
 *  - **三动作**：export（写文件）、preview（只读 diff＋token）、apply（校验＋备份＋事务落库）；
 *  - **回滚**：apply 前把当前配置写 `.aico/company.backup.json`；rollback 校验备份后恢复；
 *  - **非法配置整体拒**（schema/枚举/设置边界/重名/助理冲突/忙碌员工停用），不半应用；
 *  - **只增量同步**：配置里没有的现有员工不删/不停（diff 显式列 skipped），避免一份文件误删全公司。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { SqliteDb } from '../db/open.js';
import {
  insertEmployee,
  updateEmployee,
  validateSettingValue,
  readSetting,
  writeSetting,
  getSkillById,
  getSkillByName,
  getMcpServerById,
  getMcpServerByName,
  getEmployeeById,
} from '../db/index.js';
import type { EmployeeWriteRow } from '../db/employees.js';
import { listProjects } from '../db/projects.js';
import { modelWhitelistError } from './model-whitelist.js';

export const COMPANY_CONFIG_SCHEMA = 'aico-company/1';
export const COMPANY_CONFIG_RELATIVE = '.aico/company.json';
export const COMPANY_BACKUP_RELATIVE = '.aico/company.backup.json';
export const COMPANY_APPLY_JOURNAL_RELATIVE = '.aico/company.last-apply.json';

/** 可随仓库走的公司级设置（不含项目/通知/向导/凭据；键必须 ∈ KNOWN_SETTINGS_KEYS）。 */
export const COMPANY_SETTING_KEYS = [
  'models.default',
  'models.role_map',
  'models.fallback_chain',
  'scheduler.maxActiveTasks',
  'scheduler.agingMinutes',
  'scheduler.agingCap',
  'concurrency.maxPerTask',
  'concurrency.maxCompany',
  'rate.softUsdPerHour',
] as const;

export interface CompanyEmployeeConfig {
  name: string;
  role: string;
  persona: string;
  model: string | null;
  thinking: string | null;
  /** 技能名（导出时把 id 解析成名字；解析不到保留原 ref）。 */
  skills: string[];
  /** MCP server 名（同上）。 */
  mcps: string[];
  capabilityTier: string;
  active: boolean;
  isAssistant: boolean;
}

export interface CompanyConfigV1 {
  schema: typeof COMPANY_CONFIG_SCHEMA;
  exportedAt: string;
  employees: CompanyEmployeeConfig[];
  settings: Record<string, unknown>;
}

export type CompanyDiff = {
  added: string[];
  updated: Array<{ name: string; changes: Record<string, { from: unknown; to: unknown }> }>;
  skipped: string[];
  unchanged: number;
  settings: {
    added: string[];
    updated: string[];
    unchanged: number;
  };
  errors: string[];
};

export type ApplyResult =
  | {
      ok: true;
      added: string[];
      updated: string[];
      skipped: string[];
      settings: string[];
    }
  | { ok: false; code: string; message: string; errors?: string[] };

const THINKING = ['off', 'low', 'medium', 'high'] as const;
const TIERS = ['sandbox', 'standard', 'trusted'] as const;
const MAX_EMPLOYEES = 200;

function parseRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function refToName(db: SqliteDb, table: 'skills' | 'mcp_servers', ref: string): string {
  const byId = /^\d+$/.test(ref)
    ? table === 'skills'
      ? getSkillById(db, Number(ref))
      : getMcpServerById(db, Number(ref))
    : undefined;
  if (byId) return byId.name;
  const row = table === 'skills' ? getSkillByName(db, ref) : getMcpServerByName(db, ref);
  return row?.name ?? ref;
}

function allEmployees(db: SqliteDb): EmployeeWriteRow[] {
  return db
    .prepare(
      `SELECT id, name, role, persona, model, thinking, skills, mcps, capability_tier, avatar, is_assistant, active, created_at
         FROM employees ORDER BY id`,
    )
    .all() as EmployeeWriteRow[];
}

/** 从 DB 生成可提交进仓库的公司配置。 */
export function buildCompanyConfig(db: SqliteDb, now: number = Date.now()): CompanyConfigV1 {
  const employees: CompanyEmployeeConfig[] = allEmployees(db).map((row) => ({
    name: row.name,
    role: row.role,
    persona: row.persona,
    model: row.model,
    thinking: row.thinking,
    skills: parseRefs(row.skills).map((ref) => refToName(db, 'skills', ref)),
    mcps: parseRefs(row.mcps).map((ref) => refToName(db, 'mcp_servers', ref)),
    capabilityTier: row.capability_tier,
    active: row.active === 1,
    isAssistant: row.is_assistant === 1,
  }));
  const settings: Record<string, unknown> = {};
  for (const key of COMPANY_SETTING_KEYS) {
    const value = readSetting(db, key);
    if (value !== undefined) settings[key] = value;
  }
  return { schema: COMPANY_CONFIG_SCHEMA, exportedAt: new Date(now).toISOString(), employees, settings };
}

export type ValidateResult = { ok: true; config: CompanyConfigV1 } | { ok: false; errors: string[] };

/** 严格解析/校验；任何一项坏 → 整体拒（不半应用）。 */
export function validateCompanyConfig(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj) return { ok: false, errors: ['配置必须是 JSON 对象'] };
  if (obj.schema !== COMPANY_CONFIG_SCHEMA) errors.push(`schema 必须为 ${COMPANY_CONFIG_SCHEMA}`);
  if (typeof obj.exportedAt !== 'string' || Number.isNaN(Date.parse(obj.exportedAt))) {
    errors.push('exportedAt 必须是 ISO 时间字符串');
  }
  const employeesRaw = obj.employees;
  if (!Array.isArray(employeesRaw) || employeesRaw.length === 0) errors.push('employees 必须是非空数组');
  if (Array.isArray(employeesRaw) && employeesRaw.length > MAX_EMPLOYEES) {
    errors.push(`employees 超过上限 ${MAX_EMPLOYEES}`);
  }
  const names = new Set<string>();
  let assistantCount = 0;
  const employees: CompanyEmployeeConfig[] = [];
  for (const [index, item] of (Array.isArray(employeesRaw) ? employeesRaw : []).entries()) {
    const e = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!e) {
      errors.push(`employees[${index}] 必须是对象`);
      continue;
    }
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const role = typeof e.role === 'string' ? e.role.trim() : '';
    if (name.length === 0) errors.push(`employees[${index}].name 不能为空`);
    if (role.length === 0) errors.push(`employees[${index}].role 不能为空`);
    if (name.length > 0) {
      if (names.has(name)) errors.push(`员工重名：${name}`);
      names.add(name);
    }
    const thinking = e.thinking == null ? null : String(e.thinking);
    if (thinking != null && !(THINKING as readonly string[]).includes(thinking)) {
      errors.push(`employees[${index}].thinking 非法：${thinking}`);
    }
    const tier = typeof e.capabilityTier === 'string' ? e.capabilityTier : 'standard';
    if (!(TIERS as readonly string[]).includes(tier)) errors.push(`employees[${index}].capabilityTier 非法：${tier}`);
    const skills = Array.isArray(e.skills) ? e.skills.filter((v): v is string => typeof v === 'string') : [];
    const mcps = Array.isArray(e.mcps) ? e.mcps.filter((v): v is string => typeof v === 'string') : [];
    if (e.skills !== undefined && (!Array.isArray(e.skills) || skills.length !== e.skills.length)) {
      errors.push(`employees[${index}].skills 必须是字符串数组`);
    }
    if (e.mcps !== undefined && (!Array.isArray(e.mcps) || mcps.length !== e.mcps.length)) {
      errors.push(`employees[${index}].mcps 必须是字符串数组`);
    }
    const isAssistant = e.isAssistant === true;
    if (isAssistant) assistantCount += 1;
    if (typeof e.active !== 'boolean') errors.push(`employees[${index}].active 必须是布尔`);
    if (e.model != null && typeof e.model !== 'string') errors.push(`employees[${index}].model 必须是字符串或 null`);
    if (e.persona !== undefined && typeof e.persona !== 'string') errors.push(`employees[${index}].persona 必须是字符串`);
    employees.push({
      name,
      role,
      persona: typeof e.persona === 'string' ? e.persona : '',
      model: e.model == null ? null : String(e.model),
      thinking,
      skills,
      mcps,
      capabilityTier: tier,
      active: e.active === true,
      isAssistant,
    });
  }
  if (assistantCount > 1) errors.push('最多只能有一个 isAssistant=true');

  const settingsRaw = obj.settings === undefined ? {} : obj.settings;
  if (!settingsRaw || typeof settingsRaw !== 'object' || Array.isArray(settingsRaw)) {
    errors.push('settings 必须是对象');
  }
  const settings: Record<string, unknown> = {};
  if (settingsRaw && typeof settingsRaw === 'object' && !Array.isArray(settingsRaw)) {
    for (const [key, value] of Object.entries(settingsRaw as Record<string, unknown>)) {
      if (!(COMPANY_SETTING_KEYS as readonly string[]).includes(key)) {
        errors.push(`settings.${key} 不允许随仓库走（白名单外）`);
        continue;
      }
      const check = validateSettingValue(key as never, value);
      if (!check.ok) errors.push(`settings.${key}：${check.reason}`);
      else settings[key] = value;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      schema: COMPANY_CONFIG_SCHEMA,
      exportedAt: String(obj.exportedAt),
      employees,
      settings,
    },
  };
}

function currentByName(db: SqliteDb): Map<string, EmployeeWriteRow> {
  return new Map(allEmployees(db).map((row) => [row.name, row]));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 只读 diff（不回写）；token 由文件内容 sha256 提供（防止预览后文件被改）。 */
export function diffCompanyConfig(db: SqliteDb, config: CompanyConfigV1): CompanyDiff {
  const target = currentByName(db);
  const configNames = new Set(config.employees.map((e) => e.name));
  const added: string[] = [];
  const updated: CompanyDiff['updated'] = [];
  let unchanged = 0;
  for (const e of config.employees) {
    const row = e.isAssistant ? allEmployees(db).find((r) => r.is_assistant === 1) ?? target.get(e.name) : target.get(e.name);
    if (!row) {
      added.push(e.name);
      continue;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const fields: Array<[keyof CompanyEmployeeConfig, unknown, unknown]> = [
      ['name', row.name, e.name],
      ['role', row.role, e.role],
      ['persona', row.persona, e.persona],
      ['model', row.model, e.model],
      ['thinking', row.thinking, e.thinking],
      ['skills', parseRefs(row.skills), e.skills],
      ['mcps', parseRefs(row.mcps), e.mcps],
      ['capabilityTier', row.capability_tier, e.capabilityTier],
      ['active', row.active === 1, e.active],
      ['isAssistant', row.is_assistant === 1, e.isAssistant],
    ];
    for (const [field, from, to] of fields) {
      if (!sameJson(from, to)) changes[field] = { from, to };
    }
    if (Object.keys(changes).length > 0) updated.push({ name: e.name, changes });
    else unchanged += 1;
  }
  const skipped = allEmployees(db)
    .map((row) => row.name)
    .filter((name) => !configNames.has(name));
  const settingsAdded: string[] = [];
  const settingsUpdated: string[] = [];
  let settingsUnchanged = 0;
  for (const [key, value] of Object.entries(config.settings)) {
    const current = readSetting(db, key);
    if (current === undefined) settingsAdded.push(key);
    else if (!sameJson(current, value)) settingsUpdated.push(key);
    else settingsUnchanged += 1;
  }
  return {
    added,
    updated,
    skipped,
    unchanged,
    settings: { added: settingsAdded, updated: settingsUpdated, unchanged: settingsUnchanged },
    errors: [],
  };
}

function openWorkCount(db: SqliteDb, employeeId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM work_items WHERE employee_id = ? AND state IN ('queued','running','blocked','submitted','rejected','interrupted')",
    )
    .get(employeeId) as { n: number };
  return row.n;
}

/** company.json 里的员工模型也必须过项目白名单（与 `employee:update` 同一判据）。 */
function configEmployeeModelError(db: SqliteDb, employeeId: number, model: string): string | null {
  for (const project of listProjects(db, { includeArchived: true })) {
    const allowed = parseRefs(project.allowed_providers);
    if (allowed.length === 0) continue;
    const referenced =
      project.default_owner_id === employeeId ||
      parseRefs(project.default_employee_ids).some((id) => Number(id) === employeeId);
    if (!referenced) continue;
    const error = modelWhitelistError({ model, allowedProviders: allowed, projectLabel: project.name });
    if (error) return error;
  }
  return null;
}

/**
 * 应用配置：**先全量校验（含忙碌员工停用/助理冲突）→ 备份当前 → 事务写库**。
 * 不与配置对应的现有员工既不删也不停（`skipped` 如实回报）。
 */
export function applyCompanyConfig(db: SqliteDb, config: CompanyConfigV1, now: number = Date.now()): ApplyResult {
  const targetByName = currentByName(db);
  const assistant = allEmployees(db).find((row) => row.is_assistant === 1);
  const planned: Array<{ cfg: CompanyEmployeeConfig; row: EmployeeWriteRow | null; kind: 'add' | 'update' }> = [];
  const errors: string[] = [];

  for (const cfg of config.employees) {
    const row = cfg.isAssistant ? assistant ?? null : targetByName.get(cfg.name) ?? null;
    if (row) {
      if (row.is_assistant === 1 && !cfg.isAssistant) errors.push(`幕僚长 ${row.name} 不得被配置改成普通员工`);
      if (row.is_assistant !== 1 && cfg.isAssistant) errors.push(`员工 ${row.name} 不是幕僚长，不能标 isAssistant`);
      if (!cfg.active && row.active === 1 && openWorkCount(db, row.id) > 0) {
        errors.push(`员工 ${row.name} 仍有在跑/排队工作项，不能在配置里停用`);
      }
      const collide = allEmployees(db).find((r) => r.id !== row.id && r.name === cfg.name);
      if (collide) errors.push(`员工重名冲突：${cfg.name}（已存在 #${collide.id}）`);
      planned.push({ cfg, row, kind: 'update' });
    } else {
      if (cfg.isAssistant && allEmployees(db).some((r) => r.is_assistant === 1)) {
        errors.push('配置要求幕僚长，但本机已有另一个幕僚长（id 不是 0）');
      }
      if (cfg.isAssistant && getEmployeeById(db, 0) != null) {
        errors.push('配置要求幕僚长，但 id=0 已被非助理员工占用');
      }
      planned.push({ cfg, row: null, kind: 'add' });
    }
  }
  // 引用/白名单再校验一遍（不只看形状）：悬空技能/MCP、项目白名单外模型都整体拒。
  for (const { cfg, row } of planned) {
    for (const skill of cfg.skills) {
      if (!getSkillByName(db, skill)) errors.push(`员工 ${cfg.name}：技能不存在「${skill}」`);
    }
    for (const mcp of cfg.mcps) {
      if (!getMcpServerByName(db, mcp)) errors.push(`员工 ${cfg.name}：MCP 不存在「${mcp}」`);
    }
    if (row && cfg.model != null) {
      const error = configEmployeeModelError(db, row.id, cfg.model);
      if (error) errors.push(`员工 ${cfg.name}：${error}`);
    }
  }
  if (errors.length > 0) return { ok: false, code: 'invalid_config', message: errors.join('；'), errors };

  db.exec('BEGIN');
  try {
    for (const { cfg, row, kind } of planned) {
      if (kind === 'add') {
        if (cfg.isAssistant) {
          insertEmployee(db, {
            id: 0,
            name: cfg.name,
            role: cfg.role,
            persona: cfg.persona,
            model: cfg.model,
            thinking: cfg.thinking,
            skills: cfg.skills,
            mcps: cfg.mcps,
            capabilityTier: cfg.capabilityTier,
            isAssistant: true,
            active: cfg.active,
            now,
          });
        } else {
          insertEmployee(db, {
            name: cfg.name,
            role: cfg.role,
            persona: cfg.persona,
            model: cfg.model,
            thinking: cfg.thinking,
            skills: cfg.skills,
            mcps: cfg.mcps,
            capabilityTier: cfg.capabilityTier,
            active: cfg.active,
            now,
          });
        }
      } else if (row) {
        const res = updateEmployee(db, row.id, {
          name: cfg.name,
          role: cfg.role,
          persona: cfg.persona,
          model: cfg.model,
          thinking: cfg.thinking,
          skills: cfg.skills,
          mcps: cfg.mcps,
          capabilityTier: cfg.capabilityTier,
          active: cfg.active,
        });
        if (!res.ok) throw new Error(`${cfg.name}：${res.message}`);
      }
    }
    for (const [key, value] of Object.entries(config.settings)) {
      const check = validateSettingValue(key as never, value);
      if (!check.ok) throw new Error(`settings.${key}：${check.reason}`);
      writeSetting(db, key, value);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return {
      ok: false,
      code: 'apply_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const diff = diffCompanyConfig(db, config);
  return {
    ok: true,
    added: planned.filter((p) => p.kind === 'add').map((p) => p.cfg.name),
    updated: diff.updated.map((u) => u.name),
    skipped: diff.skipped,
    settings: Object.keys(config.settings),
  };
}

function assertInsideProject(projectRoot: string, file: string): void {
  const root = resolve(projectRoot);
  const target = resolve(file);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error('配置文件越出项目根');
  }
  const aico = resolve(projectRoot, '.aico');
  if (existsSync(aico)) {
    const st = lstatSync(aico);
    if (st.isSymbolicLink()) throw new Error('.aico 不能是符号链接');
  }
}

export function companyConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), COMPANY_CONFIG_RELATIVE);
}

export function companyBackupPath(projectRoot: string): string {
  return join(resolve(projectRoot), COMPANY_BACKUP_RELATIVE);
}

export function companyApplyJournalPath(projectRoot: string): string {
  return join(resolve(projectRoot), COMPANY_APPLY_JOURNAL_RELATIVE);
}

/** apply 前记下本次**新增**的员工/设置，供 rollback 精确撤销（不碰原有配置）。 */
export function writeApplyJournal(
  projectRoot: string,
  added: readonly string[],
  settingsAdded: readonly string[] = [],
  now: number = Date.now(),
): string {
  const path = companyApplyJournalPath(projectRoot);
  assertInsideProject(projectRoot, path);
  writeJsonAtomic(path, {
    schema: 'aico-company-apply/1',
    added: [...added],
    settingsAdded: [...settingsAdded],
    at: new Date(now).toISOString(),
  });
  return path;
}

export interface ApplyJournal {
  added: string[];
  settingsAdded: string[];
}

export function readApplyJournal(projectRoot: string): ApplyJournal {
  const path = companyApplyJournalPath(projectRoot);
  try {
    assertInsideProject(projectRoot, path);
    if (!existsSync(path)) return { added: [], settingsAdded: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { added?: unknown; settingsAdded?: unknown };
    return {
      added: Array.isArray(parsed.added) ? parsed.added.filter((v): v is string => typeof v === 'string') : [],
      settingsAdded: Array.isArray(parsed.settingsAdded)
        ? parsed.settingsAdded.filter((v): v is string => typeof v === 'string')
        : [],
    };
  } catch {
    return { added: [], settingsAdded: [] };
  }
}

/** rollback：撤销**本次 apply 新增**的设置（备份里没有 → 删除，恢复“未设置”）。 */
export function undoAppliedSettings(db: SqliteDb, keys: readonly string[]): string[] {
  const removed: string[] = [];
  for (const key of keys) {
    const info = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    if (info.changes > 0) removed.push(key);
  }
  return removed;
}

/** rollback：撤销**本次 apply 新增**的员工（有历史引用 → 停用而非删，避免 FK 破坏）。返回实际删除/停用的名字。 */
export function undoAppliedAdditions(db: SqliteDb, names: readonly string[]): { removed: string[]; deactivated: string[] } {
  const removed: string[] = [];
  const deactivated: string[] = [];
  for (const name of names) {
    const row = db.prepare('SELECT id, is_assistant FROM employees WHERE name = ?').get(name) as
      | { id: number; is_assistant: number }
      | undefined;
    if (!row || row.is_assistant === 1) continue;
    try {
      db.prepare('DELETE FROM employees WHERE id = ?').run(row.id);
      removed.push(name);
    } catch {
      db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(row.id);
      deactivated.push(name);
    }
  }
  return { removed, deactivated };
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** 导出到 `<项目根>/.aico/company.json`（原子写；返回路径/配置/计数）。 */
export function exportCompanyConfigToProject(
  db: SqliteDb,
  projectRoot: string,
  now: number = Date.now(),
): { path: string; config: CompanyConfigV1 } {
  const path = companyConfigPath(projectRoot);
  assertInsideProject(projectRoot, path);
  const config = buildCompanyConfig(db, now);
  writeJsonAtomic(path, config);
  return { path, config };
}

export interface ReadConfigResult {
  ok: true;
  config: CompanyConfigV1;
  text: string;
  token: string;
  path: string;
}
export type ReadConfigFailure = { ok: false; code: 'missing_file' | 'invalid_json' | 'invalid_config' | 'unsafe_path'; message: string; errors?: string[] };

function readConfigAt(projectRoot: string, file: string, label: string): ReadConfigResult | ReadConfigFailure {
  try {
    assertInsideProject(projectRoot, file);
  } catch (error) {
    return { ok: false, code: 'unsafe_path', message: error instanceof Error ? error.message : String(error) };
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { ok: false, code: 'missing_file', message: `没有配置文件：${label}（先导出一次）` };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, code: 'missing_file', message: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, code: 'invalid_json', message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const valid = validateCompanyConfig(raw);
  if (!valid.ok) return { ok: false, code: 'invalid_config', message: '配置校验未通过', errors: valid.errors };
  return { ok: true, config: valid.config, text, token: createHash('sha256').update(text).digest('hex'), path: file };
}

/** 读/校验项目根里的 company.json；token = 文件 sha256。 */
export function readCompanyConfigFromProject(projectRoot: string): ReadConfigResult | ReadConfigFailure {
  return readConfigAt(projectRoot, companyConfigPath(projectRoot), COMPANY_CONFIG_RELATIVE);
}

/** 读/校验最后一次 apply 前的备份。 */
export function readCompanyBackupFromProject(projectRoot: string): ReadConfigResult | ReadConfigFailure {
  return readConfigAt(projectRoot, companyBackupPath(projectRoot), COMPANY_BACKUP_RELATIVE);
}

/** 用给定配置覆盖 `.aico/company.json`（rollback 成功后让文件与库同态）。 */
export function writeCompanyConfigFile(projectRoot: string, config: CompanyConfigV1): string {
  const path = companyConfigPath(projectRoot);
  assertInsideProject(projectRoot, path);
  writeJsonAtomic(path, config);
  return path;
}

/** 写备份（apply 前调用；失败不阻断 apply? 由调用方决定）。 */
export function backupCompanyConfig(projectRoot: string, db: SqliteDb, now: number = Date.now()): string {
  const path = companyBackupPath(projectRoot);
  assertInsideProject(projectRoot, path);
  writeJsonAtomic(path, buildCompanyConfig(db, now));
  return path;
}
