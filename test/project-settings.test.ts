import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, readSetting, runMigrations, SETTING_REDACTED, validateSettingValue, writeSetting } from '../src/main/db/index.js';
import { getDefaultProject } from '../src/main/db/projects.js';
import { engineTuningFromSettings } from '../src/main/engine/tuning.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectGet, handleProjectList, handleSettingsGet, handleSettingsSet } from '../src/main/ipc/ipc.js';

// ── R2-3 · 三桩第一批（主进程侧）：`project:list/get` ＋ `settings:get/set`（白名单） ──
// 口径：未设值 → `{value:null}`（不臆造）；未知键拒（`unknown_key`）；secret 名一律 `«redacted»`；
//       `projects.default_id` 的**真实读者**＝`getDefaultProject`（写出"没人用的键"不算交付）。

const AT = 1_800_000_000_000;

function setup(): { db: ReturnType<typeof openMemoryDatabase>; deps: { repo: ReturnType<typeof createSqliteChatRepo> } } {
  const db = openMemoryDatabase();
  runMigrations(db);
  return { db, deps: { repo: createSqliteChatRepo(db) } };
}

test('R2-3 settings DAO: 写读往返（JSON/upsert）；缺失 → undefined；坏 JSON → 原样字符串（不抛）', () => {
  const { db } = setup();
  assert.equal(readSetting(db, 'projects.default_id'), undefined, '未设值 → undefined（不臆造默认）');

  writeSetting(db, 'projects.default_id', 11);
  assert.equal(readSetting(db, 'projects.default_id'), 11);
  writeSetting(db, 'projects.default_id', 12);
  assert.equal(readSetting(db, 'projects.default_id'), 12, '重复写＝upsert');

  // 坏 JSON：忠实返回原样字符串（读路径不抛；守卫在写侧）
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run('projects.default_id', '{bad');
  assert.equal(readSetting(db, 'projects.default_id'), '{bad');
  db.close();
});

test('R2-3 settings:get/set（IPC 层）：白名单守卫 ＋ 未设值 null ＋ 端到端真读者（getDefaultProject）', () => {
  const { db, deps } = setup();
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, '记账系统', 'D:/repo', AT);

  // 未设值 → null（不臆造）
  assert.deepEqual(handleSettingsGet(deps, { key: 'projects.default_id' }), { value: null });

  // 未知键 → 拒（防任意写/悬空键）
  const bad = handleSettingsGet(deps, { key: 'nope.unknown' }) as { ok: false; code: string };
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unknown_key');
  assert.equal((handleSettingsSet(deps, { key: 'nope.unknown', value: 1 }) as { ok: false; code: string }).code, 'unknown_key');

  // 缺 key / 不可序列化值 → bad_request
  assert.equal((handleSettingsGet(deps, {}) as { ok: false; code: string }).code, 'bad_request');
  assert.equal((handleSettingsSet(deps, { key: 'projects.default_id', value: () => 1 }) as { ok: false; code: string }).code, 'bad_request');

  // 正常写读
  assert.deepEqual(handleSettingsSet(deps, { key: 'projects.default_id', value: 11 }), { ok: true, value: 11 });
  assert.deepEqual(handleSettingsGet(deps, { key: 'projects.default_id' }), { value: 11 });

  // **真读者**：resolver 的默认项目解析读得到（不是"写了个没人用的键"）
  assert.deepEqual(getDefaultProject(db), { id: 11, name: '记账系统' });
  db.close();
});

test('R2-3 settings:get secret 名一律掩码（03 §7.3 契约；优先级高于白名单）', () => {
  const { db, deps } = setup();
  const res = handleSettingsGet(deps, { key: 'models.api_key' });
  assert.deepEqual(res, { value: SETTING_REDACTED }, 'secret 名 → «redacted»（不查白名单、不泄露存在性）');

  // 即便将来真存了值，读路径也掩码
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('models.api_key', JSON.stringify('sk-abc'));
  assert.deepEqual(handleSettingsGet(deps, { key: 'models.api_key' }), { value: SETTING_REDACTED });
  db.close();
});

test('R2-3 project:list/get：归档默认过滤、DTO camelCase、JSON 列防御解析、非法入参 → null', () => {
  const { db, deps } = setup();
  const ins = db.prepare(
    `INSERT INTO projects (id, name, alias, root_dir, default_employee_ids, default_skills, allowed_providers, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(11, '记账系统', '记账', 'D:/repo/a', JSON.stringify([1, 2]), JSON.stringify(['style-guide']), JSON.stringify(['deepseek']), 0, AT);
  ins.run(12, '旧项目', null, 'D:/repo/b', '[]', '{bad', '[]', 1, AT); // 归档 + 坏 JSON 列

  const active = handleProjectList(deps, {});
  assert.equal(active.length, 1, '归档默认过滤');
  assert.equal(active[0].id, 11);
  assert.equal(active[0].rootDir, 'D:/repo/a');
  assert.deepEqual(active[0].defaultEmployeeIds, [1, 2]);
  assert.deepEqual(active[0].defaultSkills, ['style-guide']);
  assert.deepEqual(active[0].allowedProviders, ['deepseek']);
  assert.equal(active[0].alias, '记账');

  const all = handleProjectList(deps, { includeArchived: true });
  assert.equal(all.length, 2, 'includeArchived 全列');
  assert.deepEqual(all[1].defaultSkills, [], '坏 JSON 列 → []（防御解析，不抛）');

  assert.equal(handleProjectGet(deps, { projectId: 11 })?.name, '记账系统');
  assert.equal(handleProjectGet(deps, { projectId: 999 }), null, '不存在 → null');
  assert.equal(handleProjectGet(deps, {}), null, '非法入参 → null（不抛）');
  db.close();
});

// ── 件 A · 调度与费率可配面（写侧校验 ＋ 装配期真读者 `engineTuningFromSettings`）──────────────

test('件 A 校验：形状/边界（整数/数字/范围/清空 null 恒合法）；越界与类型错给人话原因', () => {
  // 清空恒合法（回落缺省语义）
  assert.deepEqual(validateSettingValue('concurrency.maxPerTask', null), { ok: true });
  // 范围内
  assert.deepEqual(validateSettingValue('concurrency.maxPerTask', 6), { ok: true });
  assert.deepEqual(validateSettingValue('rate.softUsdPerHour', 3.5), { ok: true });
  assert.deepEqual(validateSettingValue('scheduler.agingCap', 0), { ok: true });
  // 越界 / 错类型 → 拒（带范围说明）
  assert.equal(validateSettingValue('concurrency.maxCompany', 0).ok, false);
  assert.equal(validateSettingValue('concurrency.maxCompany', 21).ok, false);
  assert.equal(validateSettingValue('scheduler.maxActiveTasks', 2.5).ok, false, '整数键不接受小数');
  assert.equal(validateSettingValue('scheduler.maxActiveTasks', '3').ok, false, '字符串数字也必须拒（防隐式转换）');
  assert.equal(validateSettingValue('rate.softUsdPerHour', Number.NaN).ok, false);
  const bad = validateSettingValue('rate.softUsdPerHour', 0.01) as { ok: false; reason: string };
  assert.ok(bad.reason.includes('0.1–100'), `原因须带范围（实际：${bad.reason}）`);
  // 既有键（防回归）：onboarding 布尔、models 非空串
  assert.deepEqual(validateSettingValue('onboarding.completed', true), { ok: true });
  assert.equal(validateSettingValue('onboarding.completed', 1).ok, false);
  assert.equal(validateSettingValue('models.default', '').ok, false);
});

test('件 A settings:set：越界/类型错 → `bad_value` 且**不落库**；合法值落库（端到端）', () => {
  const { db, deps } = setup();
  const bad = handleSettingsSet(deps, { key: 'concurrency.maxPerTask', value: 99 }) as { ok: false; code: string; message: string };
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_value');
  assert.ok(bad.message.includes('1–10'), '错误信息带范围（人话）');
  assert.equal(readSetting(db, 'concurrency.maxPerTask'), undefined, '被拒的值绝不落库');

  assert.deepEqual(handleSettingsSet(deps, { key: 'concurrency.maxPerTask', value: 2 }), { ok: true, value: 2 });
  assert.equal(readSetting(db, 'concurrency.maxPerTask'), 2);
  // 清空（null）＝回落缺省
  assert.deepEqual(handleSettingsSet(deps, { key: 'concurrency.maxPerTask', value: null }), { ok: true, value: null });
  assert.equal(readSetting(db, 'concurrency.maxPerTask'), null);
  db.close();
});

test('件 A engineTuningFromSettings：映射到 EngineConfig；未设/越界 → 不出现（回落缺省，不臆造）；排队线 = 降档线 ×1.5', () => {
  const { db, deps } = setup();
  // 全未设 → 三个子对象都为空（Engine 用它自己的缺省）
  assert.deepEqual(engineTuningFromSettings((k) => readSetting(db, k)), { scheduler: {}, concurrency: {}, rateLimit: {} });

  handleSettingsSet(deps, { key: 'scheduler.maxActiveTasks', value: 5 });
  handleSettingsSet(deps, { key: 'scheduler.agingMinutes', value: 60 });
  handleSettingsSet(deps, { key: 'concurrency.maxPerTask', value: 2 });
  handleSettingsSet(deps, { key: 'concurrency.maxCompany', value: 8 });
  handleSettingsSet(deps, { key: 'rate.softUsdPerHour', value: 4 });
  const tuned = engineTuningFromSettings((k) => readSetting(db, k));
  assert.deepEqual(tuned.scheduler, { maxActiveTasks: 5, agingMinutes: 60 });
  assert.deepEqual(tuned.concurrency, { maxPerTask: 2, maxCompany: 8 });
  assert.deepEqual(tuned.rateLimit, { softUsdPerHour: 4, hardUsdPerHour: 6 }, '排队线＝降档线 ×1.5（与 env 口径同公式）');

  // 越界值（绕过写侧校验直接入库，防御面）→ 视为未设，不喂给引擎
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run('concurrency.maxCompany', '999');
  const afterBad = engineTuningFromSettings((k) => readSetting(db, k));
  assert.equal(afterBad.concurrency?.maxCompany, undefined, '越界值不得进引擎配置（回落缺省）');
  db.close();
});
