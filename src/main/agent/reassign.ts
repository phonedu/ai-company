/**
 * BRK7（M3-R-3）：员工不可用时的**改派策略**（同角色、在职、未试过的人）。
 *
 * 口径（FLOWS F8）：
 *  - 在跑件 → 先 `pause_task`（真中断，避免留 running）→ `reassign` 到同角色在职员工；
 *  - 排队/失败件 → 直接 `reassign`；
 *  - 没有同角色候选 / 候选都试过 → 返回 `false`（调用方按 BRK2 落 `error`＋异常卡，不静默）。
 *  - 试过人集合从 `work_item_created` 事件 payload 的 `employeeId` 读取；当前持有人也算。
 *  - 改派本身**不扩权**（P8 G-2）：新员工按自己的能力档/项目策略重新过闸。
 */
import { getWorkItem } from '../db/work_items.js';
import type { SqliteDb } from '../db/open.js';
import type { EngineEvent } from '../engine/types.js';

export interface UnavailableWorkItemInfo {
  workItemId: number;
  taskId: number;
  reason: string;
}

export type UnavailableReassigner = (info: UnavailableWorkItemInfo) => Promise<boolean>;

export function createUnavailableReassigner(
  db: SqliteDb,
  dispatch: (event: EngineEvent) => Promise<void> | void,
): UnavailableReassigner {
  return async ({ workItemId, reason }) => {
    const wi = getWorkItem(db, workItemId);
    if (!wi) return false;
    if (!['queued', 'running', 'blocked', 'failed', 'interrupted'].includes(wi.state)) return false;

    const roleRow = db.prepare('SELECT role FROM employees WHERE id = ?').get(wi.employee_id) as
      | { role: string | null }
      | undefined;
    const role = roleRow?.role ?? '';
    if (role.length === 0) return false;

    const tried = new Set<number>([wi.employee_id]);
    const createdEvents = db
      .prepare("SELECT payload FROM task_events WHERE work_item_id = ? AND kind = 'work_item_created' ORDER BY id")
      .all(workItemId) as Array<{ payload: string | null }>;
    for (const row of createdEvents) {
      try {
        const payload = JSON.parse(row.payload ?? '{}') as { employeeId?: unknown };
        if (typeof payload.employeeId === 'number' && Number.isInteger(payload.employeeId)) {
          tried.add(payload.employeeId);
        }
      } catch {
        /* 坏 payload 不臆造 */
      }
    }

    const candidates = db
      .prepare('SELECT id FROM employees WHERE active = 1 AND role = ? ORDER BY id')
      .all(role) as Array<{ id: number }>;
    const next = candidates.find((c) => !tried.has(c.id));
    if (!next) return false;

    // 在跑件先按真值表中断（running/blocked → interrupted），再改派；不能从 running 直接 reassign。
    if (wi.state === 'running' || wi.state === 'blocked') {
      await dispatch({
        scope: 'work_item',
        id: workItemId,
        event: 'pause_task',
        actor: 'system',
        payload: { via: 'unavailable' },
      });
    }
    await dispatch({
      scope: 'work_item',
      id: workItemId,
      event: 'reassign',
      actor: 'system',
      payload: { employeeId: next.id, fromEmployeeId: wi.employee_id, reason },
    });
    return true;
  };
}
