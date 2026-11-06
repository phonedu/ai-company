/**
 * R2-3 · `settings` KV DAO（值 = JSON）。
 *
 * 口径：
 *  - **白名单**：只许读写**已有真实读者**的键（防「加了没人用的悬空键」，同 005 迁移的加列纪律）；
 *    新增键 = 这里加一行 ＋ 接线一个真读者。键名单以下方 `KNOWN_SETTINGS_KEYS` 为准（13 个，全部带真读者；
 *    `schema.sql` §约定键 是设计期命名清单，两者非一一对应——**不要在文档里重抄本名单**）。
 *    读者：`projects.default_id` → `getDefaultProject`；`models.default`/`models.role_map` → `agent/model-policy` 的
 *    `setDefaultModel`/`setRoleMap`（启动注入 ＋ 写入即生效）；`onboarding.completed` → 渲染层向导门；
 *    其余 → `engine/tuning.ts` 装配期读取。
 *  - **凭据不进此表**：key/token 一律走 `~/.aico/secrets`（EMPLOYEES §10）；`settings:get` 对 secret 名一律掩码（DEV §7.3 契约）。
 *  - **不臆造**：未设值 → `undefined`（ipc 层转 `{value:null}`）；坏 JSON → 原样字符串（忠实返回，不抛）。
 *  - 表结构只有 `(key, value)`（**无时间戳列**——不另加）。
 */
import type { SqliteDb } from './open.js';
import { fallbackChainShapeError, MAX_FALLBACK_CHAIN, roleMapShapeError, SESSION_ROLES, THINKING_LEVELS } from '../../core/model-tiers.js';

/** 白名单键（只含有真实读者的键）：
 *  - `projects.default_id` → `db/projects.ts` 的 `getDefaultProject`；
  - `channel.scope_project_id` → 频道范围落库（RW-14）：note_write 等助手工具读它定落点（0/缺省＝全局）；
 *  - `models.default` → `agent/model-policy.ts` 的 `setDefaultModel`（启动注入 ＋ 写入即生效于下次装配）；
 *  - `onboarding.completed` → 渲染层首启向导门（R2-4：读它决定是否显示向导；完成/跳过写 true）。
 *  - **件 A（调度与费率可配面）** → `engine/tuning.ts` 的 `engineTuningFromSettings`
 *    （装配期读 → `EngineConfig.scheduler/concurrency/rateLimit`；写入即生效于**下次装配**）。 */
export const KNOWN_SETTINGS_KEYS = [
  'channel.scope_project_id',
  'projects.default_id',
  'models.default',
  'models.role_map',
  'models.fallback_chain',
  'onboarding.completed',
  'scheduler.maxActiveTasks',
  'scheduler.agingMinutes',
  'scheduler.agingCap',
  'concurrency.maxPerTask',
  'concurrency.maxCompany',
  'rate.softUsdPerHour',
  /** C4（M3）：公司级日预算（USD；null/未设＝不限制；达线暂停 executing 任务并提示）。 */
  'budget.companyDailyUsd',
  'notify.quietStartMinutes',
  'notify.quietEndMinutes',
  'notify.digestAtMinutes',
  /** OPT-AI-12 / OPT-AI-11：上下文增强开关（缺省开；显式 false 关）。 */
  'prompt.fewShot',
  'memory.retrieval',
  /** M4-C：外观主题（light / dark / system；缺省跟随系统）。 */
  'ui.theme',
  /** 2026-10-29 P2（P-N05）：开机自启（true＝下次启动写入系统登录项；缺省 false）。 */
  'app.openAtLogin',
] as const;
export type KnownSettingKey = (typeof KNOWN_SETTINGS_KEYS)[number];

export function isKnownSettingKey(key: string): key is KnownSettingKey {
  return (KNOWN_SETTINGS_KEYS as readonly string[]).includes(key);
}

/** 键的形状/边界（**写侧唯一守卫**；`null` 一律＝清空 → 回落缺省）。 */
export interface SettingSpec {
  kind: 'string' | 'boolean' | 'integer' | 'number' | 'json';
  min?: number;
  max?: number;
  /** 人话范围（错误信息用；缺失＝只校验类型）。 */
  range?: string;
  /** `kind:'string'` 的枚举白名单（缺失＝只要求非空）。 */
  allowed?: readonly string[];
  /** `kind:'json'` 的形状校验（返回人话 reason 或 null）——复用同一条判据，防两套守卫漂移。 */
  validate?: (value: unknown) => string | null;
}

export const SETTING_SPECS: Record<KnownSettingKey, SettingSpec> = {
  'projects.default_id': { kind: 'integer', min: 1, range: '整数 ≥1（项目 id）' },
  'channel.scope_project_id': { kind: 'integer', min: 0, range: '整数 ≥0（0＝公司全局）' },
  'models.default': { kind: 'string', range: '非空字符串（provider/model）' },
  // N5（`R3-3`）：角色 → 模型档（**不动表**；形状守卫与读边界消毒同判据＝`core/model-tiers.roleMapShapeError`）。
  'models.role_map': {
    kind: 'json',
    range: `对象：角色 → {model, thinking?}（角色：${SESSION_ROLES.join('/')}；thinking：${THINKING_LEVELS.join('/')}）`,
    validate: roleMapShapeError,
  },
  // N5 余账（2026-10-16）：运行时兜底链（主模型不可用 → 降级）＋ critic/verifier 异供应商备选。
  'models.fallback_chain': {
    kind: 'json',
    range: `字符串数组：模型名（≤${MAX_FALLBACK_CHAIN} 条、非空、不重复），如 ["deepseek/deepseek-flash"]`,
    validate: fallbackChainShapeError,
  },
  'onboarding.completed': { kind: 'boolean', range: '布尔' },
  'scheduler.maxActiveTasks': { kind: 'integer', min: 1, max: 10, range: '整数 1–10' },
  'scheduler.agingMinutes': { kind: 'integer', min: 1, max: 240, range: '整数 1–240（分钟）' },
  'scheduler.agingCap': { kind: 'integer', min: 0, max: 50, range: '整数 0–50' },
  'concurrency.maxPerTask': { kind: 'integer', min: 1, max: 10, range: '整数 1–10' },
  'concurrency.maxCompany': { kind: 'integer', min: 1, max: 20, range: '整数 1–20' },
  'rate.softUsdPerHour': { kind: 'number', min: 0.1, max: 100, range: '数字 0.1–100（$/h）' },
  'budget.companyDailyUsd': { kind: 'number', min: 0.1, max: 10_000, range: '数字 0.1–10000（$/日）' },
  // M2-A 余（通知策略）：分钟数 0..1439（00:00..23:59）；静默窗 start===end ⇒ 不静默（用户没设就是没设）。
  'notify.quietStartMinutes': { kind: 'integer', min: 0, max: 1439, range: '整数 0–1439（分钟）' },
  'notify.quietEndMinutes': { kind: 'integer', min: 0, max: 1439, range: '整数 0–1439（分钟）' },
  'notify.digestAtMinutes': { kind: 'integer', min: 0, max: 1439, range: '整数 0–1439（分钟）' },
  'prompt.fewShot': { kind: 'boolean', range: '布尔（缺省开；false＝关闭 few-shot）' },
  'memory.retrieval': { kind: 'boolean', range: '布尔（缺省开；false＝关闭同项目历史检索）' },
  'ui.theme': { kind: 'string', range: 'light / dark / system', allowed: ['light', 'dark', 'system'] },
  'app.openAtLogin': { kind: 'boolean', range: '布尔（true＝下次启动写入系统登录项）' },
};

export type SettingValidation = { ok: true } | { ok: false; reason: string };

/** 校验一个白名单键的值（`null`＝清空 → 回落缺省，恒合法）。 */
export function validateSettingValue(key: KnownSettingKey, value: unknown): SettingValidation {
  if (value === null) return { ok: true };
  const spec = SETTING_SPECS[key];
  const range = spec.range ? `（${spec.range}）` : '';
  if (spec.kind === 'string') {
    if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, reason: `值需为${range || '非空字符串'}` };
    if (spec.allowed && !spec.allowed.includes(value)) return { ok: false, reason: `值需为${range}` };
    return { ok: true };
  }
  if (spec.kind === 'boolean') return typeof value === 'boolean' ? { ok: true } : { ok: false, reason: '值需为布尔' };
  if (spec.kind === 'json') {
    const reason = spec.validate
      ? spec.validate(value)
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : '值需为对象';
    return reason === null ? { ok: true } : { ok: false, reason: `${reason}${range}` };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `值需为数字${range}` };
  if (spec.kind === 'integer' && !Number.isInteger(value)) return { ok: false, reason: `值需为整数${range}` };
  if (spec.min != null && value < spec.min) return { ok: false, reason: `值超出范围${range}` };
  if (spec.max != null && value > spec.max) return { ok: false, reason: `值超出范围${range}` };
  return { ok: true };
}

/** secret 名 → 读时掩码。当前 settings 表内无凭据键；机制先立（防将来加键时漏掩码）。 */
const SECRET_KEY_RE = /(secret|token|password|api[_-]?key)/i;

export function isSecretSettingKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export const SETTING_REDACTED = '«redacted»';

/** 读一个键：缺失 → `undefined`；JSON 合法 → 解析值；坏 JSON → 原样字符串（不抛）。 */
export function readSetting(db: SqliteDb, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return row.value;
  }
}

/** 写一个键（upsert；值 JSON 序列化——不可序列化由调用方先校验）。 */
export function writeSetting(db: SqliteDb, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}
