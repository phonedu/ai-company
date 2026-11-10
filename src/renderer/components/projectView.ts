/**
 *  · 「项目分组 + 项目概览」**纯逻辑**（无 React/DOM/存储依赖，可单测）。
 *
 * 口径（3152 = 裁定 (A′)）：
 *  - **项目树分组**：以 `project:list` 为准（空项目也显示），再用 `task:list` 补任务与计数；
 *  - `projectsFromTasks` 保留给只看任务分组的旧口径（空项目不入）；
 *  - **计数同源**：组内 `taskCount === tasks.length`（页面数字必须与列表行数一致）。
 */
import type { ProjectDTO, TaskDTO } from '../types.js';

export interface ProjectGroup {
  projectId: number;
  /** 项目名（缺省 `项目 #<id>`，**不臆造**）。 */
  name: string;
  alias: string | null;
  tasks: TaskDTO[];
  /** = `tasks.length`（同源计数，供页面直接渲染，避免 UI 自己再数一遍导致不一致）。 */
  taskCount: number;
  /** P2：第二读数——执行中/待你处理/失败，全部由同一份 tasks 派生（不新建空壳字段）。 */
  runningCount: number;
  waitingCount: number;
  failedCount: number;
}

/** P2：组内第二读数（执行中 / 待确认处理 / 失败）——纯派生，与 taskCount 同源。 */
const WAITING_STATES = new Set(['needs_decision', 'awaiting_approval']);
export function taskStats(tasks: readonly TaskDTO[]): { runningCount: number; waitingCount: number; failedCount: number } {
  let runningCount = 0;
  let waitingCount = 0;
  let failedCount = 0;
  for (const task of tasks) {
    if (task.state === 'executing' || task.state === 'planning' || task.state === 'verifying') runningCount += 1;
    else if (WAITING_STATES.has(task.state)) waitingCount += 1;
    else if (task.state === 'failed') failedCount += 1;
  }
  return { runningCount, waitingCount, failedCount };
}

function withStats(group: ProjectGroup): ProjectGroup {
  return { ...group, ...taskStats(group.tasks) };
}

/** 把任务按项目归并（**空项目不入**；按 `projectId` 升序）。 */
export function projectsFromTasks(tasks: readonly TaskDTO[]): ProjectGroup[] {
  const map = new Map<number, ProjectGroup>();
  for (const task of tasks) {
    const group =
      map.get(task.projectId) ??
      ({
        projectId: task.projectId,
        name: task.projectName ?? `项目 #${task.projectId}`,
        alias: task.projectAlias ?? null,
        tasks: [],
        taskCount: 0,
        runningCount: 0,
        waitingCount: 0,
        failedCount: 0,
      } satisfies ProjectGroup);
    group.tasks.push(task);
    group.taskCount = group.tasks.length;
    map.set(task.projectId, group);
  }
  return [...map.values()].map(withStats).sort((a, b) => a.projectId - b.projectId);
}

/**
 * 项目树分组（2026-10-17 真机修复）：**以项目列表为准**，空项目也显示；
 * 任务只用来填 tasks/taskCount。项目列表尚未加载时，任务里的项目仍先成组（不白屏）。
 * 已归档项目不显示（项目归档为软操作；任务仍可在归档页看）。
 */
export function projectsFromList(
  projects: readonly ProjectDTO[],
  tasks: readonly TaskDTO[],
): ProjectGroup[] {
  const archivedIds = new Set(projects.filter((project) => project.archived === 1).map((project) => project.id));
  const map = new Map<number, ProjectGroup>();
  for (const project of projects) {
    if (project.archived === 1) continue;
    map.set(project.id, {
      projectId: project.id,
      name: project.name,
      alias: project.alias,
      tasks: [],
      taskCount: 0,
      runningCount: 0,
      waitingCount: 0,
      failedCount: 0,
    });
  }
  for (const task of tasks) {
    if (task.archived === 1 || archivedIds.has(task.projectId)) continue;
    const group =
      map.get(task.projectId) ??
      ({
        projectId: task.projectId,
        name: task.projectName ?? `项目 #${task.projectId}`,
        alias: task.projectAlias ?? null,
        tasks: [],
        taskCount: 0,
        runningCount: 0,
        waitingCount: 0,
        failedCount: 0,
      } satisfies ProjectGroup);
    group.tasks.push(task);
    group.taskCount = group.tasks.length;
    map.set(task.projectId, group);
  }
  return [...map.values()].map(withStats).sort((a, b) => a.projectId - b.projectId);
}

/**
 * 归档项目分组（-12）：项目树折叠区用；任务计数＝该项目下**全部**任务（含已归档任务），
 * 不写死 0。别处仍不显示归档项目（`projectsFromList` 保持原口径）。
 */
export function archivedProjectsFromList(
  projects: readonly ProjectDTO[],
  tasks: readonly TaskDTO[],
): ProjectGroup[] {
  return projects
    .filter((project) => project.archived === 1)
    .map((project) => {
      const rows = tasks.filter((task) => task.projectId === project.id);
      return {
        projectId: project.id,
        name: project.name,
        alias: project.alias,
        tasks: rows,
        taskCount: rows.length,
        ...taskStats(rows),
      } satisfies ProjectGroup;
    })
    .sort((a, b) => a.projectId - b.projectId);
}

/** 状态分组顺序（与左栏一致；仅用于概览展示）。 */
export const PROJECT_STATE_ORDER = [
  'executing',
  'ready',
  'awaiting_approval',
  'verifying',
  'planning',
  'inbox',
  'needs_decision',
  'blocked',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;

/** 状态 → 中文标签（**镜像 `LeftRail.STATE_LABEL` 的 12 态**；`test/project-view.test.ts` 守住 12 键）。 */
export const PROJECT_STATE_LABEL: Record<string, string> = {
  inbox: '待分诊',
  planning: '规划中',
  awaiting_approval: '待批准',
  ready: '排队',
  executing: '执行中',
  paused: '暂停',
  verifying: '验收中',
  done: '完成',
  failed: '失败',
  cancelled: '取消',
  needs_decision: '待决策',
  blocked: '阻塞',
};

/** 项目内任务按状态分组（按 `PROJECT_STATE_ORDER` 排序；未知状态排末尾、原样标签）。 */
export function groupProjectTasks(tasks: readonly TaskDTO[]): Array<{ state: string; label: string; tasks: TaskDTO[] }> {
  const map = new Map<string, TaskDTO[]>();
  for (const task of tasks) {
    const bucket = map.get(task.state) ?? [];
    bucket.push(task);
    map.set(task.state, bucket);
  }
  return [...map.entries()]
    .sort((a, b) => {
      const ai = PROJECT_STATE_ORDER.indexOf(a[0] as (typeof PROJECT_STATE_ORDER)[number]);
      const bi = PROJECT_STATE_ORDER.indexOf(b[0] as (typeof PROJECT_STATE_ORDER)[number]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .map(([state, ts]) => ({ state, label: PROJECT_STATE_LABEL[state] ?? state, tasks: ts }));
}

/** 「未接入」项（3152：**不要摆空壳卡片**，只留一行说清；D-5 ③ 更新：归档已就位）。 */
export const PROJECT_OVERVIEW_UNIMPLEMENTED =
  '项目级操作：归档/恢复项目已就位（本页）；「注意力 / 放行档 / 重新定位」与「产物库 / IM 绑定」未实现。';

/** D-5 ③：项目级操作状态（概览页动作区；纯函数可测）。 */
export type ProjectActionState = 'active' | 'archived' | 'unknown';

/** `unknown`＝列表未到/项目行不存在 → **不摆动作按钮、不臆造状态**（只留任务列表）。 */
export function projectActionState(project: { archived: number } | null | undefined): ProjectActionState {
  if (!project) return 'unknown';
  return project.archived === 1 ? 'archived' : 'active';
}

// ── §7 序 4：文档健康（面板；纯函数可测）──────────────────

export interface DocsHealthResultLike {
  docRoot: string;
  hasDocsTree: boolean;
  truncated: boolean;
  counts: { live: number; archive: number; dangling: number; oversized: number; issues: number };
  issues: Array<{ kind: string; path: string; message: string }>;
}

export type DocsHealthState = 'idle' | 'busy' | 'error' | 'no-tree' | 'ok';

/** issue kind → 人话（未知 kind 原样显示，不吞）。 */
export const DOC_ISSUE_KIND_LABEL: Record<string, string> = {
  entry: '入口',
  header: '头注',
  index: '索引',
  ref: '引用',
  dirlink: '目录链接',
  size: '体量',
  naming: '命名',
};

export interface DocsHealthIssueItem {
  kind: string;
  kindLabel: string;
  path: string;
  message: string;
}

export interface DocsHealthView {
  state: DocsHealthState;
  /** 一行读数（`state==='ok'` 时）；其余状态给如实说明。 */
  text: string;
  /** 最多 3 条 issue 人话（兼容旧一行读数；完整明细看 `items`）。 */
  issues: string[];
  /** 未展示的其余条数（0 ⇒ 没有"更多"）。 */
  more: number;
  /** 完整计数（仅 `state==='ok'`；其余为 `null`，不显假 0）。 */
  counts: DocsHealthResultLike['counts'] | null;
  /** 全量 issue 明细（后端单次最多 50 条；仍可能被 `counts.issues` 超过）。 */
  items: DocsHealthIssueItem[];
  /** 文件数超上限（检查器已截断）——如实标注。 */
  truncated: boolean;
  /** 文档根（相对项目根）。 */
  docRoot: string;
}

/**
 * 文档健康**面板**的渲染判定（唯一口径；组件只贴文本）。
 * 反"假读数"红线：① 未检查/换项目后 ⇒ `idle`（不沿用上一个项目的结果）；② 无文档树 ⇒ `no-tree`（**不显 0**，
 * 零悬空会被读成"健康"）；③ 检查失败 ⇒ `error`（不静默）；④ 截断如实标注；⑤ 明细不截成一行（面板看全）。
 */
export function docsHealthView(input: {
  status: 'idle' | 'busy';
  error: string | null;
  result: DocsHealthResultLike | null;
  /** 结果属于哪个项目（`null`＝还没结果）。 */
  resultProjectId: number | null;
  /** 当前正在看的项目。 */
  selectedProjectId: number | null;
}): DocsHealthView {
  const empty = (state: DocsHealthState, text: string, docRoot = '.aico/docs'): DocsHealthView => ({
    state,
    text,
    issues: [],
    more: 0,
    counts: null,
    items: [],
    truncated: false,
    docRoot,
  });
  if (input.status === 'busy') return empty('busy', '检查中…');
  if (input.error !== null) return empty('error', input.error);
  const fresh = input.result !== null && input.resultProjectId !== null && input.resultProjectId === input.selectedProjectId;
  if (!fresh) return empty('idle', '尚未检查（点「检查文档」跑一次只读结构检查）');
  const r = input.result as DocsHealthResultLike;
  if (!r.hasDocsTree) {
    return empty(
      'no-tree',
      `无 ${r.docRoot} 文档树（新建项目时可勾选初始化；本页不做假读数）`,
      r.docRoot,
    );
  }
  const { live, archive, dangling, oversized } = r.counts;
  const suffix = r.truncated ? '（文件数超上限，已截断）' : '';
  const text = `活文档 ${live} · 归档 ${archive} · 悬空 ${dangling} · 超线 ${oversized}${suffix}`;
  const items = r.issues.map((issue) => ({
    kind: issue.kind,
    kindLabel: DOC_ISSUE_KIND_LABEL[issue.kind] ?? issue.kind,
    path: issue.path,
    message: issue.message,
  }));
  return {
    state: 'ok',
    text,
    issues: items.slice(0, 3).map((item) => item.message),
    more: Math.max(0, r.counts.issues - items.length),
    counts: r.counts,
    items,
    truncated: r.truncated,
    docRoot: r.docRoot,
  };
}

// ──：一键整理预览（纯函数；UI 只贴 diff）────────────────────

export interface DocsOrganizeChangeLike {
  path: string;
  before: string | null;
  after: string;
  added: readonly string[];
}

/**
 * 生成“将追加什么”的可复核 diff（本项目只追加，不删改）。
 * - 新建文件：全部行标 `+`；
 * - 已有文件：只展示 `after` 相对 `before` 的追加部分（`before` 是 `after` 前缀时）；
 * - 超长截断并如实标注（不静默丢）。
 */
export function docsOrganizeDiff(change: DocsOrganizeChangeLike): { text: string; truncated: boolean } {
  const header = change.before === null ? `+++ ${change.path}（新建）` : `--- ${change.path}（现有，只追加）`;
  let appended = change.after;
  if (change.before !== null && change.after.startsWith(change.before)) {
    appended = change.after.slice(change.before.length);
  }
  const lines = [header, ...appended.split('\n').map((line) => `+ ${line}`)];
  const MAX_LINES = 80;
  const truncated = lines.length > MAX_LINES;
  return { text: lines.slice(0, MAX_LINES).join('\n'), truncated };
}

// ── 编制 v1：项目三项缺省（概览「编制」卡与建任务对话框预填共用的纯口径）──────────

/** 全未设置时的显式读法（**不臆造**默认人名/默认档；「按缺省链」＝规划者→项目默认员工→负责人→幕僚长）。 */
export const STAFFING_UNSET_TEXT = '未设置——按项目默认';

/** 档位 → 人话（与建任务对话框档位下拉同款文案；`null`＝未设置）。 */
export const STAFFING_TIER_LABEL: Record<0 | 1 | 2, string> = {
  0: '直通 L0',
  1: '审计划 L1',
  2: '全流程 L2',
};

export interface StaffingForm {
  ownerEmployeeId: number | null;
  defaultEmployeeId: number | null;
  defaultRiskTier: 0 | 1 | 2 | null;
}

export interface StaffingProjectLike {
  id: number;
  archived?: number | null;
  defaultOwnerId?: number | null;
  defaultRiskTier?: number | null;
}

/**
 * 编制预填落点：**显式项目优先**（项目页对话框传 `projectId`）→ **active 默认项目** → 判不出。
 *
 * 必须与主进程 `getDefaultProject()` 同口径：无显式项目时**只看 `projects.default_id` 且必须是 active**；
 * 不拿"唯一未归档项目"猜落点（主进程不会这样做，会新建「默认项目」→ 预填与实际落库不一致）。
 * 返回 `project` 可能为 null（项目不在当前列表快照里；调用方可用 `project:get` 真读）。
 */
export function resolveStaffingProject(
  projects: readonly StaffingProjectLike[],
  explicitProjectId: number | null,
  defaultProjectId: number | null,
): { projectId: number | null; project: StaffingProjectLike | null } {
  let pid: number | null = explicitProjectId;
  if (pid == null && defaultProjectId != null) {
    const def = projects.find((p) => p.id === defaultProjectId);
    if (def && def.archived !== 1) pid = def.id;
  }
  return { projectId: pid, project: pid == null ? null : (projects.find((p) => p.id === pid) ?? null) };
}

/** 从项目 DTO 取编制表单值（缺字段/坏值 ⇒ `null`——未设置，不臆造）。 */
export function staffingFromProject(
  project:
    | { defaultOwnerId?: number | null; defaultEmployeeIds?: readonly number[] | null; defaultRiskTier?: number | null }
    | null
    | undefined,
): StaffingForm {
  const ids = Array.isArray(project?.defaultEmployeeIds) ? project.defaultEmployeeIds : ([] as readonly number[]);
  const first = ids.find((v): v is number => typeof v === 'number');
  const tier = project?.defaultRiskTier;
  return {
    ownerEmployeeId: typeof project?.defaultOwnerId === 'number' ? project.defaultOwnerId : null,
    defaultEmployeeId: typeof first === 'number' ? first : null,
    defaultRiskTier: tier === 0 || tier === 1 || tier === 2 ? tier : null,
  };
}

/**
 * 只读摘要（概览卡一行）：全部未设置 ⇒ 显式「未设置——按缺省链」；部分设置 ⇒ **只把未设置项**写「未设置」
 * （不把已设置项的默认值渲染到别处；`nameOf` 查不到名字 → 如实 `#id`）。
 */
export function staffingSummary(
  form: StaffingForm,
  nameOf: (id: number) => string | null,
): { text: string; unset: boolean } {
  const unset = form.ownerEmployeeId == null && form.defaultEmployeeId == null && form.defaultRiskTier == null;
  if (unset) return { text: STAFFING_UNSET_TEXT, unset: true };
  const name = (id: number | null): string => (id == null ? '未设置' : (nameOf(id) ?? `#${id}`));
  return {
    text: [
      `负责人：${name(form.ownerEmployeeId)}`,
      `默认执行：${name(form.defaultEmployeeId)}`,
      `默认档：${form.defaultRiskTier == null ? '未设置' : STAFFING_TIER_LABEL[form.defaultRiskTier]}`,
    ].join(' · '),
    unset: false,
  };
}
