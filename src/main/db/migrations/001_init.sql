-- 001_init.sql — ai-company v1 基线 schema（冻结）
--
-- 唯一权威：仓库根 schema.sql（v1 冻结，30 表 / 22 索引）。
-- 本文件 = schema.sql 的 DDL，去掉了连接级 PRAGMA（journal_mode / foreign_keys 由连接打开时设置，见 open.ts）。
-- 迁移器按「一个迁移 = 一个事务」应用；所有 DDL 均为 IF NOT EXISTS → 幂等可重跑。
-- 改动顺序：先改 schema.sql，再新增 NNN_*.sql；禁止改写历史迁移（checksum 守卫）。
-- ai-company 数据模型（SQLite / WAL）—— **v1 冻结（frozen）**
-- 本文件是 DDL 契约的**唯一权威**（schema.sql）；改动遵循「先改文档（本节），再改迁移」。
-- 冻结日期：2026-10-12。v1 = 30 张表（26 张原有 + schema_migrations / counters / pending_lists / plan_steps）。
-- 计划步骤完成度：plan_steps 中 state='done' 的计数 / 总数（任务详情进度条）。
-- 设计要点：
--   1) task_events 是唯一事实来源（event sourcing 的轻量版）：状态、进度、汇报、timeline 全部由它投影。
--   2) "聊天"不出现在工作模型里：只有老板频道（human_messages）+ 三类卡片（reports）+ IM 会话状态（im_conversations）。
--   3) 员工协作走 work_items + mailbox 语义的 task_events，不共享 transcript。
--   4) 多任务并发 = 活跃槽位（task.state=ready 等槽位）+ 员工占用队列；多项目 = projects + 记忆/产物隔离。
--
-- 【迁移清单机制】（解 「重启不重复迁移」）
--   * 基线：本文件即 v1 基线快照；所有 CREATE 一律 `IF NOT EXISTS`，可安全重复执行（幂等）。
--   * 版本：启动读 `PRAGMA user_version`（0 = 空库）；逐条应用 `migrations/NNN_*.sql`。
--     一个迁移 = 一个事务：应用 DDL + `INSERT INTO schema_migrations` + `PRAGMA user_version = N`。
--   * 清单：`schema_migrations` 是可读、可审计的已应用清单；`user_version` 只是快速门槛（避免每次遍历）。
--   * 旧库升级：永远增量（`ALTER TABLE`），**不重跑基线**；新库：先跑基线（version=1），再按清单追加。
--   * 守卫：版本号已存在于 `schema_migrations` → 跳过；`checksum` 不匹配 → 报错（禁止改写历史迁移）。


-- ─────────────────────────── 迁移清单（DDL 的版本轴） ───────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,          -- 迁移号（基线 = 1；严格递增、不复用）
  name        TEXT NOT NULL,                -- 迁移文件名（不含序号），如 "001_init"
  applied_at  INTEGER NOT NULL,             -- epoch ms
  checksum    TEXT                          -- 迁移文件内容 sha256（防「改写历史迁移」）
);

-- ─────────────────────────── 身份与团队 ───────────────────────────

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,              -- 一句话角色，如 "researcher" / "writer" / "reviewer"
  persona       TEXT NOT NULL DEFAULT '',   -- 长期 system prompt（人设层③；与具体任务无关，任务细节进工作简报）
  model         TEXT,                       -- providerId/modelId；NULL = 跟随全局默认
  thinking      TEXT,                       -- 思考强度：off | low | medium | high
  skills        TEXT NOT NULL DEFAULT '[]', -- JSON: 勾选的 skills.id 列表
  mcps          TEXT NOT NULL DEFAULT '[]', -- JSON: 勾选的 mcp_servers.id 列表
  capability_tier TEXT NOT NULL DEFAULT 'standard', -- 员工能力档：sandbox | standard | trusted——限定 TA 能拿到什么工具（与项目放行档取交集）
  avatar        TEXT,                       -- 头像文件（~/.aico/avatars/）
  is_assistant  INTEGER NOT NULL DEFAULT 0, -- 0 号员工（幕僚长）
  active        INTEGER NOT NULL DEFAULT 1, -- 0 = 停用（停用前检查在跑/排队工作项并转派）
  created_at    INTEGER NOT NULL
);

-- 技能库：员工档案里存勾选的 id；项目默认集存 projects.default_skills
CREATE TABLE IF NOT EXISTS skills (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL,              -- builtin | local | url | ai（AI 自建技能）
  path          TEXT NOT NULL,              -- ~/.aico/skills/<name>/SKILL.md
  version       TEXT,                       -- url 来源可更新用
  enabled       INTEGER NOT NULL DEFAULT 1, -- builtin 不可删、可停用
  created_at    INTEGER NOT NULL
);

-- MCP server 库
CREATE TABLE IF NOT EXISTS mcp_servers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  transport     TEXT NOT NULL,              -- stdio | http
  command       TEXT,                       -- stdio: 命令
  args          TEXT NOT NULL DEFAULT '[]', -- JSON
  url           TEXT,                       -- http: URL
  env           TEXT NOT NULL DEFAULT '{}', -- JSON；含凭据（存 ~/.aico 受限权限文件，UI 掩码，绝不进项目文件夹）
  exposure      TEXT NOT NULL DEFAULT 'auto', -- auto | direct | deferred（工具多时按需加载）| codemode
  has_external_actions INTEGER NOT NULL DEFAULT 0, -- 1 = 含对外动作工具 → 一律 consent 逐次批准
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- 供应商凭据池：明文只存 ~/.aico/secrets（受限权限文件），
-- 本表仅存元数据；同供应商多 Key 默认轮询 + 遇 429 自动换 Key，可手动 pin。
CREATE TABLE IF NOT EXISTS provider_keys (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL,              -- anthropic | openai | deepseek | local | ...
  label         TEXT NOT NULL,              -- 主 | 备用 | 项目专用 …
  secret_ref    TEXT NOT NULL,              -- 指向 ~/.aico/secrets 的条目名（绝不存明文）
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  UNIQUE(provider, label)
);

-- 员工记忆按作用域分区：project_id = 0 表示跨项目的通用记忆（需显式提升），
-- 其余为项目记忆（任务结束时写入）。分开存放防止项目间串味。
CREATE TABLE IF NOT EXISTS employee_memory (
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  project_id    INTEGER NOT NULL DEFAULT 0, -- 0 = 全局/通用；否则 = projects.id
  memory        TEXT NOT NULL DEFAULT '',   -- Markdown；任务结束时由编排器追写
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (employee_id, project_id)
);

-- ─────────────────────────── 工作图谱 ───────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  alias         TEXT UNIQUE,                -- IM 里用的短别名（如 "记账"），#记账 … 可寻址
  root_dir      TEXT NOT NULL,              -- 该项目产物与任务工作目录的根
  attention     TEXT NOT NULL DEFAULT 'normal', -- focus | normal | quiet（推送策略）
  access_mode   TEXT NOT NULL DEFAULT 'inplace', -- inplace（原地 + 每任务 git 分支）| staging（沙盒副本）
  default_employee_ids TEXT NOT NULL DEFAULT '[]', -- JSON: 项目默认参与员工（v2）
  default_skills TEXT NOT NULL DEFAULT '[]', -- JSON: 项目默认技能集——该项目下任务自动附加
  allowed_providers TEXT NOT NULL DEFAULT '[]', -- JSON: 供应商白名单；空 = 不限制。非空时本项目员工模型必须落在其内
  archived      INTEGER NOT NULL DEFAULT 0, -- 归档（软操作，不搬动/不删除文件夹；可恢复）
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  short_id      TEXT UNIQUE,                -- 人类与 IM 用的短号，如 "T-1042"
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,              -- 原始需求（用户原话，不改写）
  acceptance    TEXT NOT NULL DEFAULT '[]', -- JSON: [{text, check?}] —— check 为可选的可执行检查命令（如 "npm test"），
                                            -- verifier 实际执行取原始输出（机器判定）；无 check 的条目人话判定 + 证据
  state         TEXT NOT NULL DEFAULT 'inbox',
    -- inbox | planning | awaiting_approval | ready | executing | paused | verifying
    -- | needs_decision | done | failed | blocked | cancelled
    -- paused：用户主动暂停/搁置，不占槽位、不老化
  resume_state  TEXT,                       -- 回边恢复目标：needs_decision/blocked/paused 恢复时回到的状态（禁默认回 ready）
  state_before_close TEXT,                  -- 结束前状态：撤销结束回边（done/failed/cancelled → 原状态）用
  risk_level    INTEGER NOT NULL DEFAULT 1, -- 0=L0 无闸门 / 1=L1 审计划 / 2=L2 全流程+人工批准
  priority      INTEGER NOT NULL DEFAULT 0, -- 取槽位排序；优先 = 数值大
  ready_since   INTEGER,                    -- 进入 ready 的时刻；老化（anti-starvation）基准，src/core/scheduler.effectivePriority 依赖
  deadline      INTEGER,                    -- 截止时刻（epoch ms；NULL = 无）；调度次级排序键，src/core/scheduler.priorityOrder 依赖
  owner_id      INTEGER REFERENCES employees(id), -- 任务负责人（通常是 assistant）
  parent_task_id INTEGER REFERENCES tasks(id),    -- 子任务（父任务等全部子任务完成后进 verifying）
  renewed_from  INTEGER REFERENCES tasks(id),     -- 续办来源：本任务由哪个终态任务续办而来
  budget_tokens INTEGER,                    -- 预算（NULL = 不限）
  cost_tokens   INTEGER NOT NULL DEFAULT 0, -- 已消耗（由 costs 汇总回写）
  origin        TEXT NOT NULL DEFAULT 'boss',
    -- boss | im:<platform> | cron | task:<id>（来源；归属项目由 project_id 表达）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_at     INTEGER,                    -- 进入终态的时刻（撤销窗口 7 天从此算起）
  archived      INTEGER NOT NULL DEFAULT 0, -- 归档后不再提供"撤销结束"，只能「续办」
  archived_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, priority DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

-- 任务依赖（DAG）：task_id 依赖 depends_on；全部依赖 done → 自动 ready
CREATE TABLE IF NOT EXISTS task_deps (
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  depends_on    INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

-- 计划步骤（任务详情进度条的数据源；「●●○○ 2/4」）
-- materialized 投影：task_events 仍是唯一事实来源——
--   初始步骤随 kind='plan_drafted'（payload.steps[]）落库；
--   每步状态变更落 kind='progress_reported'（payload={stepIdx,state}）；本表由事件重放/增量维护。
-- 进度条 = count(state='done') / count(*)（按 idx 排序）；证据落在 evidence_ref。
CREATE TABLE IF NOT EXISTS plan_steps (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  idx           INTEGER NOT NULL,           -- 展示顺序，从 1 起（"2/4" 的 2）
  text          TEXT NOT NULL,              -- 步骤描述（人话）
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | skipped | failed
  work_item_id  INTEGER REFERENCES work_items(id), -- 该步骤由哪个工作项承载（可空）
  evidence_ref  TEXT,                       -- 证据引用：artifacts.id / 相对路径 / 命令输出摘要（可空）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(task_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_task ON plan_steps(task_id, state);

-- 派给员工的原子工作单元
CREATE TABLE IF NOT EXISTS work_items (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL,              -- 结构化工作简报（目标/验收/输入产物/预算）
  state         TEXT NOT NULL DEFAULT 'queued',
    -- queued | running | submitted | rejected | done | failed | interrupted
    -- interrupted = 崩溃/重启导致的中断，编排器按策略自动重派或问你（风险 7）
    -- 注：每次迁移都必须在 task_events 落对应 kind（见下），work_items 只存当前态
    -- （员工占用队列：同员工 queued 项按任务优先级 → created_at 排序）
  attempt       INTEGER NOT NULL DEFAULT 0,
  result        TEXT,                       -- JSON: submit_work_item 的结构化结果
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_items_task ON work_items(task_id, state);
CREATE INDEX IF NOT EXISTS idx_work_items_emp ON work_items(employee_id, state);

-- 单一事实来源：所有状态迁移、问答、产物、评审、成本事件
CREATE TABLE IF NOT EXISTS task_events (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id  INTEGER REFERENCES work_items(id),
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
    -- task_created / task_triaged / task_activated（依赖满足）/ task_started / task_reopened（撤销结束回边）
    -- plan_drafted / plan_reviewed / plan_approved
    -- work_item_created / work_item_assigned / work_item_started / work_item_submitted
    -- work_item_done / work_item_rejected / work_item_failed（与 work_items.state 对齐；rejected = 打回重做）
    -- work_item_interrupted（崩溃/重启中断，可自动重派， 风险 7）
    -- agent_settled（Pi 会话一轮结束 → 推进状态机）
    -- cost_recorded（写 costs 行；payload 带 usage，/§6.2）
    -- question_asked / question_answered / artifact_produced / progress_reported
    -- review_requested / review_completed / verification_started / verification_completed
    -- report_generated / decision_requested / decision_made
    -- task_blocked / task_failed / task_completed / task_cancelled
    -- task_paused / task_resumed / task_archived / task_renewed（/）
    -- budget_exceeded / focus_changed / thread_bound / thread_archived
    -- tool_call / permission_requested / permission_decision（权限审计）
    -- changeset_created / changeset_merged / changeset_discarded / external_change_detected（变更审查）
  actor         TEXT NOT NULL,              -- boss | assistant | employee:<id> | verifier | critic | system
  payload       TEXT NOT NULL DEFAULT '{}', -- JSON：按 kind 约定结构
  session_ref   TEXT                        -- 原始模型/会话引用，供下钻查看，不进人类频道
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON task_events(kind, ts);

-- ─────────── 引擎两件套（：运行时模型） ───────────

-- 动作日志：每个副作用动作先登记（pending）再执行（done），幂等键防重复
-- 崩溃重启：扫 pending 的动作做幂等重放 —— 不会重复派工单/通知/扣预算
-- 【action_key 生成规范】<kind>:<subject_kind>:<subject_id>:<revision>
--   kind = 动作类型（dispatch | notify | merge | charge_budget | schedule_timer ...）
--   subject_kind/id = 动作针对的主体（work_item / report / task / changeset ...）
--   revision = 主体上的“第几次”（work_item.attempt；无自然次数的用 0）
--   例：dispatch:work_item:42:2 · notify:report:88:0 · merge:changeset:7:0
--   不变式：同一逻辑动作重算出的 key 必须相同；不同主体/不同 attempt 必须不同。
--   注：“已执行、未置 done”的崩溃窗口内重放是 at-least-once，靠下游幂等键（notifications.dedupe_key / timers.dedupe_key）兜底。
CREATE TABLE IF NOT EXISTS action_log (
  id            INTEGER PRIMARY KEY,
  action_key    TEXT NOT NULL UNIQUE,       -- 幂等键：<kind>:<subject_kind>:<subject_id>:<revision>（见上）
  kind          TEXT NOT NULL,
  task_id       INTEGER REFERENCES tasks(id),
  payload       TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  created_at    INTEGER NOT NULL,
  done_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_action_pending ON action_log(state, created_at);

-- 持久化时钟：AskCard 超时 / 阻塞看门狗 / 会话心跳 / cron 触发
CREATE TABLE IF NOT EXISTS timers (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,              -- askcard_timeout | blocked_watchdog | session_heartbeat | cron_fire
  task_id       INTEGER REFERENCES tasks(id),
  due_at        INTEGER NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  dedupe_key    TEXT,                       -- 幂等键：<kind>:<task_id|0>:<逻辑标识>（如 watchdog:blocked:task:42）
  fired_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_timers_due ON timers(fired_at, due_at);
-- 重建幂等（解「重启重复定时器」）：启动恢复二选一，禁止“只 INSERT 不清理”——
--   (a) `DELETE FROM timers WHERE fired_at IS NULL` 后按 due_at 重建；或
--   (b) 按 dedupe_key 做 UPSERT，依赖下面部分唯一索引拦住同一逻辑定时器重复登记。
CREATE UNIQUE INDEX IF NOT EXISTS idx_timers_dedupe ON timers(kind, task_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id  INTEGER REFERENCES work_items(id),
  path          TEXT NOT NULL,              -- 相对任务工作目录的文件路径或 URL
  kind          TEXT NOT NULL DEFAULT 'file', -- file | url | snapshot | input（你或 IM 发来的附件作为任务输入，落 inputs/ 并全任务可引用）
  note          TEXT NOT NULL DEFAULT '',
  sha256        TEXT,                       -- 产物指纹（防止"汇报的产物"被后续改动影响）
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- ──────────────── 变更集（代码/文件改动的审查单元） ────────────────
-- 由任务 git 分支（aico/T-xxxx）生成；work_item 粒度的"小步提交"；
-- 主分支只有在你点「合并」后才前进（合并 = consent 动作）。

CREATE TABLE IF NOT EXISTS changesets (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id  INTEGER REFERENCES work_items(id),
  branch        TEXT,                       -- aico/T-1042
  base_sha      TEXT,                       -- 创建分支时的主分支 sha（外部改动检测的基线）
  head_sha      TEXT,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL DEFAULT '',   -- 人话摘要（AI 生成，随汇报卡的 🔀 行展示）
  commit_msg    TEXT,
  state         TEXT NOT NULL DEFAULT 'open', -- open | merged | discarded | superseded
  created_at    INTEGER NOT NULL,
  merged_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_changesets_task ON changesets(task_id, state);

CREATE TABLE IF NOT EXISTS changeset_files (
  id            INTEGER PRIMARY KEY,
  changeset_id  INTEGER NOT NULL REFERENCES changesets(id),
  path          TEXT NOT NULL,
  status        TEXT NOT NULL,              -- added | modified | deleted | renamed
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  employee_id   INTEGER REFERENCES employees(id) -- 谁改的（对应"哪个员工・哪个 work item"）
);
CREATE INDEX IF NOT EXISTS idx_changeset_files ON changeset_files(changeset_id);

-- ─────────────────────── 人类通道（唯一入口） ───────────────────────

-- 所有外部输入归一化后先落这里，再 triage
CREATE TABLE IF NOT EXISTS inbox_items (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,              -- desktop | im:wechat | im:qq | im:telegram | cron
  sender        TEXT,                       -- 平台侧发送者标识
  conversation_ref TEXT,                    -- 平台会话 id（私聊/群），用于 sticky 焦点解析
  platform_msg_id  TEXT,                    -- 平台侧消息 id（回复链锚点，入站侧）
  raw           TEXT NOT NULL,              -- 原始消息体（含附件引用）
  received_at   INTEGER NOT NULL,
  triaged_as    TEXT,                       -- chat | command | task_related | new_task | reply_to_task
  task_id       INTEGER REFERENCES tasks(id), -- 归位到的任务
  confidence    REAL,                       -- triage 置信度；< 0.8 且 new_task 时先确认一次
  handled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbox_open ON inbox_items(handled_at, received_at);

-- 老板频道：全应用唯一的人机对话 transcript（含 IM 桥接进来的消息）
CREATE TABLE IF NOT EXISTS human_messages (
  id            INTEGER PRIMARY KEY,
  direction     TEXT NOT NULL,              -- in(你→系统) | out(系统→你)
  task_id       INTEGER REFERENCES tasks(id), -- 带上下文的消息归属任务；NULL = 全局
  content       TEXT NOT NULL,
  attachments   TEXT NOT NULL DEFAULT '[]', -- JSON
  inbox_item_id INTEGER REFERENCES inbox_items(id), -- 入站的溯源
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_human_msgs ON human_messages(created_at);

-- 三类卡片：完成汇报 / 决策请求 / 异常
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  kind          TEXT NOT NULL,              -- report | ask | alert
  payload       TEXT NOT NULL,              -- JSON：TL;DR/产物/证据/成本；或问题/选项/推荐/默认动作/超时
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | acknowledged | resolved
  dedupe_key    TEXT,                       -- 同任务同类型去重
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_pending ON reports(state, kind, created_at);

-- AskCard 的答案（含超时默认动作）
CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id), -- 可空：权限审批（全局/项目级）无任务上下文；见文件底部“权限审批复用 approvals”
  report_id     INTEGER REFERENCES reports(id),
  question      TEXT NOT NULL,
  options       TEXT NOT NULL,              -- JSON 数组，含 recommended 标记
  default_action TEXT,                      -- 超时执行的选项 key；NULL = 一直等
  timeout_at    INTEGER,
  chosen        TEXT,                       -- 选项 key
  decided_by    TEXT,                       -- boss | timeout
  decided_at    INTEGER
);

-- 通知投递记录（策略引擎的事实表）
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  report_id     INTEGER REFERENCES reports(id),
  channel       TEXT NOT NULL,              -- desktop | im:wechat | im:qq | im:telegram
  conversation_ref TEXT,                    -- 投递到的平台会话
  dedupe_key    TEXT NOT NULL,              -- 幂等键：<report_id>:<channel>:<conversation_ref>:<revision>；同键重放直接丢弃
  sent_at       INTEGER NOT NULL,
  merged_into   INTEGER REFERENCES notifications(id), -- 被合并进哪条（合并窗口）
  UNIQUE(dedupe_key)                        -- 防重放：回滚“已执行未落 done”窗口，不会重复发消息
);
CREATE INDEX IF NOT EXISTS idx_notifications_report ON notifications(report_id, channel);

-- ─────────── IM 通道：会话状态 / 回复链 / 显式绑定 ───────────
-- 对象模型：私聊总收件箱（唯一且永久） + 可选的项目群（每项目 ≤ 1 个）。
-- 任务不是 IM 对象，只是消息上的短 ID 标签；IM 对象数 = 1 + 活跃项目数。
-- 注：桌面老板频道（channel='desktop', conversation_ref='desktop:boss'）也复用本表存 sticky 焦点——
--     resolver 对 desktop 与 IM 同构（src/core/resolver.ts 统一调 getConversation/setFocus）。

CREATE TABLE IF NOT EXISTS im_conversations (
  id              INTEGER PRIMARY KEY,
  channel         TEXT NOT NULL,            -- im:wechat | im:qq | im:telegram | desktop
  conversation_ref TEXT NOT NULL,           -- 平台会话 id（私聊或群）
  kind            TEXT NOT NULL,            -- private | group
  project_id      INTEGER REFERENCES projects(id), -- 群 → 项目；私聊 → NULL
  focus_task_id   INTEGER REFERENCES tasks(id),    -- sticky 焦点；只被工作性消息更新
  focus_updated_at INTEGER,
  last_active_at  INTEGER NOT NULL,
  UNIQUE(channel, conversation_ref)
);

-- 出站消息 → 任务/卡片映射：回复链归位（reply-to）的依据
CREATE TABLE IF NOT EXISTS outbound_refs (
  id              INTEGER PRIMARY KEY,
  channel         TEXT NOT NULL,
  conversation_ref TEXT NOT NULL,
  platform_msg_id TEXT NOT NULL,            -- 平台侧消息 id
  task_id         INTEGER REFERENCES tasks(id),
  report_id       INTEGER REFERENCES reports(id),
  sent_at         INTEGER NOT NULL,
  UNIQUE(channel, platform_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_task ON outbound_refs(task_id);

-- 显式任务绑定：仅用于 war room / 需外部人参与的场景，默认不创建
-- 硬约束（应用层断言）：同一 task_id 同时 active=1 的绑定 ≤ 1
CREATE TABLE IF NOT EXISTS im_bindings (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  channel       TEXT NOT NULL,              -- im:wechat | im:qq | ...
  thread_ref    TEXT NOT NULL,              -- 平台会话/线程 id
  reply_context TEXT,                       -- 平台侧回复凭据（如 token）
  active        INTEGER NOT NULL DEFAULT 1, -- 任务终态 → 置 0（归档）
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  UNIQUE(channel, thread_ref, active)
);
CREATE INDEX IF NOT EXISTS idx_bindings_task ON im_bindings(task_id, active);

-- ─────────────── 计数器与会话瞬态（short-id / resolver 的落库载体） ───────────────

-- 短号计数器（src/core/short-id.ts 的 CounterStore）。分配**必须与任务 INSERT 在同一事务内**：
--   UPDATE counters SET value = value + 1 WHERE name = 'task_short_id' RETURNING value;
-- 单调递增、永不复用（允许空洞，绝不允许回收）—— 旧卡片上的 T-1042 必须永远指向同一任务。
-- 取代原“塞进 settings(TEXT JSON)”方案（KV-JSON 做原子自增语义不清、易误用）。
CREATE TABLE IF NOT EXISTS counters (
  name        TEXT PRIMARY KEY,             -- 目前 'task_short_id'（起始 1001）；以后可扩 project_alias 等
  value       INTEGER NOT NULL              -- 最近一次已分配的值
);

-- resolver 的 PendingList（src/core/resolver.ts）：“列表/模糊确认”后暂存的可选清单，
-- 用户回序号 → 走 resolver 链条第 2 步精确解析 → 保证“只问一次”。
-- 选专用表（而非 im_conversations 挂 JSON 列）的三个理由：① desktop 会话也需同一载体（channel='desktop'）；
-- ② 这是有 TTL 的瞬态会话状态，不该污染 IM 会话表；③ items 结构（index/taskId/reportId）需要可校验的落点。
-- 同一会话只保留最近一份（UNIQUE 覆盖）；新的一次提问直接 REPLACE 旧清单。
CREATE TABLE IF NOT EXISTS pending_lists (
  id              INTEGER PRIMARY KEY,
  channel         TEXT NOT NULL,            -- desktop | im:wechat | im:qq | im:telegram
  conversation_ref TEXT NOT NULL,           -- 会话 id（desktop 用固定值如 'desktop:boss'）
  message_ref     TEXT NOT NULL,            -- 提问那条消息/卡片的引用（溯源用）
  items           TEXT NOT NULL DEFAULT '[]', -- JSON: [{index, taskId, reportId}]（ResolverStore.PendingList.items）
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,                  -- 过期即视为无待办（NULL = 不自动过期）
  UNIQUE(channel, conversation_ref)
);
CREATE INDEX IF NOT EXISTS idx_pending_expiry ON pending_lists(expires_at);

-- ─────────────────────────── 成本 ───────────────────────────
-- 落库触发（解「costs 无写入触发点」）：会话/turn 结算或工具调用结束时，engine 在同一动作里
-- 写一行 costs + 一条 task_events(kind='cost_recorded', payload 带 usage)，并回写 tasks.cost_tokens（budgetLeft）。

CREATE TABLE IF NOT EXISTS costs (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id  INTEGER REFERENCES work_items(id),
  employee_id   INTEGER,
  model         TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_task ON costs(task_id);

-- ─────────────────────────── 其他 ───────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL               -- JSON
);
-- 约定键：
--   scheduler.max_active_tasks （默认 3；全局 executing 任务槽位上限）
--   scheduler.aging_minutes （默认 30；等待老化的时间粒度）
--   scheduler.occupancy_aware （默认 false；true = 取槽位前确认有可立即派发的工作，避免空占）
--   employee.concurrency （默认 1；同员工并行上限，不建议 >1）
--   employees.auto_recruit （默认 true；秘书可自主招人，招募卡仅通知+可改；false = 招募需你批准）
--   models.default_thinking （默认 medium；员工/任务可覆盖）
--   models.role_map （JSON：角色 → 模型，招募时预填；）
--   models.critic （critic/verifier 专用模型，建议与执行员工不同供应商）
--   models.fallback_chain （JSON 数组：主模型不可用时的降级链，降级会记事件并标注）
--   projects.default_id （IM 未指定项目时新任务的落点；空 = 模糊时问你一次）

-- 放行档（autonomy）：global(0) / project / task 三级覆盖
-- tier: strict（严格——写操作也逐次批准）| standard（标准，默认）| loose（宽松——本地全自动；对外动作永远逐次批准）
-- 员工"能拿到什么工具"的能力档在 employees.capability_tier；有效权限 = 两者取交集
-- policy JSON: { pathRules[], commandDenylist[], consentRules[], grants[{rule, scope:'once'|'task'|'project', expiresAt}] }
CREATE TABLE IF NOT EXISTS permission_policies (
  id            INTEGER PRIMARY KEY,
  scope_type    TEXT NOT NULL,              -- global | project | task
  scope_id      INTEGER NOT NULL DEFAULT 0, -- 0 = 全局；否则为 project_id / task_id
  tier          TEXT NOT NULL DEFAULT 'standard',
  policy        TEXT NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL,
  UNIQUE(scope_type, scope_id)
);
-- 权限审批记录复用 approvals（report_id 为空、question 前缀标识为权限请求）：
-- 目的是让"批准 AI 的对外动作"和"回答业务决策"走同一套 AskCard 通道 —— 微信里也能批。
