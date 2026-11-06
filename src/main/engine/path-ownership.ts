/**
 * M1-2 · 文件所有权（`PLAN §10` 第 2 条 / `B-5 G-4`）：派发前**路径相交去重**的纯逻辑。
 *
 * 规则：同一 `projects.root_dir` 内，若候选工作项的 `touched_paths` 与**已占用**（`running` + 本轮已派发）
 * 相交 → **不并行派发**，改 `hold`（原因 `path_conflict`）。不同 `root_dir` 互不约束。
 * **粗粒度**：同文件 / 互为父目录路径即算冲突；**hunk 级**细粒度留给 worktree 那条（M1-5/M2）。
 */
import type { PathClaim } from '../db/index.js';
import type { WaitingReason } from '../../core/types.js';

/** 派发 hold 原因：统一走 `WaitingReason`（1603；`path_conflict` 即其一）。 */
export type DispatchHoldReason = WaitingReason;

const normalizePath = (p: string): string =>
  p.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/** 粗粒度相交：同一路径，或一个是另一个的父目录（`src/a.ts` vs `src` / `src/`）。 */
export function pathsIntersect(a: string[], b: string[]): boolean {
  for (const pa of a) {
    const na = normalizePath(pa);
    if (!na) continue;
    for (const pb of b) {
      const nb = normalizePath(pb);
      if (!nb) continue;
      if (na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)) return true;
    }
  }
  return false;
}

export interface PathConflict {
  workItemId: number;
  reason: WaitingReason;
  conflictsWith: number[];
  /** R3-2：给「等待可见」的人话补充（如「同任务并发已达上限 3」/「$ 4.10/h ≥ 软线 $3.00/h」）；无 → 省略。 */
  detail?: string;
}

/** 候选 vs 已占用集合：返回**相交**的 work item id 列表（不同 root_dir 不算冲突）。 */
export function pathConflictWith(candidate: PathClaim, occupied: PathClaim[]): number[] {
  return occupied
    .filter(
      (o) =>
        o.workItemId !== candidate.workItemId &&
        o.rootDir === candidate.rootDir &&
        pathsIntersect(candidate.paths, o.paths),
    )
    .map((o) => o.workItemId);
}
