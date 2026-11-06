# 架构

## 进程

- **main**（Electron 主进程）：窗口/托盘/通知、SQLite、引擎、IPC、模型会话调度。
- **preload**：只暴露白名单 IPC（`window.api`），不暴露 `ipcRenderer` 本体。
- **renderer**（React + valtio）：老板频道、任务详情、项目树、大厅、笔记、设置。

## 数据与引擎

- SQLite（better-sqlite3，WAL）；迁移在 `src/main/db/migrations`。
- 任务状态机由事件驱动：`task_events` 是事实来源，`plan_steps` 等是物化投影。
- 事件经 `evt:batch` 推到渲染层；UI 只读投影，不直接改表。
- 关键闸门：计划评审（critic）、验收（verifier）、权限卡（工具调用）、预算/槽位。

## 模型

- 通过 Pi SDK 运行员工/幕僚长会话；模型目录、Key、项目策略在设置中配置。
- BYO-key；Key 存 `~/.aico/secrets`。会话上下文分层组装，压缩策略可配置。
- 员工工具（shell/文件/笔记等）受权限档约束；高风险动作走权限卡。

## IPC 域

`app / task / chat / employee / hall / inbox / project / settings / provider / model / im / file /
cost / scheduler / mailbox / docs / search / skills / mcp / seams / memory / notify / notes / update`。

## 构建

- electron-vite 构建 `out/`；electron-builder 出 NSIS 安装器与 portable；
- 自动更新走 GitHub Releases（generic provider + `latest.yml`）。
