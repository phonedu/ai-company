/**
 * `task_deps` DAO（D4 写入面）—— 任务依赖 DAG（`schema.sql`）。
 * 之前**只有读取**（引擎 `buildSchedulerInput`），没有写入者 → 「依赖激活」路径实际不可达（审计 D4）。
 * 本模块补上写入面：`addTaskDependency`（纯插入）/ `addTaskDependencyChecked`（存在性＋判环＋审计）。
 */
import { insertTaskEvent } from './task_events.js';
import type { SqliteDb } from './open.js';

/** 建立 `task_id` 依赖 `depends_on`。幂等（PK 去重）；自依赖拒绝。返回是否新增。 */
export function addTaskDependency(db: SqliteDb, taskId: number, dependsOn: number): boolean {
  if (taskId === dependsOn) throw new Error('[db] task_deps 不允许自依赖');
  const info = db.prepare('INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES(?, ?)').run(taskId, dependsOn);
  return info.changes > 0;
}

export function removeTaskDependency(db: SqliteDb, taskId: number, dependsOn: number): boolean {
  const info = db.prepare('DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?').run(taskId, dependsOn);
  return info.changes > 0;
}

export function listTaskDependencies(db: SqliteDb, taskId: number): number[] {
  return (
    db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on').all(taskId) as {
      depends_on: number;
    }[]
  ).map((r) => r.depends_on);
}

export type DependencyWriteResult =
  | { ok: true; added: boolean }
  | { ok: false; code: 'not_found' | 'self' | 'cycle'; message: string };

function taskExists(db: SqliteDb, taskId: number): boolean {
  return !!db.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(taskId);
}

/**
 * 判环：加入 `taskId → dependsOn` 后是否形成环。
 * 从 `dependsOn` 沿 `depends_on` 向下走；若能回到 `taskId`，则新边闭合一个环。
 * **纯读**；调用方在写前用它拒绝（不靠 blocked 看门狗兜底——写入时就该拒）。
 */
export function wouldCreateDependencyCycle(db: SqliteDb, taskId: number, dependsOn: number): boolean {
  if (taskId === dependsOn) return true;
  const seen = new Set<number>();
  const stack = [dependsOn];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const parents = db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?').all(current) as {
      depends_on: number;
    }[];
    for (const row of parents) stack.push(row.depends_on);
  }
  return false;
}

/**
 * 写入一条依赖（**唯一带守卫的写入口**）：任务必须都存在；自依赖/环拒绝；幂等。
 * 真新增时同事务写 `task_events(dependency_added)`（审计：谁在何时加了哪条边）。
 */
export function addTaskDependencyChecked(
  db: SqliteDb,
  input: { taskId: number; dependsOn: number; actor?: string; now?: number },
): DependencyWriteResult {
  const { taskId, dependsOn } = input;
  if (taskId === dependsOn) return { ok: false, code: 'self', message: '任务不能依赖自己' };
  if (!taskExists(db, taskId)) return { ok: false, code: 'not_found', message: `任务不存在：#${taskId}` };
  if (!taskExists(db, dependsOn)) return { ok: false, code: 'not_found', message: `依赖任务不存在：#${dependsOn}` };
  if (wouldCreateDependencyCycle(db, taskId, dependsOn)) {
    return { ok: false, code: 'cycle', message: `依赖会形成环：#${taskId} → #${dependsOn}（已拒绝，未落库）` };
  }

  const now = input.now ?? Date.now();
  db.exec('BEGIN');
  try {
    const added = addTaskDependency(db, taskId, dependsOn);
    if (added) {
      insertTaskEvent(db, {
        taskId,
        ts: now,
        kind: 'dependency_added',
        actor: input.actor ?? 'boss',
        payload: { taskId, dependsOn },
      });
    }
    db.exec('COMMIT');
    return { ok: true, added };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 移除一条依赖；真删除时写 `task_events(dependency_removed)`（审计）。幂等。 */
export function removeTaskDependencyChecked(
  db: SqliteDb,
  input: { taskId: number; dependsOn: number; actor?: string; now?: number },
): DependencyWriteResult {
  const { taskId, dependsOn } = input;
  if (!taskExists(db, taskId)) return { ok: false, code: 'not_found', message: `任务不存在：#${taskId}` };
  if (!taskExists(db, dependsOn)) return { ok: false, code: 'not_found', message: `依赖任务不存在：#${dependsOn}` };

  const now = input.now ?? Date.now();
  db.exec('BEGIN');
  try {
    const removed = removeTaskDependency(db, taskId, dependsOn);
    if (removed) {
      insertTaskEvent(db, {
        taskId,
        ts: now,
        kind: 'dependency_removed',
        actor: input.actor ?? 'boss',
        payload: { taskId, dependsOn },
      });
    }
    db.exec('COMMIT');
    return { ok: true, added: removed };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
