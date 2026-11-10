import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NOTIFY_FIELDS, SETTINGS_GROUPS, SETTINGS_SECTIONS, SettingsPane, TUNING_FIELDS, settingsGroupOf, type SettingsPaneProps } from '../src/renderer/components/SettingsPane.js';
import { KNOWN_SETTINGS_KEYS } from '../src/main/db/settings.js';
import type { ProjectDTO } from '../src/renderer/types.js';

// ── R2-3 第二批 · 设置页纯组件：11 分区全列；已实现 5 个可点、未实现 6 个 disabled（如实） ──
// 件 A：`advanced` 分区＝调度与费率可配面（键真源＝主进程 `KNOWN_SETTINGS_KEYS`，本测断言两侧不漂移）。
// D-5 补位 ②：`employees` 分区转**指针**（真跳转公司大厅；管理面＝公司大厅 × 员工工位页）。
// 纯组件（props 驱动、不依赖 store）→ `renderToStaticMarkup` 可测；容器（store 接线）由 CDP 真机验。

const BASE: SettingsPaneProps = {
  section: 'models',
  onSectionChange: () => undefined,
  loading: false,
  error: null,
  saved: null,
  onGoHall: () => undefined,
  model: null,
  modelDraft: '',
  onModelDraftChange: () => undefined,
  onSaveModel: () => undefined,
  roleMap: null,
  roleMapDraft: '',
  onRoleMapDraftChange: () => undefined,
  onSaveRoleMap: () => undefined,
  fallbackChain: null,
  fallbackChainDraft: '',
  onFallbackChainDraftChange: () => undefined,
  onSaveFallbackChain: () => undefined,
  defaultProjectId: null,
  projects: [],
  onSetDefaultProject: () => undefined,
  tuningValues: {},
  tuningDrafts: {},
  onTuningDraftChange: () => undefined,
  onSaveTuning: () => undefined,
};

function render(overrides: Partial<SettingsPaneProps> = {}): string {
  return renderToStaticMarkup(createElement(SettingsPane, { ...BASE, ...overrides }));
}

/** 取某 testid 所在开标签的原文（用于断 `disabled` 这类布尔属性）。 */
function openTag(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  assert.ok(at >= 0, `缺 ${testid}`);
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('>', at);
  return html.slice(start, end + 1);
}

function countTestId(html: string, id: string): number {
  const needle = `data-testid="${id}"`;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** 取某 testid 元素的**文本内容**（跳过属性区；用于断"生效行"这类文案）。 */
function cellText(html: string, testid: string): string | null {
  const at = html.indexOf(`data-testid="${testid}"`);
  if (at < 0) return null;
  const gt = html.indexOf('>', at);
  const lt = html.indexOf('<', gt + 1);
  return html.slice(gt + 1, lt);
}

function project(partial: Partial<ProjectDTO> & { id: number }): ProjectDTO {
  return {
    name: `项目${partial.id}`,
    alias: null,
    rootDir: 'D:/repo',
    attention: 'normal',
    accessMode: 'inplace',
    defaultEmployeeIds: [],
    // 编制 v1：未设置＝null/[]（测试工厂缺省同 DTO 契约）
    defaultOwnerId: null,
    defaultRiskTier: null,
    assistantWriteMode: 'confirm',
    docsCheckEnabled: true,
    defaultSkills: [],
    allowedProviders: [],
    defaultModel: null,
    defaultBudgetTokens: null,
    // /：合并目标分支（未设置＝沿用 main/master）
    targetBranch: null,
    allowedModels: [],
    modelPolicy: 'employee_first',
    archived: 0,
    archivedAt: null,
    createdAt: 1,
    ...partial,
  };
}

test('2026-11-03 老板拍板「细分直达」：设置导航＝8 直达项；14 分区不丢、只归一组', () => {
  const html = render();
  assert.deepEqual(
    SETTINGS_GROUPS.map((g) => g.id),
    ['look', 'notify', 'model', 'employees', 'projects', 'integrations', 'ops', 'data'],
    '设置导航＝8 直达项（顺序＝外观/通知/供应商与模型/员工/项目/通道与技能/权限与调度/数据与关于）',
  );
  assert.deepEqual(
    SETTINGS_GROUPS.map((g) => g.label),
    ['外观', '通知', '供应商与模型', '员工', '项目', '通道与技能', '权限与调度', '数据与关于'],
  );
  for (const g of SETTINGS_GROUPS) {
    assert.equal(countTestId(html, `settings-group-${g.id}`), 1, `${g.label} 导航入口唯一`);
  }
  assert.equal((html.match(/data-testid="settings-group-/g) ?? []).length, 8, '导航恰 8 个直达项');
  assert.equal(SETTINGS_SECTIONS.length, 13, '13 个分区面板（项目模型随 S2 退役，原 14）');
  for (const sec of SETTINGS_SECTIONS) {
    assert.ok(settingsGroupOf(sec.id) != null, `${sec.id} 必须归属某个直达组`);
  }
  assert.equal(new Set(SETTINGS_GROUPS.flatMap((g) => g.sections)).size, SETTINGS_GROUPS.flatMap((g) => g.sections).length, '分区只归一组，不重复');
  // 卡片摘要层退役：无组页/卡/更改/返回（点一次导航就落在控件上）。
  assert.equal(html.includes('settings-group-page'), false, '组页摘要层退役');
  assert.equal(html.includes('settings-card-'), false, '摘要卡退役');
  assert.equal(html.includes('settings-back'), false, '返回钮退役');
  assert.doesNotMatch(html, /data-testid="settings-unimplemented"/);
  assert.equal(SETTINGS_SECTIONS.find((s) => s.id === 'permissions')?.implemented, true, '权限分区已实现');
});

test('细分直达：点「供应商与模型」一页铺开连接与模型；点「外观」即见主题开关', () => {
  const model = render({ section: 'model' });
  assert.match(model, /data-testid="settings-providers"/, '供应商连接直接在场（无需再点「更改」）');
  assert.equal(countTestId(model, 'settings-project-model'), 0, '项目模型分区已退役（S2）');
  assert.match(model, /供应商与模型/, '组标题');
  assert.equal(countTestId(model, 'settings-employees'), 0, '员工面板不混进供应商与模型页（角色映射属模型面板，允许出现）');

  const look = render({ section: 'look' });
  assert.match(look, /data-testid="settings-general"/);
  assert.match(look, /日间\/夜间/, '主题开关一次点击即可改');

  // 旧分区 id 深链兜底：settingsGroupOf 归组后同样直达控件。
  const legacy = render({ section: 'providers' });
  assert.match(legacy, /data-testid="settings-providers"/);
  const common = render({ section: 'common' });
  assert.match(common, /data-testid="settings-general"/, '旧组 id common → 外观');

  const ops = render({ section: 'ops' });
  assert.match(ops, /data-testid="settings-permissions-panel"/);
  assert.match(ops, /data-testid="settings-tuning-row"/);

  const data = render({ section: 'data' });
  assert.match(data, /data-testid="settings-about"/);
});

test('项目页设置分组：设置页不再有「项目模型」分区（指针也不留）——旧深链落到供应商与模型组', () => {
  const html = render({ section: 'project-model', defaultProjectId: 11, projects: [project({ id: 11 })] });
  assert.equal(countTestId(html, 'settings-project-model'), 0, '指针块也不留（老板：没用且增加疑惑）');
  assert.match(html, /data-testid="settings-providers"/, '旧深链 project-model → 供应商与模型组');
  assert.equal(SETTINGS_SECTIONS.some((x) => x.id === 'project-model'), false, '分区目录已退役');
});

test('D-22 配套 模型目录：真读数（上下文/能力/单价/Key 来源）；空态与错误不伪装', () => {
  const html = render({
    section: 'providers',
    modelCatalog: [
      {
        provider: 'deepseek',
        providerLabel: 'DeepSeek',
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        input: ['text'],
        reasoning: true,
        cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
        keyConfigured: true,
        keySource: 'file',
      },
    ],
    modelCatalogLoading: false,
    modelCatalogError: null,
    onReloadModelCatalog: () => undefined,
  });
  assert.match(html, /data-testid="settings-model-catalog-row"[^>]*data-provider="deepseek"[^>]*data-model="deepseek-v4-pro"/);
  assert.match(html, /DeepSeek V4 Pro/);
  assert.match(html, /1M/, '上下文读数');
  assert.match(html, /入 \$1\.32 · 出 \$3\.96/, '单价 USD/1M');
  assert.match(html, /已配置（本机）/, 'Key 来源');
  assert.match(html, /text · 思考/, '能力标签');

  const empty = render({ section: 'providers', modelCatalog: [], modelCatalogLoading: false });
  assert.match(empty, /data-testid="settings-model-catalog-empty"/);
  const loading = render({ section: 'providers', modelCatalog: null, modelCatalogLoading: true });
  assert.match(loading, /data-testid="settings-model-catalog-loading"/);
  const failed = render({ section: 'providers', modelCatalog: null, modelCatalogError: 'SDK 不可用' });
  assert.match(failed, /data-testid="settings-model-catalog-error"/);
  assert.match(failed, /SDK 不可用/);
});

test('D-22 配套 添加供应商：目录未加载时按钮 disabled（不假装可选）；有目录时可用', () => {
  const inert = render({ section: 'providers', catalogProviders: null });
  assert.match(openTag(inert, 'settings-add-provider'), /disabled/, '无目录 ⇒ 添加供应商 disabled');
  const ready = render({
    section: 'providers',
    catalogProviders: [
      { provider: 'google', providerLabel: 'Google', modelCount: 3, keyConfigured: false, keySource: null },
    ],
    onAddProviderKey: async () => ({ ok: true }),
  });
  assert.doesNotMatch(openTag(ready, 'settings-add-provider'), /disabled/, '有目录＋接线 ⇒ 可点');
  assert.equal(countTestId(ready, 'settings-add-provider-dialog'), 0, '弹窗未打开时不渲染');
});

test('设置页 · 通用主题：两态滑动开关（老板 2026-10-28 裁定），system 时提示跟随系统', () => {
  const calls: string[] = [];
  const html = render({ section: 'general', theme: 'dark', onThemeChange: (theme) => calls.push(theme) });
  assert.match(html, /data-testid="settings-general"/);
  // 下拉已退役，改为 role=switch 的日/夜开关
  assert.doesNotMatch(html, /settings-theme-select/);
  assert.match(html, /data-testid="settings-theme-switch"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /data-dark="true"/, 'dark 主题下开关在夜间位');
  // 未设置（system）→ 显示「跟随系统」小字提示
  const sys = render({ section: 'general', theme: 'system', onThemeChange: (theme) => calls.push(theme) });
  assert.match(sys, /data-testid="settings-theme-following"/);
  assert.equal(calls.length, 0, '静态渲染不触发回调');
});

test('R2-3 设置页 · 模型分区：未设置 → 显式「用本机配置」（不臆造）；有值 → 回显', () => {
  let html = render();
  assert.ok(html.includes('data-testid="settings-model-input"'), '输入框在场');
  assert.ok(html.includes('—（未设置，用本机配置）'), '未设置必须显式标注（不写假值）');
  assert.ok(!html.includes('deepseek-flash'), '未设置时不得凭空出现模型名');

  html = render({ model: 'deepseek/deepseek-flash' });
  assert.ok(html.includes('deepseek/deepseek-flash'), '现值必须回显（「当前生效」行）');

  html = render({ loading: true, model: null });
  assert.ok(html.includes('读取中…'), '加载中显式（不静默展示旧值/假值）');
});

test('N5 设置页 · role_map 行：在场；未设置显式标注（不臆造）；有值回显 JSON；缺 handler → 保存 disabled', () => {
  let html = render();
  assert.ok(html.includes('data-testid="settings-role-map-input"'), 'role_map 文本域在场');
  assert.ok(html.includes('—（未设置：全部走默认档）'), '未设置必须显式标注（不写假档位）');
  assert.ok(!openTag(html, 'settings-role-map-save').includes('disabled'), '容器接线在（BASE 提供 handler）→ 保存可点');

  html = render({ roleMap: { employee: { model: 'flash-x', thinking: 'low' } } });
  assert.ok(html.includes('flash-x'), '现值必须回显（「当前生效」行 JSON）');

  html = render({ onSaveRoleMap: undefined });
  assert.ok(openTag(html, 'settings-role-map-save').includes('disabled'), '缺 handler ⇒ 保存 disabled（不假装可点）');
});

test('N5 余账 设置页 · fallback_chain 行：在场；未设置显式标注（不降级）；有值回显 JSON；缺 handler → 保存 disabled', () => {
  let html = render();
  assert.ok(html.includes('data-testid="settings-fallback-chain-input"'), 'fallback_chain 文本域在场');
  assert.ok(html.includes('—（未设置：不降级）'), '未设置必须显式标注（不写假链）');
  assert.ok(!openTag(html, 'settings-fallback-chain-save').includes('disabled'), '容器接线在（BASE 提供 handler）→ 保存可点');

  html = render({ fallbackChain: ['deepseek/deepseek-flash'] });
  assert.ok(html.includes('deepseek/deepseek-flash'), '现值必须回显（「当前生效」行 JSON）');

  html = render({ onSaveFallbackChain: undefined });
  assert.ok(openTag(html, 'settings-fallback-chain-save').includes('disabled'), '缺 handler ⇒ 保存 disabled（不假装可点）');
});

test('R2-3＋D-5 ③ 设置页 · 项目分区（默认徽标 / 非默认给「设为默认」/ 已归档如实标注；归档按钮已移出本页）', () => {
  const html = render({
    section: 'projects',
    defaultProjectId: 11,
    projects: [
      project({ id: 11, name: '记账系统', alias: '记账', rootDir: 'D:/repo/a' }),
      project({ id: 12, name: '官网', rootDir: 'D:/repo/b' }),
      project({ id: 13, name: '旧项目', rootDir: 'D:/repo/c', archived: 1, archivedAt: 2 }),
    ],
  });
  assert.equal(countTestId(html, 'settings-project-row'), 3, '三行都在（含已归档，如实列出）');
  assert.equal(countTestId(html, 'settings-project-default-badge'), 1, '默认项目恰好 1 个徽标');
  assert.equal(countTestId(html, 'settings-project-set-default'), 1, '非默认的未归档项目恰好 1 个「设为默认」');
  assert.equal(countTestId(html, 'settings-project-archive'), 0, 'D-5 ③：归档按钮已移出设置页（唯一入口＝项目概览）');
  assert.ok(html.includes('项目概览'), '分区说明指路项目概览（项目级操作的家）');
  assert.ok(html.includes('已归档'), '归档项目如实标注（不隐藏、不假装可用）');

  const empty = render({ section: 'projects' });
  assert.ok(empty.includes('data-testid="settings-projects-empty"'), '空态显式（不伪装有数据）');
});

test('C4 公司日预算：未设显式「不限制」（不写假 0）；有值回显；保存入口在场', () => {
  let html = render({ section: 'models' });
  assert.match(html, /data-testid="settings-company-budget-input"/);
  assert.match(html, /未设置（不限制；不写假 0）/);
  html = render({ section: 'models', companyDailyBudget: 5, companyDailyBudgetDraft: '5', onSaveCompanyDailyBudget: () => undefined });
  assert.match(html, /data-testid="settings-company-budget-effective"[^>]*>\$5\.00\/日/);
  assert.ok((KNOWN_SETTINGS_KEYS as readonly string[]).includes('budget.companyDailyUsd'));
});

test('D-5 ② 设置页 · 员工分区＝指针：明说管理面在公司大厅 ＋「去公司大厅」真跳转；缺省 handler → disabled', () => {
  const html = render({ section: 'employees' });
  assert.ok(html.includes('data-testid="settings-employees"'), '员工分区有真内容（不是占位）');
  assert.ok(html.includes('公司大厅'), '指路文案指明管理面所在地');
  assert.ok(html.includes('「配置 ▸」'), '指向工位配置入口（人设/偏好/技能；2026-10-16 设置批文案改后对齐——原断言「员工工位」已不在真源）');
  assert.ok(html.includes('未实现'), '招募/编辑如实标注未实现（不臆造能力）');
  const tag = openTag(html, 'settings-go-hall');
  assert.equal(tag.includes('disabled'), false, '有 handler → 可点');

  const inert = openTag(render({ section: 'employees', onGoHall: undefined }), 'settings-go-hall');
  assert.equal(inert.includes('disabled'), true, '缺省 handler → disabled（不假装可点）');
});

test('R2-3 设置页 · 关于：只说真话（本地优先三条；版本/许可标注未实现）', () => {
  const html = render({ section: 'about' });
  assert.ok(html.includes('数据不上传'), '本地优先事实在场');
  assert.ok(html.includes('暂未开放'), '版本/许可等如实标注暂未开放（不臆造版本号）');
});

// ── 件 A · 调度与费率可配面（advanced 分区）──────────────────────────────────

test('件 A 设置页 · 高级：字段全列（=字段表）＋ 每个未设置显式「当前：默认」＋ 有值回显 ＋ 加载中显式', () => {
  const html = render({ section: 'tuning' });
  assert.equal(countTestId(html, 'settings-tuning-row'), TUNING_FIELDS.length, '行数＝字段表长度（不偷偷少列）');
  for (const f of TUNING_FIELDS) {
    assert.ok(html.includes(`data-testid="settings-tuning-input-${f.key}"`), `${f.key} 缺输入框`);
    assert.ok(html.includes(`data-testid="settings-tuning-save-${f.key}"`), `${f.key} 缺保存按钮`);
    const effective = cellText(html, `settings-tuning-effective-${f.key}`) ?? '';
    const expected = f.fallback === '未配置' ? '当前：未设置' : '当前：默认';
    assert.ok(
      effective.includes(expected),
      `${f.key} 未设置必须显式标「${expected}」（不写假值；实际：${effective}）`,
    );
  }

  const withValue = render({ section: 'tuning', tuningValues: { 'concurrency.maxPerTask': 2 } });
  assert.equal(cellText(withValue, 'settings-tuning-effective-concurrency.maxPerTask'), '当前：2', '现值必须回显（生效行）');

  const loading = render({ section: 'tuning', loading: true });
  assert.equal(cellText(loading, 'settings-tuning-effective-scheduler.maxActiveTasks'), '读取中…', '加载中显式（不静默展示旧值/假值）');
});

test('顺带件 设置页 · 通知：字段全列（＝字段表）＋ 未设置显「当前：未设置」＋ 有值回显 ＋ 机制说明在场', () => {
  const html = render({ section: 'notify' });
  assert.equal(countTestId(html, 'settings-notify-row'), NOTIFY_FIELDS.length, '行数＝字段表长度（不偷偷少列）');
  for (const f of NOTIFY_FIELDS) {
    assert.ok(html.includes(`data-testid="settings-notify-input-${f.key}"`), `${f.key} 缺输入框`);
    assert.ok(html.includes(`data-testid="settings-notify-save-${f.key}"`), `${f.key} 缺保存按钮`);
    const effective = cellText(html, `settings-notify-effective-${f.key}`) ?? '';
    const expected = f.fallback === '未配置' ? '当前：未设置' : '当前：默认';
    assert.ok(
      effective.includes(expected),
      `${f.key} 未设置必须显式标「${expected}」（不写假值；实际：${effective}）`,
    );
  }
  assert.ok(html.includes('静默时段') && html.includes('无需重启'), '机制口径在场（静默窗/日报；写下即生效）');
  assert.ok(html.includes('暂未开放'), '未实现项（桌面通知/聚合窗口/按项目覆盖）如实标注');
  assert.match(html, /data-testid="settings-notify-test"[^>]*disabled/, '缺 handler ⇒ 测试通知按钮 disabled（不假装可点）');
  assert.match(
    render({ section: 'notify', onSendTestNotification: () => {} }),
    /data-testid="settings-notify-test"(?![^>]*disabled)/,
    '接线在场 ⇒ 测试通知可点',
  );

  const withValue = render({ section: 'notify', tuningValues: { 'notify.digestAtMinutes': 600 } });
  assert.equal(cellText(withValue, 'settings-notify-effective-notify.digestAtMinutes'), '当前：600', '现值必须回显');
});

test('顺带件 守卫：通知字段键 ↔ 主进程白名单 —— 两侧不漂移（缺一即红）', () => {
  const uiKeys = NOTIFY_FIELDS.map((f) => f.key);
  assert.equal(new Set(uiKeys).size, uiKeys.length, '字段键不得重复');
  for (const k of uiKeys) {
    assert.ok((KNOWN_SETTINGS_KEYS as readonly string[]).includes(k), `${k} 不在主进程白名单（UI 会写出"悬空键"）`);
  }
  const notifyKeys = (KNOWN_SETTINGS_KEYS as readonly string[]).filter((k) => k.startsWith('notify.'));
  assert.deepEqual([...notifyKeys].sort(), [...uiKeys].sort(), '白名单里的通知族键必须全部有 UI 字段（防"加了键没人能改"）');
});

test('M3-N-3 技能分区：列表/来源/启停；内置不可删；本地行可删；安装入口可点', () => {
  const html = render({
    section: 'skills',
    skills: [
      { id: 1, name: 'fact-check', description: '核查', source: 'builtin', path: 'C:/s/1/SKILL.md', version: '1', enabled: 1 },
      { id: 2, name: 'team-style', description: '风格', source: 'local', path: 'C:/s/2/SKILL.md', version: null, enabled: 0 },
    ],
    skillsLoading: false,
    onInstallSkillFolder: () => undefined,
    onInstallSkillUrl: () => undefined,
    onToggleSkill: () => undefined,
    onRemoveSkill: () => undefined,
  });
  assert.match(html, /data-testid="settings-skill-row"[^>]*data-skill-name="fact-check"/);
  assert.match(html, /data-testid="settings-skill-row"[^>]*data-skill-name="team-style"/);
  assert.match(html, /data-testid="settings-skill-enabled-1"[^>]*checked/);
  assert.doesNotMatch(html, /data-testid="settings-skill-enabled-2"[^>]*checked/, '停用项不勾');
  assert.match(html, /data-testid="settings-skill-builtin-1"/);
  assert.match(html, /data-testid="settings-skill-remove-2"/);
  assert.doesNotMatch(html, /data-testid="settings-skill-remove-1"/, '内置不可删');
  assert.match(html, /data-testid="settings-skill-install-folder"[^>]*>从文件夹安装/);
  assert.match(html, /data-testid="settings-skill-install-url"/);
});

test('M3-N-4 MCP 分区：注册表单/列表/启停/删除/脱敏 env/分配矩阵', () => {
  const html = render({
    section: 'mcp',
    mcpServers: [
      {
        id: 1,
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        url: null,
        envKeys: ['TOKEN'],
        exposure: 'direct',
        hasExternalActions: false,
        enabled: true,
        createdAt: 1,
      },
    ],
    employees: [{ id: 1, name: '实施', role: 'engineer', mcpRefs: ['filesystem'] }],
    mcpLoading: false,
    onSaveMcpServer: async () => ({ ok: true }),
    onToggleMcp: () => undefined,
    onRemoveMcp: () => undefined,
  });
  assert.match(html, /data-testid="settings-mcp"/);
  assert.match(html, /data-testid="settings-mcp-name"/);
  assert.match(html, /data-testid="settings-mcp-command"/);
  assert.match(html, /data-testid="settings-mcp-env"/);
  assert.match(html, /data-testid="settings-mcp-row"[^>]*data-mcp-name="filesystem"/);
  assert.match(html, /env:TOKEN/);
  assert.doesNotMatch(html, /super-secret/, 'env 值不回显');
  assert.match(html, /data-testid="settings-mcp-enabled-1"[^>]*checked/);
  assert.match(html, /data-testid="settings-mcp-remove-1"/);
  assert.match(html, /data-testid="settings-mcp-matrix"/);
  assert.match(html, /data-assigned="true"/);
});

test('件 A 守卫：设置页字段键 ↔ 主进程白名单 —— 两侧不漂移（缺一即红）', () => {
  const uiKeys = TUNING_FIELDS.map((f) => f.key);
  assert.equal(new Set(uiKeys).size, uiKeys.length, '字段键不得重复');
  for (const k of uiKeys) {
    assert.ok((KNOWN_SETTINGS_KEYS as readonly string[]).includes(k), `${k} 不在主进程白名单（UI 会写出"悬空键"）`);
  }
  const tuningKeys = (KNOWN_SETTINGS_KEYS as readonly string[]).filter(
    (k) => k.startsWith('scheduler.') || k.startsWith('concurrency.') || k.startsWith('rate.'),
  );
  assert.deepEqual(
    [...tuningKeys].sort(),
    [...uiKeys].sort(),
    '白名单里的调度/费率族键必须全部有 UI 字段（防"加了键没人能改"）',
  );
});

test('官方 B：need_verifycode 才显示验证码输入；空值不可提交', () => {
  const status = {
    channel: 'im:wechat' as const,
    state: 'login_pending' as const,
    qr: 'data:image/png;base64,AA==',
    qrStatus: 'need_verifycode',
    ownerId: null,
    accountId: null,
    lastError: null,
    pendingOutbox: 0,
  };
  const html = render({ section: 'im', imStatus: status, onImVerifyCode: () => undefined });
  assert.match(html, /data-testid="settings-im-verify-code"/);
  assert.match(html, /data-testid="settings-im-verify-input"/);
  assert.match(html, /手机微信显示的数字/);
  assert.match(openTag(html, 'settings-im-verify-submit'), /disabled/);

  const waiting = render({
    section: 'im',
    imStatus: { ...status, qrStatus: 'wait' },
    onImVerifyCode: () => undefined,
  });
  assert.equal(waiting.includes('data-testid="settings-im-verify-code"'), false);
});

test('RM-9：绑定/解绑回执可见，与红色错误分离；不在 IM 区时不渲染', () => {
  const status = {
    channel: 'im:wechat' as const,
    state: 'login_required' as const,
    qr: null,
    qrStatus: null,
    ownerId: null,
    accountId: null,
    lastError: null,
    pendingOutbox: 0,
  };
  const ok = render({ section: 'im', imStatus: status, imNotice: '已解绑微信：本地凭证已清除。', imError: null });
  assert.match(ok, /data-testid="settings-im-notice"/);
  assert.match(ok, /已解绑微信/);
  assert.equal(ok.includes('data-testid="settings-im-error"'), false);

  const err = render({ section: 'im', imStatus: status, imNotice: null, imError: '解绑失败：通道未装配' });
  assert.match(err, /data-testid="settings-im-error"/);
  assert.equal(err.includes('data-testid="settings-im-notice"'), false);
});

// 2026-11-03 D4-N1 回归守卫：拍平后 section 恒为组 id，容器懒加载必须按 settingsGroupOf 归组判断；
// 若再出现对旧分区 id（'models'/'im'）的字面比较，目录与 IM 会假状态（不摆假状态红线）。
test('设置容器懒加载：按组 id 判断（settingsGroupOf），不得比较旧分区 id 字面量', () => {
  const src = readFileSync('src/renderer/components/SettingsView.tsx', 'utf8');
  assert.match(src, /settingsGroupOf\(section\)\?\.id !== 'model'/, '模型目录懒加载按组判断');
  assert.match(src, /settingsGroupOf\(section\)\?\.id !== 'integrations'/, 'IM 状态懒加载按组判断');
  assert.doesNotMatch(src, /section !== 'models'/, '旧分区 id 比较已退役');
  assert.doesNotMatch(src, /section !== 'im'/, '旧分区 id 比较已退役');
});

// 2026-11-04 T5（记账债清偿）：容器接线守卫——section/expandedEmployeeId 持久化到
// settingsView proxy（跨视图切换保持）；这是容器级自动化能做到的最大覆盖（无 DOM 环境）。
test('设置容器持久化接线：section/expandedEmployeeId 写 proxy；深链归组', () => {
  const src = readFileSync('src/renderer/components/SettingsView.tsx', 'utf8');
  assert.match(src, /settingsView\.section = next/, '切组写 proxy');
  assert.match(src, /settingsView\.expandedEmployeeId = id/, '展开员工写 proxy');
  assert.match(src, /settingsGroupOf\(initialSection\)/, '深链 initialSection 归组');
  assert.match(src, /settingsView\.section = g\.id/, '归组结果写 proxy');
});

test('自动更新（关于区）：状态如实显示；检查按钮按 canCheck 禁用；仅 canInstall 时出现重启安装', () => {
  const downloading = render({
    section: 'about',
    onCheckUpdate: () => undefined,
    updateStatus: {
      phase: 'downloading',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      percent: 42,
      message: '正在下载新版本… 42%',
      canCheck: false,
      canInstall: false,
    },
  });
  assert.match(downloading, /data-testid="settings-update-status"/);
  assert.match(downloading, /正在下载新版本… 42%/);
  assert.match(downloading, /data-testid="settings-update-check"[^>]*disabled/);
  assert.ok(!downloading.includes('settings-update-install'), '未下载完成时不得出现「重启安装」');

  const downloaded = render({
    section: 'about',
    onCheckUpdate: () => undefined,
    onInstallUpdate: () => undefined,
    updateStatus: {
      phase: 'downloaded',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      percent: 100,
      message: '新版本 v0.2.0 已下载，重启后安装',
      canCheck: true,
      canInstall: true,
    },
  });
  assert.match(downloaded, /data-testid="settings-update-install"/);
  assert.match(downloaded, /重启安装/);

  const portable = render({
    section: 'about',
    updateStatus: {
      phase: 'disabled',
      currentVersion: '0.1.0',
      message: '免安装版请手动下载新版本',
      canCheck: false,
      canInstall: false,
    },
  });
  assert.match(portable, /免安装版请手动下载新版本/);
  assert.ok(!portable.includes('settings-update-install'));
});

// 项目页设置分组（2026-11-09）：项目页「设置」页签分组——分段导航 + 只做显示过滤（卡片 DOM 不动），
// 默认只开「模型」；没有「定时」卡就不摆空组（不造假入口）。源码级守卫（组件渲染依赖 store 上下文）。
// 运行/产物页签（2026-11-10）：「记忆」从设置组迁出为独立页签 ⇒ 设置组 8 → 7。
test('项目页设置分组：项目设置 7 组导航在场、默认模型组、卡片带 data-group', () => {
  const src = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.match(src, /data-testid="project-settings-groupnav"/, '分组导航在场');
  assert.match(src, /useState<[^>]*'model'[^>]*>\('model'\)/, '默认组＝model');
  for (const g of ['model', 'staffing', 'permission', 'skills', 'docs', 'time', 'advanced']) {
    assert.ok(src.includes(`data-group="${g}"`), `卡片缺 data-group="${g}"`);
  }
  assert.ok(!src.includes(`data-group="memory"`), '记忆不再属于设置组（已迁独立页签）');
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(css, /data-active-group="model"[^\n]*\[data-group\]:not\(\[data-group="model"\]\)/, 'CSS 过滤规则在场');
});

// 运行/产物页签（2026-11-10）：项目页新增 运行/产物/记忆 页签；三格与两页签的 testid 契约。
test('运行/产物页签：页面五页签＋三格＋运行/产物/记忆容器在场', () => {
  const src = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  for (const id of ['project-tab-tasks', 'project-tab-runs', 'project-tab-artifacts', 'project-tab-memory', 'project-tab-settings']) {
    assert.ok(src.includes(`data-testid="${id}"`), `缺页签 ${id}`);
  }
  for (const id of ['project-now', 'project-now-progress', 'project-now-pending', 'project-runs', 'project-runs-list', 'project-artifacts', 'project-artifacts-list', 'project-memory-tab']) {
    assert.ok(src.includes(`data-testid="${id}"`), `缺容器 ${id}`);
  }
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  assert.match(store, /export async function loadProjectRuns/, '运行/产物拼装走 store（懒加载＋缓存）');
  assert.match(store, /projectRuns\.signature === signature/, '签名不变不重拉（缓存口径）');
  assert.match(store, /projectRuns\.details = \[\]/, '切项目/失败路径清空旧详情（不串项目）');
  assert.match(store, /projectRunsToken \+= 1/, '失败路径作废在飞的旧请求');
});

//  S2b（2026-11-09）：归档页集中承载归档项目的恢复/导出/删除（项目页仍保留上下文入口）。
test('归档页复核：归档页有「归档项目」区；恢复/导出/删除三键＋删除需二次确认', () => {
  const src = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
  assert.match(src, /data-testid="archive-projects"/, '归档项目区在场');
  for (const id of ['archive-project-restore', 'archive-project-export', 'archive-project-delete']) {
    assert.ok(src.includes(`data-testid="${id}"`), `缺 ${id}`);
  }
  assert.match(src, /data-testid="archive-project-delete-confirm"/, '删除需二次确认（不一点就删）');
  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.match(shell, /archivedProjects=\{archivedProjects/, 'AppShell 已把归档项目列表接进归档页');
  assert.match(shell, /onRestoreProject=\{\(projectId\) => void restoreProject/, '恢复接线');
});

//   复核（2026-11-09）：设置页「项目模型」随退役时把唯一编辑面一起删了，只剩只读摘要＋
// 指向不存在的入口。真活搬回项目页「设置·模型」：策略/默认模型/允许清单/默认预算/合并目标分支。
test('项目页设置复核 P1：项目页「设置·模型」有编辑面，且不再指向已退役的设置入口', () => {
  const src = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  for (const id of [
    'project-model-edit',
    'project-model-policy',
    'project-model-default',
    'project-model-allowed',
    'project-budget',
    'project-budget-save',
    'project-target-branch',
    'project-target-branch-save',
    'project-model-save',
  ]) {
    assert.ok(src.includes(`data-testid="${id}"`), `缺 ${id}`);
  }
  assert.match(src, /saveProjectModelPolicy\(/, '策略保存走真 IPC 封装');
  assert.match(src, /saveProjectDefaultBudget\(/, '默认预算保存走真 IPC 封装');
  assert.match(src, /saveProjectTargetBranch\(/, '合并目标分支保存走真 IPC 封装');
  assert.ok(!src.includes('设置 → 模型与员工 → 项目模型'), '不再指向已退役的设置入口');
});

//   复核（2026-11-09）：后端只允许删**空**归档项目；UI 对非空项目必须显式禁用并说明，
// 恢复/导出/删除的失败要显示出来（此前静默写进 projectActions）。
test('归档页复核 复核 P2：非空归档项目禁删＋动作回执可见', () => {
  const src = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
  assert.match(src, /disabled=\{p\.taskCount > 0\}/, '非空项目删除键禁用');
  assert.match(src, /archive-project-action-error/, '动作失败可见');
  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.match(shell, /actionError=\{projectsSnap\.error\}/, 'AppShell 把 projectActions.error 接进归档页');
});

// 复核（2026-11-10，独立独立复核冷启动发现）：上次停在归档页时，restoreSession 只走 loadTasks()
//（不含归档行）也不拉项目 ⇒ 假空态＋删除门失效。恢复路径必须与 showArchive 同口径。
test('归档页复核 复核 P1：恢复视图=归档时补拉项目列表与归档行', () => {
  const store = readFileSync('src/renderer/store.ts', 'utf8');
  const start = store.indexOf('export async function restoreSession');
  const end = store.indexOf('export function showNotes', start);
  assert.ok(start >= 0 && end > start, 'restoreSession 段落在场');
  const body = store.slice(start, end);
  assert.match(body, /session\.view === 'archive'/, '按归档视图分支');
  assert.match(body, /loadProjectsForOverview\(\)/, '补拉项目列表（含已归档）');
  assert.match(body, /loadTasks\(\{ includeArchived: true \}\)/, '补拉归档任务行');
});
