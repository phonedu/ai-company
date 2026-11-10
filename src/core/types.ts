/**
 * 三个核心模块（short-id / resolver / scheduler）共用的数据契约。
 *
 * 设计约束：全部模块都是【纯逻辑 + 存储接口注入】（无 IO、无数据库依赖），
 * 这样既能脱离 Electron/SQLite 单测，后续也能把 ResolverStore / CounterStore
 * 换成 better-sqlite3 的实现而不动算法。
 */

export type TaskState =
  | 'inbox'
  | 'planning'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused' // 用户主动暂停/搁置：不占槽位、不老化、不进待办（随时「继续」，无痕可逆）
  | 'verifying'
  | 'needs_decision'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaskSnapshot {
  id: number;
  /** 人类与 IM 可寻址的短号，如 T-1042 */
  shortId: string;
  /** 任务标题（确认选项/卡片标签用） */
  title: string;
  projectId: number;
  state: TaskState;
  /** 越大越优先；调度排序用 */
  priority: number;
  /** 0 = 无闸门 / 1 = 审计划 / 2 = 全流程 + 人工批准 */
  riskLevel: 0 | 1 | 2;
  /** epoch ms */
  createdAt: number;
  /** 进入 ready 的时刻；老化（anti-starvation）按它计算 */
  readySince: number | null;
  deadline: number | null;
  /** null = 不限；<= 0 = 超预算（调度器只暂停该任务） */
  budgetLeftTokens: number | null;
  /** 子任务的父任务引用 */
  parentTaskId: number | null;
}

export type WorkItemState =
  | 'queued'
  | 'running'
  | 'submitted'
  | 'rejected'
  | 'done'
  | 'failed'
  | 'blocked' // 阻塞式 mailbox：等同事答复；答复到达后回 queued（不占用员工并发槽位）
  | 'interrupted'; // 崩溃/重启中断，编排器按策略自动重派或问用户

/**
 * 单一「等待原因」枚举（1603 决定；`` 第 4 条 / `B-5 G-9`）。
 * 调度/引擎的 `hold.reason` 与 UI 的「当前在等什么」**同源**——禁止各处自造字符串。
 */
export type WaitingReason =
  | 'no_slot' // 等全局槽位
  | 'employee_busy' // 该员工已有 running 工作项（G-1 硬守卫的结果）
  | 'budget' // 预算/成本闸门
  | 'resource_lock' // 等外部资源锁（工具链/构建锁；G-9）
  | 'path_conflict' // 路径所有权冲突
  | 'dependency' // 等前置任务/任务依赖（task_deps）
  | 'session_starting'
  /** N2：速率闸门——超`排队线`时新派发排队（在跑任务不打断）。 */
  | 'rate_limit'
  /** N3：并发闸门（P20 任务内 / P22 公司级）——超上限时新派发排队。 */
  | 'concurrency_limit'; // 幕僚长/员工会话未就绪（L13「绝不静默」的等待态）

export interface WorkItemSnapshot {
  id: number;
  taskId: number;
  employeeId: number;
  state: WorkItemState;
  createdAt: number;
}
