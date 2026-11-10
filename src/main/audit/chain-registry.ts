/**
 * `chain-registry.ts` —— 链条审计**账本**（机器可读）：孤儿处置表 ＋ 固定锚探针 ＋ 人工注记。
 *
 * 维护纪律（与 `docs/work/research-feature-chain-gap.md` §5「维护纪律」同一口径）：
 *  - 每条新发现**当日**进表（`open`/`intended` ＋ `ref` ＋ `note`）；修好一条 ⇒ 翻 `fixed`（并补正例断言）；
 *  - 跑 `pnpm audit:chain` 出「账本待更新」提示（open 而孤儿已消失）⇒ 当日复核、翻状态；
 *  - 叙事与证据链的真源＝研究件 [`docs/work/research-feature-chain-gap.md`]；本表只做**机器视图**，不复制证据。
 *
 * 读数基准日：2026-10-15（``/`V3`/``/`` 已交付；``/`` 两件**并行会话当日在途修复**
 * 〔未提交〕，与 `loop.ts` 任务级失败聚合（`fail` 接线）同批——三处孤儿读数已消失，本表照现实翻 `fixed`；
 * 该次若撤销，审计将报**回归**。
 */
import type { Disposition, Probe, ToolSpec, WriterSpec } from './chain-audit.js';

export const CHAIN_AUDIT_DATE = '2026-10-15';

// ───────────────────────── 孤儿处置表（finding 在场＝照账本；不在场＝待复核/回归）─────────────────────────

export const ORPHAN_DISPOSITIONS: Disposition[] = [
  // —— 孤儿迁移（事件 0 生产者）——
  {
    check: 'event',
    name: 'decision_made',
    status: 'intended',
    ref: 'RW-51（2026-11-05 挂载：boss-card-tools）',
    note: '生产方已接线：幕僚长卡片工具 boss_card_resolve 按老板对话授权对 needs_decision 卡作答（agent/boss-card-tools.ts，走 approvalAnswerEvent 同一映射＋engine.dispatch）；锚＝test/boss-card-tools.test.ts',
  },
  {
    check: 'event',
    name: 'decision_proceed_latest',
    status: 'intended',
    ref: 'RW-51（同上挂载）',
    note: '生产方：同 boss_card_resolve 的 proceed 分支（最新稿视同批准）；锚同上',
  },
  {
    check: 'event',
    name: 'signoff',
    status: 'intended',
    ref: 'B2-6/D-30③（2026-11-08 挂载：签收关卡）',
    note: '生产方已接线：L1+ verifier pass 出签收卡（needs_decision），老板点「签」经 approvalAnswerEvent 映射 sign→handleTaskApprove dispatch（ipc.ts 唯一映射点）；锚＝test/b2-6-signoff.test.ts',
  },
  {
    check: 'event',
    name: 'signoff_reject',
    status: 'intended',
    ref: 'B2-6/D-30③（同上挂载）',
    note: '生产方已接线：签收卡点「返工件 N」经 approvalAnswerEvent 映射 rework:N→signoff_reject{workItemId}→spawnReworkItem（retry_of 血缘，跨任务守卫）；锚＝test/b2-6-signoff.test.ts',
  },
  {
    check: 'event',
    name: 'block',
    status: 'fixed',
    ref: 'D4（2026-10-17）＋ BRK6（M3-R-2）',
    note: '依赖未满足路径已接线：调度器 `block_task` → `block`（ready→blocked）；`task_deps` 生产写者随 D4 落地；`unblock` 已补 UI（解除阻塞，依赖未满足仍会再 block）；手动 block 入口未做（依赖/外部阻塞走调度器）',
  },
  { check: 'event', name: 'reassign', status: 'fixed', ref: 'BRK7（M3-R-3）', note: '员工不可用→同角色/在职/未试过员工的自动改派（`agent/reassign.ts`）；running/blocked 先 pause_task 再 reassign，attempt+1；无候选返回 false → error＋异常卡；锚＝test/reassign-unavailable.test.ts' },
  {
    check: 'event',
    name: 'pause_task',
    status: 'fixed',
    ref: 'BRK4（M3-R-1；取消小步 2026-10-16）',
    note: '生产方已接线：任务级取消/暂停 → 真中断在跑件（`loop.interruptWorkItems` 按真值表走 `pause_task`；会话真停经 `onWorkItemInterrupted`→`AgentSession.abort()`）；BRK4 恢复对账（interrupted→redispatch、全 settled 立即聚合）已落地；锚＝`test/engine.test.ts` BRK4 组＋`brk4-pause-resume-cdp`；本 finding 再现即回归',
  },
  {
    check: 'event',
    name: 'redispatch',
    status: 'fixed',
    ref: 'BRK4（M3-R-1）＋ BRK8（M3-R-4）',
    note: '生产方：暂停恢复对账（`reconcileExecutingTask`）＋崩溃恢复（`recover()` 对 executing 任务的 interrupted 件自动 redispatch，attempt+1）；恢复只改队列，启动后调度重派；锚＝test/engine.test.ts BRK4/BRK8 组＋test/engine-crash.test.ts',
  },
  { check: 'event', name: 'ask_user', status: 'open', ref: 'BRK8', note: '崩溃恢复询问策略无生产方；随批 R' },
  { check: 'event', name: 'heartbeat_timeout', status: 'fixed', ref: 'BRK-R6（M3-R-6）', note: '工作项 running 登记 session_heartbeat（10min，agent 事件刷新）；到期仍 running → heartbeat_timeout → failed＋任务失败/异常卡；离开 running 清心跳；锚＝test/engine.test.ts BRK-R6 组' },
  { check: 'event', name: 'fail', status: 'fixed', ref: 'BRK2/BRK3（在途修复）同批', note: '`loop.ts` 失败聚合派生任务级 `fail`（件进 failed ⇒ 任务 failed ＋异常卡）；修复锚＝本 finding 再现即回归' },
  { check: 'event', name: 'unblock', status: 'fixed', ref: 'BRK6（M3-R-2）', note: 'blocked 态 UI 增加「解除阻塞」→ task:transition(unblock)；依赖未满足时调度器会再次 block（不绕过依赖）；锚＝test/engine.test.ts BRK6 组＋test/task-actions.test.ts' },
  {
    check: 'event',
    name: 'review_reject',
    status: 'open',
    ref: '新登记（待裁）',
    note: 'WI 级打回行未接：现路径走任务级 verification_completed(fail)＋spawn 返工项——有意简化还是缺口待裁',
  },
  {
    check: 'event',
    name: 'archive',
    status: 'intended',
    ref: 'BRK17（挂载 3 接线）',
    note: '归档已接线（2026-10-15）：**入口＝左栏终态任务行**（`LeftRail` 的 🗄，renderer——普查只扫 main/preload＋详情表 ⇒ 仪器数不到生产者，故此条人工注记不计红）；引擎行为锚＝`test/mount3-brk17.test.ts`（done/failed 归档写 archived=1＋task_archived；非终态拒）＋引擎行 m0:true（doc-consistency G-10-1）',
  },
  {
    check: 'event',
    name: 'ask_owner',
    status: 'fixed',
    ref: 'BRK17 深件（挂载 3 余，2026-10-15）',
    note: '已接线：`handleTaskCreate` 归属拿不准分支（未显式给项目＋未设默认项目＋多个项目可选）→ **不自动分诊**、派 `ask_owner`（决策卡问一次归属；`resume_state=inbox`，「确认为任务/丢弃」分流既有）；锚＝`test/mount3-brk17-deep.test.ts`；本 finding 再现即回归',
  },
  {
    check: 'event',
    name: 'reopen_reply',
    status: 'fixed',
    ref: 'BRK17 深件（挂载 3 余，2026-10-15）',
    note: '已接线：`chat:send` 回复链打到**已归档终态**任务 → 派 `reopen_reply`（提议续办卡；文案给「续办 T-xxxx」现成指令）；行 m0:true；锚＝`test/mount3-brk17-deep.test.ts`；本 finding 再现即回归',
  },
  {
    check: 'event',
    name: 'undo_finish',
    status: 'fixed',
    ref: 'BRK17（挂载 3 转正，2026-10-15）',
    note: '已接线：`taskActions` done.undo-finish `implemented:true`（uiEvents 计生产者）＋状态机行 m0:true；守卫链真跑（7d 窗口/已归档拒→人话回执）锚＝`test/mount3-brk17.test.ts`；本 finding 再现即回归',
  },
  {
    check: 'event',
    name: 'hold',
    status: 'intended',
    ref: 'FLOWS §3.1.1 hold 行',
    note: '纯等待行（m0:false；调度器产 hold 原因、不写事件）——非断链',
  },
  {
    check: 'event',
    name: 'crash',
    status: 'intended',
    ref: 'loop.recover',
    note: '恢复直写等价：recover() 直写 state＋work_item_interrupted（不经 dispatch）——防双路径，登记为有意',
  },
  { check: 'event', name: 'task_created', status: 'intended', ref: 'db/tasks.ts', note: '建档直写：createTask 同事务写 task_events（NEW 行非事件派发）' },
  { check: 'event', name: 'work_item_created', status: 'intended', ref: 'db/work_items.ts', note: '建件直写：insertWorkItem 同事务写 kind（非事件派发）' },

  // —— 非法派发（scope:event 不在真值表）——
  {
    check: 'invalid-dispatch',
    name: 'work_item:work_item_failed',
    status: 'fixed',
    ref: 'BRK2（在途修复）',
    note: '兜底执行器改发工作项机真事件 `error`（unavailable-executor / employee-factory 内联）＋任务级失败聚合；修复锚＝本 finding 再现即回归',
  },
  {
    check: 'invalid-dispatch',
    name: 'task:error',
    status: 'fixed',
    ref: 'BRK3（在途修复）',
    note: '无产出路径改发合法 `escalate`（任务进 needs_decision ＋决策卡）；修复锚＝非法 task 级 `error` 再现即回归',
  },
  {
    check: 'invalid-dispatch',
    name: 'task:verification_blocked',
    status: 'fixed',
    ref: 'BRK3（在途修复）',
    note: 'verifier 无可用人 / critic 即实现者 → 改发 `escalate`；修复锚＝本 finding 再现即回归',
  },

  // —— 孤儿写者 ——
  {
    check: 'writer',
    name: 'src/main/db/task_deps.ts:addTaskDependency',
    status: 'fixed',
    ref: 'M2 尾 D4（2026-10-17）',
    note: '写入面已接：`createTask.dependsOn`（同事务）＋ `依赖 T1042 T1001` 命令；判环/审计在 `addTaskDependencyChecked`',
  },
  {
    check: 'writer',
    name: 'src/main/db/task_deps.ts:removeTaskDependency',
    status: 'fixed',
    ref: 'M2 尾 D4（2026-10-17）',
    note: '移除面已接：`移除依赖 T1042 T1001` 命令（`removeTaskDependencyChecked`，幂等＋审计）',
  },

  // —— 孤儿工具 ——
  { check: 'tool', name: 'report_progress', status: 'fixed', ref: 'BRK5（2026-10-15 交付）', note: '员工侧消费者已接：`employee-executor` 调 `projectProgressReported`（progress_reported 事件＋plan_steps 真投影）；非法参数 tool_call 标 error 不阻断' },
  { check: 'tool', name: 'request_review', status: 'fixed', ref: 'BRK5（2026-10-15 交付）', note: '员工侧消费者已接：落 `review_requested` 事件（actor=员工）；强制度仍按 risk_level 由引擎 requestReview 决定（v1 口径）' },
  {
    check: 'tool',
    name: 'load_skill',
    status: 'intended',
    ref: 'GAP7（M3-N-3）',
    note: '工具由 `employee-factory` 注册、模型按需调用；白名单（员工勾选∪项目默认∪任务强制）与文件读取在 `skill-tool.ts`。静态工具审计只认 `toolName ===` 的宿主消费点 ⇒ 本工具属"注册即消费"，登记为有意；锚＝test/skills-context.test.ts',
  },
  {
    check: 'tool',
    name: 'tool_search',
    status: 'intended',
    ref: 'B5（M3-N-4）',
    note: '工具由 `employee-factory` 注册、模型按需调用；只查询本会话分配 MCP server 的工具（含 deferred/codemode），不执行外部动作。静态审计只认 `toolName ===` 消费点 ⇒ 登记为有意；锚＝test/mcp-assignment.test.ts',
  },

  // —— 孤儿 timer ——
  { check: 'timer-kind', name: 'session_heartbeat', status: 'fixed', ref: 'BRK-R6（M3-R-6）', note: '调度/刷新/清除已接线（`timers.heartbeatWorkItem/clearWorkItemHeartbeat`；engine fireDueTimers 处理）；锚＝test/engine.test.ts' },
  { check: 'timer-kind', name: 'cron_fire', status: 'fixed', ref: 'GAP1（M3-N-1）', note: 'cron 触发已接：`TriggerService` 用 timers(kind=cron_fire) 存储/重排，tick 创建任务；事件触发用 kind=event_trigger；重启 rebuild 保留两类定时器' },

  // —— 孤儿推送通道（声明/推送/路由三腿；⑦）——
  { check: 'ipc-push', name: 'evt:hall', status: 'fixed', ref: 'BRK15（挂载 2，2026-10-15 交付）', note: '主进程 `onEvent` 同推 `evt:hall`（大厅动状态实时刷新，不靠下一次拉取）；修复锚＝finding 再现即回归' },
  { check: 'ipc-push', name: 'evt:notify', status: 'fixed', ref: 'BRK15（挂载 2，2026-10-15 交付）', note: '卡片落库回调 `onCard` → `evt:notify`（引擎卡；main 日报直接推）；渲染层 store 路由 `loadChannel` 实时刷新' },
  { check: 'ipc-push', name: 'evt:inbox', status: 'fixed', ref: 'BRK15（挂载 2，2026-10-15 交付）', note: '同上（「待我处理」与频道同源刷新）；修复锚＝finding 再现即回归' },
  {
    check: 'ipc-push',
    name: 'evt:agent（未声明）',
    status: 'fixed',
    ref: 'BRK15（挂载 2，2026-10-15 交付）',
    note: '已补进 preload `EVENT_CHANNELS` 直订白名单（推＋路由早就在；口径＝白名单即全量通道表）',
  },
];

// ───────────────────────── 固定锚探针（账本记读数；偏移语义见 chain-audit.ts 头注）─────────────────────────

export const PROBES: Probe[] = [
  {
    id: 'BRK1-fix-anchor',
    status: 'fixed',
    scope: 'src/main/engine/statemachine.ts',
    pattern: 'planWorkItemsAction',
    op: '>=',
    value: 3,
    note: '超时批准行补建件动作（§6 配方期望 3；2026-10-15 实测 4）',
  },
  { id: 'BRK18-fix-anchor', status: 'fixed', scope: 'src/main', pattern: 'linkApprovalReport', op: '>=', value: 1, note: '批准卡先落 → 审批行回挂 report_id（新 DAO）' },
  { id: 'BRK19-fix-anchor', status: 'fixed', scope: 'src/renderer/AppShell.tsx', pattern: 'subscribeEvents', op: '>=', value: 1, note: '订阅上移全局单点' },
  {
    id: 'BRK13-absence-main',
    status: 'fixed',
    scope: 'src/main/ipc',
    pattern: 'budget_tokens',
    op: '>=',
    value: 1,
    note: 'BRK13 已动工（挂载 3 首批：task:create 透传＋`加预算 T1042 N` 命令＋setTaskBudget DAO）；修复锚＝读数 0 再现即回归',
  },
  { id: 'BRK13-absence-ui', status: 'fixed', scope: 'src/renderer', pattern: 'taskdlg-budget|task-budget', op: '>=', value: 1, note: 'BRK13 UI 已接：建任务表单预算 + 任务头预算徽标；修复锚＝读数 0 再现即回归' },
  { id: 'GAP3-absence', status: 'fixed', scope: 'src/main', pattern: 'new Notification', op: '>=', value: 1, note: 'M2 尾已接：`notify` 投递旁路 → Electron `Notification`（desktop；digest/employee 不弹）＋托盘未读刷新；修复锚＝读数 0 再现即回归' },
  { id: 'GAP5-absence', status: 'fixed', scope: 'src/main', pattern: 'AGENTS\\.md', op: '>=', value: 1, note: '已实现（挂载 3 首批：`context.ts` 直读 AGENTS.md/CLAUDE.md）；修复锚＝读数 0 再现即回归' },
];

// ───────────────────────── 扫描规格（写者/工具/timer 种类）─────────────────────────

export const WRITER_SPECS: WriterSpec[] = [
  { file: 'src/main/db/task_deps.ts', fn: 'addTaskDependency' },
  { file: 'src/main/db/task_deps.ts', fn: 'removeTaskDependency' },
];

/** 员工工具全集（`src/main/agent/*-tool.ts` 的 `name` 字面量；消费者口径＝员工会话侧）。 */
export const TOOL_SPECS: ToolSpec[] = [
  { name: 'report_progress', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'request_review', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'submit_work_item', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'ask_colleague', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'submit_review', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'escalate_to_boss', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'submit_plan', consumer: 'src/main/agent/employee-executor.ts' },
  { name: 'load_skill', consumer: 'src/main/agent/employee-factory.ts', consumerPattern: 'createLoadSkillTool|\\bloadSkill\\b' },
  { name: 'tool_search', consumer: 'src/main/agent/employee-factory.ts', consumerPattern: 'createMcpTools|\\btoolSearch\\b' },
];

export const TIMER_KINDS: string[] = [
  'askcard_timeout',
  'blocked_watchdog',
  'session_heartbeat',
  'cron_fire',
  'event_trigger',
];

// ───────────────────────── 人工注记（不计红，报告尾列）─────────────────────────

export const MANUAL_NOTES: Array<{ title: string; note: string }> = [
  {
    title: 'work_item:error',
    note: '工作项机 `error` 行：已由兜底执行器合法使用（`work_item` 域；BRK2 在途修复）；此前 3 处 task 域非法 `error` 已改发 `escalate`（BRK3 在途修复）⇒ 本注记已清零。',
  },
  {
    title: 'BRK9 steer（已接线）',
    note: '插话：**已接线（挂载 2，2026-10-15）**——`#T1042 要说的话` 直通 → `steerEmployee`（懒运行时透传）；不在跑落回 `task_message` 寻址（旧语义不动）；§6 配方 `grep steer(` 仍会误计定义行，探针从略。',
  },
  {
    title: 'confirm_as_task 语义路径',
    note: '已接线（挂载 3 深件，2026-10-15）：`confirm` 裁定落编排器——`setPendingList` 登记「只问一次」清单（`pending_lists`）＋问题 out 消息上屏；回序号直通该选项的完整决议（`then`；其中「新建任务」选项＝语义确认为任务）。静态普查看不见本路（renderer/消息流），锚＝`test/mount3-brk17-deep.test.ts`。',
  },
  {
    title: 'CompanyHall 重复订阅（已修，2026-10-20）',
    note: 'BRK19 修复口径＝订阅全局单点（AppShell）；`CompanyHall.tsx` 的局部 `subscribeEvents()` 已移除，避免挂载期双通道重复 reload。源码守卫＝`test/company-hall.test.ts`（大厅容器不得再出现 `subscribeEvents`；AppShell 必须保留）。',
  },
  {
    title: '孤儿动作 / 推送三腿（P2 已交付）',
    note: "⑥ 动作＝以 dummy ctx 执行 `actions()` ∪ 字面量 `act('K'` 兜底（执行抛错行如实列出）；⑦ 推送三腿＝preload 声明 × `push('evt:X'` 站点 × `channel === 'evt:X'` 路由（`evt:batch` 信封层不参与）。UI 入口 × 状态交叉仍由 `test/task-actions.test.ts` 承担。",
  },
];
