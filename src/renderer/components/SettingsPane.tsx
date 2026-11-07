import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import type { CustomProviderDef } from '../../core/custom-provider.js';
import type { ImStatusView, McpServerDTO, ModelCatalogEntryDTO, ProviderCatalogEntryDTO, ProviderStatusDTO, SkillDTO } from '../types.js';
import { PermissionsPanel } from './PermissionsPanel.js';

// ─────────────────────────────────────────────────────────────────────────────
// R2-3 第二批 · 设置页**纯组件**（`UI §11`）——props 驱动、**不依赖 store**（可 node 测）。
//   容器（store 接线）＝`SettingsView.tsx`；**如实口径**：导航 4 组（2026-10-23 简化），组页只露摘要卡；
//   组内详情仍覆盖原 11 个分区（「权限」已接只读审计/撤销；其余未实现项仍显式标「未实现」）。
//   件 A：`advanced` 分区＝**调度与费率可配面**（6 个数字键；键真源＝`src/main/db/settings.ts`
//   的 `KNOWN_SETTINGS_KEYS`，本文件只给标签/提示——`test/settings-view.test.ts` 断言两侧不漂移）。
// ─────────────────────────────────────────────────────────────────────────────

const IM_STATE_LABEL: Readonly<Record<string, string>> = {
  disabled: '未启用',
  login_required: '待扫码绑定',
  login_pending: '等待扫码',
  connecting: '连接中',
  connected: '已连接',
  error: '错误',
};

export const MODEL_SETTING_KEY = 'models.default';
export const ROLE_MAP_SETTING_KEY = 'models.role_map';
export const COMPANY_DAILY_BUDGET_KEY = 'budget.companyDailyUsd';
export const DEFAULT_PROJECT_SETTING_KEY = 'projects.default_id';

/** 件 A：设置页「高级」的调度与费率字段（键必须 ∈ `KNOWN_SETTINGS_KEYS`；`fallback` ＝ Engine 缺省，仅供"回落缺省"展示）。 */
export interface TuningFieldDef {
  key: string;
  label: string;
  hint: string;
  fallback: string;
}

export const TUNING_FIELDS: readonly TuningFieldDef[] = [
  { key: 'scheduler.maxActiveTasks', label: '同时跑几个任务', hint: '全局最多同时执行的任务数（默认 3）', fallback: '3' },
  { key: 'scheduler.agingMinutes', label: '等得越久越靠前（分钟）', hint: '每多等 N 分钟，排队优先级 +1（默认 30）', fallback: '30' },
  { key: 'scheduler.agingCap', label: '等待加分上限', hint: '最多加多少分，避免老任务压过一切（默认 5）', fallback: '5' },
  { key: 'concurrency.maxPerTask', label: '单任务同时做几件', hint: '同一任务内同时在跑的 work item 上限（默认 3）', fallback: '3' },
  { key: 'concurrency.maxCompany', label: '全公司同时做几件', hint: '全公司同时在跑的 work item 上限（默认 6）', fallback: '6' },
  { key: 'rate.softUsdPerHour', label: '花钱变快时降档（$/小时）', hint: '达到这条线先降省钱档；排队线＝这条 ×1.5（默认 3）', fallback: '3' },
];

/**
 * 顺带件（M2 未排期「设置·通知面板」）：通知分区字段——**键真源＝主进程 `KNOWN_SETTINGS_KEYS`**；
 * 机制已交付（静默窗/日报，`notify/policy.ts`/`digest.ts`）；本面板只做**可配面**（0–1439 分钟数）。
 */
export const NOTIFY_FIELDS: readonly TuningFieldDef[] = [
  { key: 'notify.quietStartMinutes', label: '静默开始', hint: '分钟数（如 1320＝22:00）；非紧急夜里不弹、改走日报', fallback: '未配置' },
  { key: 'notify.quietEndMinutes', label: '静默结束', hint: '分钟数（如 480＝08:00；支持跨午夜；与开始相同＝不静默）', fallback: '未配置' },
  { key: 'notify.digestAtMinutes', label: '日报时间', hint: '分钟数（如 540＝09:00；写完即生效，无需重启）', fallback: '540' },
];

const PANE: CSSProperties = { padding: '20px', display: 'grid', gap: 16, alignContent: 'start', overflowY: 'auto' };
const NAV_ITEM: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px' };
const ROW: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--panel-2)', padding: '8px 0' };
const MUTED: CSSProperties = { color: 'var(--muted, #888)', fontSize: 'var(--text-note)', lineHeight: 1.6 };
const ERR: CSSProperties = { color: 'var(--danger)', fontSize: 'var(--text-note)', lineHeight: 1.6 };

/**
 * 数字设置字段行（件 A「高级」与顺带件「通知」**共用**，防两套镜像标记）：
 * `prefix` 决定 testid（`settings-tuning` / `settings-notify`）；props 复用同一份 tuning 契约。
 */
function NumericSettingRow({ props, field, prefix }: { props: SettingsPaneProps; field: TuningFieldDef; prefix: string }): ReactElement {
  // 脏值标记（2026-10-16 设置批）：草稿 ≠ 现值 ⇒ accent 描边 ＋「已改待存」（写下前看得见）。
  const current = props.tuningValues[field.key];
  const dirty = (props.tuningDrafts[field.key] ?? '') !== (current == null ? '' : String(current));
  return (
    <div style={ROW} data-testid={`${prefix}-row`} data-key={field.key}>
      <span style={{ flex: 1 }}>
        {field.label} <span style={MUTED}>{field.hint}</span>
      </span>
      <input
        className="settings-view__input"
        data-testid={`${prefix}-input-${field.key}`}
        data-dirty={dirty ? 'true' : 'false'}
        placeholder="留空＝用默认"
        value={props.tuningDrafts[field.key] ?? ''}
        onChange={(e) => props.onTuningDraftChange(field.key, e.target.value)}
        style={{ width: 88 }}
      />
      <button type="button" data-testid={`${prefix}-save-${field.key}`} onClick={() => props.onSaveTuning(field.key)}>
        保存
      </button>
      <span data-testid={`${prefix}-effective-${field.key}`} style={MUTED}>
        {props.loading
          ? '读取中…'
          : props.tuningValues[field.key] == null
            ? field.fallback === '未配置'
              ? '当前：未设置'
              : '当前：默认'
            : `当前：${props.tuningValues[field.key]}`}
      </span>
      {dirty ? (
        <span className="settings-dirty" data-testid={`${prefix}-dirty-${field.key}`}>
          已改待存
        </span>
      ) : null}
    </div>
  );
}

export interface SettingsSectionDef {
  id: string;
  label: string;
  implemented: boolean;
}

/** `UI §11` 的 11 个分区（顺序与文档一致；未实现的列全、但**不给假控件**）。 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'general', label: '外观', implemented: true },
  { id: 'models', label: '模型与预算', implemented: true },
  { id: 'providers', label: '供应商', implemented: true },
  { id: 'project-model', label: '项目模型', implemented: true },
  { id: 'employees', label: '员工', implemented: true },
  { id: 'projects', label: '项目', implemented: true },
  { id: 'permissions', label: '权限', implemented: true },
  { id: 'im', label: '通道（IM）', implemented: true },
  { id: 'notify', label: '通知', implemented: true },
  { id: 'skills', label: '技能', implemented: true },
  { id: 'mcp', label: 'MCP', implemented: true },
  { id: 'tuning', label: '调度与费率', implemented: true },
  { id: 'retention', label: '数据保留', implemented: true },
  { id: 'about', label: '关于', implemented: true },
];

export type SettingsGroupId =
  | 'look' | 'notify' | 'model' | 'employees' | 'projects' | 'integrations' | 'ops' | 'data';

export interface SettingsGroupDef {
  id: SettingsGroupId;
  label: string;
  /** 该直达项落地上要铺开的真实分区面板（一页滚动，点控件即改）。 */
  sections: readonly string[];
}

/**
 * 2026-11-03 老板拍板「细分直达」：设置导航＝8 个直达项，点一下就落在真实控件上；
 * 卡片摘要层 / 「更改」/ 「返回」全部退役（原来是 组→卡「更改」→控件 三步，层级太深）。
 */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'look', label: '外观', sections: ['general'] },
  { id: 'notify', label: '通知', sections: ['notify'] },
  { id: 'model', label: '供应商与模型', sections: ['providers', 'models', 'project-model'] },
  { id: 'employees', label: '员工', sections: ['employees'] },
  { id: 'projects', label: '项目', sections: ['projects'] },
  { id: 'integrations', label: '通道与技能', sections: ['im', 'skills', 'mcp'] },
  { id: 'ops', label: '权限与调度', sections: ['permissions', 'tuning'] },
  { id: 'data', label: '数据与关于', sections: ['retention', 'about'] },
];

/** 旧组 id → 新直达组（外部深链兜底；2026-10-23 的 4 组已拍平退役）。 */
const LEGACY_GROUP_ALIAS: Readonly<Record<string, SettingsGroupId>> = {
  common: 'look',
  'model-staff': 'model',
  'project-integration': 'integrations',
  'advanced-tools': 'ops',
};

export function settingsGroupOf(section: string): SettingsGroupDef | undefined {
  const id = LEGACY_GROUP_ALIAS[section] ?? section;
  return SETTINGS_GROUPS.find((g) => g.id === id || g.sections.includes(id));
}

import { isFollowingSystem, themeSwitchChecked, themeSwitchTarget } from './themeSwitch.js';
import { SplitLayout } from './SplitLayout.js';
import { EmployeePane } from './EmployeePane.js';

export interface SettingsPaneProps {
  section: string;
  onSectionChange: (id: string) => void;
  loading: boolean;
  error: string | null;
  /** 主题：跟随系统 / 浅色 / 夜间；切换立即生效（nativeTheme）。 */
  theme?: 'light' | 'dark' | 'system';
  /** 2026-10-29 P2（P-N05）：开机自启（下次启动写入系统登录项）。 */
  openAtLogin?: boolean;
  onToggleOpenAtLogin?: (enabled: boolean) => void;
  /** P-N05：应用信息（版本/数据目录；null＝主进程未注入）。 */
  appInfo?: { version: string; userDataDir: string } | null;
  /** 自动更新状态（2026-11-06；null＝尚未取到）。 */
  updateStatus?: {
    phase: string;
    currentVersion: string;
    availableVersion?: string;
    percent?: number;
    message: string;
    canCheck: boolean;
    canDownload?: boolean;
    canInstall: boolean;
  } | null;
  onCheckUpdate?: () => void;
  onDownloadUpdate?: () => void;
  onInstallUpdate?: () => void;
  onOpenDataDir?: () => void;
  /** 2026-11-03（逐页错误注入）：设置加载失败后的重试。 */
  onRetryLoad?: () => void;
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
  /** D-5 补位 ②：「员工」分区＝**指针**（真跳转公司大厅）；缺省 → 按钮 disabled（不假装可点）。 */
  onGoHall?: () => void;
  /** 2026-10-16（设置批）：「员工」分区**花名册**（`employee:list` 真数据；null＝读取中）；UG-11：含已停用（`active` 真值）。 */
  employees?: readonly { id: number; name: string; role: string; mcpRefs?: readonly string[]; active?: boolean }[] | null;
  /** 2026-11-03 老板反馈：员工配置内联展开（不再跳独立页）——当前展开的员工 id。 */
  expandedEmployeeId?: number | null;
  /** 内联配置的数据面（workstation 快照；随 expandedEmployeeId 装载）。 */
  workstation?: { data: unknown; loading: boolean; error: string | null } | null;
  /** 内联配置写面（同独立页 updateEmployee；缺省 ⇒ 保存 disabled，不假装可点）。 */
  onUpdateEmployeeDetail?: (patch: {
    persona?: string;
    model?: string | null;
    thinking?: string | null;
    skills?: Array<string | number>;
    mcps?: Array<string | number>;
    capabilityTier?: string;
    active?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** 花名册行「配置 ▸」→ 员工设置为（缺省 ⇒ disabled，不假装可点）。 */
  onOpenEmployee?: (id: number) => void;
  /** M2 尾：招募员工（打开招募对话框；缺省 ⇒ disabled）。 */
  onRecruit?: () => void;
  /** GAP7（M3-N-3）：技能库（含停用；null＝未加载）。 */
  skills?: readonly SkillDTO[] | null;
  skillsLoading?: boolean;
  skillsNotice?: string | null;
  skillsError?: string | null;
  onInstallSkillFolder?: () => void;
  onInstallSkillUrl?: (url: string) => void;
  onToggleSkill?: (id: number, enabled: boolean) => void;
  onRemoveSkill?: (id: number) => void;
  /** GAP6（M3-N-4）：MCP server 库（含停用；env 只到 key 名）。 */
  mcpServers?: readonly McpServerDTO[] | null;
  mcpLoading?: boolean;
  mcpNotice?: string | null;
  mcpError?: string | null;
  onSaveMcpServer?: (input: {
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
    exposure?: string;
    hasExternalActions?: boolean;
    enabled?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  onToggleMcp?: (id: number, enabled: boolean) => void;
  onRemoveMcp?: (id: number) => void;
  /** 2026-10-17 真机反馈：发送一次测试通知（系统通知＋托盘；缺省 ⇒ disabled）。 */
  onSendTestNotification?: () => void;
  /** M3：IM 通道状态（null＝未读取；本轮只做微信 1:1，不显示群/其他通道）。 */
  imStatus?: ImStatusView | null;
  imLoading?: boolean;
  imError?: string | null;
  /** RM-9：绑定/解绑/刷新成功后的可见回执（不静默）。 */
  imNotice?: string | null;
  onImBind?: () => void;
  /** 官方 B：手机微信要求数字验证码时提交。 */
  onImVerifyCode?: (code: string) => void;
  onImUnbind?: () => void;
  onImRefresh?: () => void;
  saved: string | null;
  /** `models.default` 现值（null = 未设置，用本机配置）。 */
  model: string | null;
  /** 设置·模型与供应商：本机 Key 状态（只含来源/掩码；null/缺省 = 未加载）。 */
  providers?: readonly ProviderStatusDTO[] | null;
  /** 每个供应商的 Key 输入草稿（受控；保存成功由容器清空）。 */
  providerDrafts?: Readonly<Record<string, string>>;
  onProviderDraftChange?: (provider: string, value: string) => void;
  onSaveProviderKey?: (provider: string) => void;
  onClearProviderKey?: (provider: string) => void;
  /** 输入框草稿（受控）。 */
  modelDraft: string;
  onModelDraftChange: (value: string) => void;
  onSaveModel: () => void;
  /** C4（M3）：公司级日预算（USD；null＝未设，不限制）。 */
  companyDailyBudget?: number | null;
  companyDailyBudgetDraft?: string;
  onCompanyDailyBudgetDraftChange?: (value: string) => void;
  onSaveCompanyDailyBudget?: () => void;
  /** N5：`models.role_map` 现值（原始 JSON 值；null = 未设置）。 */
  roleMap?: unknown;
  /** N5：role_map 草稿（JSON 文本；受控）。 */
  roleMapDraft?: string;
  onRoleMapDraftChange?: (value: string) => void;
  /** N5：保存 role_map（解析/校验失败由容器显式报错，不静默）；缺省 → 行不可用（disabled）。 */
  onSaveRoleMap?: () => void;
  /** N5 余账：`models.fallback_chain` 现值（字符串数组；null = 未设置）。 */
  fallbackChain?: unknown;
  /** N5 余账：fallback_chain 草稿（JSON 文本；受控）。 */
  fallbackChainDraft?: string;
  onFallbackChainDraftChange?: (value: string) => void;
  /** N5 余账：保存 fallback_chain（解析/校验失败由容器显式报错，不静默）；缺省 → 行不可用（disabled）。 */
  onSaveFallbackChain?: () => void;
  defaultProjectId: number | null;
  /** **只读最小视图**（valtio 快照是 DeepReadonly——props 按只读声明，避免深只读→可变的赋值错）。 */
  projects: readonly ProjectView[];
  onSetDefaultProject: (id: number) => void;
  /** D-22：保存项目模型策略（策略/默认模型/允许清单整体写）；缺省 → 保存键 disabled。 */
  onSaveProjectModelPolicy?: (input: {
    projectId: number;
    policy: 'fixed' | 'employee_first' | 'assistant';
    defaultModel: string | null;
    allowedModels: string[];
  }) => Promise<{ ok: boolean; error?: string }> | void;
  /** v19：保存项目默认任务预算（null＝不限）；缺省 → 保存键 disabled。 */
  onSaveProjectDefaultBudget?: (projectId: number, budgetTokens: number | null) => Promise<{ ok: boolean; error?: string }> | void;
  /** S13-G/D-N06：保存合并目标分支（null/空串 ⇒ 回到 main/master）。 */
  onSaveProjectTargetBranch?: (projectId: number, branch: string | null) => Promise<{ ok: boolean; error?: string }> | void;
  /** D-22 配套：只读模型目录（null/缺省＝未加载；空数组＝真的没有）。 */
  modelCatalog?: readonly ModelCatalogEntryDTO[] | null;
  modelCatalogLoading?: boolean;
  modelCatalogError?: string | null;
  onReloadModelCatalog?: () => void;
  /** 添加供应商：SDK 已支持的供应商目录（含未配置）。 */
  catalogProviders?: readonly ProviderCatalogEntryDTO[] | null;
  /** 添加供应商：保存 Key（成功/失败都回执；缺省 → 保存键 disabled）。 */
  onAddProviderKey?: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  /** D-22：自定义供应商（写 Pi models.json；Key 仍走本机 secrets）。 */
  customProviders?: readonly CustomProviderDef[] | null;
  onSaveCustomProvider?: (provider: CustomProviderDef, key?: string) => Promise<{ ok: boolean; error?: string }>;
  onRemoveCustomProvider?: (id: string) => void;
  onTestCustomProvider?: (id: string) => Promise<{ ok: boolean; message?: string; error?: string }>;
  /** 件 A：调度与费率现值（`null` = 未设置 → 显式「回落缺省」）；键＝`TUNING_FIELDS[*].key`。 */
  tuningValues: Readonly<Record<string, number | null>>;  /** 件 A：输入框草稿（受控；空串 = 清空 → 保存时发 null）。 */
  tuningDrafts: Readonly<Record<string, string>>;
  onTuningDraftChange: (key: string, value: string) => void;
  onSaveTuning: (key: string) => void;
  /** OPT-M4-1：接缝矩阵（项目级；null＝未接线/未加载）。 */
  seams?: {
    boundaries: readonly string[];
    rows: ReadonlyArray<{
      boundary: string;
      status: string;
      coverageRef: string | null;
      owner: string | null;
      milestone: string | null;
    }>;
    missing: readonly string[];
  } | null;
  /** B-4：设置·高级「数据保留」面板（容器注入；缺省不渲染）。 */
  maintenance?: ReactNode;
}

/** 设置页「项目」行所需的最小字段（`ProjectDTO` 可直接传入）。 */
export interface ProjectView {
  readonly id: number;
  readonly name: string;
  readonly alias: string | null;
  readonly rootDir: string;
  readonly archived: number;
  /** D-22：项目模型策略（缺省＝旧数据/未加载，编辑面按 employee_first 显示）。 */
  readonly defaultModel?: string | null;
  readonly allowedModels?: readonly string[];
  readonly modelPolicy?: 'fixed' | 'employee_first' | 'assistant';
  /** v19：新任务默认 token 预算（null＝不限）。 */
  readonly defaultBudgetTokens?: number | null;
  /** S13-G/D-N06：合并目标分支（null/缺省＝沿用 main/master）。 */
  readonly targetBranch?: string | null;
}

/** 目录读数：token 数 → 1M / 128K；未知/0 如实显 —（不写假 0）。 */
function tokenText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** USD / 1M tokens；极小值保留 3 位（缓存价常见 0.006）。 */
function usdText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  const digits = value < 0.1 ? 3 : 2;
  return `$${value.toFixed(digits)}`;
}

export function SettingsPane(props: SettingsPaneProps): ReactElement {
  // 2026-11-03 细分直达：section 恒为直达组 id（旧分区 id 经 settingsGroupOf 归组兜底）。
  const activeGroup = settingsGroupOf(props.section) ?? SETTINGS_GROUPS[0];
  /** 分区在当前直达组内 → 直接铺真实控件（无卡片摘要层）。 */
  const has = (id: string): boolean => activeGroup.sections.includes(id);
  const [skillUrlDraft, setSkillUrlDraft] = useState('');
  const [imVerifyCode, setImVerifyCode] = useState('');
  // GAP6：MCP 注册表单（env 只写不读；保存后 store 只回 key 名）。
  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpEnv, setMcpEnv] = useState('');
  const [mcpExposure, setMcpExposure] = useState('auto');
  const [mcpExternal, setMcpExternal] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpFormError, setMcpFormError] = useState('');
  // D-22：项目模型策略（项目选择＋三字段草稿；编辑面只在设置里，项目概览只读）。
  const [projectModelId, setProjectModelId] = useState<number | null>(null);
  const [policyDraft, setPolicyDraft] = useState<'fixed' | 'employee_first' | 'assistant'>('employee_first');
  const [defaultModelDraft, setDefaultModelDraft] = useState('');
  const [allowedModelsDraft, setAllowedModelsDraft] = useState('');
  const [defaultBudgetDraft, setDefaultBudgetDraft] = useState('');
  const [targetBranchDraft, setTargetBranchDraft] = useState('');
  const [targetBranchSaving, setTargetBranchSaving] = useState(false);
  const [projectModelSaving, setProjectModelSaving] = useState(false);
  const [projectBudgetSaving, setProjectBudgetSaving] = useState(false);
  const [projectModelNotice, setProjectModelNotice] = useState<string | null>(null);
  const [projectModelError, setProjectModelError] = useState<string | null>(null);
  // D-22 配套：添加供应商（先从 SDK 已有目录里选；自定义 Base URL 另列未实施）。
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [addProviderId, setAddProviderId] = useState('');
  const [addProviderKeyDraft, setAddProviderKeyDraft] = useState('');
  const [addProviderSaving, setAddProviderSaving] = useState(false);
  const [addProviderNotice, setAddProviderNotice] = useState<string | null>(null);
  const [addProviderError, setAddProviderError] = useState<string | null>(null);
  // D-22：自定义供应商表单（一个 provider 一个模型；配置写 Pi models.json）。
  const [customOpen, setCustomOpen] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApi, setCustomApi] = useState<CustomProviderDef['api']>('openai-completions');
  const [customModelId, setCustomModelId] = useState('');
  const [customModelName, setCustomModelName] = useState('');
  const [customContext, setCustomContext] = useState('128000');
  const [customMaxTokens, setCustomMaxTokens] = useState('8192');
  const [customInputPrice, setCustomInputPrice] = useState('0');
  const [customOutputPrice, setCustomOutputPrice] = useState('0');
  const [customReasoning, setCustomReasoning] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [customSaving, setCustomSaving] = useState(false);
  const [customNotice, setCustomNotice] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  async function submitCustomProvider(): Promise<void> {
    if (!props.onSaveCustomProvider || customSaving) return;
    setCustomSaving(true);
    setCustomNotice(null);
    setCustomError(null);
    const contextWindow = Number(customContext);
    const maxTokens = Number(customMaxTokens);
    const input = Number(customInputPrice);
    const output = Number(customOutputPrice);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      setCustomError('上下文/最大输出需为正整数');
      setCustomSaving(false);
      return;
    }
    if (![input, output].every((v) => Number.isFinite(v) && v >= 0)) {
      setCustomError('价格需为 ≥0 的数字');
      setCustomSaving(false);
      return;
    }
    const provider: CustomProviderDef = {
      id: customId.trim(),
      label: customLabel.trim() || customModelName.trim() || customId.trim(),
      baseUrl: customBaseUrl.trim(),
      api: customApi,
      models: [
        {
          id: customModelId.trim(),
          name: customModelName.trim() || customModelId.trim(),
          contextWindow,
          maxTokens,
          input: ['text'],
          reasoning: customReasoning,
          cost: { input, output, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    try {
      const res = await props.onSaveCustomProvider(provider, customKey.trim() || undefined);
      if (!res.ok) {
        setCustomError(res.error ?? '保存失败');
        return;
      }
      setCustomNotice(`已保存自定义供应商：${provider.label}`);
      setCustomKey('');
      setCustomOpen(false);
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
  }

  function openAddProvider(): void {
    const first = props.catalogProviders?.find((p) => !p.keyConfigured) ?? props.catalogProviders?.[0];
    setAddProviderOpen(true);
    setAddProviderId(first?.provider ?? '');
    setAddProviderKeyDraft('');
    setAddProviderNotice(null);
    setAddProviderError(null);
  }

  async function submitAddProvider(): Promise<void> {
    if (!props.onAddProviderKey || addProviderId.length === 0 || addProviderSaving) return;
    const key = addProviderKeyDraft.trim();
    if (key.length < 8) {
      setAddProviderError('Key 至少 8 个字符');
      return;
    }
    const label = props.catalogProviders?.find((p) => p.provider === addProviderId)?.providerLabel ?? addProviderId;
    setAddProviderSaving(true);
    setAddProviderError(null);
    setAddProviderNotice(null);
    try {
      const res = await props.onAddProviderKey(addProviderId, key);
      if (!res.ok) {
        setAddProviderError(res.error ?? '保存失败');
        return;
      }
      setAddProviderKeyDraft('');
      setAddProviderNotice(`已保存 ${label} 的 Key；目录状态已刷新`);
    } catch (error) {
      setAddProviderError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddProviderSaving(false);
    }
  }
  const projectForModel =
    props.projects.find((p) => p.id === projectModelId) ??
    props.projects.find((p) => p.id === props.defaultProjectId) ??
    props.projects[0] ??
    null;
  useEffect(() => {
    if (!projectForModel) return;
    setPolicyDraft(
      projectForModel.modelPolicy === 'fixed'
        ? 'fixed'
        : projectForModel.modelPolicy === 'assistant'
          ? 'assistant'
          : 'employee_first',
    );
    setDefaultModelDraft(projectForModel.defaultModel ?? '');
    setAllowedModelsDraft((projectForModel.allowedModels ?? []).join('\n'));
    setDefaultBudgetDraft(
      typeof projectForModel.defaultBudgetTokens === 'number' ? String(projectForModel.defaultBudgetTokens) : '',
    );
    setTargetBranchDraft(projectForModel.targetBranch ?? '');
    setProjectModelNotice(null);
    setProjectModelError(null);
  }, [
    projectForModel?.id,
    projectForModel?.modelPolicy,
    projectForModel?.defaultModel,
    projectForModel?.allowedModels?.join('\u0000'),
    projectForModel?.defaultBudgetTokens,
    projectForModel?.targetBranch,
  ]);

  async function submitProjectModel(): Promise<void> {
    if (!props.onSaveProjectModelPolicy || !projectForModel || projectModelSaving) return;
    const allowedModels = [
      ...new Set(
        allowedModelsDraft
          .split(/[\n,]+/)
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
      ),
    ];
    setProjectModelSaving(true);
    setProjectModelNotice(null);
    setProjectModelError(null);
    try {
      const res = await props.onSaveProjectModelPolicy({
        projectId: projectForModel.id,
        policy: policyDraft,
        defaultModel: defaultModelDraft.trim().length > 0 ? defaultModelDraft.trim() : null,
        allowedModels,
      });
      if (res && res.ok === false) {
        setProjectModelError(res.error ?? '保存失败');
        return;
      }
      setProjectModelNotice('项目模型策略已保存（只影响之后的员工会话）');
    } catch (error) {
      setProjectModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectModelSaving(false);
    }
  }

  async function submitTargetBranch(): Promise<void> {
    if (!props.onSaveProjectTargetBranch || !projectForModel || targetBranchSaving) return;
    const raw = targetBranchDraft.trim();
    if (raw.length > 0 && !/^[A-Za-z0-9._/-]+$/.test(raw)) {
      setProjectModelError('分支名只允许字母/数字/./_/-');
      return;
    }
    setTargetBranchSaving(true);
    setProjectModelNotice(null);
    setProjectModelError(null);
    try {
      const res = await props.onSaveProjectTargetBranch(projectForModel.id, raw.length > 0 ? raw : null);
      if (res && res.ok === false) {
        setProjectModelError(res.error ?? '保存失败');
        return;
      }
      setProjectModelNotice(raw.length > 0 ? `合并目标分支已设为 ${raw}` : '合并目标分支已清空（沿用 main/master）');
    } catch (error) {
      setProjectModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setTargetBranchSaving(false);
    }
  }

  async function submitProjectBudget(): Promise<void> {
    if (!props.onSaveProjectDefaultBudget || !projectForModel || projectBudgetSaving) return;
    const raw = defaultBudgetDraft.trim();
    const parsed = raw.length === 0 ? null : Number(raw);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
      setProjectModelError('默认预算需为正整数 token，或留空（不限）');
      return;
    }
    setProjectBudgetSaving(true);
    setProjectModelNotice(null);
    setProjectModelError(null);
    try {
      const res = await props.onSaveProjectDefaultBudget(projectForModel.id, parsed);
      if (res && res.ok === false) {
        setProjectModelError(res.error ?? '保存失败');
        return;
      }
      setProjectModelNotice('项目默认任务预算已保存（只影响之后新建且未填预算的任务）');
    } catch (error) {
      setProjectModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBudgetSaving(false);
    }
  }


  async function submitMcp(): Promise<void> {
    if (!props.onSaveMcpServer || mcpSaving) return;
    setMcpFormError('');
    let env: Record<string, string> | undefined;
    if (mcpEnv.trim().length > 0) {
      try {
        const parsed = JSON.parse(mcpEnv) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需为对象');
        env = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== 'string') throw new Error(`${k} 需为字符串`);
          env[k] = v;
        }
      } catch (error) {
        setMcpFormError(`env 不是合法 JSON 对象：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    setMcpSaving(true);
    const res = await props.onSaveMcpServer({
      name: mcpName.trim(),
      transport: mcpTransport,
      ...(mcpTransport === 'stdio' ? { command: mcpCommand.trim() } : { url: mcpUrl.trim() }),
      args: mcpArgs.trim().length > 0 ? mcpArgs.trim().split(/\s+/) : [],
      ...(env ? { env } : {}),
      exposure: mcpExposure,
      hasExternalActions: mcpExternal,
    });
    setMcpSaving(false);
    if (!res.ok) setMcpFormError(res.error ?? '保存失败');
    else {
      setMcpName('');
      setMcpCommand('');
      setMcpUrl('');
      setMcpArgs('');
      setMcpEnv('');
    }
  }
  // 2026-11-04 SplitLayout 接入（批次 2）：分栏/窄窗堆叠统一由组件管；本页只留语义容器。
  return (
    <div className="settings-view" data-testid="settings-view" style={{ height: '100%', overflow: 'hidden' }}>
      <SplitLayout
        sideWidth={190}
        label="导航"
        storageKey="settings"
        count={SETTINGS_GROUPS.length}
        side={
      <nav
        className="settings-view__nav"
        data-testid="settings-nav"
        aria-label="设置分组"
        style={{ borderRight: '1px solid var(--border)', padding: 8, display: 'grid', alignContent: 'start', gap: 4, overflowY: 'auto' }}
      >
        {SETTINGS_GROUPS.map((g) => {
          const hasUnimplemented = g.sections.some(
            (id) => SETTINGS_SECTIONS.find((s) => s.id === id)?.implemented === false,
          );
          return (
            <button
              key={g.id}
              type="button"
              className="settings-view__nav-item"
              data-testid={`settings-group-${g.id}`}
              aria-current={activeGroup?.id === g.id ? 'page' : undefined}
              style={{ ...NAV_ITEM, fontWeight: activeGroup?.id === g.id ? 600 : 400 }}
              onClick={() => props.onSectionChange(g.id)}
            >
              {g.label}
              {hasUnimplemented ? (
                <span className="settings-pill" data-testid="settings-unimplemented">
                  含未实现
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
        }
        main={
      <div className="settings-view__pane" data-testid="settings-pane" style={PANE}>
        {props.error ? (
          <div data-testid="settings-error" style={{ ...ERR, display: 'flex', alignItems: 'center', gap: 8 }} role="alert">
            <span style={{ flex: 1 }}>设置加载失败：{props.error}（以下数值可能不是最新）</span>
            <button type="button" data-testid="settings-error-retry" onClick={() => props.onRetryLoad?.()} disabled={!props.onRetryLoad}>
              重试
            </button>
          </div>
        ) : null}
        {props.saved ? (
          <p data-testid="settings-saved" style={MUTED}>
            {props.saved}
          </p>
        ) : null}

        {has('general') ? (
          <section data-testid="settings-general">
            <h3>外观</h3>
            <p style={MUTED}>外观主题立即生效；“跟随系统”会随 Windows 的深浅色设置切换。</p>
            {/* 2026-10-28 老板：只有两个状态，别用下拉——左右滑动开关＋日/夜图标。
                「跟随系统」保留为初始默认：未动过时按实际生效态显示并加小字；一动即固定。 */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>主题</span>
              <span className="theme-switch-side" data-active={
                !themeSwitchChecked(props.theme ?? 'system', typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true) ? 'true' : 'false'
              } aria-hidden="true">☀︎</span>
              <button
                type="button"
                className="theme-switch"
                role="switch"
                aria-checked={themeSwitchChecked(props.theme ?? 'system', typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)}
                aria-label="日间/夜间"
                data-testid="settings-theme-switch"
                data-dark={themeSwitchChecked(props.theme ?? 'system', typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true) ? 'true' : 'false'}
                disabled={!props.onThemeChange}
                onClick={() => {
                  const next = themeSwitchTarget(props.theme ?? 'system', window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
                  props.onThemeChange?.(next);
                }}
              >
                <span className="theme-switch__thumb" aria-hidden="true" />
              </button>
              <span className="theme-switch-side" data-active={
                themeSwitchChecked(props.theme ?? 'system', typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true) ? 'true' : 'false'
              } aria-hidden="true">☾</span>
              {isFollowingSystem(props.theme ?? 'system') ? (
                <span style={MUTED} data-testid="settings-theme-following">跟随系统（点一下即固定）</span>
              ) : null}
            </div>
            {/* 2026-10-29 P2（P-N05）：语言/自启；更新与数据目录仍如实标「暂未开放」，不摆假入口。 */}
            <div className="settings-row" data-testid="settings-general-extra" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <div style={ROW}>
                <span style={{ minWidth: 88 }}>语言</span>
                <span style={MUTED}>简体中文（当前仅此一种，暂不提供多语言切换）</span>
              </div>
              <label style={{ ...ROW, cursor: props.onToggleOpenAtLogin ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  data-testid="settings-open-at-login"
                  checked={props.openAtLogin === true}
                  disabled={!props.onToggleOpenAtLogin}
                  onChange={(e) => props.onToggleOpenAtLogin?.((e.target as HTMLInputElement).checked)}
                />
                <span>开机自启（Windows）</span>
                <span style={MUTED}>下次启动生效</span>
              </label>
              <div style={ROW}>
                <span style={{ minWidth: 88 }}>版本</span>
                <span data-testid="settings-app-version">
                  v{props.appInfo?.version ?? '—'}
                </span>
              </div>
              <div style={{ ...ROW, minWidth: 0 }}>
                <span style={{ minWidth: 88 }}>数据目录</span>
                <span
                  data-testid="settings-data-dir"
                  title={props.appInfo?.userDataDir ?? ''}
                  style={{ ...MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                >
                  {props.appInfo?.userDataDir ?? '—'}
                </span>
                <button
                  type="button"
                  data-testid="settings-open-data-dir"
                  disabled={!props.onOpenDataDir || props.appInfo == null}
                  onClick={() => props.onOpenDataDir?.()}
                >
                  打开
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {(has('providers') || has('models') || has('project-model')) ? (
          <section data-testid="settings-models">
            <h3>供应商与模型</h3>
            {/* 供应商连接区（2026-10-16 设置批；2026-10-20 更新）：Key 可填/清除（本机 secrets）；
                连通测试未实现（不摆假按钮）。B4（2026-10-17）：主界面说人话，技术细节收进折叠。 */}
            {has('providers') ? (<>
            <div className="settings-block" data-testid="settings-providers">
              <h4 style={{ margin: 0 }}>模型连接</h4>
              <p style={MUTED}>
                Key 只存本机 <code>~/.aico/secrets</code>（受限权限），不上传、不进仓库；保存后下一次员工会话生效。
                环境变量优先于本机文件。
              </p>
              {(props.providers ?? []).length === 0 ? (
                <p data-testid="settings-providers-empty" style={MUTED}>
                  {props.loading ? '读取中…' : '未读取到供应商列表（主进程不可用）。'}
                </p>
              ) : (
                (props.providers ?? []).map((provider) => {
                  const draft = props.providerDrafts?.[provider.provider] ?? '';
                  const statusText = provider.envConfigured
                    ? `已配置（环境变量 · ${provider.masked ?? '—'}）`
                    : provider.fileConfigured
                      ? `已配置（本机 · ${provider.masked ?? '—'}）`
                      : '未配置';
                  return (
                    <div
                      className="settings-provider"
                      data-testid={`settings-provider-${provider.provider}`}
                      data-configured={provider.configured ? 'true' : 'false'}
                      key={provider.provider}
                    >
                      <div style={ROW}>
                        <strong>{provider.label}</strong>
                        <span data-testid={`settings-provider-status-${provider.provider}`} style={MUTED}>
                          {statusText}
                        </span>
                      </div>
                      <div style={ROW}>
                        <input
                          className="settings-view__input"
                          data-testid={`settings-provider-key-${provider.provider}`}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={provider.envConfigured}
                          placeholder={
                            provider.envConfigured
                              ? '环境变量已配置（此处保存不覆盖）'
                              : '粘贴 API Key（只存本机，不回显）'
                          }
                          value={draft}
                          onChange={(e) => props.onProviderDraftChange?.(provider.provider, e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          data-testid={`settings-provider-save-${provider.provider}`}
                          disabled={provider.envConfigured || draft.trim().length === 0 || !props.onSaveProviderKey}
                          onClick={() => props.onSaveProviderKey?.(provider.provider)}
                        >
                          保存
                        </button>
                        {provider.fileConfigured ? (
                          <button
                            type="button"
                            data-testid={`settings-provider-clear-${provider.provider}`}
                            onClick={() => props.onClearProviderKey?.(provider.provider)}
                          >
                            清除
                          </button>
                        ) : null}
                      </div>
                      {provider.envConfigured ? (
                        <p style={MUTED} data-testid={`settings-provider-env-${provider.provider}`}>
                          当前由环境变量提供，优先于本机文件；要改环境变量请改启动环境。
                        </p>
                      ) : null}
                    </div>
                  );
                })
              )}
              <div style={{ ...ROW, alignSelf: 'stretch' }}>
                <button
                  type="button"
                  data-testid="settings-add-provider"
                  disabled={!props.onAddProviderKey || !props.catalogProviders || props.catalogProviders.length === 0}
                  onClick={openAddProvider}
                >
                  ＋ 添加供应商
                </button>
                <span style={MUTED}>从已支持的供应商里选；自定义 Base URL 暂不支持；「测试」会真发一次极短请求（产生少量费用）。</span>
              </div>
              {addProviderOpen ? (
                <div className="settings-add-provider" data-testid="settings-add-provider-dialog">
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>供应商</span>
                    <select
                      className="settings-view__input"
                      data-testid="settings-add-provider-select"
                      value={addProviderId}
                      onChange={(e) => setAddProviderId(e.target.value)}
                    >
                      {(props.catalogProviders ?? []).map((p) => (
                        <option key={p.provider} value={p.provider}>
                          {p.providerLabel}（{p.modelCount} 个模型）{p.keyConfigured ? ' · 已配置' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>API Key</span>
                    <input
                      className="settings-view__input"
                      data-testid="settings-add-provider-key"
                      type="password"
                      autoComplete="off"
                      placeholder="只存本机，不回显"
                      value={addProviderKeyDraft}
                      onChange={(e) => setAddProviderKeyDraft(e.target.value)}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <button
                      type="button"
                      data-testid="settings-add-provider-save"
                      disabled={
                        !props.onAddProviderKey ||
                        addProviderSaving ||
                        addProviderId.length === 0 ||
                        addProviderKeyDraft.trim().length < 8
                      }
                      onClick={() => void submitAddProvider()}
                    >
                      {addProviderSaving ? '保存中…' : '保存 Key'}
                    </button>
                    <button
                      type="button"
                      data-testid="settings-add-provider-cancel"
                      onClick={() => setAddProviderOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                  {addProviderNotice ? (
                    <p style={MUTED} data-testid="settings-add-provider-notice">
                      {addProviderNotice}
                    </p>
                  ) : null}
                  {addProviderError ? (
                    <p style={ERR} data-testid="settings-add-provider-error" role="alert">
                      {addProviderError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="settings-block" data-testid="settings-custom-provider">
                <h4 style={{ margin: 0 }}>自定义供应商</h4>
                <p style={MUTED}>
                  配置写本机 <code>~/.aico/models.json</code>，Key 只存本机 secrets；下一次员工会话生效。当前 MVP
                  一个供应商配一个模型；「测试」会真发一次极短请求（产生少量费用）。
                </p>
                {(props.customProviders ?? []).map((provider) => (
                  <div style={{ ...ROW, alignSelf: 'stretch' }} key={provider.id} data-testid="settings-custom-provider-row" data-provider={provider.id}>
                    <span style={{ flex: 1 }}>
                      {provider.label} <span style={MUTED}>{provider.id} · {provider.baseUrl}</span>
                    </span>
                    <button
                      type="button"
                      data-testid={`settings-custom-provider-test-${provider.id}`}
                      disabled={!props.onTestCustomProvider}
                      onClick={() => {
                        void props.onTestCustomProvider?.(provider.id).then((res) => {
                          if (res.ok) {
                            setCustomNotice(res.message ?? '连接成功');
                            setCustomError(null);
                          } else {
                            setCustomError(res.error ?? '测试失败');
                            setCustomNotice(null);
                          }
                        });
                      }}
                    >
                      测试
                    </button>
                    <button
                      type="button"
                      data-testid={`settings-custom-provider-remove-${provider.id}`}
                      disabled={!props.onRemoveCustomProvider}
                      onClick={() => props.onRemoveCustomProvider?.(provider.id)}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button type="button" data-testid="settings-custom-provider-add" onClick={() => setCustomOpen((v) => !v)}>
                  {customOpen ? '收起表单' : '＋ 自定义供应商'}
                </button>
                {customOpen ? (
                  <div className="settings-add-provider" data-testid="settings-custom-provider-form">
                    {[
                      ['id（小写字母/数字/_/-）', customId, setCustomId, 'my-provider'],
                      ['显示名', customLabel, setCustomLabel, 'My Provider'],
                      ['Base URL', customBaseUrl, setCustomBaseUrl, 'https://api.example.com/v1'],
                      ['模型 ID', customModelId, setCustomModelId, 'my-model'],
                      ['模型显示名', customModelName, setCustomModelName, 'My Model'],
                      ['上下文窗口', customContext, setCustomContext, '128000'],
                      ['最大输出', customMaxTokens, setCustomMaxTokens, '8192'],
                      ['输入价（USD/1M）', customInputPrice, setCustomInputPrice, '0'],
                      ['输出价（USD/1M）', customOutputPrice, setCustomOutputPrice, '0'],
                    ].map(([label, value, setter, placeholder]) => (
                      <div style={{ ...ROW, alignSelf: 'stretch' }} key={label as string}>
                        <span style={{ minWidth: 150 }}>{label as string}</span>
                        <input
                          className="settings-view__input"
                          data-testid={`settings-custom-provider-${label === 'Base URL' ? 'base-url' : label === '模型 ID' ? 'model-id' : label === '显示名' ? 'label' : label === '上下文窗口' ? 'context' : label === '最大输出' ? 'max-tokens' : label === '输入价（USD/1M）' ? 'input-price' : label === '输出价（USD/1M）' ? 'output-price' : 'id'}`}
                          value={value as string}
                          placeholder={placeholder as string}
                          onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                          style={{ flex: 1 }}
                        />
                      </div>
                    ))}
                    <div style={{ ...ROW, alignSelf: 'stretch' }}>
                      <span style={{ minWidth: 150 }}>API</span>
                      <select
                        className="settings-view__input"
                        data-testid="settings-custom-provider-api"
                        value={customApi}
                        onChange={(e) => setCustomApi(e.target.value as CustomProviderDef['api'])}
                      >
                        <option value="openai-completions">OpenAI 兼容（/chat/completions）</option>
                        <option value="anthropic-messages">Anthropic Messages</option>
                        <option value="google-generative-ai">Google Generative AI</option>
                      </select>
                      <label style={ROW}>
                        <input type="checkbox" checked={customReasoning} onChange={(e) => setCustomReasoning(e.target.checked)} />
                        支持思考
                      </label>
                    </div>
                    <div style={{ ...ROW, alignSelf: 'stretch' }}>
                      <span style={{ minWidth: 150 }}>API Key</span>
                      <input
                        className="settings-view__input"
                        data-testid="settings-custom-provider-key"
                        type="password"
                        autoComplete="off"
                        placeholder="可选；只存本机"
                        value={customKey}
                        onChange={(e) => setCustomKey(e.target.value)}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div style={{ ...ROW, alignSelf: 'stretch' }}>
                      <button type="button" data-testid="settings-custom-provider-save" disabled={customSaving || !props.onSaveCustomProvider} onClick={() => void submitCustomProvider()}>
                        {customSaving ? '保存中…' : '保存供应商'}
                      </button>
                      <span style={MUTED}>保存后目录刷新；Key 不会写进 models.json。</span>
                    </div>
                  </div>
                ) : null}
                {customNotice ? (
                  <p style={MUTED} data-testid="settings-custom-provider-notice">
                    {customNotice}
                  </p>
                ) : null}
                {customError ? (
                  <p style={ERR} data-testid="settings-custom-provider-error" role="alert">
                    {customError}
                  </p>
                ) : null}
              </div>
              <p style={MUTED}>连通性由下一次员工会话实际验证；本页不摆假的“已连接”状态。</p>
            </div>
            {has('models') ? (<>
            <h4 style={{ margin: 0 }}>模型与预算</h4>
            <p style={MUTED}>全局默认模型（新建任务时使用；未设置时用本机配置）。</p>
            <div style={ROW}>
              <input
                className="settings-view__input"
                data-testid="settings-model-input"
                data-dirty={props.modelDraft !== (props.model ?? '') ? 'true' : 'false'}
                placeholder="未设置（用本机配置）"
                value={props.modelDraft}
                onChange={(e) => props.onModelDraftChange(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" data-testid="settings-model-save" onClick={props.onSaveModel}>
                保存
              </button>
              {props.modelDraft !== (props.model ?? '') ? (
                <span className="settings-dirty" data-testid="settings-model-dirty">
                  已改待存
                </span>
              ) : null}
            </div>
            <p data-testid="settings-model-effective" style={MUTED}>
              当前生效：{props.loading ? '读取中…' : (props.model ?? '—（未设置，用本机配置）')}
            </p>
            {/* C4（M3）：公司级日预算（可选；达线暂停 executing 任务并提示，重启保留）。 */}
            <h4 style={{ marginBottom: 4 }}>公司日预算（可选）</h4>
            <p style={MUTED}>
              按今日全部成本（含公司级共享开销）计；达线暂停所有执行中任务并提示，**重启后仍生效**；提高预算后需手动继续暂停任务。
            </p>
            <div style={ROW}>
              <input
                className="settings-view__input"
                data-testid="settings-company-budget-input"
                placeholder="未设置（如 5 = $5/日）"
                value={props.companyDailyBudgetDraft ?? ''}
                onChange={(e) => props.onCompanyDailyBudgetDraftChange?.(e.target.value)}
                style={{ width: 220 }}
              />
              <button
                type="button"
                data-testid="settings-company-budget-save"
                disabled={!props.onSaveCompanyDailyBudget}
                onClick={() => props.onSaveCompanyDailyBudget?.()}
              >
                保存
              </button>
              <span data-testid="settings-company-budget-effective" style={MUTED}>
                {props.loading
                  ? '读取中…'
                  : props.companyDailyBudget == null
                    ? '未设置（不限制；不写假 0）'
                    : `$${props.companyDailyBudget.toFixed(2)}/日`}
              </span>
            </div>
            {/* 高级折叠（B4）：日常只用上面的默认模型；JSON 路由给技术场景。 */}
            <details className="settings-advanced" data-testid="settings-advanced-json">
              <summary className="settings-advanced__summary" data-testid="settings-devblock-title">
                高级：模型路由（JSON）
              </summary>
            <h4 style={{ marginBottom: 4 }}>角色映射（role_map）</h4>
            <p style={MUTED}>
              JSON：角色 → 模型档（角色 ∈ planner/critic/verifier/employee；可带 thinking）。L0 直通任务的执行员工
              未配时走省钱档（`AICO_ECONOMY_MODEL`）；规划/评审与 L1/L2 保持默认档。存放＝设置项（不动表）。
            </p>
            <div style={ROW}>
              <textarea
                className="settings-view__input"
                data-testid="settings-role-map-input"
                placeholder='例：{"employee": {"model": "<模型名>", "thinking": "low"}}'
                value={props.roleMapDraft ?? ''}
                onChange={(e) => props.onRoleMapDraftChange?.(e.target.value)}
                rows={4}
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button
                type="button"
                data-testid="settings-role-map-save"
                onClick={() => props.onSaveRoleMap?.()}
                disabled={!props.onSaveRoleMap}
              >
                保存
              </button>
            </div>
            <p data-testid="settings-role-map-effective" style={MUTED}>
              当前生效：{props.loading ? '读取中…' : (props.roleMap == null ? '—（未设置：全部走默认档）' : JSON.stringify(props.roleMap))}
            </p>
            <h4 style={{ marginBottom: 4 }}>兜底链（fallback_chain）</h4>
            <p style={MUTED}>
              JSON 数组：主模型不可用（故障/限流/Key 失效）时按序降级（≤5 条，非空、不重复）；critic/verifier
              异供应商备选也从这里取。降级会记事件（`agent_model_fallback`）。存放＝设置项（不动表）。
            </p>
            <div style={ROW}>
              <textarea
                className="settings-view__input"
                data-testid="settings-fallback-chain-input"
                placeholder='例：["<provider>/<模型名>", "<provider>/<模型名>"]'
                value={props.fallbackChainDraft ?? ''}
                onChange={(e) => props.onFallbackChainDraftChange?.(e.target.value)}
                rows={2}
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button
                type="button"
                data-testid="settings-fallback-chain-save"
                onClick={() => props.onSaveFallbackChain?.()}
                disabled={!props.onSaveFallbackChain}
              >
                保存
              </button>
            </div>
            <p data-testid="settings-fallback-chain-effective" style={MUTED}>
              当前生效：{props.loading ? '读取中…' : (props.fallbackChain == null ? '—（未设置：不降级）' : JSON.stringify(props.fallbackChain))}
            </p>
            </details>
            </>) : null}
            {/* D-22：项目模型策略（项目定边界与默认；员工偏好只是允许清单内的建议）。 */}
            </>) : null}
            {has('project-model') ? (<>
            <div className="settings-block" data-testid="settings-project-model">
              <h4 style={{ margin: 0 }}>项目模型</h4>
              <p style={MUTED}>项目定边界与默认；员工偏好只在允许清单内生效。只影响之后的员工会话。</p>
              {projectForModel ? (
                <>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>项目</span>
                    <select
                      className="settings-view__input"
                      data-testid="settings-project-model-project"
                      value={projectForModel.id}
                      onChange={(e) => setProjectModelId(Number(e.target.value))}
                    >
                      {props.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.archived === 1 ? '（已归档）' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>策略</span>
                    <select
                      className="settings-view__input"
                      data-testid="settings-project-model-policy"
                      value={policyDraft}
                      onChange={(e) =>
                        setPolicyDraft(
                          e.target.value === 'fixed'
                            ? 'fixed'
                            : e.target.value === 'assistant'
                              ? 'assistant'
                              : 'employee_first',
                        )
                      }
                    >
                      <option value="employee_first">员工优先（默认）</option>
                      <option value="fixed">固定模型（压平员工偏好）</option>
                      <option value="assistant">幕僚长调度（允许清单内按任务选）</option>
                    </select>
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>默认模型</span>
                    <input
                      className="settings-view__input"
                      data-testid="settings-project-model-default"
                      placeholder="未设置（回落公司默认；fixed 必填）"
                      value={defaultModelDraft}
                      onChange={(e) => setDefaultModelDraft(e.target.value)}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>允许模型</span>
                    <textarea
                      className="settings-view__input"
                      data-testid="settings-project-model-allowed"
                      placeholder={'每行一个（provider/model）；留空＝不额外限制\n例：deepseek/deepseek-v4-pro'}
                      value={allowedModelsDraft}
                      onChange={(e) => setAllowedModelsDraft(e.target.value)}
                      rows={3}
                      style={{ flex: 1, fontFamily: 'monospace' }}
                    />
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>默认任务预算</span>
                    <input
                      className="settings-view__input"
                      data-testid="settings-project-budget"
                      placeholder="留空＝不限；只影响之后新建且未填预算的任务"
                      inputMode="numeric"
                      value={defaultBudgetDraft}
                      onChange={(e) => setDefaultBudgetDraft(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      data-testid="settings-project-budget-save"
                      disabled={!props.onSaveProjectDefaultBudget || projectBudgetSaving}
                      onClick={() => void submitProjectBudget()}
                    >
                      {projectBudgetSaving ? '保存中…' : '保存预算'}
                    </button>
                  </div>
                  <div style={{ ...ROW, alignSelf: 'stretch' }}>
                    <span style={{ minWidth: 88 }}>合并目标分支</span>
                    <input
                      className="settings-view__input"
                      data-testid="settings-project-target-branch"
                      placeholder="留空＝沿用 main/master（例：trunk）"
                      value={targetBranchDraft}
                      onChange={(e) => setTargetBranchDraft(e.target.value)}
                      style={{ flex: 1, fontFamily: 'monospace' }}
                    />
                    <button
                      type="button"
                      data-testid="settings-project-target-branch-save"
                      disabled={!props.onSaveProjectTargetBranch || targetBranchSaving}
                      onClick={() => void submitTargetBranch()}
                    >
                      {targetBranchSaving ? '保存中…' : '保存分支'}
                    </button>
                  </div>
                  <div style={ROW}>
                    <button
                      type="button"
                      data-testid="settings-project-model-save"
                      disabled={!props.onSaveProjectModelPolicy || projectModelSaving}
                      onClick={() => void submitProjectModel()}
                    >
                      {projectModelSaving ? '保存中…' : '保存'}
                    </button>
                    <span style={MUTED}>
                      {policyDraft === 'assistant'
                        ? '幕僚长只在允许清单内选（至少填一个）；默认模型作为没有可用目录项时的回落落点。'
                        : '固定模型必须填默认；设了允许清单就必须有默认，且默认在清单内。'}
                    </span>
                  </div>
                  {projectModelNotice ? (
                    <p style={MUTED} data-testid="settings-project-model-notice">
                      {projectModelNotice}
                    </p>
                  ) : null}
                  {projectModelError ? (
                    <p style={ERR} data-testid="settings-project-model-error" role="alert">
                      {projectModelError}
                    </p>
                  ) : null}
                </>
              ) : (
                <p style={MUTED} data-testid="settings-project-model-empty">
                  还没有项目；先新建项目或从老板频道建任务。
                </p>
              )}
            </div>
            {/* D-22 配套：只读模型目录（价格 / 上下文 / 能力 / Key 状态）。默认折叠，避免把设置页铺满。 */}
            </>) : null}
            {has('providers') ? (<>
            <details className="settings-advanced" data-testid="settings-model-catalog">
              <summary className="settings-advanced__summary" data-testid="settings-model-catalog-summary">
                模型目录
                {props.modelCatalogLoading
                  ? ' · 读取中…'
                  : props.modelCatalog == null
                    ? ' · 未读取'
                    : `（${props.modelCatalog.length} 个）`}
              </summary>
              {props.modelCatalogError ? (
                <p style={ERR} data-testid="settings-model-catalog-error" role="alert">
                  模型目录读取失败：{props.modelCatalogError}
                </p>
              ) : null}
              {props.modelCatalogLoading && (props.modelCatalog?.length ?? 0) === 0 ? (
                <p style={MUTED} data-testid="settings-model-catalog-loading">
                  读取中…
                </p>
              ) : null}
              {!props.modelCatalogLoading && props.modelCatalog != null && props.modelCatalog.length === 0 ? (
                <p style={MUTED} data-testid="settings-model-catalog-empty">
                  未读取到模型目录（不摆假模型）。
                </p>
              ) : null}
              {(props.modelCatalog?.length ?? 0) > 0 ? (
                <div className="settings-catalog" data-testid="settings-model-catalog-list">
                  <table className="settings-catalog__table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th>上下文</th>
                        <th>能力</th>
                        <th>单价（USD/1M）</th>
                        <th>Key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.modelCatalog?.map((model) => (
                        <tr
                          key={`${model.provider}/${model.id}`}
                          data-testid="settings-model-catalog-row"
                          data-provider={model.provider}
                          data-model={model.id}
                          data-key-configured={model.keyConfigured ? 'true' : 'false'}
                        >
                          <td>
                            <div>{model.name}</div>
                            <div style={MUTED}>
                              {model.providerLabel} · {model.id}
                            </div>
                          </td>
                          <td title={`上下文 ${model.contextWindow} · 最大输出 ${model.maxTokens}`}>
                            {tokenText(model.contextWindow)}
                          </td>
                          <td>
                            {model.input.join(' / ')}
                            {model.reasoning ? ' · 思考' : ''}
                          </td>
                          <td title={`缓存读 ${usdText(model.cost.cacheRead)} · 缓存写 ${usdText(model.cost.cacheWrite)}`}>
                            入 {usdText(model.cost.input)} · 出 {usdText(model.cost.output)}
                          </td>
                          <td>
                            {model.keyConfigured
                              ? `已配置${model.keySource === 'env' ? '（环境变量）' : '（本机）'}`
                              : '未配置'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div style={ROW}>
                <button
                  type="button"
                  data-testid="settings-model-catalog-reload"
                  disabled={!props.onReloadModelCatalog || props.modelCatalogLoading}
                  onClick={() => props.onReloadModelCatalog?.()}
                >
                  刷新目录
                </button>
                <span style={MUTED}>只列对话模型；价格口径 USD / 1M tokens；Key 状态只显示来源，不显示明文。</span>
              </div>
            </details>
            </>) : null}

          </section>
        ) : null}

        {has('employees') ? (
          <section data-testid="settings-employees">
            <h3>员工</h3>
            {/* 2026-10-16（设置批）：本分区＝**改人**（花名册＋配置 ▸）；看 TA 在干啥＝公司大厅。 */}
            <p style={MUTED}>
              员工设置：人设 / 偏好 / 技能在「配置 ▸」里改（写下即生效口径同模型设置）；看 TA 当前在干啥去公司大厅。
              招募与停用已接主进程（停用需先在跑件结束）；记忆编辑仍属未实现。
            </p>
            {props.employees == null ? (
              <p style={MUTED} data-testid="settings-employees-loading">
                读取中…
              </p>
            ) : props.employees.length === 0 ? (
              <p style={MUTED} data-testid="settings-employees-empty">
                暂无员工
              </p>
            ) : (
              props.employees.map((employee) => (
              <>
                <div key={employee.id} style={ROW} data-testid="settings-employee-row" data-employee-id={employee.id} data-active={employee.active === false ? '0' : '1'}>
                  <span style={{ flex: 1 }}>
                    {employee.name} <span style={MUTED}>{employee.role}</span>
                    {employee.active === false ? (
                      <span style={{ ...MUTED, marginLeft: 6 }} data-testid="settings-employee-inactive">
                        已停用
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    data-testid="settings-employee-config"
                    disabled={!props.onOpenEmployee}
                    title={props.onOpenEmployee ? '在本页展开配置（人设 / 偏好 / 技能）；再点收起' : '未接线'}
                    onClick={() => props.onOpenEmployee?.(employee.id)}
                  >
                    {props.expandedEmployeeId === employee.id ? '收起 ▴' : '配置 ▸'}
                  </button>
                </div>
                {props.expandedEmployeeId === employee.id ? (
                  <div
                    data-testid="settings-employee-inline"
                    style={{ margin: '2px 0 10px', padding: '8px 10px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-md)', background: 'var(--panel-2)' }}
                  >
                    {/* 守卫：详情必须属于展开的员工——大厅等处会改写共享 workstation，不匹配时按读取中处理（容器会重载）。 */}
                    <EmployeePane
                      mode="config"
                      embedded
                      onBack={() => undefined}
                      detail={(() => {
                        const d = props.workstation?.data as { employee: { id: number } } | null | undefined;
                        return d != null && d.employee.id === employee.id ? (props.workstation!.data as never) : null;
                      })()}
                      loading={props.workstation?.loading ?? false}
                      error={props.workstation?.error ?? null}
                      skillOptions={(props.skills ?? null) as never}
                      mcpOptions={props.mcpServers as never}
                      onUpdateEmployee={props.onUpdateEmployeeDetail}
                    />
                  </div>
                ) : null}
              </>
              ))
            )}
            {/* 招募面 NI（M1+）——disabled ＋ 显式理由（不假装可点）。 */}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                data-testid="settings-employee-recruit"
                disabled={!props.onRecruit}
                title={props.onRecruit ? '招募一名员工（名字/角色/偏好模型）' : '未接线'}
                onClick={() => props.onRecruit?.()}
              >
                ＋招募
              </button>
              <button type="button" data-testid="settings-go-hall" onClick={props.onGoHall} disabled={!props.onGoHall}>
                去公司大厅
              </button>
            </div>
          </section>
        ) : null}

        {has('projects') ? (
          <section data-testid="settings-projects">
            <h3>项目</h3>
            <p style={MUTED}>
              「设为默认」＝新任务未指定项目时的落点（resolver 真读者）——本分区只留**全局默认**；项目级操作（归档项目）在**项目概览**（左栏点项目名，D-5 ③）。接入模式 / 放行档 / 别名等未实现。
            </p>
            {props.projects.length === 0 ? (
              <p data-testid="settings-projects-empty" style={MUTED}>
                暂无项目
              </p>
            ) : null}
            {props.projects.map((p) => (
              <div
                key={p.id}
                style={ROW}
                data-testid="settings-project-row"
                data-project-id={p.id}
                data-archived={p.archived === 1 ? 'true' : 'false'}
              >
                <span style={{ flex: 1 }}>
                  {p.name}
                  {p.alias ? `（${p.alias}）` : ''} <span style={MUTED}>{p.rootDir}</span>
                </span>
                {p.archived === 1 ? (
                  <span data-testid="settings-project-archived" style={MUTED}>
                    已归档
                  </span>
                ) : props.defaultProjectId === p.id ? (
                  <span data-testid="settings-project-default-badge" style={MUTED}>
                    默认
                  </span>
                ) : (
                  <button type="button" data-testid="settings-project-set-default" onClick={() => props.onSetDefaultProject(p.id)}>
                    设为默认
                  </button>
                )}
              </div>
            ))}
          </section>
        ) : null}

        {has('skills') ? (
          <section data-testid="settings-skills">
            <h3>技能</h3>
            <p style={MUTED}>
              技能＝含 <code>SKILL.md</code> 的文件夹。内置三个（公司管理/事实核查/变更审查）随软件安装、不可删可停用；
              员工勾选 ∪ 项目默认 → 会话只拿到索引，模型需要时调 <code>load_skill</code> 读全文（按需披露）。
            </p>
            <div style={ROW}>
              <button
                type="button"
                data-testid="settings-skill-install-folder"
                disabled={!props.onInstallSkillFolder || props.skillsLoading}
                title={props.onInstallSkillFolder ? '从本地文件夹安装（主进程选择目录）' : '未接线'}
                onClick={() => props.onInstallSkillFolder?.()}
              >
                从文件夹安装
              </button>
              <input
                className="settings-view__input"
                data-testid="settings-skill-url"
                placeholder="https://…/SKILL.md 或 Git 仓库地址"
                value={skillUrlDraft}
                onChange={(e) => setSkillUrlDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                data-testid="settings-skill-install-url"
                disabled={!props.onInstallSkillUrl || props.skillsLoading || skillUrlDraft.trim().length === 0}
                title={props.onInstallSkillUrl ? '从 URL 安装（直接 .md 或浅克隆 Git 仓库）' : '未接线'}
                onClick={() => props.onInstallSkillUrl?.(skillUrlDraft.trim())}
              >
                从 URL 安装
              </button>
            </div>
            {props.skillsNotice ? (
              <p style={MUTED} data-testid="settings-skill-notice" role="status">
                {props.skillsNotice}
              </p>
            ) : null}
            {props.skillsError ? (
              <p style={ERR} data-testid="settings-skill-error" role="alert">
                {props.skillsError}
              </p>
            ) : null}
            {props.skillsLoading && props.skills == null ? (
              <p style={MUTED} data-testid="settings-skills-loading">
                读取中…
              </p>
            ) : props.skills == null || props.skills.length === 0 ? (
              <p style={MUTED} data-testid="settings-skills-empty">
                暂无技能（内置包应在启动时自动安装；若为空请检查日志）。
              </p>
            ) : (
              props.skills.map((skill) => {
                const builtin = skill.source === 'builtin';
                const sourceLabel = builtin
                  ? '内置'
                  : skill.source.startsWith('url:')
                    ? 'URL'
                    : skill.source === 'local'
                      ? '本地'
                      : skill.source;
                return (
                  <div
                    key={skill.id}
                    style={ROW}
                    data-testid="settings-skill-row"
                    data-skill-id={skill.id}
                    data-skill-name={skill.name}
                    data-source={skill.source}
                    data-enabled={skill.enabled === 1 ? 'true' : 'false'}
                  >
                    <label style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        data-testid={`settings-skill-enabled-${skill.id}`}
                        checked={skill.enabled === 1}
                        disabled={!props.onToggleSkill}
                        onChange={(e) => props.onToggleSkill?.(skill.id, e.target.checked)}
                      />
                      <span>
                        {skill.name} <span style={MUTED}>{sourceLabel}{skill.version ? ` · ${skill.version}` : ''}</span>
                        {skill.description ? <span style={MUTED}> — {skill.description}</span> : null}
                      </span>
                    </label>
                    {builtin ? (
                      <span style={MUTED} data-testid={`settings-skill-builtin-${skill.id}`}>
                        不可删
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`settings-skill-remove-${skill.id}`}
                        disabled={!props.onRemoveSkill}
                        onClick={() => props.onRemoveSkill?.(skill.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </section>
        ) : null}

        {has('mcp') ? (
          <section data-testid="settings-mcp">
            <h3>MCP</h3>
            <p style={MUTED}>
              注册 MCP server 后，在「员工 → 配置 ▸ → MCP」勾选分配。env 值存本机 SQLite（**当前未加密**；列表只回变量名，不回值）——
              不要把长期高权限凭据放这里；密钥环存储列后续。deferred/codemode 不预载工具清单，员工用 tool_search 按需发现；mcp_call 逐次批准。
            </p>
            <div style={ROW} data-testid="settings-mcp-form">
              <input
                className="settings-view__input"
                data-testid="settings-mcp-name"
                placeholder="名称（如 filesystem）"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                style={{ width: 130 }}
              />
              <select
                className="settings-view__input"
                data-testid="settings-mcp-transport"
                value={mcpTransport}
                onChange={(e) => setMcpTransport(e.target.value === 'http' ? 'http' : 'stdio')}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
              {mcpTransport === 'stdio' ? (
                <input
                  className="settings-view__input"
                  data-testid="settings-mcp-command"
                  placeholder="命令（如 npx）"
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                  style={{ flex: 1 }}
                />
              ) : (
                <input
                  className="settings-view__input"
                  data-testid="settings-mcp-url"
                  placeholder="http(s)://…"
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                  style={{ flex: 1 }}
                />
              )}
            </div>
            <div style={ROW}>
              <input
                className="settings-view__input"
                data-testid="settings-mcp-args"
                placeholder="参数（空格分隔，可选）"
                value={mcpArgs}
                onChange={(e) => setMcpArgs(e.target.value)}
                style={{ flex: 1 }}
              />
              <select
                className="settings-view__input"
                data-testid="settings-mcp-exposure"
                value={mcpExposure}
                onChange={(e) => setMcpExposure(e.target.value)}
              >
                <option value="auto">auto</option>
                <option value="direct">direct</option>
                <option value="deferred">deferred</option>
                <option value="codemode">codemode（按 deferred）</option>
              </select>
              <label style={MUTED}>
                <input
                  type="checkbox"
                  data-testid="settings-mcp-external"
                  checked={mcpExternal}
                  onChange={(e) => setMcpExternal(e.target.checked)}
                />{' '}
                含对外动作
              </label>
            </div>
            <div style={ROW}>
              <textarea
                className="settings-view__input"
                data-testid="settings-mcp-env"
                placeholder='env JSON（可选；值存本机库、当前未加密）例：{"TOKEN":"…"}'
                value={mcpEnv}
                onChange={(e) => setMcpEnv(e.target.value)}
                rows={2}
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button
                type="button"
                data-testid="settings-mcp-save"
                disabled={!props.onSaveMcpServer || mcpSaving || mcpName.trim().length === 0}
                onClick={() => {
                  void submitMcp();
                }}
              >
                {mcpSaving ? '保存中…' : '保存 server'}
              </button>
            </div>
            {mcpFormError ? (
              <p style={ERR} data-testid="settings-mcp-form-error" role="alert">
                {mcpFormError}
              </p>
            ) : null}
            {props.mcpNotice ? (
              <p style={MUTED} data-testid="settings-mcp-notice" role="status">
                {props.mcpNotice}
              </p>
            ) : null}
            {props.mcpError ? (
              <p style={ERR} data-testid="settings-mcp-error" role="alert">
                {props.mcpError}
              </p>
            ) : null}
            {props.mcpLoading && props.mcpServers == null ? (
              <p style={MUTED} data-testid="settings-mcp-loading">
                读取中…
              </p>
            ) : props.mcpServers == null || props.mcpServers.length === 0 ? (
              <p style={MUTED} data-testid="settings-mcp-empty">
                暂无 MCP server。
              </p>
            ) : (
              props.mcpServers.map((server) => (
                <div
                  key={server.id}
                  style={ROW}
                  data-testid="settings-mcp-row"
                  data-mcp-id={server.id}
                  data-mcp-name={server.name}
                  data-transport={server.transport}
                  data-enabled={server.enabled ? 'true' : 'false'}
                >
                  <label style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      data-testid={`settings-mcp-enabled-${server.id}`}
                      checked={server.enabled}
                      disabled={!props.onToggleMcp}
                      onChange={(e) => props.onToggleMcp?.(server.id, e.target.checked)}
                    />
                    <span>
                      {server.name}{' '}
                      <span style={MUTED}>
                        {server.transport} · {server.exposure}
                        {server.hasExternalActions ? ' · 对外' : ''}
                        {server.envKeys.length > 0 ? ` · env:${server.envKeys.join(',')}` : ''}
                      </span>
                      <span style={MUTED}>
                        {' '}
                        {server.transport === 'stdio' ? `${server.command ?? ''} ${server.args.join(' ')}` : server.url ?? ''}
                      </span>
                    </span>
                  </label>
                  <button
                    type="button"
                    data-testid={`settings-mcp-remove-${server.id}`}
                    disabled={!props.onRemoveMcp}
                    onClick={() => props.onRemoveMcp?.(server.id)}
                  >
                    删除
                  </button>
                </div>
              ))
            )}

            {props.mcpServers && props.mcpServers.length > 0 && props.employees && props.employees.length > 0 ? (
              <div data-testid="settings-mcp-matrix" style={{ overflowX: 'auto' }}>
                <h4 style={{ marginBottom: 4 }}>分配矩阵（只读；改分配去员工「配置 ▸ → MCP」）</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 4 }}>server</th>
                      {props.employees.map((employee) => (
                        <th key={employee.id} style={{ padding: 4 }}>{employee.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {props.mcpServers.map((server) => (
                      <tr key={server.id} data-testid="settings-mcp-matrix-row" data-mcp-name={server.name}>
                        <td style={{ padding: 4 }}>{server.name}</td>
                        {props.employees!.map((employee) => {
                          const assigned = (employee.mcpRefs ?? []).some(
                            (ref) => ref === server.name || ref === String(server.id),
                          );
                          return (
                            <td key={employee.id} style={{ padding: 4, textAlign: 'center' }} data-assigned={assigned ? 'true' : 'false'}>
                              {assigned ? '✓' : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}

        {has('permissions') ? (
          <section data-testid="settings-permissions-panel">
            <h3>权限</h3>
            <PermissionsPanel />
          </section>
        ) : null}

        {has('tuning') ? (
          <section data-testid="settings-tuning">
            <h3>调度与费率</h3>
            <p style={MUTED}>
              写下后下次启动生效；留空保存＝恢复默认。越界或非数字会被拒绝并说明范围。
            </p>
            {TUNING_FIELDS.map((f) => (
              <NumericSettingRow key={f.key} props={props} field={f} prefix="settings-tuning" />
            ))}
          </section>
        ) : null}

        {has('retention') ? (
          <section data-testid="settings-retention">
            <h3>数据保留</h3>
            <p style={MUTED}>
              只清理临时数据，任务/报告/产物/变更集不受影响；备份与导出全库、日志、清空某任务会话暂未开放。
            </p>
            {props.maintenance ?? null}
          </section>
        ) : null}

        {has('im') ? (
          <section data-testid="settings-im">
            <h3>通道（IM）</h3>
            <p style={MUTED}>
              只做老板 ↔ 幕僚长 <strong>1:1 私聊</strong>：不发群、不建群。绑定后在微信里发
              <code>#项目别名 任务内容</code>（如 <code>#记账 把竞品动态整理一下</code>）；审批卡直接回 1/2。
              本轮只接微信；QQ/飞书/企业微信等通道登记不实现。
            </p>
            {props.imError ? (
              <p style={ERR} role="alert" data-testid="settings-im-error">
                {props.imError}
              </p>
            ) : null}
            {props.imNotice ? (
              <p style={MUTED} role="status" data-testid="settings-im-notice">
                {props.imNotice}
              </p>
            ) : null}
            {props.imLoading && !props.imStatus ? (
              <p style={MUTED} data-testid="settings-im-loading">
                读取中…
              </p>
            ) : !props.imStatus ? (
              <p style={MUTED} data-testid="settings-im-empty">
                微信通道未启用——这不是“已连接”。
              </p>
            ) : (
              <>
                <p data-testid="settings-im-state">
                  状态：{IM_STATE_LABEL[props.imStatus.state] ?? props.imStatus.state}
                </p>
                {props.imStatus.ownerId ? (
                  <p style={MUTED} data-testid="settings-im-owner">
                    老板账号：{props.imStatus.ownerId}
                  </p>
                ) : null}
                {props.imStatus.accountId ? (
                  <p style={MUTED} data-testid="settings-im-account">
                    机器人：{props.imStatus.accountId}
                  </p>
                ) : null}
                <p style={MUTED} data-testid="settings-im-outbox">
                  待补发卡片：{props.imStatus.pendingOutbox}
                </p>
                {props.imStatus.state === 'login_pending' && props.imStatus.qr ? (
                  <div data-testid="settings-im-qr">
                    {props.imStatus.qr.startsWith('data:image/') ? (
                      <img src={props.imStatus.qr} alt="微信扫码绑定" width={240} height={240} />
                    ) : (
                      <p style={MUTED}>
                        二维码：<code>{props.imStatus.qr}</code>
                      </p>
                    )}
                    <p style={MUTED}>用微信扫码；状态：{props.imStatus.qrStatus ?? 'wait'}。</p>
                    {props.imStatus.qrStatus === 'need_verifycode' ? (
                      <div data-testid="settings-im-verify-code">
                        <p style={MUTED}>手机微信要求输入数字验证码；输入后继续登录。</p>
                        <div style={ROW}>
                          <input
                            className="settings-view__input"
                            data-testid="settings-im-verify-input"
                            inputMode="numeric"
                            placeholder="手机微信显示的数字"
                            value={imVerifyCode}
                            onChange={(event) => setImVerifyCode(event.target.value)}
                            style={{ flex: 1 }}
                          />
                          <button
                            type="button"
                            data-testid="settings-im-verify-submit"
                            disabled={!props.onImVerifyCode || imVerifyCode.trim().length === 0}
                            onClick={() => props.onImVerifyCode?.(imVerifyCode)}
                          >
                            提交验证码
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {props.imStatus.lastError ? (
                  <p style={ERR} data-testid="settings-im-last-error">
                    {props.imStatus.lastError}
                  </p>
                ) : null}
                <div style={ROW}>
                  <button
                    type="button"
                    data-testid="settings-im-bind"
                    disabled={
                      !props.onImBind ||
                      props.imStatus.state === 'connected' ||
                      props.imStatus.state === 'login_pending'
                    }
                    onClick={props.onImBind}
                  >
                    绑定微信
                  </button>
                  <button
                    type="button"
                    data-testid="settings-im-unbind"
                    disabled={!props.onImUnbind || props.imStatus.state === 'disabled'}
                    onClick={props.onImUnbind}
                  >
                    解绑
                  </button>
                  <button
                    type="button"
                    data-testid="settings-im-refresh"
                    disabled={!props.onImRefresh}
                    onClick={props.onImRefresh}
                  >
                    刷新状态
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {has('notify') ? (
          <section data-testid="settings-notify">
            <h3>通知</h3>
            <p style={MUTED}>
              静默时段：窗内非紧急提醒不弹（改并进日报；紧急升级照弹）；日报每天一次（幂等）。写下即生效（运行时每分钟读，无需重启）。
              桌面通知与声音、聚合窗口、按项目覆盖注意力：暂未开放。
            </p>
            {NOTIFY_FIELDS.map((f) => (
              <NumericSettingRow key={f.key} props={props} field={f} prefix="settings-notify" />
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                data-testid="settings-notify-test"
                disabled={!props.onSendTestNotification}
                title={props.onSendTestNotification ? '立即弹一次系统通知（不写日报幂等键）' : '未接线'}
                onClick={() => props.onSendTestNotification?.()}
              >
                发送测试通知
              </button>
              <span style={MUTED}>点一次看 Windows 右下角/托盘；不占当天日报。</span>
            </div>
          </section>
        ) : null}

        {has('about') ? (
          <section data-testid="settings-about">
            <h3>关于</h3>
            <p>ai-company —— 本地优先 · 无服务端 · BYO-key；对话、任务、账本都在本机（~/.aico），数据不上传。</p>
            <details data-testid="settings-seams">
              <summary>接缝矩阵（本项目 · 只读）</summary>
              {props.seams ? (
                <>
                  <ul>
                    {props.seams.boundaries.map((boundary) => {
                      const row = props.seams?.rows.find((r) => r.boundary === boundary);
                      return (
                        <li key={boundary} data-testid="settings-seam" data-boundary={boundary} data-status={row?.status ?? 'unregistered'}>
                          {boundary} · {row ? `${row.status}${row.coverageRef ? ` · ${row.coverageRef}` : ''}` : '未登记'}
                        </li>
                      );
                    })}
                  </ul>
                  {props.seams.missing.length > 0 ? (
                    <p data-testid="settings-seams-missing" style={MUTED}>
                      未登记边界：{props.seams.missing.join(' / ')}
                    </p>
                  ) : null}
                </>
              ) : (
                <p style={MUTED}>接缝矩阵未接线（seams:list 不可用）。</p>
              )}
            </details>
            <div style={{ ...ROW, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 88 }}>自动更新</span>
              <span data-testid="settings-update-status" style={{ flex: 1, minWidth: 180 }}>
                {props.updateStatus?.message ?? '更新状态未就绪'}
              </span>
              <button
                type="button"
                data-testid="settings-update-check"
                disabled={!props.onCheckUpdate || props.updateStatus?.canCheck === false}
                title={props.onCheckUpdate ? '向 GitHub Releases 检查新版本' : '未接线'}
                onClick={() => props.onCheckUpdate?.()}
              >
                {props.updateStatus?.phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
              {props.updateStatus?.canDownload === true ? (
                <button
                  type="button"
                  data-testid="settings-update-download"
                  disabled={!props.onDownloadUpdate}
                  title={props.onDownloadUpdate ? '手动下载新版本（不自动下载/安装）' : '未接线'}
                  onClick={() => props.onDownloadUpdate?.()}
                >
                  下载更新
                </button>
              ) : null}
              {props.updateStatus?.canInstall === true ? (
                <button type="button" data-testid="settings-update-install" onClick={() => props.onInstallUpdate?.()}>
                  重启安装
                </button>
              ) : null}
            </div>
            <p style={MUTED}>版本号 / 更新日志 / 许可致谢 / 反馈入口：见上方自动更新与数据目录；其余暂未开放。</p>
          </section>
        ) : null}
      </div>
        }
      />
    </div>
  );
}
