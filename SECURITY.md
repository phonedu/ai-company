# 安全策略

## 报告

请使用 GitHub **Private vulnerability reporting**（Security → Advisories → Report a vulnerability）。
不要在公开 Issue 里贴密钥、利用细节或用户数据。维护者会尽快确认并给出处置计划。

## 威胁模型（本项目特有）

- **本地优先 / BYO-key**：模型 Key 保存在本机 `~/.aico/secrets`，不上传；请勿在 Issue/截图里泄露 Key。
- **工具权限**：员工/幕僚长可执行 shell、读写项目文件。模型输出可能被提示词注入诱导；
  高风险动作应走权限卡（设置 → 权限与调度），不要给不可信项目开放过宽权限。
- **更新完整性**：当前安装包**未做代码签名**；electron-updater 校验 `latest.yml` 的 sha512，
  但不防更新源被篡改。请只从官方 Releases 下载。
- **数据**：任务/笔记/账本在本地 SQLite 与项目目录；无遥测、无云同步。备份与删除见 `docs/DATA.md`。

## 支持范围

维护者按 best-effort 处理；不承诺 SLA。已发布版本的安全修复会尽量以 patch release 提供。
