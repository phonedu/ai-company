# src/main/engine — 引擎（T0.3）

串行事件循环 + 状态机 + 幂等动作 + 持久化定时器 + 启动恢复。
**唯一契约**：`FLOWS §3.1` 状态迁移真值表（本目录 `statemachine.ts` 是它的代码化）、`DEV §4/§5`、`PLAN §19`、`schema.sql`。

| 文件 | 职责 |
|---|---|
| `statemachine.ts` | FLOWS §3.1.1（任务 49 行）/ §3.1.2（工作项 16 行）逐行编码；`planTaskTransition` / `planWorkItemTransition`（纯函数） |
| `actions.ts` | 动作登记（事务内，`action_log` pending）+ 执行（事务外，幂等；done 跳过） |
| `timers.ts` | 持久化时钟；`scheduleTimer`（`dedupe_key` UPSERT）、到期扫描、重启重建 |
| `loop.ts` | `Engine`：一批事件一个事务 → 调度 fixpoint → 事务外执行副作用；启动恢复 |
| `bus.ts` | 进程内事件总线（→ 渲染进程推送出口） |

## 一次性启动顺序（DEV §4.5）

```ts
const db = openDatabase(dbFile);      // WAL + foreign_keys
runMigrations(db);                    // ① 迁移
const engine = new Engine(db, executor, { autoSchedule: true });
await engine.recover();               // ② running→interrupted ③ 重放 pending ④ 重建 timers
engine.start();                       // ⑤ 进入事件循环（异步 tick；到期的 timers 转事件）
```

`executor` 是副作用执行器（`EffectExecutor`）：M0 用桩（记录/无真实 LLM），M1 换成 Pi 会话池。

## 手工驱动（T0.6「手动推进」/ 脚本化验收）

`Engine.dispatch(event)` = 入队 + 同步排空；`autoSchedule:false` 时每次只走一步，便于逐条对照 `FLOWS §3.1`：

```ts
// 建任务（短号在 createTask 内分配；状态 inbox；同事务落 task_created）
const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T0.6', goal: '走通主链', riskLevel: 1 });
const taskId = task.id;

// autoSchedule:false —— 每次 dispatch 只走一步（不在事务里自动跑调度 fixpoint），便于逐条对照
const engine = new Engine(db, executor, { autoSchedule: false, now: () => Date.now() });
const e = (event: string, payload?: Record<string, unknown>) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss', payload });

await engine.dispatch(e('triage'));                                        // inbox → planning            [task_triaged]
await engine.dispatch(e('plan_drafted', { steps: ['收集', '写稿', '校对'] })); // planning(不变) [plan_drafted] + plan_steps 初始化
await engine.dispatch(e('plan_reviewed'));                                 // → awaiting_approval         [plan_reviewed]
await engine.dispatch(e('plan_approved'));                                 // → ready（写 ready_since）    [plan_approved]
await engine.dispatch(e('start_task'));                                    // → executing                 [task_started]
// 进度（report_progress 工具路径；也可由幕僚长真实调用）
projectProgressReported(db, { taskId, stepIdx: 1, state: 'done' });
projectProgressReported(db, { taskId, stepIdx: 2, state: 'running' });
await engine.dispatch(e('pause'));                                         // → paused                    [task_paused]
await engine.dispatch(e('resume'));                                        // → ready                     [task_resumed]
await engine.dispatch(e('start_task'));                                    // → executing                 [task_started]
await engine.dispatch(e('all_work_items_done'));                           // → verifying                 [verification_started]
await engine.dispatch(e('verification_completed', { verdict: 'pass' }));   // → done  [verification_completed, task_completed]
```

- **`autoSchedule:false`**：每次 `dispatch` 只走一步；置 `true`（默认）时 `plan_approved` 后会在**同一事务**里跑调度 fixpoint，自动 `ready→executing`（见 `DEV §5`）。T0.6 逐步取证用 `false`。
- **可跑的驱动**：`node dist\test\fixtures\t06-walkthrough.js`（源 `test/fixtures/t06-walkthrough.ts`）——逐步打印 `event → state / ready_since → 新增 kind → plan_steps`；预期 `plan_steps = 1:done,2:running,3:pending`、终态 `done`、事件流 `task_created,…,verification_completed,task_completed`。**推进按钮 / T0.8 冒烟可直接照此序列。**
- 工作项事件用 `{ scope: 'work_item', id: workItemId, event }`。单测见 `test/engine.test.ts`（T0.3①）。

## 幂等与崩溃恢复

- `action_key = <kind>:<subject_kind>:<subject_id>:<revision>`（schema.sql 规范）；事务内先登记 pending，事务外执行后置 done；**执行前再查一次，done 则跳过**。
- 「已执行、未置 done」的崩溃窗口内重放是 **at-least-once**，靠下游幂等键兜底（`timers.dedupe_key` / 通知 dedupe_key）。
- 重启：`running` 工作项 → `interrupted`（写 `work_item_interrupted`）+ 重放 pending + 重建 timers；**状态是物化的，不从事件重建**。

真·kill 用例：`test/engine-crash.test.ts`（起子进程 → `taskkill` → 重启 → 断言无重复副作用、无状态回退）。

## 与 main/ipc/renderer 的接缝

- 构造：`new Engine(db, executor, config)`；`config.onEvent` 与 `engine.bus.subscribe(fn)` 用于把事件推给渲染进程。
- 渲染层动作 → `engine.dispatch({ scope, id, event, actor, payload })`（P 通道 `evt:task` 的载荷形状同 `EngineEvent`）。
- 引擎不碰 Electron / IPC；`main/index.ts` 负责装配（openDatabase → runMigrations → recover → start）。

## T0.8「重启不丢」引擎侧说明（冒烟用）

**`recover()` 做什么**（`DEV §4.5` 第 ②–④ 步；① 迁移由装配方先跑）：
1. ② `running` 工作项 → `interrupted`（写 `work_item_interrupted`）——重启即判定「会话已死」；**任务仍 `executing` 的件随后自动 `redispatch` 回 `queued`（attempt+1，BRK8）**，暂停/阻塞/验证中的任务不擅自重派；
2. ③ 重放 `action_log` 中 `pending` 的动作（幂等；`done` 的跳过）；
3. ④ 重建 `timers`：`DELETE WHERE fired_at IS NULL` 后按**物化状态**重计划（`awaiting_approval`→`askcard_timeout`、`blocked`→`blocked_watchdog`）。

返回 `RecoveryReport = { interrupted, redispatched, replayed:{executed,skipped,failed}, timersRebuilt }`（可直接断言）。恢复只改队列，不跑调度 fixpoint；真正派发在 `start()` 后的 `schedulePass`。

**物化 vs 事件（关键）**：`tasks.state` / `work_items.state` / `plan_steps` / `action_log` / `counters` 都是**物化的**，重启**不从 `task_events` 重建**（event-sourcing-lite：事件只用于 UI 投影与审计，`PLAN §19.3`）。所以重启后状态**保持不变**；唯一变化是第 ② 步的 `running → interrupted`，那是**规范内的推进**（不是回退）。

**断言要点**（照 `test/engine-crash.test.ts` / `test/fixtures/crash-driver.ts`）：
- **`action_log` 无重复副作用**：`action_key` 唯一；重启只重放 `pending`，`done` 不再执行 → 每个副作用恰好一条（无重复行）。
- **无 pending 重放**：重启前已全部 `done` 时 `recover().replayed.executed === []`（`skipped`/`failed` 同为空）。
- **状态不回退**：`tasks.state` 与重启前一致（如 `executing` 仍 `executing`）；`running` 工作项 → `interrupted` →（executing 任务）`queued` 属预期；暂停/阻塞/验证中的件留 `interrupted` 等恢复/人工；短号计数器只增不减。
- 「已执行、未置 done」的崩溃窗口内重放是 **at-least-once**，靠**下游幂等键**（`notifications.dedupe_key` / `timers.dedupe_key`）兜底。

**冒烟配方（建议）**：用 `t06-walkthrough` 驱动到 `executing`（或更远）→ 记 `tasks.state` / `action_log` 行 / 副作用记录 → 强杀**我启动的 PID** → 重启 → `recover()` → 按上面三条断言；DB 用独立路径、应用用 `--user-data-dir` 隔离（见设计记录 §6）。
