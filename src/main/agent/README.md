# `src/main/agent` —— 员工会话运行时（OPT-AI-1）

> 实现细节的**契约真源**。规则正文（里程碑口径）见 `PLAN M1`；本文件给**接口与字段**。

## 1. 部件与 owner

| 件 | 文件 | 说明 |
|---|---|---|
| 真执行器 | `employee-executor.ts` | `createEmployeeExecutor(deps): EffectExecutor`；work_item `dispatch` → 员工会话 → 回写 |
| 会话生命周期 | `employee-runtime.ts` | `EmployeeSessionRuntime` + `employeeSessionKey(employee,task,workItem)`（Pi-free，可 fake 单测） |
| 封装工厂 | `employee-factory.ts` | `createEmployeeRuntime({db,cwd,sessionDir,buildContext})`（自带工具 ＋ `persistDir`） |
| 上下文组装 | `context.ts` | `buildEmployeeContext(db,input) → {systemPrompt,userPrompt,meta}`（**纯函数**） |
| 压缩可观测 | `compaction-policy.ts`（N4） | 纯逻辑：`observeBeforeCompact/observeCompacted/stats/describeCompaction`（**观测，不改压缩行为**） |
| 工具 | `report-progress-tool.ts` / `request-review-tool.ts` / `submit-work-item-tool.ts` / `ask-colleague-tool.ts` / `answer-colleague-tool.ts` | 均 **signal-only**（状态由宿主驱动）；**一律动态 `import()`**（`struct-pi-import` 门） |
| 原始交流投影 | `raw-conversation.ts` | `projectRawConversation(db,taskId) → RawItem[]`（只读派生） |

## 2. 关键口径

- **层归属**：构造期 `systemPrompt` 只是**占位**（`EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER`）；**五层真值在 `run(input)` 时经 `buildContext` 逐次传入**。
  - **N4 调整**：①平台 ②角色 ③人设 **④任务基线（简报/验收/证据索引）** 进 **system 段**；⑤项目上下文 + 老板原话进 user 段。
    理由：底座自动压缩（threshold/overflow）**不传 `customInstructions`**（无法注入领域指令），而 **system 段不参与历史压缩**
    ⇒ 基线与**验收标准**压缩后必然仍在（**构造性保证**）；`meta.layers.baseline` 记"有无真实基线"（无任务 → false，占位段仍在场）。
- **员工记忆（G11）**：DAO＋投影＝`src/main/db/memory.ts`——任务进 `done` 时引擎**同事务**写「参与者 × 项目记忆」（**确定性投影、幂等、不调 LLM**；无成本行不写假 `0`）。
  组装侧新增 **`[员工记忆]` 层**（system 段：人设后、任务基线前——**静态→动态**护缓存前缀；`meta.layers.memory` 记有无真实记忆）。**v1 只写项目记忆**（通用记忆＝后续显式"提升"）。
- **压缩观测（N4）**：`registerCompactionObserver` 由 `pi-runtime` 的 `extensionFactories` **前置注册**（`session_before_compact`/`session_compact`）——
  每次压缩 `reason/tokensBefore/willRetry/是否迭代摘要` 进 `console.error` 留痕并计数（`compaction-policy.stats()`）；
  回调**返回 `undefined`** ⇒ 底座照常压缩（**只观测、不夺权**）。
- **回写语义**：会话调 `submit_work_item` → 引擎事件 `submit_work_item`（→`submitted`）；**未提交** → `agent_settled{submitted:false,lastOutput}`（→`failed`，**失败可见、不静默**）。
- **`ask_colleague`**：执行器观察到即调 `engine/mailbox.requestAsk`（`task_events.question_asked` + `notifications`；**不进人类频道**）。
- **`answer_colleague`**（BRK12）：被问员工在【同事提问】拿到 `askDedupeKey`；执行器校验 `to=本员工` 后调 `answerAsk(via='employee')`，阻塞式提问的对方件派 `answer_received` 唤醒。
- **持久化**：`persistDir` = 用户数据目录（`~/.aico/sessions/...`）；按 `sessionKey` 派生稳定 id，`findById/open` 续用。
  **N4**：幕僚长（`pi-assistant.ts`，`sessionKey='boss-channel:assistant'`）接线处同样传 `defaultSessionDir(userData)`——
  此前缺省 inMemory ⇒ 每次启动幕僚长失忆（重启继续 = 产品的"记得上次说到哪"）。
- **无凭据**：`createEmployeeRuntime` **抛错**；装配方转「不可用执行器」（`work_item_failed{reason:'no_credential'}`），**绝不回落录制桩**。
- **已知缺口（M2）**：会话**内部**工具调用（内建 write 等）**不过 `permissionGate`**；会话 cwd = 构造期 cwd（worktree/staging 的任务级 cwd 隔离 → M2）。

## 3. `rawConversation` 读模型（前端唯一数据源）

**存储（不新增表）**：`task_events.{agent_message,agent_thinking}` + 既有 `tool_call` + 既有 `human_messages(direction='in')`。
**投影**：`projectRawConversation(db, taskId, {limit?=500})`。

```ts
interface RawItem {
  id: string;            // '<source>:<rowId>'（'task_event:812' / 'human_msg:33'）
  role: 'boss' | 'employee' | 'system';
  employeeId?: number;
  name?: string;         // 缺失 → 渲染层降级 `员工#<id>`
  at: number;            // epoch ms
  text?: string;         // 发言条（与 thinking 互斥，各自成条）
  thinking?: string;     // 思考条（默认折叠）
  toolCall?: { name: string; argsDigest?: string; ok: boolean; error?: string; durationMs?: number };  // G3：`durationMs` 为会话内工具耗时（自含行）
  mentions?: number[];   // 显式；渲染层不解析 text
}
```

**硬口径**：① `text`/`thinking` **各自成条**；② `mentions` **显式 `number[]`**；③ `argsDigest` **主进程截断 ≤120 且脱敏**（密钥/令牌/密码不出现）；④ 排序 `at`↑、同 `at` 按 `id`↑。
**空态**：缺失/空 → **`[]`**（渲染层显式空态，**绝不臆造占位气泡**）；逐字段可缺（只有 `thinking` 或只有 `toolCall` 也要能渲染，**不用空串 `text` 兜底**）。
**M1 采集现状（如实）**：`agent_message`（执行器落最终输出）+ `tool_call`（已有）+ 老板原话 **可投影**；**`agent_thinking` kind 已登记但 M1 不采集** → `thinking` 本轮**恒缺**（缺即不渲染，不是缺陷）。
**隐私**：本视图**只读、只在本机、绝不进人类频道**（`UI §4.6`）。
