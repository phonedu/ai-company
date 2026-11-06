/**
 * M2-A · `OPT-EXT-6`「UI 现场恢复」**纯逻辑 + 本地存储**。
 *
 * 口径（3185）：**重启回到上次视图**；**恢复态失真时回落 `channel`**（如 `selectedTaskId` 已不存在）
 * ——**不许白屏/空壳**。存储**复用 `localStorage` 那套**（`settings:*` 是 `notImplemented` 桩，不用）；
 * **登记**：等 `settings:*` 真落地后把本游标迁过去（与 `inboxCursor` 同源缺口）。
 * 无 `localStorage` 环境安全降级（读 `null`、写 no-op），**不抛**。
 */
export type RestorableView = 'channel' | 'task' | 'hall' | 'inbox' | 'project' | 'employee' | 'settings' | 'projects' | 'archive';

export interface ViewState {
  view: RestorableView;
  selectedTaskId: number | null;
  selectedProjectId: number | null;
  /** D-5 补位 ①：员工工位页的选中员工（失真 → 回落 `channel`，同 task/project 口径）。 */
  selectedEmployeeId: number | null;
}

const KEY = 'aico.session.view';
const VIEWS: readonly RestorableView[] = ['channel', 'task', 'hall', 'inbox', 'project', 'employee', 'settings', 'projects', 'archive'];

export const DEFAULT_VIEW: ViewState = { view: 'channel', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读上次视图；无/非法 → `null`（由调用方回落到 `channel`）。 */
export function loadViewState(): ViewState | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    const view = o.view;
    if (typeof view !== 'string' || !VIEWS.includes(view as RestorableView)) return null;
    return {
      view: view as RestorableView,
      selectedTaskId: typeof o.selectedTaskId === 'number' ? o.selectedTaskId : null,
      selectedProjectId: typeof o.selectedProjectId === 'number' ? o.selectedProjectId : null,
      selectedEmployeeId: typeof o.selectedEmployeeId === 'number' ? o.selectedEmployeeId : null,
    };
  } catch {
    return null;
  }
}

/** 写上次视图（切视图时调用）。失败静默降级（不阻断 UI）。 */
export function saveViewState(state: ViewState): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 存储不可用不致命 */
  }
}

/**
 * **失真判定**：给定"现存 task/project/employee id 集合"，决定真正落到哪个视图。
 * - `task`：id 存在 → 恢复；否则 → **回落 `channel`**。
 * - `project`（旧游标；2026-10-17 起并入 `projects` 页）→ 映射 **`projects`**（项目名选中；id 失真 ⇒ 项目树页空选）。
 * - `projects`：项目树页；`selectedProjectId` 存在则保留右栏选中，否则进页后自动选第一个。
 * - `employee`（员工设置）：id 存在 → 恢复；否则 → **回落 `channel`**。
 * - `channel`/`hall`/`inbox`/`settings`/`archive`：无选中依赖 → 原样恢复。
 * - `saved === null` / 未知 → `channel`。
 */
export function resolveView(
  saved: ViewState | null,
  existingTaskIds: ReadonlySet<number>,
  existingProjectIds: ReadonlySet<number>,
  existingEmployeeIds: ReadonlySet<number> = new Set(),
): ViewState {
  if (!saved) return DEFAULT_VIEW;
  if (saved.view === 'task') {
    return saved.selectedTaskId != null && existingTaskIds.has(saved.selectedTaskId)
      ? { view: 'task', selectedTaskId: saved.selectedTaskId, selectedProjectId: null, selectedEmployeeId: null }
      : DEFAULT_VIEW;
  }
  if (saved.view === 'project' || saved.view === 'projects') {
    const projectId =
      saved.selectedProjectId != null && existingProjectIds.has(saved.selectedProjectId) ? saved.selectedProjectId : null;
    return { view: 'projects', selectedTaskId: null, selectedProjectId: projectId, selectedEmployeeId: null };
  }
  if (saved.view === 'employee') {
    return saved.selectedEmployeeId != null && existingEmployeeIds.has(saved.selectedEmployeeId)
      ? { view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: saved.selectedEmployeeId }
      : DEFAULT_VIEW;
  }
  // 2026-10-26（频道范围选择器）：频道等视图恢复时保留范围（项目仍存在才有效；失效回落公司）。
  const scopeId =
    saved.selectedProjectId != null && existingProjectIds.has(saved.selectedProjectId) ? saved.selectedProjectId : null;
  return { view: saved.view, selectedTaskId: null, selectedProjectId: scopeId, selectedEmployeeId: null };
}
