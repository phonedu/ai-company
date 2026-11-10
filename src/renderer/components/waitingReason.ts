/**
 *  · `waiting_reason` 渲染侧（` 第 4 条` · `B-5 G-9`「等待可见」）。
 *
 * **单一映射表**：枚举→文案只写这一份（`WAITING_REASON_TEXT`）；枚举本体是
 * `src/core/types.ts` 的 `WaitingReason`（**唯一权威，不另建第二份枚举**）。
 * **不推断**：渲染层绝不按 `task.state` 猜等待原因——原因**只来自引擎**（`task:get().waits`）。
 *
 * 文案口径（可被「弄红」的测试绑在这份表上）：`等待：<原因>` + 冲突对象 + 细节。
 */
import type { WaitingReason } from '../../core/types.js';

/** `task:get().waits[]` 的元素（在 `task` 域内提供；数据源 = 引擎 `listDispatchHolds()`/`evaluatePathHolds()`）。 */
export interface TaskWaitDTO {
  /** WI 级等待＝该件；任务级等待（等槽位/等预算/等员工空闲）＝`null`。 */
  workItemId: number | null;
  reason: WaitingReason | string;
  /** 供人读的补充（如「研究员正忙（T-1038）」）。 */
  detail?: string;
  /** 冲突的 work item id（如 `path_conflict`）。 */
  conflictsWith?: number[];
  /** 冲突对象的人类可读标识（如 `T-1001`）；有则优先用它。 */
  conflictsWithShortIds?: string[];
}

/** 枚举 → 文案（**唯一真源**；改这里即改全站显示）。 */
export const WAITING_REASON_TEXT: Record<WaitingReason | string, string> = {
  no_slot: '等槽位',
  employee_busy: '等员工空闲',
  budget: '等预算',
  resource_lock: '等资源锁',
  path_conflict: '路径冲突',
  dependency: '等前置任务',
  session_starting: '会话启动中',
  rate_limit: '限速排队',
  concurrency_limit: '并发已达上限',
};

/** 冲突对象的显示串（优先短号，其次 `#<workItemId>`）。 */
function conflictLabel(wait: TaskWaitDTO): string {
  if (wait.conflictsWithShortIds && wait.conflictsWithShortIds.length > 0) {
    return wait.conflictsWithShortIds.map((s) => `@${s}`).join('、');
  }
  if (wait.conflictsWith && wait.conflictsWith.length > 0) {
    return wait.conflictsWith.map((id) => `@#${id}`).join('、');
  }
  return '';
}

/** 一条等待的人话文案（`UI §1`「等待：研究员正忙」口径）。 */
export function waitingReasonText(wait: TaskWaitDTO): string {
  const label = WAITING_REASON_TEXT[wait.reason] ?? String(wait.reason);
  const conflict = conflictLabel(wait);
  const detail = wait.detail && wait.detail.length > 0 ? `（${wait.detail}）` : '';
  return `等待：${label}${conflict ? ` ${conflict}` : ''}${detail}`;
}

/** 任务级等待摘要（用于任务详情顶部一行；无等待 → 返回 null，渲染层据此不显示任何占位）。 */
export function waitingSummary(waits: readonly TaskWaitDTO[] | undefined): string | null {
  if (!waits || waits.length === 0) return null;
  return waits.map(waitingReasonText).join('；');
}
