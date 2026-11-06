import { contextBridge, ipcRenderer, webUtils } from 'electron';

// ─────────────────────────────────────────────────────────────────────────────
// preload：只暴露白名单方法，**绝不暴露 ipcRenderer 本体**（DEV §7.5）。
// 通道 = `DEV §7.3` 的域集合（task/chat/employee/hall/inbox/project/settings/im）。
// 本文件不写业务逻辑，只做「请求转发 + 订阅转发 + 退订函数」。
// ─────────────────────────────────────────────────────────────────────────────

type Unsubscribe = () => void;

const invoke = (channel: string, arg?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, arg);

/** 主→渲染推送通道白名单（§7.3 P 方向）。
 *  `evt:batch` 为统一信封（Q-B 裁决）：`{channel, batchSeq, items[], emitAt}`，16ms 窗口 / 单批 ≤500。
 *  `evt:agent`（G8 装配三态）经信封送达并由 store 路由——补进白名单（BRK15 核对：推了但未声明）。 */
const EVENT_CHANNELS = ['evt:task', 'evt:message', 'evt:hall', 'evt:notify', 'evt:inbox', 'evt:read', 'evt:agent', 'evt:toast', 'evt:open-view', 'evt:batch'] as const;
type EventChannel = (typeof EVENT_CHANNELS)[number];

/** 浏览器 `File` 的结构化最小类型（preload 的 lib 不带 DOM）。 */
type FileLike = {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const api = {
  /** 壳生命周期信号（T0.1 日志/截图基线用）。 */
  ui: {
    mounted: (): void => {
      ipcRenderer.send('ui:mounted');
    },
  },
  /** 壳层窗口控制（2026-10-16 替换批·壳层重排）：`frame:false` 自绘三键的驱动面。
   *  `ui:` ＝内部前缀（同 `ui:mounted`），非业务域。 */
  win: {
    minimize: (): Promise<unknown> => invoke('ui:win-minimize'),
    toggleMaximize: (): Promise<unknown> => invoke('ui:win-toggle-maximize'),
    isMaximized: (): Promise<unknown> => invoke('ui:win-is-maximized'),
    close: (): Promise<unknown> => invoke('ui:win-close'),
  },
  /** 2026-10-29 P2（P-N05）：版本/数据目录（只读）；打开数据目录走主进程 shell。 */
  app: {
    info: (): Promise<unknown> => invoke('app:info'),
    openDataDir: (): Promise<unknown> => invoke('app:open-data-dir'),
  },
  /** 自动更新（2026-11-06）：状态/检查/重启安装；`update:status` 为主→渲染推送。 */
  update: {
    get: (): Promise<unknown> => invoke('update:get'),
    check: (): Promise<unknown> => invoke('update:check'),
    install: (): Promise<unknown> => invoke('update:install'),
    onStatus: (callback: (status: unknown) => void): Unsubscribe => {
      const handler = (_e: unknown, status: unknown): void => callback(status);
      ipcRenderer.on('update:status', handler);
      return (): void => {
        ipcRenderer.off('update:status', handler);
      };
    },
  },
  task: {
    create: (input?: unknown): Promise<unknown> => invoke('task:create', input),
    list: (filter?: unknown): Promise<unknown> => invoke('task:list', filter),
    get: (input?: unknown): Promise<unknown> => invoke('task:get', input),
    transition: (input?: unknown): Promise<unknown> => invoke('task:transition', input),
    approve: (input?: unknown): Promise<unknown> => invoke('task:approve', input),
    /** GAP8：批准前编辑计划（`awaiting_approval`；`approve:true`＝改计划再批准）。 */
    editPlan: (input?: unknown): Promise<unknown> => invoke('task:edit-plan', input),
    /** M3-P-4 / BRK16-b：把一个变更集合并到项目主分支（真值表/幂等/冲突由主进程返回）。 */
    merge: (input?: unknown): Promise<unknown> => invoke('task:merge', input),
    reworkMergeConflict: (input?: unknown): Promise<unknown> => invoke('task:rework-merge-conflict', input),
    /** M3-N-2 / GAP4：把一个变更集回滚到其工作项检查点（只动该次提交改过的文件）。 */
    rollback: (input?: unknown): Promise<unknown> => invoke('task:rollback', input),
    /** B-2：丢弃一个变更集（不合并；主分支/其他工作项不动；幂等）。 */
    discard: (input?: unknown): Promise<unknown> => invoke('task:discard', input),
    readArtifact: (input?: unknown): Promise<unknown> => invoke('task:read-artifact', input),
    /** UG-06：变更集单文件只读 diff（`{taskId, changesetId, path}`；主进程校验归属/路径）。 */
    diff: (input?: unknown): Promise<unknown> => invoke('task:diff', input),
    /** M4-D-1（P2）：按 ref 受控读取归档的工具大输出。 */
    readToolOutput: (input?: unknown): Promise<unknown> => invoke('task:read-tool-output', input),
    /** G-A/G-B/C（M2 §7 序 3）：把某任务的产物**引用到目标任务**（老板显式发起；copy 快照＋sha256）。 */
    referenceArtifact: (input?: unknown): Promise<unknown> => invoke('task:reference-artifact', input),
    export: (input?: unknown): Promise<unknown> => invoke('task:export', input),
  },
  chat: {
    send: (message?: unknown): Promise<unknown> => invoke('chat:send', message),
    list: (query?: unknown): Promise<unknown> => invoke('chat:list', query),
    resolveAttachment: (input?: unknown): Promise<unknown> => invoke('chat:resolve-attachment', input),
    /** GenUI 卡片意图（M1，`UI §4.7`）：只发意图 `{schemaId,componentId,action,payload}`；主进程过 `permissionGate`。 */
    cardAction: (input?: unknown): Promise<unknown> => invoke('chat:card-action', input),
  },
  docs: {
    /** M2 §7 序 4：文档结构检查（只读；项目概览文档健康面板）。 */
    check: (input?: unknown): Promise<unknown> => invoke('docs:check', input),
    /** M3-DOC-3：只读预览索引补全（返回 changes/token/读数；不写文件）。 */
    organizePreview: (input?: unknown): Promise<unknown> => invoke('docs:organize-preview', input),
    /** M3-DOC-3：应用预览（token 防过期；失败回滚）。 */
    organizeApply: (input?: unknown): Promise<unknown> => invoke('docs:organize-apply', input),
  },
  employee: {
    list: (filter?: unknown): Promise<unknown> => invoke('employee:list', filter),
    get: (input?: unknown): Promise<unknown> => invoke('employee:get', input),
    /** M2 尾：招募 / 改档（人设为真字段；白名单拦点在主进程）。 */
    recruit: (input?: unknown): Promise<unknown> => invoke('employee:recruit', input),
    update: (input?: unknown): Promise<unknown> => invoke('employee:update', input),
  },
  hall: {
    state: (): Promise<unknown> => invoke('hall:state'),
    subscribe: (): Promise<unknown> => invoke('hall:subscribe'),
  },
  inbox: {
    list: (filter?: unknown): Promise<unknown> => invoke('inbox:list', filter),
    answer: (input?: unknown): Promise<unknown> => invoke('inbox:answer', input),
    /** M3-REM-1c：服务端未读游标（channel:cards / channel:messages）。 */
    readState: (input?: unknown): Promise<unknown> => invoke('inbox:read-state', input),
    readMark: (input?: unknown): Promise<unknown> => invoke('inbox:read-mark', input),
  },
  project: {
    list: (input?: unknown): Promise<unknown> => invoke('project:list', input),
    get: (input?: unknown): Promise<unknown> => invoke('project:get', input),
    archive: (input?: unknown): Promise<unknown> => invoke('project:archive', input),
    /** R2-4：关联已有文件夹（**主进程 dialog 选目录**；renderer 不传路径）。 */
    attach: (): Promise<unknown> => invoke('project:attach'),
    /** 2026-10-25：在系统文件管理器中打开项目根目录（只传 projectId；路径由主进程解析）。 */
    openDir: (input?: unknown): Promise<unknown> => invoke('project:open-dir', input),
    /** 009 后（2026-10-16）：软件代建项目骨架（renderer 只给 `{name}`；父目录经主进程 dialog 选；不覆盖同名目录）。 */
    create: (input?: unknown): Promise<unknown> => invoke('project:create', input),
    /** 验收后复查 A：项目别名设置/清空（新项目可被 `#别名` 寻址）。 */
    aliasSet: (input?: unknown): Promise<unknown> => invoke('project:alias-set', input),
    /** CR14：删除空归档项目（文件夹不动；非空拒）。 */
    delete: (input?: unknown): Promise<unknown> => invoke('project:delete', input),
    /** B-3：导出项目档案（单文件 JSON；删除前的备份面）。 */
    export: (input?: unknown): Promise<unknown> => invoke('project:export', input),
    /** 编制 v1（D-11）：写项目三项缺省（默认负责人/默认执行员工/默认档）；**读面**走 `project:get` 的 DTO。 */
    staffingSet: (input?: unknown): Promise<unknown> => invoke('project:staffing-set', input),
    /** D-22：项目模型策略（策略/默认模型/模型级允许清单整体写）；**读面**走 `project:get` 的 DTO。 */
    modelPolicySet: (input?: unknown): Promise<unknown> => invoke('project:model-policy-set', input),
    /** v19：项目默认任务预算（NULL＝不限；只影响之后新建且未显式给预算的任务）。 */
    defaultBudgetSet: (input?: unknown): Promise<unknown> => invoke('project:default-budget-set', input),
    /** S13-G/D-N06：合并目标分支（空串/null ⇒ 回到 main/master）。 */
    targetBranchSet: (input?: unknown): Promise<unknown> => invoke('project:target-branch-set', input),
    /** D-19 P1：项目级频道助手写权限（read-only/confirm/auto；`full` v1 不做）。 */
    assistantWriteModeSet: (input?: unknown): Promise<unknown> => invoke('project:assistant-write-mode-set', input),
    /** B-1：触发管理（list/create-cron/create-event/cancel；与频道命令同源）。 */
    triggerManage: (input?: unknown): Promise<unknown> => invoke('project:trigger-manage', input),
    /** M3-DOC-4：项目级文档检查开关（1=新任务默认挂 `aico:docs-check`；0=不挂/未检查）。 */
    docsCheckSet: (input?: unknown): Promise<unknown> => invoke('project:docs-check-set', input),
    /** B3（M3-N-3）：项目默认技能集（员工勾选 ∪ 项目默认；只影响新会话装配）。 */
    skillsSet: (input?: unknown): Promise<unknown> => invoke('project:skills-set', input),
    /** GAP9（M3-N-5）：公司配置版本化（`.aico/company.json`；export/preview/apply/rollback）。 */
    companyConfig: (input?: unknown): Promise<unknown> => invoke('project:company-config', input),
  },
  /** B-6：记忆 P1b（老板显式 list/remember/update/pin/forget/promote/search/audit）。 */
  memory: {
    manage: (input?: unknown): Promise<unknown> => invoke('memory:manage', input),
  },
  /** `OPT-EXT-13` 用量可视：成本聚合（今日成本等）。 */
  cost: {
    summary: (input?: unknown): Promise<unknown> => invoke('cost:summary', input),
  },
  /** R3-2：顶栏槽位真读数（任务级活跃槽位 占用/上限）。 */
  scheduler: {
    slots: (): Promise<unknown> => invoke('scheduler:slots'),
  },
  /** M2 尾（G-D）：跨项目全局搜索（任务/消息/产物；只读）。 */
  search: {
    global: (input?: unknown): Promise<unknown> => invoke('search:global', input),
  },
  /** OPT-AI-9：技能库（列表 / 注册；员工勾选走 employee.update）。 */
  skills: {
    list: (input?: unknown): Promise<unknown> => invoke('skills:list', input),
    set: (input?: unknown): Promise<unknown> => invoke('skills:set', input),
  },
  /** OPT-AI-10：MCP server 库（列表 / 注册；员工侧工具走 mcp_list/mcp_call）。 */
  mcp: {
    list: (input?: unknown): Promise<unknown> => invoke('mcp:list', input),
    set: (input?: unknown): Promise<unknown> => invoke('mcp:set', input),
  },
  /** OPT-M4-1：接缝矩阵（只读；项目级覆盖读数）。 */
  seams: {
    list: (input?: unknown): Promise<unknown> => invoke('seams:list', input),
  },
  settings: {
    get: (input?: unknown): Promise<unknown> => invoke('settings:get', input),
    set: (input?: unknown): Promise<unknown> => invoke('settings:set', input),
    /** B-4：数据保留/清理（preview 只数不删；run 只清四张临时表）。 */
    maintenance: (input?: unknown): Promise<unknown> => invoke('settings:maintenance', input),
    /** UG-09：权限页只读审计（策略 + [权限] 审批历史）。 */
    permissionList: (): Promise<unknown> => invoke('settings:permission-list'),
    /** UG-09：撤销一个 scope 的权限策略（删除；审批历史不动）。 */
    permissionRevoke: (input?: unknown): Promise<unknown> => invoke('settings:permission-revoke', input),
  },
  /** 2026-10-20：设置·模型与供应商——本机 Key 状态/保存/清除（Key 只落 ~/.aico/secrets）。 */
  provider: {
    list: (): Promise<unknown> => invoke('provider:list'),
    setKey: (input?: unknown): Promise<unknown> => invoke('provider:set-key', input),
    clearKey: (input?: unknown): Promise<unknown> => invoke('provider:clear-key', input),
    /** D-22：自定义供应商（写 Pi models.json；Key 仍走本机 secrets）。 */
    custom: (input?: unknown): Promise<unknown> => invoke('provider:custom', input),
  },
  /** D-22 配套：只读模型目录（chat；已知供应商＋已配置 Key；价格 USD/1M）。 */
  model: {
    catalog: (input?: unknown): Promise<unknown> => invoke('model:catalog', input),
  },
  /** 2026-10-17：设置·通知「发送测试通知」（系统通知＋托盘刷新；不写日报幂等键）。 */
  notify: {
    test: (input?: unknown): Promise<unknown> => invoke('notify:test', input),
  },
  /** R2-2（G7）：员工间问答面——未结提问列表 / 老板代答（via='boss' 如实入账）。 */
  mailbox: {
    list: (): Promise<unknown> => invoke('mailbox:list'),
    answer: (input?: unknown): Promise<unknown> => invoke('mailbox:answer', input),
  },
  im: {
    bind: (input?: unknown): Promise<unknown> => invoke('im:bind', input),
    unbind: (input?: unknown): Promise<unknown> => invoke('im:unbind', input),
  },
  /**
   * 文件导入（D1 例外③）：**只在这里（preload）读取可信路径**，渲染层永远拿不到 path。
   * - 真实文件（拖拽/📎）：`webUtils.getPathForFile(File)` 非空 → 走 `file:import`（主进程按可信路径读盘）；
   * - 无盘路径（如 Win+Shift+S 剪贴板截图）：返回 `''` → 走 `file:import-bytes`（`arrayBuffer()` 字节通路）。
   * 返回 `{ fileToken, name, size, type }`；**不回传任何路径**。
   */
  files: {
    import: async (file: FileLike): Promise<unknown> => {
      const meta = {
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
      };
      // 只对用户在 UI 里真实选择/拖入/粘贴的 File 有效；非文件来源返回空串。
      const path = (webUtils.getPathForFile as unknown as (f: unknown) => string)(file);
      if (path) return invoke('file:import', { ...meta, path });
      const bytes = await file.arrayBuffer();
      return invoke('file:import-bytes', { ...meta, bytes });
    },
  },
  /** 基准专用（仅 `AICO_BENCH` 下主进程才注册 handler）；生产环境调用会 reject。 */
  bench: {
    ping: (): Promise<unknown> => invoke('ipc:bench:ping'),
  },
  /** F-G8：拉一次「每通道最新值」快照（渲染层订阅时补齐**订阅前**丢失的事件）。 */
  evt: {
    snapshot: (): Promise<unknown> => invoke('evt:snapshot'),
  },
  /** 订阅主进程推送；返回退订函数（§7.5）。 */
  on: (event: EventChannel, callback: (payload: unknown) => void): Unsubscribe => {
    const handler = (_e: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on(event, handler);
    return (): void => {
      ipcRenderer.off(event, handler);
    };
  },
  notes: {
    list: (): Promise<unknown> => invoke('notes:list'),
    read: (input: { projectId?: number | null; name: string }): Promise<unknown> => invoke('notes:read', input),
    preview: (input: { projectId?: number | null; path: string; mode?: 'read' | 'open' | 'reveal' }): Promise<unknown> => invoke('notes:preview', input),
    write: (input: { projectId?: number | null; name: string; content: string }): Promise<unknown> => invoke('notes:write', input),
    delete: (input: { projectId?: number | null; name: string }): Promise<unknown> => invoke('notes:delete', input),
    search: (input: { query: string }): Promise<unknown> => invoke('notes:search', input),
    promote: (input: { projectId: number; name: string }): Promise<unknown> => invoke('notes:promote', input),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
