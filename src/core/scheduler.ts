/**
 * 调度器：两层资源模型（PLAN §13.3）
 *
 *   第一层 · 全局活跃槽位：同时处于 executing 的任务数 ≤ maxActiveTasks；
 *   第二层 · 员工占用队列：每员工并发 1，queued 的 work item 按【任务优先级 → 创建时间】派发。
 *
 * 规则一句话：任务抢的是"槽位"，员工抢的是"队列" —— 两层解耦，任何一层拥堵都能在 UI 上看见原因。
 *
 * 输出是【决议（Action）】，不产生副作用：调用方（编排器）在事务内应用决议并落 task_events，
 * 然后**再跑一次**直到没有新决议（fixpoint），因为 activate/start 会解锁后续派发。
 *
 * 纯函数：给定快照，输出确定 —— 可脱离数据库单测。
 */

import type { TaskSnapshot, TaskState, WaitingReason, WorkItemSnapshot } from './types.js';

export interface SchedulerConfig {
  /** 同时处于 executing 的任务上限（全局活跃槽位） */
  maxActiveTasks: number;
  /** 等待老化的时间粒度（分钟）：每等满这么久，有效优先级 +1 */
  agingMinutes: number;
  /** 老化加分上限（防"无限老化"压过一切） */
  agingCap: number;
  /** true = 取槽位前先确认该任务至少有一个可立即派发的 work item（避免空占槽位） */
  occupancyAware: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxActiveTasks: 3,
  agingMinutes: 30,
  agingCap: 5,
  occupancyAware: false,
};

export interface SchedulerInput {
  now: number;
  config?: Partial<SchedulerConfig>;
  tasks: TaskSnapshot[];
  workItems: WorkItemSnapshot[];
  /** taskId -> 它依赖的 task id 列表（task_deps） */
  deps: Map<number, number[]>;
  /** B2-3/D-30②：workItemId -> 前置 work item id 列表（work_item_deps；同任务内）。缺省空 → 无门控（旧调用兼容）。 */
  workItemDeps?: Map<number, number[]>;
  /** employeeId -> 正在执行的 work item id（员工并发 = 1） */
  runningByEmployee: Map<number, number>;
}

export type SchedulerAction =
  | { type: 'activate_task'; taskId: number; reason: 'deps_satisfied' }
  | { type: 'block_task'; taskId: number; reason: 'deps_unsatisfied' }
  | { type: 'start_task'; taskId: number }
  | { type: 'dispatch_work_item'; workItemId: number; taskId: number; employeeId: number }
  | { type: 'advance_parent'; taskId: number }
  /** `occupiedBy`＝占用该员工的 work item id（仅 employee_busy；MP1-3「含占用任务短号」的数据源）。 */
  | { type: 'hold'; taskId: number; reason: WaitingReason; occupiedBy?: number };

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled']);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/** 依赖是否全部满足：依赖任务不存在（幻影）按满足处理（fail-open，不永远卡死）；否则必须终态。 */
export function dependenciesSatisfied(
  taskId: number,
  deps: ReadonlyMap<number, number[]>,
  byId: ReadonlyMap<number, TaskSnapshot>,
): boolean {
  const list = deps.get(taskId) ?? [];
  return list.every((d) => {
    const dep = byId.get(d);
    return dep == null || isTerminal(dep.state);
  });
}

/** 有效优先级 = 优先级 + 老化分（等待越久越不容易被饿死）。 */
export function effectivePriority(task: TaskSnapshot, now: number, cfg: SchedulerConfig): number {
  const since = task.readySince ?? task.createdAt;
  const waitedMin = Math.max(0, now - since) / 60_000;
  const aging = Math.min(cfg.agingCap, Math.floor(waitedMin / cfg.agingMinutes));
  return task.priority + aging;
}

function overBudget(t: TaskSnapshot): boolean {
  // 超预算只暂停该任务自己，不影响其他任务（PLAN §13.3）
  return t.budgetLeftTokens != null && t.budgetLeftTokens <= 0;
}

export function planScheduling(input: SchedulerInput): SchedulerAction[] {
  const cfg: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...input.config };
  const actions: SchedulerAction[] = [];
  const byId = new Map(input.tasks.map((t) => [t.id, t]));

  // ── 1. 依赖激活：blocked 且依赖全部满足 → ready ──────────────────
  for (const t of input.tasks) {
    if (t.state !== 'blocked') continue;
    if (dependenciesSatisfied(t.id, input.deps, byId)) {
      actions.push({ type: 'activate_task', taskId: t.id, reason: 'deps_satisfied' });
    }
  }

  // ── 2. 子任务全部完成 → 父任务推进 verifying（由调用方执行）───────
  const childrenOf = new Map<number, number[]>();
  for (const t of input.tasks) {
    if (t.parentTaskId == null) continue;
    const list = childrenOf.get(t.parentTaskId) ?? [];
    list.push(t.id);
    childrenOf.set(t.parentTaskId, list);
  }
  for (const [parentId, childIds] of childrenOf) {
    const parent = byId.get(parentId);
    if (!parent || parent.state !== 'executing') continue;
    const allDone = childIds.every((cid) => byId.get(cid)?.state === 'done');
    if (allDone) actions.push({ type: 'advance_parent', taskId: parentId });
  }

  // ── 3. 取槽位：ready → executing ────────────────────────────────
  const executingNow = input.tasks.filter((t) => t.state === 'executing').length;
  let slotsFree = Math.max(0, cfg.maxActiveTasks - executingNow);

  const queuedByTask = new Map<number, WorkItemSnapshot[]>();
  for (const wi of input.workItems) {
    if (wi.state !== 'queued') continue;
    const list = queuedByTask.get(wi.taskId) ?? [];
    list.push(wi);
    queuedByTask.set(wi.taskId, list);
  }
  const busyEmployees = new Set(input.runningByEmployee.keys());

  const priorityOrder = (a: TaskSnapshot, b: TaskSnapshot): number =>
    effectivePriority(b, input.now, cfg) - effectivePriority(a, input.now, cfg) ||
    (a.deadline ?? Number.POSITIVE_INFINITY) - (b.deadline ?? Number.POSITIVE_INFINITY) ||
    (a.readySince ?? a.createdAt) - (b.readySince ?? b.createdAt);

  const ready = input.tasks.filter((t) => t.state === 'ready').sort(priorityOrder);
  const startedThisTick: TaskSnapshot[] = [];
  for (const t of ready) {
    // D4：依赖未满足 → 先阻塞（ready --block--> blocked），不占槽位、不派工；依赖完成后下一拍激活。
    if (!dependenciesSatisfied(t.id, input.deps, byId)) {
      actions.push({ type: 'block_task', taskId: t.id, reason: 'deps_unsatisfied' });
      continue;
    }
    if (slotsFree === 0) {
      actions.push({ type: 'hold', taskId: t.id, reason: 'no_slot' });
      continue;
    }
    if (overBudget(t)) {
      actions.push({ type: 'hold', taskId: t.id, reason: 'budget' });
      continue;
    }
    const items = queuedByTask.get(t.id) ?? [];
    if (
      cfg.occupancyAware &&
      items.length > 0 &&
      !items.some((wi) => !busyEmployees.has(wi.employeeId))
    ) {
      const occupiedBy = input.runningByEmployee.get(items[0].employeeId);
      actions.push({ type: 'hold', taskId: t.id, reason: 'employee_busy', ...(occupiedBy != null ? { occupiedBy } : {}) });
      continue;
    }
    actions.push({ type: 'start_task', taskId: t.id });
    startedThisTick.push(t);
    slotsFree -= 1;
  }

  // ── 4. 派发 work item：员工占用队列 ──────────────────────────────
  const dispatching = input.tasks
    .filter((t) => t.state === 'executing' || startedThisTick.some((s) => s.id === t.id))
    .sort(priorityOrder);

  const wiById = new Map(input.workItems.map((w) => [w.id, w]));
  const wiDeps = input.workItemDeps ?? new Map<number, number[]>();
  for (const t of dispatching) {
    if (overBudget(t)) {
      actions.push({ type: 'hold', taskId: t.id, reason: 'budget' });
      continue;
    }
    const items = (queuedByTask.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    let heldEmployeeBusy = false;
    let heldOccupiedBy: number | undefined;
    for (const wi of items) {
      // B2-3/D-30②：工作项依赖门控——前置件未全部 done → hold（不占员工、任务不被 block）；
      // 前置件幻影按满足处理（fail-open，与任务级 dependenciesSatisfied 同哲学）。
      const wiDepsList = wiDeps.get(wi.id) ?? [];
      const depsSatisfied = wiDepsList.every((d) => {
        const dep = wiById.get(d);
        return dep == null || dep.state === 'done';
      });
      if (!depsSatisfied) {
        actions.push({ type: 'hold', taskId: t.id, reason: 'dependency' });
        continue;
      }
      if (busyEmployees.has(wi.employeeId)) {
        heldEmployeeBusy = true;
        heldOccupiedBy ??= input.runningByEmployee.get(wi.employeeId);
        continue;
      }
      busyEmployees.add(wi.employeeId);
      actions.push({
        type: 'dispatch_work_item',
        workItemId: wi.id,
        taskId: t.id,
        employeeId: wi.employeeId,
      });
    }
    if (heldEmployeeBusy) {
      actions.push({ type: 'hold', taskId: t.id, reason: 'employee_busy', ...(heldOccupiedBy != null ? { occupiedBy: heldOccupiedBy } : {}) });
    }
  }

  return dedupeHolds(actions);
}

function dedupeHolds(actions: SchedulerAction[]): SchedulerAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    if (a.type !== 'hold') return true;
    const key = `${a.taskId}:${a.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
