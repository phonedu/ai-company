/**
 * M2-D · staging worktree 清理策略（`PLAN §929`「staging 沙盒清理策略」）。
 *
 * 口径（**只清确定没人要的**，其余一律保留并**给出保留原因**——不静默删、不误删在办）：
 *  - **可清**：① 任务已终态（`done`/`failed`/`cancelled`）**且** `now - tasks.updated_at > maxAgeDays`；
 *    ② **孤儿**（worktree 存在但库里没有对应任务——任务永不复用短号，故孤儿只能是历史遗留）。
 *  - **保留**：任务非终态（可能还在跑）｜终态但未过期（留出合并/审查窗口）｜查不到任务的年龄信息。
 *  - 台账 = `git worktree list` 推导（`WorktreeManager.list()`；零 schema 变更），`remove` 保留分支。
 *
 * 纯规划函数（`planWorktreePrune`，可 node 测）＋ 执行器（`pruneStagingWorktrees`，逐个 remove）。
 */
import type { WorktreeInfo } from './worktree.js';

/** 任务终态（可进入清理候选；非终态一律保留）。 */
export const TERMINAL_TASK_STATES = ['done', 'failed', 'cancelled'] as const;

export interface WorktreeTaskInfo {
  state: string;
  updatedAt: number;
}

export interface WorktreePruneInput {
  /** 终态任务的保留窗口（天）——小于此年龄的终态任务 worktree 保留（合并/审查还来得及）。 */
  maxAgeDays: number;
  now: number;
}

export interface WorktreePrunePlan {
  prunable: Array<{ shortId: string; path: string; reason: 'task_closed' | 'no_task'; ageMs: number | null }>;
  kept: Array<{ shortId: string; reason: 'active' | 'recent' | 'unknown_task' }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 纯规划：谁能清、谁保留（保留必须带原因——日志里要看得见为什么不删）。 */
export function planWorktreePrune(
  entries: readonly WorktreeInfo[],
  lookup: (shortId: string) => WorktreeTaskInfo | null,
  input: WorktreePruneInput,
): WorktreePrunePlan {
  const plan: WorktreePrunePlan = { prunable: [], kept: [] };
  const ageLimit = input.maxAgeDays * DAY_MS;
  for (const e of entries) {
    const task = lookup(e.taskShortId);
    if (!task) {
      plan.prunable.push({ shortId: e.taskShortId, path: e.path, reason: 'no_task', ageMs: null });
      continue;
    }
    if (!(TERMINAL_TASK_STATES as readonly string[]).includes(task.state)) {
      plan.kept.push({ shortId: e.taskShortId, reason: 'active' });
      continue;
    }
    const ageMs = Math.max(0, input.now - task.updatedAt);
    if (ageMs <= ageLimit) {
      plan.kept.push({ shortId: e.taskShortId, reason: 'recent' });
      continue;
    }
    plan.prunable.push({ shortId: e.taskShortId, path: e.path, reason: 'task_closed', ageMs });
  }
  return plan;
}

export interface WorktreePruneManager {
  list(): WorktreeInfo[];
  remove(shortId: string): boolean;
}

export interface WorktreePruneResult {
  removed: string[];
  kept: WorktreePrunePlan['kept'];
}

/** 执行清理：按规划逐个 `remove`（保留分支）；每个动作都进返回值（调用方负责打日志——不静默）。 */
export function pruneStagingWorktrees(
  manager: WorktreePruneManager,
  lookup: (shortId: string) => WorktreeTaskInfo | null,
  input: WorktreePruneInput,
): WorktreePruneResult {
  const plan = planWorktreePrune(manager.list(), lookup, input);
  const removed: string[] = [];
  for (const item of plan.prunable) {
    if (manager.remove(item.shortId)) removed.push(item.shortId);
  }
  return { removed, kept: plan.kept };
}
