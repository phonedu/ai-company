/**
 * 项目页「运行 / 产物」页签的数据拼装（纯函数，可单测）。
 *
 * 口径：数据全部来自 `task:get` 的只读投影（逐任务），本模块只做筛选/分组/排序，
 * 不读盘、不推断；空数组＝真的没有（调用方按空态渲染，不摆假 0）。
 */
import type { ReportDTO, TaskDTO } from '../types.js';
import type { TaskDetailDTO } from './TaskDetail.js';

/** 「活跃」＝任务还在流程里（含待批准/规划/等待/暂停），终态任务不再列入运行页。 */
export const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set([
  'inbox',
  'planning',
  'awaiting_approval',
  'ready',
  'executing',
  'verifying',
  'needs_decision',
  'blocked',
  'paused',
]);

export interface ProjectWorkItemRow {
  taskId: number;
  shortId: string | null;
  taskTitle: string;
  taskState: string;
  idx: number;
  text: string;
  state: string;
}

export interface ProjectArtifactRow {
  artifactId: number;
  taskId: number;
  shortId: string | null;
  taskTitle: string;
  kind: string;
  name: string;
  path: string;
  sha256: string | null;
  at: number;
  originProjectId: number | null;
  originProjectName: string | null;
}

export interface ProjectArtifactGroup {
  key: string;
  kind: string;
  path: string;
  latest: ProjectArtifactRow;
  older: ProjectArtifactRow[];
}

/** 活跃工作项：任务在流程中，且计划步骤未结束（done/skipped 视为结束）。 */
export function collectActiveWorkItems(details: readonly TaskDetailDTO[]): ProjectWorkItemRow[] {
  const rows: ProjectWorkItemRow[] = [];
  for (const detail of details) {
    const task = detail.task;
    if (!ACTIVE_TASK_STATES.has(task.state)) continue;
    for (const step of detail.planSteps) {
      if (step.state === 'done' || step.state === 'skipped') continue;
      rows.push({
        taskId: task.id,
        shortId: task.shortId ?? null,
        taskTitle: task.title,
        taskState: task.state,
        idx: step.idx,
        text: step.text,
        state: step.state,
      });
    }
  }
  rows.sort((a, b) => a.taskId - b.taskId || a.idx - b.idx);
  return rows;
}

/** 产物：跨任务摊平（只取产出类，输入附件归任务详情）。 */
export function collectProjectArtifacts(details: readonly TaskDetailDTO[]): ProjectArtifactRow[] {
  const rows: ProjectArtifactRow[] = [];
  for (const detail of details) {
    const task = detail.task;
    for (const artifact of detail.artifacts ?? []) {
      if (artifact.kind === 'input') continue;
      rows.push({
        artifactId: artifact.id,
        taskId: task.id,
        shortId: task.shortId ?? null,
        taskTitle: task.title,
        kind: artifact.kind,
        name: artifact.name,
        path: artifact.path,
        sha256: artifact.sha256 ?? null,
        at: artifact.at ?? 0,
        originProjectId: artifact.originProjectId ?? null,
        originProjectName: artifact.originProjectName ?? null,
      });
    }
  }
  rows.sort((a, b) => b.at - a.at || b.artifactId - a.artifactId);
  return rows;
}

/**
 * 产物分组：`kind|path|来源项目`——同一路径不同工作项各提交一次会留多行，
 * 默认只显示最新（at 大者；同 at 取 id 大者），旧版本进「历史版本（N）」。
 */
export function groupProjectArtifacts(rows: readonly ProjectArtifactRow[]): ProjectArtifactGroup[] {
  const groups = new Map<string, ProjectArtifactRow[]>();
  for (const row of rows) {
    const key = `${row.kind}|${row.path}|${row.originProjectId ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: ProjectArtifactGroup[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => b.at - a.at || b.artifactId - a.artifactId);
    out.push({ key, kind: sorted[0]!.kind, path: sorted[0]!.path, latest: sorted[0]!, older: sorted.slice(1) });
  }
  out.sort((a, b) => b.latest.at - a.latest.at || b.latest.artifactId - a.latest.artifactId);
  return out;
}

/** 三格·当前进展（派生摘要；调用方必须显式标「自动摘要」）。 */
export function progressSummary(tasks: readonly TaskDTO[]): {
  running: number;
  waiting: number;
  pendingStart: number;
  done: number;
  latest: TaskDTO | null;
} {
  let running = 0;
  let waiting = 0;
  let pendingStart = 0;
  let done = 0;
  let latest: TaskDTO | null = null;
  for (const task of tasks) {
    if (task.state === 'executing' || task.state === 'verifying') running += 1;
    else if (
      task.state === 'awaiting_approval' ||
      task.state === 'needs_decision' ||
      task.state === 'blocked' ||
      task.state === 'paused'
    ) {
      waiting += 1;
    } else if (task.state === 'inbox' || task.state === 'planning' || task.state === 'ready') pendingStart += 1;
    else if (task.state === 'done') done += 1;
    if (latest == null || (task.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = task;
  }
  return { running, waiting, pendingStart, done, latest };
}

/** 三格·待拍板：本项目未决卡（只认「需要你决定」的 ask 卡，通知类不算；按时间倒序）。 */
export function pendingCardsOfProject(cards: readonly ReportDTO[], projectId: number): ReportDTO[] {
  return cards
    .filter((card) => card.projectId === projectId && card.state === 'pending' && card.kind === 'ask')
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 产物的类型标签（真实 kind 是 file/url/snapshot/input，不直接给用户看英文）。 */
export function artifactKindLabel(kind: string): string {
  if (kind === 'image') return '图片';
  if (kind === 'doc') return '文档';
  if (kind === 'url') return '链接';
  if (kind === 'snapshot') return '快照';
  if (kind === 'input') return '输入';
  return '文件';
}

export interface LiveEmployeeRow {
  id: number;
  name: string;
  status: 'running' | 'waiting';
  currentAction: string | null;
  currentMinutes: number | null;
  taskId: number;
}
/** 三格·员工现场：大厅员工按「当前任务属于本项目」过滤（只取在跑/在等）。 */
export function liveEmployeesOfProject(
  employees: readonly {
    id: number;
    name: string;
    activity?: { status: string; currentAction: string | null; taskId?: number | null; currentMinutes?: number };
  }[],
  projectTaskIds: ReadonlySet<number>,
): LiveEmployeeRow[] {
  const rows: LiveEmployeeRow[] = [];
  for (const employee of employees) {
    const activity = employee.activity;
    if (!activity || activity.taskId == null) continue;
    if (activity.status !== 'running' && activity.status !== 'waiting') continue;
    if (!projectTaskIds.has(activity.taskId)) continue;
    rows.push({
      id: employee.id,
      name: employee.name,
      status: activity.status,
      currentAction: activity.currentAction,
      currentMinutes: activity.currentMinutes ?? null,
      taskId: activity.taskId,
    });
  }
  return rows;
}
