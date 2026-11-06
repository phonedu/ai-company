# src/core — 编排核心（M0 第一批）

三个模块都是**纯逻辑 + 存储接口注入**，不依赖 Electron/SQLite，可以直接单测；
后续把 `ResolverStore` / `CounterStore` 换成 better-sqlite3 实现即可接入产品。

| 模块 | 职责 | 对应方案 |
|---|---|---|
| `short-id.ts` | 任务短号 `T-1042` 分配（单调递增、永不复用）+ 项目别名校验与引用解析 | PLAN §14.2 / §14.3 |
| `resolver.ts` | 归属解析优先级链：命令 → 显式地址 → 待办序号 → 回复链 → 项目别名 → sticky 焦点 → 语义 → 兜底确认。桌面与 IM 共用 | PLAN §14.3 / §14.5 |
| `scheduler.ts` | 两层资源调度：全局活跃槽位（ready→executing）+ 员工占用队列（work item 派发）；依赖激活与父任务推进；输出决议（无副作用） | PLAN §13.2 / §13.3 |

## 运行

本项目要求 Node **≥ 22.19**，但本机系统是 Node 20，所以要用 `scripts/` 下的入口包一层（本机**默认无 bash**，请用 PowerShell / cmd 版）：

```powershell
# PowerShell（推荐）
cd D:\ai-company
.\scripts\with-node22.ps1 pnpm install
.\scripts\with-node22.ps1 pnpm test      # tsc 编译 + node --test，25 pass / 0 fail
# 或先切换当前会话（注意点 + 空格）： . .\scripts\env.ps1
```

```bat
REM cmd
scripts\with-node22.cmd pnpm test
```

```bash
# Git Bash（有 bash 的机器）
scripts/with-node22.sh pnpm test
```

直接 `pnpm test`（系统 Node 20）会被 `scripts/check-node.mjs` 拦下并提示切换方式。

> 普通 PowerShell 若报“禁止运行脚本”，先跑一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，或改用 cmd 入口。

## 集成约定（给编排器）

- `planScheduling` 返回的决议要在**同一事务内**应用并落 `task_events`，然后**再跑一次**直到没有新决议（fixpoint）——`activate`/`start` 会解锁后续派发。
- `resolveInbound` 的 `confirm` 决议要登记为 **pending list**：专用载体是 `schema.sql` 新增的 **`pending_lists` 表**（按 `channel` + `conversation_ref` 归并、`items` JSON、带 `expires_at` 过期；桌面会话用 `channel='desktop'`）。用户回序号后走链条第 2 步精确解析，保证“只问一次”。
- `resolveInbound` 的 `new_task` 决议只是"该建任务"的裁定；**短号计数器自增独立提交（允许空洞、永不复用）；任务 INSERT 必须携带已分配的 `short_id`，并与其余写入同事务**。理由：第一不变式是"单调递增、永不复用"（见 `short-id.ts`），而同一事务下 ROLLBACK 必然回收序号，二者不可兼得——取更强的"永不复用"，代价是允许空洞。
- 短号规则（明文化）：格式 = `T-` + 十进制（起始 `1001`），**单调递增、永不复用、允许空洞**；**人不需要手打短号**（入站优先「回复」或「序号」）；**预留 `T2-` 命名空间但当前不实现**——将来换格式只加 `format`/`canonicalize` 兼容层，**不动核心分配器**。
