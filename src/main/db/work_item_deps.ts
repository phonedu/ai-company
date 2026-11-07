/**
 * `work_item_deps` DAO（B2-3/D-30②）—— **同任务内**工作项依赖 DAG。
 *
 * 口径：
 *  - 依赖只允许**同一任务内**的工作项（跨任务依赖走 `task_deps`，不混层）；
 *  - 自依赖拒绝；成环拒绝（DFS 沿 depends_on 上溯，同 task_deps 口径）；
 *  - 调度门控读 `workItemDepsOf`（全部前置 `done` 才派发——`core/scheduler.ts`）。
 */
import type { SqliteDb } from './open.js';

export function insertWorkItemDep(
  db: SqliteDb,
  input: { workItemId: number; dependsOn: number; now?: number },
): void {
  const { workItemId, dependsOn } = input;
  if (!Number.isInteger(workItemId) || !Number.isInteger(dependsOn) || workItemId <= 0 || dependsOn <= 0) {
    throw new Error('[db] work_item_deps 需要 workItemId/dependsOn 正整数');
  }
  if (workItemId === dependsOn) throw new Error('[db] work_item_deps 不允许自依赖');
  const wi = db.prepare('SELECT task_id FROM work_items WHERE id = ?').get(workItemId) as { task_id: number } | undefined;
  const dep = db.prepare('SELECT task_id FROM work_items WHERE id = ?').get(dependsOn) as { task_id: number } | undefined;
  if (!wi || !dep) throw new Error('[db] work_item_deps 引用的 work item 不存在');
  if (wi.task_id !== dep.task_id) {
    throw new Error(`[db] work_item_deps 只允许同任务内依赖（件 ${workItemId} 属任务 ${wi.task_id}，${dependsOn} 属任务 ${dep.task_id}）`);
  }
  // 环检测：沿 depends_on 上溯；若能回到 workItemId 则成环（含 workItemId 自身已可经链到达）。
  const visited = new Set<number>([workItemId]);
  const stack = [dependsOn];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (cur === workItemId) throw new Error('[db] work_item_deps 不允许成环（work item 依赖链回到自身）');
    if (visited.has(cur)) continue;
    visited.add(cur);
    const ups = db.prepare('SELECT depends_on FROM work_item_deps WHERE work_item_id = ?').all(cur) as Array<{
      depends_on: number;
    }>;
    for (const u of ups) stack.push(u.depends_on);
  }
  db.prepare('INSERT OR IGNORE INTO work_item_deps(work_item_id, depends_on, created_at) VALUES(?, ?, ?)').run(
    workItemId,
    dependsOn,
    input.now ?? Date.now(),
  );
}

/** 某件的全部前置件 id（派发门控用；无依赖 → 空数组）。 */
export function workItemDepsOf(db: SqliteDb, workItemId: number): number[] {
  return (
    db.prepare('SELECT depends_on FROM work_item_deps WHERE work_item_id = ? ORDER BY depends_on').all(workItemId) as Array<{
      depends_on: number;
    }>
  ).map((r) => r.depends_on);
}

/** 任务内全部依赖边（spawn 后校验/展示用）。 */
export function workItemDepsByTask(db: SqliteDb, taskId: number): Array<{ workItemId: number; dependsOn: number }> {
  return (
    db
      .prepare(
        'SELECT d.work_item_id AS workItemId, d.depends_on AS dependsOn FROM work_item_deps d JOIN work_items w ON w.id = d.work_item_id WHERE w.task_id = ? ORDER BY d.work_item_id, d.depends_on',
      )
      .all(taskId) as Array<{ workItemId: number; dependsOn: number }>
  );
}

export function deleteWorkItemDepsByTask(db: SqliteDb, taskId: number): void {
  db.prepare(
    'DELETE FROM work_item_deps WHERE work_item_id IN (SELECT id FROM work_items WHERE task_id = ?)',
  ).run(taskId);
}
