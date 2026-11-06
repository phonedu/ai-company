/**
 * 短号计数器落库载体（`src/core/short-id.ts` 的 `CounterStore` 实现）。
 *
 * 表：`counters(name PK, value)`（schema.sql v1）。
 * 原子自增：`INSERT ... ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
 * —— 单条 statement，等价于 `UPDATE counters SET value = value + 1 ... RETURNING value` 的初值语义。
 *
 * 【关键：序号永不回收 —— T0.2 断言③】
 * `nextCounter` 是一次**独立提交**的写（没有调用方开启的事务时，statement 处于 autocommit）。
 * 这样即便随后的「任务 INSERT」事务回滚，counter 也已前进：**允许空洞，绝不允许回收**
 * （schema.sql / short-id.ts 的第一硬规则）。因此 `createTask`（tasks.ts）必须先分配、再开 INSERT 事务。
 *
 * 取舍说明：DEV §4 写作「分配必须与任务 INSERT 在同一事务」；但同一事务下 ROLLBACK 会连带回收序号，
 * 与「永不复用（允许空洞）」及 T0.2 断言③「事务回滚后序号不回收」冲突。此处按**安全不变式**实现，
 * 并在交付报告中提出文档口径澄清（见 chat 13 报告）。
 */
import type { CounterStore } from '../../core/short-id.js';
import type { SqliteDb } from './open.js';

const UPSERT_RETURNING = `INSERT INTO counters(name, value) VALUES(?, ?)
  ON CONFLICT(name) DO UPDATE SET value = value + 1
  RETURNING value`;

export class SqliteCounterStore implements CounterStore {
  constructor(private readonly db: SqliteDb) {}

  nextCounter(name: string, start: number): number {
    const row = this.db.prepare(UPSERT_RETURNING).get(name, start) as { value: number } | undefined;
    if (!row) throw new Error(`[db] counters 自增未返回行: name=${name}`);
    return row.value;
  }
}

/** 只读当前计数值（测试/诊断用）。 */
export function readCounter(db: SqliteDb, name: string): number | null {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number } | undefined;
  return row ? row.value : null;
}
