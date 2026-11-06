/// <reference types="vite/client" />

// preload 经 `contextBridge` 暴露的白名单 API（形状镜像 `src/preload/index.ts`）。
// 放在 `declare global` 内，使 `getApi()` / 组件无需 import 即可引用。
declare global {
  type Unsubscribe = () => void;
  type EventChannel =
    | 'evt:task'
    | 'evt:message'
    | 'evt:hall'
    | 'evt:notify'
    | 'evt:inbox'
    | 'evt:read'
    | 'evt:batch';

  /** 附件 DTO：**只有元信息 + 不透明令牌，没有路径**（D1 铁律）。 */
  interface AttachmentDTO {
    name: string;
    size: number;
    type: string;
    fileToken?: string;
  }

  interface AicoPreloadApi {
    ui: { mounted(): void };
    /** 壳层窗口控制（自绘三键；`frame:false` 后唯一驱动面）。 */
    win: {
      minimize(): Promise<unknown>;
      toggleMaximize(): Promise<unknown>;
      isMaximized(): Promise<unknown>;
      close(): Promise<unknown>;
    };
    app: {
      info(): Promise<unknown>;
      openDataDir(): Promise<unknown>;
    };
    task: {
      create(input?: unknown): Promise<unknown>;
      list(filter?: unknown): Promise<unknown>;
      get(input?: unknown): Promise<unknown>;
      transition(input?: unknown): Promise<unknown>;
      approve(input?: unknown): Promise<unknown>;
      /** GAP8：批准前编辑计划（`approve:true`＝改计划再批准）。 */
      editPlan(input?: unknown): Promise<unknown>;
      /** M3-P-4 / BRK16-b：合并一个变更集到主分支。 */
      merge(input?: unknown): Promise<unknown>;
      reworkMergeConflict(input?: unknown): Promise<unknown>;
      /** M3-N-2 / GAP4：回滚一个变更集到其工作项检查点（只动该次提交改过的文件）。 */
      rollback(input?: unknown): Promise<unknown>;
      /** B-2：丢弃一个变更集（不合并；主分支/其他工作项不动；幂等）。 */
      discard(input?: unknown): Promise<unknown>;
      readArtifact(input?: unknown): Promise<unknown>;
      /** UG-06：变更集单文件只读 diff（`{taskId, changesetId, path}`）。 */
      diff(input?: unknown): Promise<unknown>;
      /** M4-D-1（P2）：按 ref 受控读取归档的工具大输出。 */
      readToolOutput(input?: unknown): Promise<unknown>;
      /** G-A/G-B/C（M2 §7 序 3）：产物引用到目标任务（老板显式发起；copy 快照＋sha256）。 */
      referenceArtifact(input?: unknown): Promise<unknown>;
      export(input?: unknown): Promise<unknown>;
    };
    chat: {
      send(message?: unknown): Promise<unknown>;
      list(query?: unknown): Promise<unknown>;
      resolveAttachment(input?: unknown): Promise<unknown>;
      /** GenUI 卡片意图（M1，`UI §4.7`）。 */
      cardAction(input?: unknown): Promise<unknown>;
    };
    docs: {
      /** M2 §7 序 4：文档结构检查（只读；项目概览文档健康面板）。 */
      check(input?: unknown): Promise<unknown>;
      /** M3-DOC-3：索引整理预览（只读）。 */
      organizePreview(input?: unknown): Promise<unknown>;
      /** M3-DOC-3：应用索引整理（token 防过期；失败回滚）。 */
      organizeApply(input?: unknown): Promise<unknown>;
    };
    employee: {
      list(filter?: unknown): Promise<unknown>;
      get(input?: unknown): Promise<unknown>;
      recruit(input?: unknown): Promise<unknown>;
      update(input?: unknown): Promise<unknown>;
    };
    hall: { state(): Promise<unknown>; subscribe(): Promise<unknown> };
    inbox: {
      list(filter?: unknown): Promise<unknown>;
      answer(input?: unknown): Promise<unknown>;
      /** M3-REM-1c：服务端未读游标（channel:cards / channel:messages）。 */
      readState(input?: unknown): Promise<unknown>;
      readMark(input?: unknown): Promise<unknown>;
    };
    project: {
      list(input?: unknown): Promise<unknown>;
      get(input?: unknown): Promise<unknown>;
      archive(input?: unknown): Promise<unknown>;
      attach(): Promise<unknown>;
      /** 2026-10-25：在系统文件管理器中打开项目根目录。 */
      openDir?(input?: unknown): Promise<unknown>;
      create(input?: unknown): Promise<unknown>;
      /** 验收后复查 A：项目别名设置/清空。 */
      aliasSet(input?: unknown): Promise<unknown>;
      /** CR14：删除空归档项目。 */
      delete(input?: unknown): Promise<unknown>;
      /** B-3：导出项目档案（单文件 JSON；删除前备份）。 */
      export(input?: unknown): Promise<unknown>;
      /** 编制 v1（D-11）：写项目三项缺省（读面走 `project:get` 的 DTO）。 */
      staffingSet(input?: unknown): Promise<unknown>;
      /** D-22：项目模型策略（策略/默认模型/允许清单整体写；读面走 `project:get` 的 DTO）。 */
      modelPolicySet(input?: unknown): Promise<unknown>;
      /** v19：项目默认任务预算（NULL＝不限）。 */
      defaultBudgetSet(input?: unknown): Promise<unknown>;
      targetBranchSet(input?: unknown): Promise<unknown>;
      /** D-19 P1：项目级频道助手写权限（read-only/confirm/auto）。 */
      assistantWriteModeSet(input?: unknown): Promise<unknown>;
      /** B-1：触发管理（列表/创建/取消；与频道命令同源）。 */
      triggerManage(input?: unknown): Promise<unknown>;
      /** M3-DOC-4：项目级文档检查开关。 */
      docsCheckSet(input?: unknown): Promise<unknown>;
      /** B3（M3-N-3）：项目默认技能集。 */
      skillsSet(input?: unknown): Promise<unknown>;
      /** GAP9（M3-N-5）：公司配置版本化（`.aico/company.json`）。 */
      companyConfig(input?: unknown): Promise<unknown>;
    };
    /** B-6：记忆 P1b（老板显式 list/remember/update/pin/forget/promote/search/audit）。 */
    memory: { manage(input?: unknown): Promise<unknown> };
    /** D-22 配套：只读模型目录（chat；已知供应商＋已配置 Key）。 */
    model: { catalog(input?: unknown): Promise<unknown> };
    /** `OPT-EXT-13` 用量可视：成本聚合。 */
    cost: { summary(input?: unknown): Promise<unknown> };
    /** R3-2：顶栏槽位真读数（任务级活跃槽位）。 */
    scheduler: { slots(): Promise<unknown> };
    /** M2 尾（G-D）：跨项目全局搜索（任务/消息/产物；只读）。 */
    search: { global(input?: unknown): Promise<unknown> };
    /** OPT-AI-9：技能库（列表 / 注册）。 */
    skills: { list(input?: unknown): Promise<unknown>; set(input?: unknown): Promise<unknown> };
    /** OPT-AI-10：MCP server 库（列表 / 注册）。 */
    mcp: { list(input?: unknown): Promise<unknown>; set(input?: unknown): Promise<unknown> };
    /** OPT-M4-1：接缝矩阵（只读）。 */
    seams: { list(input?: unknown): Promise<unknown> };
    settings: {
      get(input?: unknown): Promise<unknown>;
      set(input?: unknown): Promise<unknown>;
      /** B-4：数据保留/清理（preview 只数不删；run 只清四张临时表）。 */
      maintenance(input?: unknown): Promise<unknown>;
      /** UG-09：权限页只读审计（策略 + [权限] 审批历史）。 */
      permissionList(): Promise<unknown>;
      /** UG-09：撤销一个 scope 的权限策略（删除；审批历史不动）。 */
      permissionRevoke(input?: unknown): Promise<unknown>;
    };
    /** 设置·模型与供应商：本机 Key 状态/保存/清除（只回掩码，不回明文）。 */
    provider: {
      list(): Promise<unknown>;
      setKey(input?: unknown): Promise<unknown>;
      clearKey(input?: unknown): Promise<unknown>;
      /** D-22：自定义供应商 list/save/remove（配置写 Pi models.json；Key 走 secrets）。 */
      custom(input?: unknown): Promise<unknown>;
    };
    /** 2026-10-17：设置·通知「发送测试通知」。 */
    notes: {
      list(): Promise<unknown>;
      read(input: { projectId?: number | null; name: string }): Promise<unknown>;
      preview(input: { projectId?: number | null; path: string; mode?: 'read' | 'open' | 'reveal' }): Promise<unknown>;
      write(input: { projectId?: number | null; name: string; content: string }): Promise<unknown>;
      delete(input: { projectId?: number | null; name: string }): Promise<unknown>;
      search(input: { query: string }): Promise<unknown>;
      promote(input: { projectId: number; name: string }): Promise<unknown>;
    };
    notify: { test(input?: unknown): Promise<unknown> };
    /** R2-2（G7）：员工间问答面（未结提问 / 老板代答）。 */
    mailbox: { list(): Promise<unknown>; answer(input?: unknown): Promise<unknown> };
    im: { bind(input?: unknown): Promise<unknown>; unbind(input?: unknown): Promise<unknown> };
    /** 文件导入（D1 例外③）：preload 读可信路径/字节；返回 `{fileToken,...}`，永不回传路径。 */
    files: {
      import(file: { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<{
        ok?: boolean;
        file?: AttachmentDTO;
        code?: string;
        message?: string;
      }>;
    };
    /** 基准专用（仅 AICO_BENCH 下可用）。 */
    update: {
      get(): Promise<unknown>;
      check(): Promise<unknown>;
      install(): Promise<unknown>;
      onStatus(callback: (status: unknown) => void): Unsubscribe;
    };
    bench: { ping(): Promise<unknown> };
    /** F-G8：每通道最新值快照（渲染层订阅时拉一次）。 */
    evt: { snapshot(): Promise<unknown> };
    on(event: EventChannel, callback: (payload: unknown) => void): Unsubscribe;
  }

  interface Window {
    api?: AicoPreloadApi;
  }
}

export {};
