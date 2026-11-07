// 渲染层状态（valtio）：全部由主进程 IPC 驱动，渲染层不做业务逻辑（DEV §7.2）。
import { proxy } from 'valtio';

import { getApi } from './api';
import type { TaskDetailDTO } from './components/TaskDetail';
import type { AgentStatusDTO } from './components/agentStatus';
import { applySchemaPatch, validateSchema, type GenUiIntent, type GenUiSchema, type GenUiSchemaPatch } from './components/genui/schema';
import { NOTIFY_FIELDS, TUNING_FIELDS } from './components/SettingsPane';
import type { CustomProviderDef } from '../core/custom-provider.js';
import type { AttachmentDTO, ChannelItem, CostSummaryDTO, EmployeeDTO, EmployeeDetailDTO, GlobalSearchDTO, HallStateDTO, HumanMessageDTO, ImStatusView, MailboxAskDTO, McpServerDTO, ModelCatalogEntryDTO, ProjectDTO, ProviderCatalogEntryDTO, ProviderStatusDTO, ReportDTO, ResolutionDTO, SkillDTO, TaskDTO, TriggerDTO } from './types';
import { clearSeenAt, loadSeenAt, seenThroughId } from './components/inboxCursor';
import { appendToast, removeToast, type ToastDTO } from './components/toastModel';
import { loadViewState, resolveView, saveViewState, type RestorableView } from './components/viewCursor';
import { projectsFromTasks, resolveStaffingProject } from './components/projectView';
import { parseReadState, type ReadSurface } from './components/readStateModel';

/** 中栏视图（`DEV §7.1` 中栏视图；2026-10-17 双栏改版：项目概览并入「项目树」页右栏、
 *  员工·当前任务并入「公司大厅」页右栏——`project` 路由退役（仅恢复游标兼容），新增 `hall` 右栏分区态）。 */
export type CenterView = 'channel' | 'task' | 'hall' | 'inbox' | 'employee' | 'settings' | 'projects' | 'archive' | 'notes';

export const session = proxy({
  sending: false,
  error: null as string | null,
  view: 'channel' as CenterView,
  selectedTaskId: null as number | null,
  // 2026-10-18（老板裁）：」项目树/归档「站在导航栏就是导航——**开关语义退役**（原两枚开关字段
  // 已删除），改为中栏两页（`projects` / `archive` 视图；左栏任务列表回归纯状态分组）。
  /** 当前打开项目概览的项目 id。 */
  selectedProjectId: null as number | null,
  /** D-5 补位 ①：当前打开员工工位页的员工 id。 */
  selectedEmployeeId: null as number | null,
  /**
   * 2026-10-16（任务详情批）：「返回」随入口动态——记录**进入任务详情之前**的视图
   * （从待我处理进来回待我处理，从大厅进来回大厅…；缺省/重启后回落频道）。
   */
  detailReturnView: null as CenterView | null,
  /**
   * 2026-10-17（工位批·两视图拆分）：员工视图口子——`ops`＝「员工 · 当前任务」（大厅入口，看活）；
   * `config`＝「员工设置」（设置·员工「配置 ▸」入口，改人）。缺省 `ops`（大厅是主入口）。
   */
  employeeMode: 'ops' as 'ops' | 'config',
  /**
   * 2026-10-17（双栏改版）：公司大厅右栏分区——`employee`＝选中员工当前任务（缺省）；
   * `collab`＝部门协作（左列底部按钮进入）。
   */
  hallPane: 'employee' as 'employee' | 'collab' | 'activity',
});
export const messages = proxy({ list: [] as HumanMessageDTO[] });
export const cards = proxy({
  list: [] as ReportDTO[],
  /** M4-C-4：待我处理的首载/失败态（空态不伪装成“没有事”）。 */
  loading: false,
  loaded: false,
  error: null as string | null,
});
/** M3-REM-1c：未读读数来自服务端 `read_cursors`；`seenAt` 只作旧 localStorage 的一次性迁移来源。 */
export const inbox = proxy({
  seenAt: loadSeenAt(),
  /** `channel:cards`（驱 badge/待办）。 */
  cursor: 0,
  unread: null as number | null,
  unreadState: 'unknown' as 'exact' | 'unknown',
  loaded: false,
  seeded: false,
  error: null as string | null,
  /** `channel:messages`（只驱频道「新消息」锚；绝不写 badge）。 */
  messageCursor: 0,
  messageUnread: null as number | null,
  messageUnreadState: 'unknown' as 'exact' | 'unknown',
  messageError: null as string | null,
});

/** 2026-10-17 真机反馈「没通知」：应用内通知浮层（与 OS 通知**同内容**；OS 被吞时仍可见）。 */
let toastSeq = 0;
export const toasts = proxy({ list: [] as ToastDTO[] });

/** 追加一条通知浮层；6 秒后自动消失（同一通知重复推送会叠两条——幂等由主进程 `dedupeKey` 保证）。 */
export function pushToast(input: { title: string; text: string }): number {
  const id = ++toastSeq;
  toasts.list = appendToast(toasts.list as ToastDTO[], { id, ...input });
  setTimeout(() => dismissToast(id), 6000);
  return id;
}

/** 关闭指定浮层（× 按钮/自动超时共用）。 */
export function dismissToast(id: number): void {
  toasts.list = removeToast(toasts.list as ToastDTO[], id);
}
export const tasks = proxy({
  list: [] as TaskDTO[],
  /** BRK17 组（挂载 3）：左栏任务区回执（归档成功/失败；不静默消失）。 */
  notice: null as string | null,
  /** 2026-11-03（逐页错误注入）：列表加载态/失败态——失败不得伪装成「0 个任务」。 */
  loading: false,
  error: null as string | null,
});
/** 幕僚长（员工）就绪态：未就绪时显示「幕僚长启动中…」（UI §4.5 系统状态行；绝不静默）。 */
export const assistant = proxy({ starting: false });

/** G8：员工运行时状态（由主进程 `evt:agent` 推送；`failed` 时界面显式提示「不可用」）。 */
export const agent = proxy<{ status: AgentStatusDTO | null }>({ status: null });
/** `OPT-EXT-13` 用量可视：今日成本聚合（`cost:summary`；空 => `null`）。 */
export const cost = proxy<{ summary: CostSummaryDTO | null }>({ summary: null });
/** R3-2：顶栏槽位真读数（`scheduler:slots`＝占用/上限；`null` = 引擎未装配 → 显 `—`）。 */
export const slots = proxy<{ data: { running: number; total: number } | null }>({ data: null });
/** `OPT-EXT-13` 成本 tab：单任务成本汇总（`cost:summary{taskId}`）。 */
export const taskCost = proxy<{ data: CostSummaryDTO | null }>({ data: null });
/** GenUI 卡片 schema（M1，`UI §4.7`）：按 `schemaId` 存被 `evt:message{schemaPatch}` 更新过的版本。 */
export const schemas = proxy({ byId: {} as Record<string, GenUiSchema> });
/** 公司大厅（简单版，B0/B1）：员工 + 轻量部门 + 真实协作流向。 */
export const hall = proxy({
  loading: false,
  error: null as string | null,
  data: null as HallStateDTO | null,
});
/** D-5 补位 ①：员工工位页（`employee:get`；`data:null` + 无 loading/error＝员工不存在）。 */
export const workstation = proxy({
  employeeId: null as number | null,
  loading: false,
  error: null as string | null,
  data: null as EmployeeDetailDTO | null,
});
/** T0.7 任务详情（`task:get` 详情形状）。 */
export const taskDetail = proxy({
  taskId: null as number | null,
  loading: false,
  error: null as string | null,
  data: null as TaskDetailDTO | null,
  /** G-C（M2 §7 序 3）：引用候选目标任务（非归档、不含本任务；缺省 → 引用控件不可用）。 */
  refTargets: [] as Array<{ id: number; shortId: string | null; title: string }>,
  /** G-C：最近一次引用的结果回执（人话；失败也显式给出）。 */
  referenceNotice: null as string | null,
  /** BRK16-a（挂载 3）：最近一次产物读预览（仅 `read` 模式产预览；`open`/`reveal` 不产）。 */
  artifactPreview: null as {
    artifactId: number;
    name: string;
    path: string;
    size: number;
    sha256: string;
    sha256Mismatch: boolean;
    /** 2026-11-05：同路径存在更晚产出 ⇒ 「旧版本」语义（不报警）。 */
    supersededBy?: { artifactId: number; createdAt: number } | null;
    text: string;
    truncated: boolean;
  } | null,
  /** BRK16-a：最近一次产物操作回执（读/打开/文件夹；失败也显式给出）。 */
  artifactNotice: null as string | null,
  /** GAP11：最近一次导出回执（含落盘路径；打开失败随 `⚠️` 一并如实给出）。 */
  exportNotice: null as string | null,
  /** BRK17 组（挂载 3）：最近一次**详情操作**失败回执（如「撤销结束」超 7 天窗口被引擎拒绝；不静默）。 */
  actionNotice: null as string | null,
  /** GAP8：计划编辑回执（保存/保存并批准；失败也给出人话）。 */
  planNotice: null as string | null,
  /** M3-P-4：变更集合并回执（成功 commit / 冲突文件 / 拒绝原因）。 */
  mergeNotice: null as string | null,
  /** S13-G/D-N07：最近一次合并冲突（结构化文件列表）与对应变更集；无冲突为 null。 */
  mergeConflicts: [] as string[],
  mergeConflictChangesetId: null as number | null,
  /** M3-N-2：变更集回滚回执（成功反向提交 / 检查点守卫拒绝原因）。 */
  rollbackNotice: null as string | null,
  /** B-2：变更集丢弃回执（成功/幂等/守卫拒绝原因）。 */
  discardNotice: null as string | null,
});

/** 归档页：续办回执（失败也显式，不静默）。 */
export const archiveView = proxy({
  notice: null as string | null,
});

/** `OPT-EXT-13`：拉今日成本（`since` = 今日 0 点；**空表 => costRows:0**，顶栏据此显 `—`）。 */
export async function loadCostSummary(now: number = Date.now()): Promise<void> {
  const api = getApi();
  if (!api?.cost) return;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  cost.summary = ((await api.cost.summary({ since: start.getTime() })) as CostSummaryDTO | undefined) ?? null;
}

/** R3-2：拉顶栏槽位（`scheduler:slots`；引擎缺失 → `null` → 显 `—`，绝不写假 0）。 */
export async function loadSlots(): Promise<void> {
  const api = getApi();
  if (!api?.scheduler?.slots) return;
  try {
    slots.data = ((await api.scheduler.slots()) as { running: number; total: number } | null | undefined) ?? null;
  } catch {
    slots.data = null;
  }
}

/** `OPT-EXT-13` 成本 tab：拉单任务成本（含 `byModel`）。 */
export async function loadTaskCosts(taskId: number): Promise<void> {
  const api = getApi();
  if (!api?.cost) return;
  taskCost.data = ((await api.cost.summary({ taskId })) as CostSummaryDTO | undefined) ?? null;
}

/** 把消息与卡片按时间合并成一条频道流（UI §4.2：卡片出现在对话流里）。 */
export function channelItems(
  msgList: readonly HumanMessageDTO[],
  cardList: readonly ReportDTO[],
): ChannelItem[] {
  const items: ChannelItem[] = [
    ...msgList.map((message) => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...cardList.map((card) => ({ kind: 'card' as const, at: card.createdAt, card })),
  ];
  return items.sort((a, b) => a.at - b.at);
}

/** 列表上限：基准模式下可由主进程注入提高（仅用于 bench，默认 100）。 */
function benchListLimit(fallback: number): number {
  const override = (globalThis as { __AICO_BENCH_LIST_LIMIT__?: unknown }).__AICO_BENCH_LIST_LIMIT__;
  return typeof override === 'number' && override > 0 ? override : fallback;
}

export async function loadChannel(): Promise<void> {
  const api = getApi();
  if (!api) return;
  cards.loading = true;
  cards.error = null;
  try {
    const [rawMessages, rawCards] = await Promise.all([
      // 取**最新** N 条（DAO 返回时仍按时间升序）：旧口径取最旧 50/100 会让新消息/新卡永远不出现，
      // 未读游标也永远清不掉（M3 联动审计 P0-2）。
      api.chat.list({ limit: benchListLimit(100), latest: true }),
      api.inbox.list({ limit: 50, latest: true }),
    ]);
    messages.list = (rawMessages as HumanMessageDTO[] | undefined) ?? [];
    cards.list = (rawCards as ReportDTO[] | undefined) ?? [];
    // 注册卡片携带的 GenUI schema（供 `schemaPatch` 增量更新；非法则不注册，Card 会降级 legacy）。
    for (const card of cards.list) {
      const raw = card.payload.schema;
      if (raw === undefined) continue;
      const validated = validateSchema(raw);
      if (validated.ok) schemas.byId[validated.schema.id] = validated.schema;
    }
    void loadReadState('channel:cards');
    void loadReadState('channel:messages');
  } catch (error) {
    cards.error = error instanceof Error ? error.message : String(error);
  } finally {
    cards.loading = false;
    cards.loaded = true;
  }
}

/**
 * 应用服务端 `read:state` / `read:mark` 的返回。
 * **必须按 surface 分面**：messages 的读数绝不能写进 cards 的 badge（M3 联动审计 P0-2）。
 */
function applyReadState(raw: unknown, expectedSurface: ReadSurface): void {
  const state = parseReadState(raw, expectedSurface);
  if (!state) return;
  if (state.surface === 'channel:cards') {
    inbox.cursor = state.lastItemId;
    inbox.unread = state.unread;
    inbox.unreadState = state.unreadState;
    inbox.loaded = true;
    inbox.error = state.reason;
  } else {
    inbox.messageCursor = state.lastItemId;
    inbox.messageUnread = state.unread;
    inbox.messageUnreadState = state.unreadState;
    inbox.messageError = state.reason;
  }
}

/**
 * M3-REM-1c：拉服务端未读读数；cards 首拉时顺带做一次旧 `localStorage` 游标迁移。
 * 失败**显式置 unknown**（UI 显 `—`），不保留旧值、不写假 0。
 */
export async function loadReadState(surface: 'channel:cards' | 'channel:messages' = 'channel:cards'): Promise<void> {
  const api = getApi();
  if (!api?.inbox?.readState) return;
  try {
    const raw = await api.inbox.readState({ surface });
    applyReadState(raw, surface);
    if (surface === 'channel:cards') {
      inbox.error = inbox.unreadState === 'exact' ? null : inbox.error;
      if (!inbox.seeded) await seedLegacyInboxCursor();
    } else {
      inbox.messageError = inbox.messageUnreadState === 'exact' ? null : inbox.messageError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (surface === 'channel:cards') {
      inbox.error = message;
      inbox.unread = null;
      inbox.unreadState = 'unknown';
      inbox.loaded = true;
    } else {
      inbox.messageError = message;
      inbox.messageUnread = null;
      inbox.messageUnreadState = 'unknown';
    }
  }
}

/**
 * 旧 `aico.inbox.seenAt` → 服务端游标的一次性迁移：只把升级前已看过的卡片标读；
 * 成功后删旧键；失败保留旧键，下一轮重试。
 */
async function seedLegacyInboxCursor(): Promise<void> {
  if (inbox.seeded) return;
  if (inbox.seenAt <= 0) {
    inbox.seeded = true;
    return;
  }
  const throughId = seenThroughId(cards.list as ReportDTO[], inbox.seenAt);
  if (throughId > 0) {
    const ok = await markRead('channel:cards', throughId);
    if (!ok) return;
  }
  clearSeenAt();
  inbox.seenAt = 0;
  inbox.seeded = true;
}

/** 推进一个 surface 的服务端游标；失败不清零、不假装成功。 */
export async function markRead(
  surface: 'channel:cards' | 'channel:messages',
  throughId: number,
  source: 'desktop' | 'action' = 'desktop',
): Promise<boolean> {
  if (!Number.isInteger(throughId) || throughId <= 0) return true;
  const api = getApi();
  if (!api?.inbox?.readMark) return false;
  try {
    const raw = await api.inbox.readMark({ surface, throughId, source });
    const result = raw as { state?: unknown } | undefined;
    applyReadState(result?.state ?? raw, surface);
    if (surface === 'channel:cards') inbox.error = inbox.unreadState === 'exact' ? null : inbox.error;
    else inbox.messageError = inbox.messageUnreadState === 'exact' ? null : inbox.messageError;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (surface === 'channel:cards') {
      inbox.error = message;
      inbox.unread = null;
      inbox.unreadState = 'unknown';
    } else {
      inbox.messageError = message;
      inbox.messageUnread = null;
      inbox.messageUnreadState = 'unknown';
    }
    return false;
  }
}

/**
 * 进「待我处理」/在视图中看到卡：把卡片游标推到指定 id（缺省＝当前已加载最大 id）。
 * `source='action'` 用于老板实际处理了一张卡（批准/打回/标已阅），与「只是打开列表」区分。
 */
export async function markInboxRead(
  throughId?: number,
  source: 'desktop' | 'action' = 'desktop',
): Promise<boolean> {
  const max =
    throughId != null
      ? throughId
      : (cards.list as ReportDTO[]).reduce((m, card) => Math.max(m, card.id), 0);
  return markRead('channel:cards', max, source);
}

/** 打开老板频道：把消息游标推到当前已加载的最大 id（in 只推进位置，不产生未读）。 */
export async function markChannelMessagesRead(): Promise<boolean> {
  const max = (messages.list as HumanMessageDTO[]).reduce((m, message) => Math.max(m, message.id), 0);
  return markRead('channel:messages', max);
}

/**
 * 处理 `evt:message` 的条目：
 *  - `{status:'assistant_starting'}` → 显示「幕僚长启动中…」系统状态行（UI §4.5，绝不静默）；
 *  - 其余（真回复 / 流式 delta）→ 清掉状态行并重载频道。
 */
function applyMessageItems(items: unknown): void {
  const list = Array.isArray(items) ? items : [];
  let starting = false;
  let content = false;
  for (const item of list) {
    const record = (item ?? {}) as { status?: unknown; delta?: unknown; schemaPatch?: GenUiSchemaPatch };
    if (record.schemaPatch) {
      // GenUI 增量 patch：按 `schemaId` 局部更新（未知 id 忽略、不抛）。
      const cur = schemas.byId[record.schemaPatch.id];
      if (cur) schemas.byId[record.schemaPatch.id] = applySchemaPatch(cur, record.schemaPatch.ops);
      continue;
    }
    if (record.status === 'assistant_starting') starting = true;
    else if (record.status == null) content = true;
  }
  if (starting) assistant.starting = true;
  if (content) {
    assistant.starting = false;
    void loadChannel();
  }
}

/**
 * 订阅主进程推送（`evt-sink` 统一信封 `evt:batch` = `{channel,batchSeq,items[],emitAt}`）。
 * M0 只做「某域有更新 → 重载频道」；同时保留 legacy 的 `evt:message`（bench / 旧路径）。
 * 返回合并退订函数。
 */
// ── K1 知识库 ─────────────────────────────────────────────────────────
export const notesStore = proxy({
  list: [] as Array<Record<string, unknown>>,
  /** 2026-11-03（逐页错误注入）：加载失败显式报错，不伪装成「没有匹配」。 */
  loading: true,
  error: null as string | null,
});

export async function loadNotes(): Promise<void> {
  const api = getApi();
  if (!api?.notes?.list) {
    notesStore.loading = false;
    return;
  }
  notesStore.loading = true;
  notesStore.error = null;
  try {
    notesStore.list = (await api.notes.list()) as Array<Record<string, unknown>>;
  } catch (error) {
    // 保留旧列表，但显式置错误（页面展示＋重试）。
    notesStore.error = error instanceof Error ? error.message : String(error);
  } finally {
    notesStore.loading = false;
  }
}

export function subscribeEvents(): () => void {
  const api = getApi();
  if (!api?.on) return () => undefined;

  /** 处理一条 `evt:batch` 信封（**live 与快照回放共用**）。 */
  const applyBatch = (envelope: { channel?: string; items?: unknown[] } | undefined): void => {
    if (envelope?.channel === 'evt:message') {
      applyMessageItems(envelope.items);
    } else if (envelope?.channel === 'evt:task') {
      // R3-2：任务状态变化 ⇒ 槽位读数会变（executing 数）——一并刷新（源已接，读数不许过期）
      void loadSlots();
      // 任务详情视图开着时同步刷新详情，否则只刷新左栏列表。
      if (session.view === 'task' && session.selectedTaskId != null) {
        void openTaskDetail(session.selectedTaskId);
      } else {
        void loadTasks();
      }
    } else if (envelope?.channel === 'evt:hall') {
      void loadHall();
    } else if (envelope?.channel === 'evt:notify' || envelope?.channel === 'evt:inbox') {
      // BRK15（挂载 2）：新卡/通知/待办变化 → 实时刷新（频道＋「待我处理」同源 `loadChannel`；不靠下一次拉取）
      void loadChannel();
    } else if (envelope?.channel === 'evt:read') {
      // 读游标变化（桌面动作/IM 批准/另一入口）→ 两个 surface 各自重拉，绝不互相覆盖。
      void loadReadState('channel:cards');
      void loadReadState('channel:messages');
    } else if (envelope?.channel === 'evt:toast') {
      // 2026-10-17 真机反馈「没通知」：主进程 desktop 投递的可见回执（OS 通知之外的兜底）。
      // 只取批内最后一条（16ms 窗口内同一通知只保留最新）；字段不合法→不弹（不臆造正文）。
      const items = (envelope.items ?? []) as Array<{ title?: unknown; text?: unknown }>;
      const last = items[items.length - 1];
      if (last && typeof last.title === 'string' && typeof last.text === 'string') {
        pushToast({ title: last.title, text: last.text });
      }
    } else if (envelope?.channel === 'evt:open-view') {
      // GAP3：托盘菜单/OS 通知点击 → 回到对应任务或视图（主进程保证挂载后才推）。
      const items = (envelope.items ?? []) as Array<{ taskId?: unknown; view?: unknown }>;
      const last = items[items.length - 1];
      if (typeof last?.taskId === 'number') void openTaskDetail(last.taskId);
      else if (last?.view === 'inbox') showInbox();
      else if (last?.view === 'hall') showHall();
      else showChannel();
    } else if (envelope?.channel === 'evt:agent') {
      // G8：员工运行时三态（idle/assembling/ready/failed）→ 只保留**最后一条**（最新态）。
      const items = (envelope.items ?? []) as AgentStatusDTO[];
      const last = items[items.length - 1];
      if (last && typeof last === 'object') agent.status = last;
    }
  };

  const offs: Array<() => void> = [];
  offs.push(
    api.on('evt:batch', (payload) => {
      applyBatch(payload as { channel?: string; items?: unknown[] } | undefined);
    }),
  );
  offs.push(
    api.on('evt:message', (payload) => {
      applyMessageItems([payload]);
    }),
  );
  // F-G8：**启动期发生的事件（如惰性装配失败）可能早于本订阅** → 订阅后拉一次快照补齐。
  // **只回放 `evt:agent`（state-like）**：`evt:message` 是增量 delta，重放会重复上屏。
  void Promise.resolve(api.evt?.snapshot?.())
    .then((snap) => {
      if (!Array.isArray(snap)) return;
      for (const entry of snap as Array<{ channel?: string; items?: unknown[] }>) {
        if (entry?.channel === 'evt:agent') applyBatch(entry);
      }
    })
    .catch(() => undefined);
  return () => {
    for (const off of offs) off();
  };
}

export async function sendMessage(input: {
  text: string;
  attachments: AttachmentDTO[];
}): Promise<{ resolution: ResolutionDTO; rejected: string | null } | null> {
  const api = getApi();
  if (!api) return null;
  session.sending = true;
  session.error = null;
  // 乐观上屏（老板 2026-10-26 真机反馈：发消息长时间不出现）：不等 IPC 里的语义分类（也是一次模型调用），
  // 先把这条消息按发送时间插进频道流；loadChannel 拉到真库列表后整体替换，临时项自然消失（id<0 不会重复）。
  const optimisticId = -Date.now();
  messages.list = [
    ...messages.list,
    {
      id: optimisticId,
      direction: 'in',
      taskId: null,
      content: input.text,
      attachments: input.attachments,
      createdAt: Date.now(),
    } as unknown as HumanMessageDTO,
  ];
  try {
    const result = (await api.chat.send({
      text: input.text,
      attachments: input.attachments,
      projectId: session.selectedProjectId,
    })) as { messageId?: number; resolution?: ResolutionDTO; rejected?: string | null } | undefined;
    await loadChannel();
    // UG-03：`rejected` 非空 = 高置信命令被拒（回执已落频道）；调用方可就地显示，不当成功。
    return { resolution: result?.resolution ?? { kind: 'chat' }, rejected: result?.rejected ?? null };
  } catch (error) {
    session.error = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    session.sending = false;
  }
}

/**
 * GenUI 卡片意图（M1，`UI §4.7`）：**一次点击 = 恰好一条 `chat:card-action` IPC**。
 * 只发**意图**（不含副作用）；主进程一个入口过 `permissionGate`。
 */
export async function cardIntent(intent: GenUiIntent, card?: ReportDTO): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.chat.cardAction({
    ...intent,
    payload: {
      ...intent.payload,
      ...(card ? { taskId: card.taskId, reportId: card.id, approvalId: card.approvalId ?? null } : {}),
    },
  });
  await loadChannel();
}

/** 卡片主操作（决策卡选项）：**一次点击 = 恰好一条 `task:approve` IPC**。 */
export async function answerCard(card: ReportDTO, chosen: string): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api) return { ok: false, error: '主进程未连接' };
  try {
    const res = (await api.task.approve({
      taskId: card.taskId,
      approvalId: card.approvalId ?? null,
      chosen,
    })) as { ok?: boolean; message?: string } | undefined;
    // P0/V1（S13-E 对抗审查）：作答失败不得静默——失败不推进已读游标、不动卡，并回执人话。
    if (res && res.ok === false) {
      const message = res.message ?? '作答失败（原因未提供）';
      pushToast({ title: '作答失败', text: message });
      return { ok: false, error: message };
    }
    // source='action'：老板实际处理了这张卡（不是“打开列表”），同事务口径由主进程再兜底一次。
    await markInboxRead(card.id, 'action');
    await loadChannel();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushToast({ title: '作答失败', text: message });
    return { ok: false, error: message };
  }
}

export async function acknowledgeCard(card: ReportDTO): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api) return { ok: false, error: '主进程未连接' };
  try {
    await api.inbox.answer({ id: card.id, answer: 'ack' });
    await markInboxRead(card.id, 'action');
    await loadChannel();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushToast({ title: '标记已阅失败', text: message });
    return { ok: false, error: message };
  }
}

/**
 * F-08（2026-10-25）：批量标记已阅（**只用于 report 卡**；决策/异常仍需逐张处理）。
 * 串行逐张 ack；任一张失败即停并返回已处理数/错误，最后统一刷新一次同源列表。
 */
export async function acknowledgeCards(cardsToAck: readonly ReportDTO[]): Promise<{ count: number; error: string | null }> {
  const api = getApi();
  if (!api) return { count: 0, error: '主进程未连接' };
  let count = 0;
  let error: string | null = null;
  for (const card of cardsToAck) {
    try {
      await api.inbox.answer({ id: card.id, answer: 'ack' });
      await markInboxRead(card.id, 'action');
      count += 1;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }
  await loadChannel();
  return { count, error };
}

// ── R2-2（G7）：员工间问答面（「待我处理」列出未结提问；老板可代答，via='boss'）──────

export const mailbox = proxy({
  loading: false,
  error: null as string | null,
  questions: [] as MailboxAskDTO[],
  /** 最近一次作答回执（人话；失败走 `error`，不静默）。 */
  saved: null as string | null,
});

/** R2-2：拉未结提问（空 → `[]`，由视图显空态；不臆造）。 */
export async function loadMailbox(): Promise<void> {
  const api = getApi();
  if (!api?.mailbox) return;
  mailbox.loading = true;
  mailbox.error = null;
  try {
    const list = (await api.mailbox.list()) as MailboxAskDTO[] | undefined;
    mailbox.questions = Array.isArray(list) ? list : [];
  } catch (error) {
    mailbox.error = error instanceof Error ? error.message : String(error);
  } finally {
    mailbox.loading = false;
  }
}

/** R2-2：老板代答一条提问（失败显式报错；成功回执 + 重取列表）。 */
export async function answerMailboxAsk(askDedupeKey: string, answer: string): Promise<boolean> {
  const api = getApi();
  if (!api?.mailbox) return false;
  const res = (await api.mailbox.answer({ askDedupeKey, answer })) as { ok?: boolean; code?: string; message?: string } | undefined;
  if (res && res.ok === false) {
    mailbox.error = `作答失败：${res.message ?? res.code ?? '未知'}`;
    mailbox.saved = null;
    return false;
  }
  mailbox.error = null;
  mailbox.saved = '已作答（答复将在该员工下一轮会话带回）';
  await loadMailbox();
  return true;
}

// ── T0.6：任务列表（左栏分组）+ 手工建单/推进 ─────────────────────────

/** 左栏列表长度上限（**显式给，不许无界查询**；`UI §515`）。 */
export const TASK_LIST_LIMIT = 200;
/** 终态任务"最近 N 天"窗口（`UI §515`：最近 7 天完成的）。 */
export const TASK_TERMINAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * F-06（2026-11-06 终验）：主进程 `initDatabaseAndIpc()` 是异步的，而 `createWindow()` 在其之前执行
 *（main/index.ts whenReady）——渲染层首次加载可能抢在 `ipcMain.handle` 注册前，抛
 * `No handler registered for 'project:list'`，页面随即停在「加载失败」且**不会自动重试**。
 * 这里只对这类启动竞态错误做**有界重试**（40×500ms，≈20s），其它错误立即抛出（不掩盖真故障）。
 */
async function withIpcReadyRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No handler registered for/i.test(message)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export async function loadTasks(opts: { includeArchived?: boolean; now?: number } = {}): Promise<void> {
  const api = getApi();
  if (!api) return;
  const since = (opts.now ?? Date.now()) - TASK_TERMINAL_WINDOW_MS;
  tasks.loading = true;
  tasks.error = null;
  try {
    tasks.list =
      ((await withIpcReadyRetry(() =>
        Promise.resolve(
          api.task.list({
            includeArchived: opts.includeArchived === true,
            since,
            limit: TASK_LIST_LIMIT,
          }),
        ),
      )) as TaskDTO[] | undefined) ?? [];
  } catch (error) {
    // 不静默：保留上次列表（若有），但显式置错误；页面负责展示与重试。
    tasks.error = error instanceof Error ? error.message : String(error);
  } finally {
    tasks.loading = false;
  }
}

/** 受理建任务（落 `inbox`）；GAP13（挂载 3）：验收标准与预算随表单一并入档（`riskLevel` 缺省＝主进程缺省 1）；
 *  D-11（编制）：`ownerId` 随行（建任务对话框「谁来做」；缺省不传 ⇒ 主进程按编制/缺省链解析）。 */
export async function createTask(
  goal: string,
  opts?: {
    projectId?: number;
    riskLevel?: number;
    ownerId?: number;
    acceptance?: string[];
    budgetTokens?: number;
    deadline?: number;
    dependsOn?: number[];
  },
): Promise<TaskDTO | null> {
  const api = getApi();
  if (!api || goal.trim().length === 0) return null;
  const created = (await api.task.create({
    goal: goal.trim(),
    ...(typeof opts?.projectId === 'number' ? { projectId: opts.projectId } : {}),
    ...(typeof opts?.riskLevel === 'number' ? { riskLevel: opts.riskLevel } : {}),
    ...(typeof opts?.ownerId === 'number' ? { ownerId: opts.ownerId } : {}),
    ...(opts?.acceptance && opts.acceptance.length > 0
      ? { acceptance: opts.acceptance.map((text) => ({ text })) }
      : {}),
    ...(typeof opts?.budgetTokens === 'number' ? { budgetTokens: opts.budgetTokens } : {}),
    ...(typeof opts?.deadline === 'number' ? { deadline: opts.deadline } : {}),
    ...(opts?.dependsOn && opts.dependsOn.length > 0 ? { dependsOn: opts.dependsOn } : {}),
  })) as TaskDTO | undefined;
  // 创建已成功：刷新失败不得把成功回执改写成失败（否则会重复建任务）。
  try {
    await loadTasks();
  } catch (error) {
    console.warn('[store] 建任务成功但列表刷新失败：', error instanceof Error ? error.message : String(error));
  }
  return created ?? null;
}

/** M2 尾（G-D）：跨项目全局搜索（命令面板第三组；空查询/未接线 → null）。 */
export async function searchGlobal(query: string): Promise<GlobalSearchDTO | null> {
  const api = getApi();
  const q = query.trim();
  if (!api?.search?.global || q.length === 0) return null;
  try {
    return ((await api.search.global({ query: q })) as GlobalSearchDTO | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 手工推进：发一个引擎事件（`task:transition`），随后重载任务列表。 */
export async function transitionTask(
  taskId: number,
  event: string,
  payload?: Record<string, unknown>,
): Promise<boolean> {
  const api = getApi();
  if (!api) return false;
  const res = (await api.task.transition({ taskId, event, payload })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    // 挂载 3（BRK17）：引擎拒绝（未知迁移/守卫不过）→ 显式回执；此前异常会变成静默 reject（「点了没反应」）。
    taskDetail.actionNotice = `操作未生效：${res.message ?? res.code ?? '未知'}`;
    return false;
  }
  taskDetail.actionNotice = null;
  await loadTasks();
  // GAP12：打回/通过后详情要看到新结论、返工件与状态；只刷列表会让详情停在旧状态。
  if (session.selectedTaskId === taskId) await openTaskDetail(taskId);
  return true;
}

/** 归档页「续办」：发 renew 事件；成功/失败都给回执（失败原因进任务详情操作回执）。 */
export async function renewTaskFromArchive(taskId: number): Promise<void> {
  archiveView.notice = null;
  const ok = await transitionTask(taskId, 'renew');
  archiveView.notice = ok ? '已提交续办；新任务在项目树' : '续办未生效；打开任务详情看原因';
  if (ok) await loadTasks();
}

/**
 * GAP8：批准前保存/保存并批准计划（`task:edit-plan`）。
 * 返回 `null`＝成功；字符串＝失败回执（同时写进 `taskDetail.planNotice` 上屏）。
 * 无论成功/失败都重载详情与频道：失败也可能是「计划已保存、批准没生效」，界面必须反映真库现状。
 */
export async function saveTaskPlan(taskId: number, steps: string[], approve: boolean): Promise<string | null> {
  const api = getApi();
  if (!api?.task?.editPlan) {
    taskDetail.planNotice = '主进程未连接，计划未保存';
    return taskDetail.planNotice;
  }
  try {
    const res = (await api.task.editPlan({ taskId, steps, approve })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    await openTaskDetail(taskId);
    await loadChannel();
    if (res && res.ok === false) {
      const message = res.message ?? res.code ?? '未知错误';
      taskDetail.planNotice = `计划未生效：${message}`;
      return message;
    }
    taskDetail.planNotice = approve
      ? `已保存并批准（${steps.length} 步），任务继续执行`
      : `已保存计划（${steps.length} 步），仍等你批准`;
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskDetail.planNotice = `计划保存失败：${message}`;
    return message;
  }
}

/**
 * M3-P-4 / BRK16-b：合并一个变更集到项目主分支（`task:merge`）。
 * 成功/幂等/冲突/拒绝都给人话回执；随后重载详情（变更集状态/按钮跟着真库走）。
 */
/** 2026-10-29 P2（D-N07）：把合并冲突派回原员工——建续办任务；失败显式回执。 */
export async function reworkMergeConflict(taskId: number, changesetId: number): Promise<string | null> {
  const api = getApi();
  if (!api?.task?.reworkMergeConflict) {
    taskDetail.mergeNotice = '主进程未连接，派回未执行';
    return taskDetail.mergeNotice;
  }
  try {
    const res = (await api.task.reworkMergeConflict({ taskId, changesetId })) as
      | { ok?: boolean; shortId?: string | null; employeeName?: string | null; message?: string; code?: string }
      | undefined;
    if (res?.ok === true) {
      taskDetail.mergeNotice = `已派回 ${res.employeeName ?? '原执行员工'} 修复：新建续办任务 ${res.shortId ?? ''}`.trim();
      return null;
    }
    taskDetail.mergeNotice = `派回失败：${res?.message ?? res?.code ?? '未知错误'}`;
    return taskDetail.mergeNotice;
  } catch (error) {
    taskDetail.mergeNotice = `派回失败：${error instanceof Error ? error.message : String(error)}`;
    return taskDetail.mergeNotice;
  }
}

export async function mergeTaskChangeset(taskId: number, changesetId: number): Promise<string | null> {
  const api = getApi();
  if (!api?.task?.merge) {
    taskDetail.mergeNotice = '主进程未连接，合并未执行';
    return taskDetail.mergeNotice;
  }
  try {
    const res = (await api.task.merge({ taskId, changesetId })) as
      | {
          ok?: boolean;
          alreadyMerged?: boolean;
          mergeCommit?: string | null;
          message?: string;
          code?: string;
          conflicts?: string[];
        }
      | undefined;
    let notice: string;
    if (res?.ok === true) {
      notice = res.alreadyMerged
        ? `已合并过（幂等）：${res.message ?? '未重复执行'}`
        : `已合并：${res.mergeCommit ? res.mergeCommit.slice(0, 8) : '合并提交已产生'}`;
    } else {
      notice = `合并未生效：${res?.message ?? res?.code ?? '未知错误'}`;
      if (res?.conflicts && res.conflicts.length > 0) notice += `（冲突：${res.conflicts.join(', ')}）`;
    }
    taskDetail.mergeNotice = notice;
    if (res?.ok === true) {
      taskDetail.mergeConflicts = [];
      taskDetail.mergeConflictChangesetId = null;
    } else if (Array.isArray(res?.conflicts) && res.conflicts.length > 0) {
      taskDetail.mergeConflicts = res.conflicts;
      taskDetail.mergeConflictChangesetId = changesetId;
    }
    await openTaskDetail(taskId);
    // openTaskDetail 会按“换任务清旧回执”清空 mergeNotice；同一任务刷新后补回本次回执。
    taskDetail.mergeNotice = notice;
    await loadChannel();
    return res?.ok === true ? null : notice;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskDetail.mergeNotice = `合并失败：${message}`;
    return taskDetail.mergeNotice;
  }
}

/**
 * B-2：丢弃一个变更集（`task:discard`）。
 * 只改台账状态；主分支/其他工作项不动；二次调用幂等。成功/拒绝都给人话回执并重载详情。
 */
export async function discardTaskChangeset(taskId: number, changesetId: number): Promise<string | null> {
  const api = getApi();
  if (!api?.task?.discard) {
    taskDetail.discardNotice = '主进程未连接，丢弃未执行';
    return taskDetail.discardNotice;
  }
  try {
    const res = (await api.task.discard({ taskId, changesetId })) as
      | { ok?: boolean; alreadyDiscarded?: boolean; filesChanged?: number; message?: string; code?: string }
      | undefined;
    let notice: string;
    if (res?.ok === true) {
      notice = res.alreadyDiscarded
        ? `已丢弃过（幂等）：${res.message ?? '未重复执行'}`
        : `已丢弃变更集 #${changesetId}：不会合并到 main；主分支/其他工作项未动`;
    } else {
      notice = `丢弃未执行：${res?.message ?? res?.code ?? '未知错误'}`;
    }
    taskDetail.discardNotice = notice;
    await openTaskDetail(taskId);
    // 同 merge：刷新会把回执清空；同一任务刷新后补回。
    taskDetail.discardNotice = notice;
    await loadChannel();
    return res?.ok === true ? null : notice;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskDetail.discardNotice = `丢弃失败：${message}`;
    return taskDetail.discardNotice;
  }
}

/**
 * M3-N-2 / GAP4：把一个变更集回滚到其工作项检查点（`task:rollback`）。
 * 成功/幂等/守卫拒绝都给人话回执；随后重载详情（状态/按钮跟着真库走）。
 */
export async function rollbackTaskChangeset(taskId: number, changesetId: number): Promise<string | null> {
  const api = getApi();
  if (!api?.task?.rollback) {
    taskDetail.rollbackNotice = '主进程未连接，回滚未执行';
    return taskDetail.rollbackNotice;
  }
  try {
    const res = (await api.task.rollback({ taskId, changesetId, scope: 'code' })) as
      | {
          ok?: boolean;
          alreadyRestored?: boolean;
          rollbackCommit?: string | null;
          files?: string[];
          message?: string;
          code?: string;
        }
      | undefined;
    let notice: string;
    if (res?.ok === true) {
      const count = Array.isArray(res.files) ? res.files.length : 0;
      notice = res.alreadyRestored
        ? `已回滚过（幂等）：${res.message ?? '未重复执行'}`
        : res.rollbackCommit
          ? `已回滚 ${count} 个文件：${res.rollbackCommit.slice(0, 8)}`
          : `已恢复到检查点：${res.message ?? '文件本来就在检查点状态'}`;
    } else {
      notice = `回滚未执行：${res?.message ?? res?.code ?? '未知错误'}`;
    }
    taskDetail.rollbackNotice = notice;
    await openTaskDetail(taskId);
    // 同 merge：刷新会把回执清空；同一任务刷新后补回。
    taskDetail.rollbackNotice = notice;
    await loadChannel();
    return res?.ok === true ? null : notice;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskDetail.rollbackNotice = `回滚失败：${message}`;
    return taskDetail.rollbackNotice;
  }
}

/**
 * BRK17 组（挂载 3）：归档任务（`archive` 引擎事件 → `tasks.archived=1`；入口＝左栏终态任务行）。
 * 默认过滤下归档任务离开列表——回执说明去「归档」开关看（不静默消失）。
 */
/** RW-13（M5 真机带回）：项目树任务行实时暂停/恢复——executing→pause、paused→resume。
 *  通路与归档同（task:transition）；失败回执进 tasks.notice（不静默），成功清 notice 并等待拉取刷新。 */
export async function pauseResumeTask(taskId: number, event: 'pause' | 'resume'): Promise<void> {
  const api = getApi();
  if (!api) return;
  const label = event === 'pause' ? '暂停' : '恢复';
  const res = (await api.task.transition({ taskId, event })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    tasks.notice = `${label}失败：${res.message ?? res.code ?? '未知'}`;
    return;
  }
  tasks.notice = null;
}

export async function archiveTask(taskId: number): Promise<void> {
  const api = getApi();
  if (!api) return;
  const task = (tasks.list as unknown as TaskDTO[]).find((t) => t.id === taskId);
  const res = (await api.task.transition({ taskId, event: 'archive' })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    tasks.notice = `归档失败：${res.message ?? res.code ?? '未知'}`;
    return;
  }
  await loadTasks();
  tasks.notice = `已归档 ${task?.shortId ?? `#${taskId}`}（「归档」页可见）`;
}

// ── T0.7：任务详情（中栏视图切换 + `task:get` 详情）──────────────────────

/**
 * 频道卡定位（2026-10-17）：待我处理点「在频道看」→ 切频道并请求把某张卡滚进视野。
 * `cardId` 由 `BossChannel` 消费（滚到卡 + 短暂高亮），找到/超时后清空；不常驻。
 */
export const channelFocus = proxy({ cardId: null as number | null });

/** 切到老板频道视图。 */
export function showChannel(): void {
  channelFocus.cardId = null;
  session.view = 'channel';
  persistSession();
}

/**
 * 切到老板频道并精准定位某张卡（待我处理 →「在频道看」）。
 * 先拉同源列表，再置 focus；频道挂载后按 `data-card-id` 命中。
 */
export async function focusChannelCard(cardId: number): Promise<void> {
  session.view = 'channel';
  persistSession();
  await loadChannel();
  channelFocus.cardId = cardId;
}

/** 切到公司大厅视图（`UI §1` 中栏七选一之一；左栏 `leftrail-hall`）。右栏分区态保持。 */
export function showHall(): void {
  session.view = 'hall';
  persistSession();
}

/** 2026-10-17（双栏改版）：大厅左列点员工 → 右栏看活（**不跳页**；`view` 仍＝`hall`）。 */
export function selectEmployee(employeeId: number): void {
  session.view = 'hall';
  session.hallPane = 'employee';
  session.selectedEmployeeId = employeeId;
  persistSession();
  void loadWorkstation(employeeId);
}

/** 2026-10-17（双栏改版）：大厅左列「部门协作」按钮 → 右栏协作流向（不跳页）。 */
export function openHallCollab(): void {
  session.view = 'hall';
  session.hallPane = 'collab';
  persistSession();
}

/** M3-P-5：大厅左列「活动流」按钮 → 右栏实时公司动态（不跳页）。 */
export function openHallActivity(): void {
  session.view = 'hall';
  session.hallPane = 'activity';
  persistSession();
}

/** OPT-EXT-6：把当前视图写到 localStorage（每次切视图调用；`settings:*` 落地后迁移）。 */
function persistSession(): void {
  saveViewState({
    view: session.view as RestorableView,
    selectedTaskId: session.selectedTaskId,
    selectedProjectId: session.selectedProjectId,
    selectedEmployeeId: session.selectedEmployeeId,
  });
}

/**
 * OPT-EXT-6：启动时恢复上次视图。**失真则回落 `channel`**（id 已不存在 / 未知视图）。
 * 先 `loadTasks()` 拿真数据算现存 id 集合，再 `resolveView` 决定真正落到哪个视图。
 */
export async function restoreSession(): Promise<void> {
  // RW-20（M5 真机 S9 批）：范围唯一真源＝settings（主进程 note_write 等按它定落点）。
  // 启动即回读，防「库里有项目 id 而会话态被默认 null 覆盖」的口径分叉（UI 显公司、笔记落项目）。
  try {
    const api = getApi();
    const res = (await api?.settings?.get?.({ key: 'channel.scope_project_id' })) as { value?: unknown } | undefined;
    const v = res?.value;
    session.selectedProjectId = typeof v === 'number' && v > 0 ? v : null;
  } catch {
    // 读不到（IPC 未就绪等）→ 保持默认公司全局，与旧口径一致
  }
  const saved = loadViewState();
  if (!saved) return;
  await loadTasks();
  const taskIds = new Set((tasks.list as unknown as TaskDTO[]).map((t) => t.id));
  const projectIds = new Set(projectsFromTasks(tasks.list as unknown as TaskDTO[]).map((g) => g.projectId));
  // D-5 工位页：失真判定需要现存员工 id（`employee:list`；取不到 → 空集 ⇒ 回落 channel，不白屏）。
  let employeeIds = new Set<number>();
  if (saved.view === 'employee') {
    try {
      const api = getApi();
      const emps = (await api?.employee?.list()) as EmployeeDTO[] | undefined;
      employeeIds = new Set((emps ?? []).map((e) => e.id));
    } catch {
      employeeIds = new Set();
    }
  }
  const resolved = resolveView(saved, taskIds, projectIds, employeeIds);
  if (resolved.view === 'task' && resolved.selectedTaskId != null) {
    await openTaskDetail(resolved.selectedTaskId);
    return;
  }
  if (resolved.view === 'employee' && resolved.selectedEmployeeId != null) {
    // 2026-10-17（双栏改版）：员工视图只剩「员工设置」（ops 已并入大厅右栏）。
    showEmployee(resolved.selectedEmployeeId, 'config');
    return;
  }
  session.view = resolved.view as CenterView;
  session.selectedTaskId = resolved.view === 'task' ? resolved.selectedTaskId : null;
  // 2026-10-26（频道范围选择器）：范围是显式设置，恢复时随视图保留（resolveView 已按现存项目校验）。
  // RW-20：settings 回读值优先（函数头已落 session）；localStorage 只在缺 settings 时兜底。
  if (session.selectedProjectId == null) {
    session.selectedProjectId = resolved.selectedProjectId ?? null;
  }
  session.selectedEmployeeId = null;
  persistSession();
}

export function showNotes(): void {
  session.view = 'notes';
  persistSession();
}

/**
 * 2026-10-18（老板裁「站在导航栏的就是导航，就该开一个页面」）：**项目树页**（中栏）——
 * 按项目归并的任务浏览面（组题可点进项目概览）；左栏项＝导航（不再切开关）。
 */
export function showProjectTree(): void {
  session.view = 'projects';
  persistSession();
}

/** 2026-10-18（同裁）：**归档页**——归档任务列表；进页拉一次 `includeArchived`（归档行只在页里，左栏不含）。 */
export function showArchive(): void {
  session.view = 'archive';
  persistSession();
  void loadTasks({ includeArchived: true });
}

/** M2-A 项目概览（2026-10-17 双栏改版）：左列点项目＝**在「项目树」页右栏切换**（不跳页）。 */
export function showProject(projectId: number): void {
  session.view = 'projects';
  session.selectedProjectId = projectId;
  persistSession();
  // RW-14：项目树点选与频道选择器同口径——范围落库，助手工具（note_write 等）跟随。
  void getApi()?.settings.set({ key: 'channel.scope_project_id', value: projectId }).catch(() => {
    /* 同上：落库失败不阻断 */
  });
}

/**
 * 频道范围选择器（老板 2026-10-26 提案落地）：老板频道「当前范围」下拉的写入口。
 * 与项目树点选写同一状态（session.selectedProjectId）——两处互同步；null＝公司（全部项目）。
 * 只改范围、不改视图（在频道里选范围不该被拽去项目树页）。
 * RW-14（M5 真机带回）：同时把范围落库 `channel.scope_project_id`（主进程 note_write 等助手
 * 工具读它定落点）——此前主进程无从得知范围，选了项目笔记也落全局。
 */
export function setChannelScope(projectId: number | null): void {
  session.selectedProjectId = projectId;
  persistSession();
  void getApi()?.settings.set({ key: 'channel.scope_project_id', value: projectId ?? 0 }).catch(() => {
    /* 落库失败不阻断 UI；note_write 回退全局口径 */
  });
}

/** M3-REM-1c：「待我处理」视图（左栏 `leftrail-inbox`）。进入后由 `InboxView` 推进服务端卡片游标。 */
export function showInbox(): void {
  session.view = 'inbox';
  persistSession();
  void loadChannel(); // 同源刷新（与老板频道共用 `cards.list`）
}

/**
 * 2026-10-16（任务详情批）：详情「返回」——回到**进入详情前**的视图（`detailReturnView`）。
 * 缺记录、或目标视图缺 id（项目/员工）⇒ 回落老板频道（不臆造跳转目标）。
 */
export function leaveTaskDetail(): void {
  const from = session.detailReturnView;
  if (from === 'inbox') {
    showInbox();
    return;
  }
  if (from === 'hall') {
    showHall();
    return;
  }
  if (from === 'settings') {
    showSettings();
    return;
  }
  if (from === 'employee' && session.selectedEmployeeId != null) {
    showEmployee(session.selectedEmployeeId, 'config');
    return;
  }
  if (from === 'projects') {
    showProjectTree();
    return;
  }
  if (from === 'archive') {
    showArchive();
    return;
  }
  showChannel();
}

/** 取公司大厅数据（`hall:state`；员工 + 部门 + 真实协作）。 */
export async function loadHall(): Promise<void> {
  const api = getApi();
  if (!api) return;
  hall.loading = true;
  hall.error = null;
  try {
    hall.data = ((await api.hall.state()) as HallStateDTO | undefined) ?? null;
  } catch (error) {
    hall.data = null;
    hall.error = error instanceof Error ? error.message : String(error);
  } finally {
    hall.loading = false;
  }
}

/** D-5 补位 ①：取员工工位页数据（`employee:get`；不存在 → `data:null` 且无错）。 */
export async function loadWorkstation(employeeId: number): Promise<void> {
  const api = getApi();
  if (!api?.employee) return;
  workstation.employeeId = employeeId;
  workstation.loading = true;
  workstation.error = null;
  try {
    workstation.data = ((await api.employee.get({ employeeId })) as EmployeeDetailDTO | undefined) ?? null;
  } catch (error) {
    workstation.data = null;
    workstation.error = error instanceof Error ? error.message : String(error);
  } finally {
    workstation.loading = false;
  }
}

/** D-5 补位 ①：打开员工视图；2026-10-17（工位批）带口子 `mode`（大厅⇒ops 看活；设置⇒config 改人）。
 *  2026-10-17（双栏改版）：`ops` 不再开独立页——落到**公司大厅右栏**（`selectEmployee`）；config 仍为独立页。 */
export function showEmployee(employeeId: number, mode: 'ops' | 'config' = 'ops'): void {
  if (mode === 'config') {
    session.view = 'employee';
    session.employeeMode = 'config';
    session.selectedEmployeeId = employeeId;
    persistSession();
    void loadWorkstation(employeeId);
    return;
  }
  session.employeeMode = 'ops';
  selectEmployee(employeeId);
}

/** 打开某任务详情：切视图 + 取 `task:get` 详情（左栏任务行点击即走这里）。 */
/**
 * 详情取数（UI-2 抽出）：`task:get` + 引用候选，**不碰视图路由**——整页详情与项目页行内展开共用。
 */
async function loadTaskDetailData(taskId: number): Promise<void> {
  taskDetail.taskId = taskId;
  // 回执/预览属于上一个任务：打开新任务先清，避免把 A 的“已丢弃/已合并”显示在 B 上。
  taskDetail.actionNotice = null;
  taskDetail.planNotice = null;
  taskDetail.mergeNotice = null;
  taskDetail.rollbackNotice = null;
  taskDetail.discardNotice = null;
  taskDetail.artifactNotice = null;
  taskDetail.exportNotice = null;
  taskDetail.artifactPreview = null;
  const api = getApi();
  if (!api) return;
  taskDetail.loading = true;
  taskDetail.error = null;
  try {
    const data = (await api.task.get({ taskId })) as TaskDetailDTO | null | undefined;
    taskDetail.data = data ?? null;
    if (!data) taskDetail.error = `未找到任务 #${taskId}`;
    // G-C：引用候选＝非归档任务里**除本任务**以外的（引用是"到别的任务"的动作；不含自身）。
    try {
      const all = (await api.task.list({})) as Array<{ id: number; shortId: string | null; title: string; archived?: number }>;
      taskDetail.refTargets = (all ?? [])
        .filter((t) => t.id !== taskId && t.archived !== 1)
        .map((t) => ({ id: t.id, shortId: t.shortId ?? null, title: t.title }));
    } catch {
      taskDetail.refTargets = []; // 取不到候选 → 控件不可用（不假装有几个能选的任务）
    }
  } catch (error) {
    taskDetail.data = null;
    taskDetail.error = error instanceof Error ? error.message : String(error);
  } finally {
    taskDetail.loading = false;
  }
}

export async function openTaskDetail(taskId: number): Promise<void> {
  // 「返回」随入口动态：记录**进入详情前**的视图（已在详情里再开别的任务不覆盖）。
  if (session.view !== 'task') session.detailReturnView = session.view;
  session.view = 'task';
  session.selectedTaskId = taskId;
  persistSession();
  await loadTaskDetailData(taskId);
}

/** 项目页任务行下展开（UI-2）：取详情但**不切视图**——留在项目页原地渲染。 */
export async function expandTaskInline(taskId: number): Promise<void> {
  session.selectedTaskId = taskId;
  persistSession();
  await loadTaskDetailData(taskId);
}

/** 收起行内展开：清选中与详情缓存，**不导航**（视图本就没切走）。 */
export function collapseTaskInline(): void {
  session.selectedTaskId = null;
  taskDetail.taskId = null;
  taskDetail.data = null;
  taskDetail.loading = false;
  taskDetail.error = null;
  taskDetail.artifactPreview = null;
  persistSession();
}

/**
 * G-C（M2 §7 序 3）：把产物**引用到目标任务**（老板显式发起；主进程做 copy 快照＋sha256＋审计）。
 * 成功/失败都给人话回执；成功后刷新详情（新产物行要上屏——"做了就要看见"）。
 */
export async function referenceArtifact(
  artifactId: number,
  targetTaskId: number,
  mode: 'copy' | 'link' = 'copy',
): Promise<void> {
  const api = getApi();
  const res = (await api?.task?.referenceArtifact?.({ artifactId, targetTaskId, mode })) as
    | { ok?: boolean; code?: string; message?: string; path?: string; duplicated?: boolean }
    | undefined;
  if (!res || res.ok === false) {
    taskDetail.referenceNotice = `${mode === 'link' ? '链接' : '引用'}失败：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  const where = taskDetail.refTargets.find((t) => t.id === targetTaskId);
  const label = where ? `${where.shortId ?? `#${where.id}`}` : `#${targetTaskId}`;
  const action = mode === 'link' ? '链接' : '引用';
  taskDetail.referenceNotice = res.duplicated
    ? `已在 ${label}（${action}已存在）`
    : `已${action}到 ${label}：${res.path ?? ''}${mode === 'link' ? '（源随动；读时按源项目根解析）' : ''}`;
  if (taskDetail.taskId != null) await openTaskDetail(taskDetail.taskId);
}

// ── BRK16-a（挂载 3）：产物读 / 系统打开 / 文件夹 ＋ GAP11 审计导出 ──────────

/**
 * 产物操作（读预览 / 系统打开 / 在文件夹中显示；`task:read-artifact`）。
 * 失败与成功都给人话回执（错误码如实转述 handler 的 message）。
 */
export async function readArtifact(artifactId: number, mode: 'read' | 'open' | 'reveal' = 'read'): Promise<void> {
  const api = getApi();
  const res = (await api?.task?.readArtifact?.({ artifactId, mode })) as
    | {
        ok?: boolean;
        code?: string;
        message?: string;
        mode?: string;
        name?: string;
        path?: string;
        size?: number;
        sha256?: string;
        sha256Mismatch?: boolean;
        supersededBy?: { artifactId: number; createdAt: number } | null;
        text?: string;
        truncated?: boolean;
        previewKind?: 'image' | 'pdf';
        previewUrl?: string;
      }
    | undefined;
  if (!res || res.ok === false) {
    // UG-05：读态失败（二进制/文件缺失/非文件）→ **元信息卡**进抽屉（消息原文 + 指路「打开/文件夹」），
    // 不再只丢一条错误 notice；open/reveal 失败仍走 notice（抽屉无从谈起）。
    const artifactRow = (taskDetail.data as unknown as { artifacts?: Array<{ id: number; name: string; path: string; sha256: string | null }> } | null)
      ?.artifacts?.find((a) => a.id === artifactId);
    if (mode === 'read' && (res?.code === 'binary_file' || res?.code === 'missing_file' || res?.code === 'not_a_file')) {
      taskDetail.artifactPreview = {
        artifactId,
        name: artifactRow?.name ?? '（产物）',
        path: artifactRow?.path ?? '',
        // D4 re-review must-fix：真实大小不可得（主进程读态失败不带 size）→ 0 由 meta 行显「—」，不写假 0。
        size: 0,
        sha256: artifactRow?.sha256 ?? '',
        sha256Mismatch: false,
        text: `${res?.message ?? res?.code ?? '不可预览'}\n\n应用内不预览该内容；用上方「打开」（系统默认程序）或「文件夹」（定位文件）查看。`,
        truncated: false,
      };
      taskDetail.artifactNotice = null;
      return;
    }
    taskDetail.artifactNotice = `产物操作失败：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  if (res.mode === 'read') {
    taskDetail.artifactPreview = {
      artifactId,
      name: res.name ?? '',
      path: res.path ?? '',
      size: res.size ?? 0,
      sha256: res.sha256 ?? '',
      sha256Mismatch: res.sha256Mismatch === true,
      supersededBy: res.supersededBy ?? null,
      text: res.text ?? '',
      truncated: res.truncated === true,
      ...(res.previewKind === 'image' || res.previewKind === 'pdf'
        ? { previewKind: res.previewKind, previewUrl: res.previewUrl ?? '' }
        : {}),
    };
    // 旧版本（同路径有更晚产出）的指纹不一致是事实而非异常——抽屉 meta 已写「旧版本」，
    // 这里不再叠一条 ⚠️ 回执（2026-11-05 老板真机：两行同名＋⚠️ 看着像故障）。
    taskDetail.artifactNotice = res.supersededBy
      ? `已读旧版本（已被 #${res.supersededBy.artifactId} 后续产出覆盖；记录未改）`
      : res.sha256Mismatch
        ? '已读预览（⚠️ 实读 sha256 与产物记录不一致——内容仍如实展示，记录未改）'
        : null;
    return;
  }
  taskDetail.artifactNotice =
    res.mode === 'open' ? `已用系统打开：${res.name ?? ''}` : `已在文件夹中显示：${res.name ?? ''}`;
}

/** M4-D-1（P2）：按 ref 读取归档的工具大输出（受控路径在主进程；renderer 只拿文本）。 */
export async function readToolOutput(ref: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.task?.readToolOutput) return { ok: false, error: '读取通道不可用（主进程未连接）' };
  try {
    const res = (await api.task.readToolOutput({ ref })) as
      | { ok: true; text?: string }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (res && res.ok === true) return { ok: true, text: res.text ?? '' };
    return { ok: false, error: res && res.ok === false ? (res.message ?? res.code ?? '读取失败') : '读取失败' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * GAP11（审计导出）：把任务档案（任务/事件/产物/成本）导出为单一 JSON 文件（`task:export`）。
 * `openAction` 由 UI 另发（导出与打开是两件事：打开失败不回滚导出，回执里如实带 `⚠️`）。
 */
export async function exportTaskArchive(taskId: number, openAction?: 'open' | 'reveal'): Promise<void> {
  const api = getApi();
  const res = (await api?.task?.export?.({ taskId, ...(openAction ? { openAction } : {}) })) as
    | { ok?: boolean; code?: string; message?: string; path?: string; bytes?: number; openError?: string }
    | undefined;
  if (!res || res.ok === false) {
    taskDetail.exportNotice = `导出失败：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  const kib = Math.max(1, Math.round((res.bytes ?? 0) / 1024));
  taskDetail.exportNotice = `已导出（${kib} KiB）：${res.path ?? ''}${res.openError ? `｜⚠️ ${res.openError}` : ''}`;
}


// ── M2 §7 序 4：文档健康（项目概览一行读数；只读检查）──────────────────

/** 文档健康读数（`result` 属于 `projectId`；**换项目后不沿用**——渲染层按 id 比对，见 `docsHealthView`）。 */
export const docsHealth = proxy({
  projectId: null as number | null,
  status: 'idle' as 'idle' | 'busy',
  error: null as string | null,
  result: null as unknown,
});

/** 跑一次文档结构检查（只读；失败/无树都如实回显——不静默、不显 0 冒充健康）。 */
export async function checkProjectDocs(projectId: number): Promise<void> {
  const api = getApi();
  docsHealth.projectId = projectId;
  docsHealth.status = 'busy';
  docsHealth.error = null;
  try {
    const res = (await api?.docs?.check?.({ projectId })) as
      | { ok?: boolean; code?: string; message?: string; docRoot?: string; hasDocsTree?: boolean; truncated?: boolean; counts?: unknown; issues?: unknown }
      | undefined;
    if (!res || res.ok === false) {
      docsHealth.error = `检查失败：${res?.message ?? res?.code ?? '未知'}`;
      docsHealth.result = null;
      return;
    }
    docsHealth.result = {
      docRoot: typeof res.docRoot === 'string' ? res.docRoot : '.aico/docs',
      hasDocsTree: res.hasDocsTree === true,
      truncated: res.truncated === true,
      counts: res.counts ?? { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 },
      issues: Array.isArray(res.issues) ? res.issues : [],
    };
  } catch (error) {
    docsHealth.error = `检查失败：${error instanceof Error ? error.message : String(error)}`;
    docsHealth.result = null;
  } finally {
    docsHealth.status = 'idle';
  }
}

/** M3-DOC-3：一键整理的预览计划（项目 id + changes + token；UI 只在同项目时展示）。 */
export interface DocsOrganizeChangeDTO {
  path: string;
  before: string | null;
  after: string;
  added: string[];
}

export interface DocsOrganizePlanDTO {
  docRoot: string;
  hasDocsTree: boolean;
  changes: DocsOrganizeChangeDTO[];
  token: string | null;
  counts: { live: number; archive: number; dangling: number; oversized: number; issues: number };
  issues: Array<{ kind: string; path: string; message: string }>;
  truncated: boolean;
}

/** 一键整理状态（预览不写文件；应用才写，失败回滚在 main）。 */
export const docsOrganize = proxy({
  projectId: null as number | null,
  status: 'idle' as 'idle' | 'previewing' | 'applying',
  plan: null as DocsOrganizePlanDTO | null,
  error: null as string | null,
  notice: null as string | null,
});

/** 只读预览：生成“将补哪些索引”的 diff 与 token（不写任何文件）。 */
export async function previewProjectDocsOrganize(projectId: number): Promise<void> {
  const api = getApi();
  docsOrganize.projectId = projectId;
  docsOrganize.status = 'previewing';
  docsOrganize.error = null;
  docsOrganize.notice = null;
  docsOrganize.plan = null;
  try {
    const res = (await api?.docs?.organizePreview?.({ projectId })) as
      | ({ ok?: boolean; code?: string; message?: string } & Partial<DocsOrganizePlanDTO>)
      | undefined;
    if (!res || res.ok === false) {
      docsOrganize.error = `整理预览失败：${res?.message ?? res?.code ?? '未知'}`;
      return;
    }
    docsOrganize.plan = {
      docRoot: typeof res.docRoot === 'string' ? res.docRoot : '.aico/docs',
      hasDocsTree: res.hasDocsTree === true,
      changes: Array.isArray(res.changes) ? res.changes : [],
      token: typeof res.token === 'string' ? res.token : null,
      counts: res.counts ?? { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 },
      issues: Array.isArray(res.issues) ? res.issues : [],
      truncated: res.truncated === true,
    };
    if (!docsOrganize.plan.hasDocsTree) {
      docsOrganize.notice = '无 .aico/docs 文档树（新建项目时可勾选初始化；已有项目补挂模板未做）。';
      docsOrganize.plan = null;
      return;
    }
    if (docsOrganize.plan.changes.length === 0) docsOrganize.notice = '索引已完整，没有需要补的条目。';
    if (docsOrganize.plan.changes.length > 0 && docsOrganize.plan.token == null) {
      docsOrganize.error = '整理预览未返回令牌，不能应用（请重试）。';
    }
  } catch (error) {
    docsOrganize.error = `整理预览失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    docsOrganize.status = 'idle';
  }
}

/** 应用预览计划（token 防过期；成功/失败都回显，成功后自动重跑检查）。 */
export async function applyProjectDocsOrganize(projectId: number, token: string): Promise<void> {
  const api = getApi();
  docsOrganize.projectId = projectId;
  docsOrganize.status = 'applying';
  docsOrganize.error = null;
  docsOrganize.notice = null;
  try {
    const res = (await api?.docs?.organizeApply?.({ projectId, token })) as
      | { ok?: boolean; code?: string; message?: string; applied?: unknown; rolledBack?: boolean }
      | undefined;
    if (!res || res.ok === false) {
      const rollback =
        res && res.ok === false
          ? res.rolledBack === true
            ? '（已回滚，文件未改变）'
            : res.rolledBack === false
              ? '（回滚未完成，请检查文件）'
              : ''
          : '';
      docsOrganize.error = `整理失败：${res?.message ?? res?.code ?? '未知'}${rollback}`;
      return;
    }
    const applied = Array.isArray(res.applied) ? res.applied : [];
    docsOrganize.plan = null;
    docsOrganize.notice = applied.length > 0 ? `已补 ${applied.length} 个索引文件。` : '索引已完整，没有改动。';
    await checkProjectDocs(projectId);
  } catch (error) {
    docsOrganize.error = `整理失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    docsOrganize.status = 'idle';
  }
}

/** 关闭预览（不写文件）。 */
export function cancelProjectDocsOrganize(): void {
  docsOrganize.plan = null;
  docsOrganize.error = null;
  docsOrganize.notice = null;
}

// ── R2-3 第二批：设置页（`settings:get/set` 白名单 ＋ `project:list/archive`）──────

/** 设置页数据（只读快照 + 保存回执；**渲染层不做业务逻辑**）。 */
export const settingsView = proxy({
  /** 2026-11-03 老板反馈：去员工配置再返回，落点要还是「员工」——section 存 proxy，不随组件重挂载丢。 */
  section: 'look' as string,
  /** 内联展开的员工 id（null＝全部收起；跨视图切换保持）。 */
  expandedEmployeeId: null as number | null,
  loading: false,
  error: null as string | null,
  /** `models.default`（null = 未设置 → 装配期回落 env）。 */
  model: null as string | null,
  /** N5：`models.role_map` 现值（原始 JSON 值；null = 未设置 → 全部走默认档）。 */
  roleMap: null as unknown,
  /** N5 余账：`models.fallback_chain` 现值（字符串数组；null = 未设置 → 不降级）。 */
  fallbackChain: null as unknown,
  /** 主题（`ui.theme`；缺省跟随系统）。 */
  theme: 'system' as 'light' | 'dark' | 'system',
  /** 2026-10-29 P2（P-N05）：开机自启（true＝下次启动写入系统登录项）。 */
  openAtLogin: false,
  /** P-N05：应用信息（版本/数据目录；主进程未注入 → null，不臆造）。 */
  appInfo: null as { version: string; userDataDir: string } | null,
  /** `projects.default_id`（null = 未设置）。 */
  defaultProjectId: null as number | null,
  /** 含归档（列表里如实显「已归档」）。 */
  projects: [] as ProjectDTO[],
  /** C4：公司级日预算（USD；null＝未设置，不限制）。 */
  companyDailyBudget: null as number | null,
  /** 设置·模型与供应商：本机 Key 状态（只含掩码/来源，不含明文）。 */
  providers: [] as ProviderStatusDTO[],
  /** D-22：自定义供应商（Pi models.json；不含 Key）。 */
  customProviders: [] as CustomProviderDef[],
  /** 件 A：调度与费率键现值（设置页「高级」）；`null` = 未设置 → 回落缺省（不臆造）。 */
  tuning: {} as Record<string, number | null>,
  /** OPT-M4-1：接缝矩阵（项目级覆盖读数；null＝未加载/未接线）。 */
  seams: null as {
    boundaries: string[];
    rows: Array<{ boundary: string; status: string; coverageRef: string | null; owner: string | null; milestone: string | null }>;
    missing: string[];
  } | null,
  /** 最近一次保存/归档的回执（人话；失败走 `error`，不静默）。 */
  saved: null as string | null,
});

/** D-22 配套：只读模型目录（设置·模型与员工；失败显式，不摆假模型）。 */
export const modelCatalog = proxy({
  loading: false,
  error: null as string | null,
  models: [] as ModelCatalogEntryDTO[],
  /** 供应商目录（添加供应商弹窗；含未配置的 SDK 供应商）。 */
  providers: [] as ProviderCatalogEntryDTO[],
});

let catalogInFlight: Promise<void> | null = null;

/** 拉模型目录（进程内目录；`refresh` 允许重读 SDK）。失败 → `error`（不静默）。 */
export function loadModelCatalog(refresh = false): Promise<void> {
  if (catalogInFlight) return catalogInFlight;
  const api = getApi();
  if (!api?.model?.catalog) {
    modelCatalog.error = '未连接主进程（模型目录不可用）';
    return Promise.resolve();
  }
  modelCatalog.loading = true;
  modelCatalog.error = null;
  catalogInFlight = (async () => {
    try {
      const res = (await api.model.catalog(refresh ? { refresh: true } : {})) as
        | { models?: ModelCatalogEntryDTO[]; providers?: ProviderCatalogEntryDTO[] }
        | undefined;
      modelCatalog.models = Array.isArray(res?.models) ? res.models : [];
      modelCatalog.providers = Array.isArray(res?.providers) ? res.providers : [];
    } catch (error) {
      modelCatalog.models = [];
      modelCatalog.providers = [];
      modelCatalog.error = error instanceof Error ? error.message : String(error);
    } finally {
      modelCatalog.loading = false;
      catalogInFlight = null;
    }
  })();
  return catalogInFlight;
}

function pickSettingValue(res: unknown): unknown {
  const r = res as { value?: unknown } | undefined;
  return r && typeof r === 'object' && 'value' in r ? r.value : null;
}

/** R2-3：拉设置页数据（白名单键现值 ＋ 项目列表）。失败 → `error`（不静默）。 */
export async function loadSettingsView(): Promise<void> {
  const api = getApi();
  if (!api?.settings || !api?.project) return;
  settingsView.loading = true;
  settingsView.error = null;
  try {
    const [modelRes, defRes, projects, roleMapRes, fallbackRes, budgetRes, providerRes, themeRes, openAtLoginRes, customRes, ...tuningRes] = await Promise.all([
      api.settings.get({ key: 'models.default' }),
      api.settings.get({ key: 'projects.default_id' }),
      api.project.list({ includeArchived: true }),
      api.settings.get({ key: 'models.role_map' }),
      api.settings.get({ key: 'models.fallback_chain' }),
      api.settings.get({ key: 'budget.companyDailyUsd' }),
      api.provider?.list?.() ?? Promise.resolve(null),
      api.settings.get({ key: 'ui.theme' }),
      api.settings.get({ key: 'app.openAtLogin' }),
      api.provider?.custom?.({ action: 'list' }) ?? Promise.resolve(null),
      ...[...TUNING_FIELDS, ...NOTIFY_FIELDS].map((f) => api.settings.get({ key: f.key })),
    ]);
    const model = pickSettingValue(modelRes);
    const def = pickSettingValue(defRes);
    const roleMap = pickSettingValue(roleMapRes);
    const fallbackChain = pickSettingValue(fallbackRes);
    const budget = pickSettingValue(budgetRes);
    settingsView.model = typeof model === 'string' && model.trim().length > 0 ? model : null;
    settingsView.roleMap = roleMap !== null && typeof roleMap === 'object' ? roleMap : null;
    settingsView.fallbackChain = Array.isArray(fallbackChain) ? fallbackChain : null;
    const theme = pickSettingValue(themeRes);
    settingsView.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
    settingsView.openAtLogin = pickSettingValue(openAtLoginRes) === true;
    const appInfoRes = (await api.app?.info?.()) as { ok?: boolean; version?: string; userDataDir?: string } | undefined;
    settingsView.appInfo =
      appInfoRes?.ok === true && typeof appInfoRes.version === 'string' && typeof appInfoRes.userDataDir === 'string'
        ? { version: appInfoRes.version, userDataDir: appInfoRes.userDataDir }
        : null;
    settingsView.companyDailyBudget = typeof budget === 'number' && Number.isFinite(budget) ? budget : null;
    const providerList = (providerRes as { providers?: ProviderStatusDTO[] } | null)?.providers;
    settingsView.providers = Array.isArray(providerList) ? providerList : [];
    const customList = (customRes as { providers?: CustomProviderDef[] } | null)?.providers;
    settingsView.customProviders = Array.isArray(customList) ? customList : [];
    settingsView.defaultProjectId = typeof def === 'number' ? def : null;
    settingsView.projects = (projects as ProjectDTO[] | undefined) ?? [];
    // OPT-M4-1：接缝矩阵（缺通道 → null，如实不摆假表）。
    settingsView.seams = ((await api.seams?.list?.({})) as typeof settingsView.seams) ?? null;
    const tuning: Record<string, number | null> = {};
    [...TUNING_FIELDS, ...NOTIFY_FIELDS].forEach((f, i) => {
      const v = pickSettingValue(tuningRes[i]);
      tuning[f.key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    settingsView.tuning = tuning;
  } catch (error) {
    settingsView.error = error instanceof Error ? error.message : String(error);
  } finally {
    settingsView.loading = false;
  }
}

/** P-N05：在系统文件管理器中打开数据目录（失败显式回执，不静默）。 */
export async function openAppDataDir(): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.app?.openDataDir) return { ok: false, error: '未连接主进程' };
  try {
    const res = (await api.app.openDataDir()) as { ok?: boolean; message?: string } | undefined;
    if (res?.ok === false) return { ok: false, error: res.message ?? '打开失败' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** R2-3：保存一个白名单键（失败显式报错；成功回执 + 重取现值——**读完才算数**）。 */
export async function saveSetting(key: string, value: unknown): Promise<boolean> {
  const api = getApi();
  if (!api?.settings) return false;
  const res = (await api.settings.set({ key, value })) as { ok?: boolean; code?: string; message?: string } | undefined;
  if (res && res.ok === false) {
    settingsView.error = `保存失败：${res.message ?? res.code ?? '未知'}`;
    settingsView.saved = null;
    return false;
  }
  settingsView.error = null;
  settingsView.saved =
    key === 'ui.theme'
      ? value === 'dark'
        ? '主题已切换到夜间'
        : value === 'light'
          ? '主题已切换到浅色'
          : '主题已改为跟随系统'
      : `已保存：${key}`;
  await loadSettingsView();
  return true;
}

/** 设置·模型与供应商：保存本机 Key（只回掩码；成功重取状态，读完才算数）。 */
export async function saveProviderKey(provider: string, key: string): Promise<boolean> {
  const api = getApi();
  if (!api?.provider) return false;
  const res = (await api.provider.setKey({ provider, key })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    settingsView.error = `保存 Key 失败：${res.message ?? res.code ?? '未知'}`;
    settingsView.saved = null;
    return false;
  }
  settingsView.error = null;
  settingsView.saved = `已保存 ${provider} 的本机 Key（下一次员工会话生效）`;
  await loadSettingsView();
  void loadModelCatalog(true); // Key 状态变了 → 目录里的「已配置/未配置」同步刷新
  return true;
}

/** D-22：保存自定义供应商（写 Pi models.json；可选同时保存 Key）。 */
export async function saveCustomProvider(input: {
  provider: CustomProviderDef;
  key?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.provider?.custom) return { ok: false, error: '未连接主进程' };
  settingsView.error = null;
  settingsView.saved = null;
  try {
    const res = (await api.provider.custom({ action: 'save', ...input })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) {
      const error = `保存自定义供应商失败：${res.message ?? res.code ?? '未知'}`;
      settingsView.error = error;
      return { ok: false, error };
    }
    settingsView.saved = '自定义供应商已保存（写 ~/.aico/models.json；下一次会话生效）';
    await loadSettingsView();
    void loadModelCatalog(true);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settingsView.error = `保存自定义供应商失败：${message}`;
    return { ok: false, error: message };
  }
}

/** D-22：测试自定义供应商（真发一次极短 completion；不打印 Key）。 */
export async function testCustomProvider(id: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  const api = getApi();
  if (!api?.provider?.custom) return { ok: false, error: '未连接主进程' };
  try {
    const res = (await api.provider.custom({ action: 'test', id })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) return { ok: false, error: `${res.message ?? res.code ?? '测试失败'}` };
    return { ok: true, message: res?.message ?? '连接成功' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** D-22：删除自定义供应商（同时清本机 Key 文件）。 */
export async function removeCustomProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.provider?.custom) return { ok: false, error: '未连接主进程' };
  const res = (await api.provider.custom({ action: 'remove', id })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    settingsView.error = `删除自定义供应商失败：${res.message ?? res.code ?? '未知'}`;
    return { ok: false, error: settingsView.error };
  }
  settingsView.error = null;
  settingsView.saved = `已删除自定义供应商：${id}`;
  await loadSettingsView();
  void loadModelCatalog(true);
  return { ok: true };
}

/** 设置·模型与供应商：清除本机 Key 文件（环境变量仍在时状态会如实显示 env）。 */
export async function clearProviderKey(provider: string): Promise<boolean> {
  const api = getApi();
  if (!api?.provider) return false;
  const res = (await api.provider.clearKey({ provider })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res && res.ok === false) {
    settingsView.error = `清除 Key 失败：${res.message ?? res.code ?? '未知'}`;
    settingsView.saved = null;
    return false;
  }
  settingsView.error = null;
  settingsView.saved = `已清除 ${provider} 的本机 Key`;
  await loadSettingsView();
  void loadModelCatalog(true);
  return true;
}

/** 2026-10-17：设置·通知「发送测试通知」（真实系统通知；不写日报幂等键）。 */
export async function sendTestNotification(): Promise<void> {  const api = getApi();
  if (!api?.notify?.test) {
    settingsView.error = '通知通道不可用（主进程未连接）';
    settingsView.saved = null;
    return;
  }
  try {
    const res = (await api.notify.test({})) as { ok?: boolean; code?: string; message?: string } | undefined;
    if (res && res.ok === false) {
      settingsView.error = `测试通知失败：${res.message ?? res.code ?? '未知'}`;
      settingsView.saved = null;
      return;
    }
    settingsView.error = null;
    settingsView.saved = '已发送测试通知（看系统右下角/托盘）';
  } catch (error) {
    settingsView.error = `测试通知失败：${error instanceof Error ? error.message : String(error)}`;
    settingsView.saved = null;
  }
}

// ── M3：IM 通道（微信 1:1）──────────────────────────────────────────────
export const imView = proxy({
  status: null as ImStatusView | null,
  loading: false,
  error: null as string | null,
  /** RM-9：绑定/解绑/刷新的可见回执。 */
  notice: null as string | null,
});

type ImIpcResult = { ok?: boolean; status?: ImStatusView; code?: string; message?: string } | undefined;

export async function loadImStatus(): Promise<void> {
  const api = getApi();
  if (!api?.im?.bind) {
    imView.status = null;
    imView.error = 'IM 通道未装配（preload 未连接）';
    imView.notice = null;
    return;
  }
  if (imView.status == null) imView.loading = true;
  try {
    const res = (await api.im.bind({ action: 'status' })) as ImIpcResult;
    if (res?.ok && res.status) {
      imView.status = res.status;
      imView.error = null;
      // 扫描/重连完成后清掉「已开始扫码」旧提示（E-2 真机：connected 仍显示扫码提示）。
      if (res.status.state === 'connected') imView.notice = null;
    } else {
      imView.error = res?.message ?? res?.code ?? 'IM 状态读取失败';
      imView.notice = null;
    }
  } catch (error) {
    imView.error = `IM 状态读取失败：${error instanceof Error ? error.message : String(error)}`;
    imView.notice = null;
  } finally {
    imView.loading = false;
  }
}

export async function bindIm(): Promise<void> {
  const api = getApi();
  if (!api?.im?.bind) {
    imView.error = 'IM 通道未装配（主进程未启动微信通道）';
    imView.notice = null;
    return;
  }
  imView.loading = true;
  imView.error = null;
  imView.notice = null;
  try {
    const res = (await api.im.bind({ action: 'login' })) as ImIpcResult;
    if (res?.ok && res.status) {
      imView.status = res.status;
      imView.notice = res.status.state === 'connected' ? null : '已开始扫码：请用微信扫描窗口里的二维码。';
    } else imView.error = res?.message ?? res?.code ?? '开始扫码失败';
  } catch (error) {
    imView.error = `开始扫码失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    imView.loading = false;
  }
}

/** 官方 B：手机微信要求输入数字验证码时提交；登录轮询继续。 */
export async function submitImVerifyCode(code: string): Promise<void> {
  const api = getApi();
  if (!api?.im?.bind) {
    imView.error = 'IM 通道未装配（主进程未启动微信通道）';
    return;
  }
  const trimmed = code.trim();
  if (!trimmed) {
    imView.error = '请输入手机微信显示的数字验证码';
    return;
  }
  imView.loading = true;
  imView.error = null;
  imView.notice = null;
  try {
    const res = (await api.im.bind({ action: 'login', verifyCode: trimmed })) as ImIpcResult;
    if (res?.ok && res.status) {
      imView.status = res.status;
      imView.notice = '验证码已提交，正在继续登录。';
    } else imView.error = res?.message ?? res?.code ?? '验证码提交失败';
  } catch (error) {
    imView.error = `验证码提交失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    imView.loading = false;
  }
}

export async function unbindIm(): Promise<void> {
  const api = getApi();
  if (!api?.im?.unbind) {
    imView.error = 'IM 通道未装配（主进程未启动微信通道）';
    imView.notice = null;
    return;
  }
  imView.loading = true;
  imView.error = null;
  imView.notice = null;
  try {
    const res = (await api.im.unbind({ action: 'unbind' })) as ImIpcResult;
    if (res?.ok && res.status) {
      imView.status = res.status;
      imView.notice = '已解绑微信：本地凭证已清除，微信消息不再进入本机。';
    } else imView.error = res?.message ?? res?.code ?? '解绑失败';
  } catch (error) {
    imView.error = `解绑失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    imView.loading = false;
  }
}

/**
 * N5（`R3-3`）：保存 `models.role_map`（草稿＝JSON 文本；空 ⇒ 清空 = null）。
 * 解析失败与主进程形状校验失败都**显式报错**（不静默）；成功走 `saveSetting` 的重取现值。
 */
export async function saveRoleMapSetting(draft: string): Promise<boolean> {
  const text = draft.trim();
  let value: unknown = null;
  if (text !== '') {
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      settingsView.error = `保存失败：role_map 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
      settingsView.saved = null;
      return false;
    }
  }
  return saveSetting('models.role_map', value);
}

/** N5 余账：保存 `models.fallback_chain`（JSON 数组；空串＝清空 → 不降级；解析失败显式报错，不静默）。 */
export async function saveFallbackChainSetting(draft: string): Promise<boolean> {
  const text = draft.trim();
  let value: unknown = null;
  if (text !== '') {
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      settingsView.error = `保存失败：fallback_chain 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
      settingsView.saved = null;
      return false;
    }
  }
  return saveSetting('models.fallback_chain', value);
}

/**
 * D-5 ③：项目级操作（**唯一入口＝项目概览**；设置页只留全局默认＋只读列表）。
 * 列表与设置页/左栏同源（`project:list`，含归档）；归档反馈落本片（不借设置页的反馈位）。
 */
export const projectActions = proxy({
  loading: false,
  list: [] as ProjectDTO[],
  message: null as string | null,
  error: null as string | null,
  /** B-1：当前项目的触发列表（`project:trigger-manage list` 真值；空数组＝无）。 */
  triggers: [] as TriggerDTO[],
  /** 列表归属项目（防切项目时短暂显示上一个项目的触发）。 */
  triggersProjectId: null as number | null,
  triggersLoading: false,
  triggersError: null as string | null,
  triggerNotice: null as string | null,
});

/** D-5 ③：拉项目列表（概览页挂载时调用）。 */
export async function loadProjectsForOverview(): Promise<void> {
  const api = getApi();
  if (!api?.project?.list) return;
  projectActions.loading = true;
  projectActions.error = null;
  try {
    projectActions.list =
      ((await withIpcReadyRetry(() => Promise.resolve(api.project.list({ includeArchived: true })))) as ProjectDTO[] | undefined) ?? [];
  } catch (error) {
    projectActions.list = [];
    projectActions.error = error instanceof Error ? error.message : String(error);
  } finally {
    projectActions.loading = false;
  }
}

/** 2026-10-25：在系统文件管理器中打开项目根目录（路径由主进程解析；失败显式）。 */
export async function openProjectDir(projectId: number): Promise<void> {
  const api = getApi();
  projectActions.message = null;
  projectActions.error = null;
  if (!api?.project?.openDir) {
    projectActions.error = '系统打开不可用（主进程未连接）';
    return;
  }
  try {
    const result = (await api.project.openDir({ projectId })) as { ok?: boolean; message?: string } | undefined;
    if (result?.ok === false) {
      projectActions.error = result.message ?? '打开目录失败';
      return;
    }
    projectActions.message = '已在系统文件管理器中打开项目目录';
  } catch (error) {
    projectActions.error = error instanceof Error ? error.message : String(error);
  }
}

/** B-1：拉当前项目的触发列表（项目概览·定时；失败如实进 `triggersError`）。 */
let triggersRequestSeq = 0;
export async function loadProjectTriggers(projectId: number): Promise<void> {
  const api = getApi();
  const seq = ++triggersRequestSeq;
  projectActions.triggersProjectId = projectId;
  projectActions.triggersLoading = true;
  projectActions.triggersError = null;
  if (!api?.project?.triggerManage) {
    projectActions.triggers = [];
    projectActions.triggersError = '触发通道不可用（主进程未连接）';
    projectActions.triggersLoading = false;
    return;
  }
  try {
    const res = (await api.project.triggerManage({ projectId, action: 'list' })) as
      | { ok: true; triggers?: TriggerDTO[] }
      | { ok: false; code?: string; message?: string }
      | undefined;
    // 切项目后旧响应晚到：丢弃，不把 A 的触发写进 B。
    if (seq !== triggersRequestSeq) return;
    if (res && res.ok === true) {
      projectActions.triggers = Array.isArray(res.triggers) ? res.triggers : [];
    } else {
      projectActions.triggers = [];
      projectActions.triggersError = res && res.ok === false ? (res.message ?? res.code ?? '读取触发失败') : '读取触发失败';
    }
  } catch (error) {
    if (seq !== triggersRequestSeq) return;
    projectActions.triggers = [];
    projectActions.triggersError = error instanceof Error ? error.message : String(error);
  } finally {
    if (seq === triggersRequestSeq) projectActions.triggersLoading = false;
  }
}

/** B-1：新建 cron 触发（项目概览·定时；与频道 `定时 …` 命令同源 TriggerService）。 */
export async function createProjectCronTrigger(input: {
  projectId: number;
  goal: string;
  intervalMinutes?: number;
  dailyMinute?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.triggerManage) return { ok: false, error: '触发通道不可用（主进程未连接）' };
  projectActions.triggerNotice = null;
  projectActions.triggersError = null;
  try {
    const res = (await api.project.triggerManage({ ...input, action: 'create-cron' })) as
      | { ok: true; trigger?: TriggerDTO }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (!res || res.ok !== true) {
      const error = res && res.ok === false ? (res.message ?? res.code ?? '创建触发失败') : '创建触发失败';
      projectActions.triggersError = error;
      return { ok: false, error };
    }
    projectActions.triggerNotice = res.trigger
      ? `已创建触发 #${res.trigger.id}：到点自动在本项目新建任务「${res.trigger.title}」`
      : '已创建触发';
    await loadProjectTriggers(input.projectId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectActions.triggersError = message;
    return { ok: false, error: message };
  }
}

/** B-1：新建事件触发（源任务完成后建新任务；与频道 `当 T1042 完成 …` 同源）。 */
export async function createProjectEventTrigger(input: {
  projectId: number;
  goal: string;
  sourceShortId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.triggerManage) return { ok: false, error: '触发通道不可用（主进程未连接）' };
  projectActions.triggerNotice = null;
  projectActions.triggersError = null;
  try {
    const res = (await api.project.triggerManage({ ...input, action: 'create-event' })) as
      | { ok: true; trigger?: TriggerDTO }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (!res || res.ok !== true) {
      const error = res && res.ok === false ? (res.message ?? res.code ?? '创建事件触发失败') : '创建事件触发失败';
      projectActions.triggersError = error;
      return { ok: false, error };
    }
    projectActions.triggerNotice = res.trigger
      ? `已创建事件触发 #${res.trigger.id}：源任务完成后自动新建任务「${res.trigger.title}」`
      : '已创建事件触发';
    await loadProjectTriggers(input.projectId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectActions.triggersError = message;
    return { ok: false, error: message };
  }
}

/** B-1：取消一个触发（项目边界由主进程校验；已触发/已取消 → 如实提示）。 */
export async function cancelProjectTrigger(
  projectId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.triggerManage) return { ok: false, error: '触发通道不可用（主进程未连接）' };
  projectActions.triggerNotice = null;
  projectActions.triggersError = null;
  try {
    const res = (await api.project.triggerManage({ projectId, action: 'cancel', id })) as
      | { ok: true; cancelled?: boolean }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (!res || res.ok !== true) {
      const error = res && res.ok === false ? (res.message ?? res.code ?? '取消触发失败') : '取消触发失败';
      projectActions.triggersError = error;
      return { ok: false, error };
    }
    projectActions.triggerNotice = res.cancelled ? `已取消触发 #${id}（不会再开新任务）` : `#${id} 已触发或已取消`;
    await loadProjectTriggers(projectId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectActions.triggersError = message;
    return { ok: false, error: message };
  }
}

/** 写操作已成功后的刷新：失败只告警，不把成功回执改成失败。 */
async function refreshProjectListsBestEffort(): Promise<void> {
  try {
    await Promise.all([loadProjectsForOverview(), loadTasks({ includeArchived: true })]);
  } catch (error) {
    console.warn('[store] 项目已变更但列表刷新失败：', error instanceof Error ? error.message : String(error));
  }
}

/** M2 尾：软件代建项目（项目树页「＋新建项目」；父目录由主进程 dialog 选，renderer 只给名字）。
 *  M3-DOC-1：`docsTemplate` 默认 true，主进程写 `.aico/docs` 骨架；false＝只建 README。 */
export async function createProject(
  name: string,
  docsTemplate = true,
): Promise<{ ok: true; project: ProjectDTO } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.create) return { ok: false, error: '项目通道不可用（主进程未连接）' };
  const res = (await api.project.create({ name, docsTemplate })) as
    | { ok: true; project: ProjectDTO }
    | { ok: false; code?: string; message?: string }
    | undefined;
  if (!res || res.ok !== true) {
    return { ok: false, error: res && res.ok === false ? (res.message ?? res.code ?? '新建项目失败') : '新建项目失败' };
  }
  try {
    await Promise.all([loadProjectsForOverview(), loadTasks({ includeArchived: true }), loadStaffingDefaults()]);
  } catch (error) {
    console.warn('[store] 项目已建但刷新失败：', error instanceof Error ? error.message : String(error));
  }
  showProject(res.project.id);
  return { ok: true, project: res.project };
}

/**
 * 验收后复查 A：设置/清空项目别名。空串→clear；成功后刷新项目列表与任务列表（`#别名` 解析同源）。
 */
export async function saveProjectAlias(
  projectId: number,
  alias: string | null,
): Promise<{ ok: true; project: ProjectDTO } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.aliasSet) return { ok: false, error: '项目通道不可用（主进程未连接）' };
  const res = (await api.project.aliasSet({ projectId, alias })) as
    | { ok: true; project: ProjectDTO }
    | { ok: false; code?: string; message?: string }
    | undefined;
  if (!res || res.ok !== true) {
    return { ok: false, error: res && res.ok === false ? (res.message ?? res.code ?? '保存别名失败') : '保存别名失败' };
  }
  await refreshProjectListsBestEffort();
  return { ok: true, project: res.project };
}

/** B-3：导出项目档案（单文件 JSON；删除前备份面）。 */
export async function exportProject(projectId: number): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.project?.export) return { ok: false, error: '导出通道不可用（主进程未连接）' };
  projectActions.message = null;
  projectActions.error = null;
  try {
    const res = (await api.project.export({ projectId })) as
      | { ok: true; path: string; bytes?: number }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (res && res.ok === true) {
      projectActions.message = `已导出项目档案：${res.path}`;
      return { ok: true, path: res.path };
    }
    const error = res && res.ok === false ? (res.message ?? res.code ?? '导出失败') : '导出失败';
    projectActions.error = `导出失败：${error}`;
    return { ok: false, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectActions.error = `导出失败：${message}`;
    return { ok: false, error: message };
  }
}

/** CR14：删除空归档项目（文件夹不动；非空/未归档由主进程显式拒）。B-3：删除前强制导出。 */
export async function deleteProject(projectId: number): Promise<boolean> {
  const api = getApi();
  if (!api?.project?.delete) return false;
  projectActions.message = null;
  projectActions.error = null;
  let ok = false;
  try {
    const backup = await exportProject(projectId);
    if (!backup.ok) {
      projectActions.error = `未删除：删除前导出失败（${backup.error}）`;
      return false;
    }
    const res = (await api.project.delete({ projectId })) as { ok?: boolean; code?: string; message?: string } | undefined;
    if (res && res.ok === false) {
      projectActions.error = `删除失败：${res.message ?? res.code ?? '未知'}`;
    } else {
      projectActions.message = `已删除项目 #${projectId}（只删空归档项目；文件夹未动）`;
      ok = true;
      if (session.selectedProjectId === projectId) session.selectedProjectId = null;
    }
  } catch (error) {
    projectActions.error = error instanceof Error ? error.message : String(error);
  }
  await refreshProjectListsBestEffort();
  return ok;
}

/** D-5 ③：归档一个项目（软操作；成功后刷新项目列表与左栏任务列表）。 */export async function archiveProject(
  projectId: number,
  mode: 'finish_all' | 'keep_paused' = 'keep_paused',
): Promise<boolean> {
  const api = getApi();
  if (!api?.project?.archive) return false;
  projectActions.message = null;
  projectActions.error = null;
  let ok = false;
  try {
    const res = (await api.project.archive({ projectId, mode })) as { ok?: boolean; code?: string; message?: string } | undefined;
    if (res && res.ok === false) {
      projectActions.error = `归档失败：${res.message ?? res.code ?? '未知'}`;
    } else {
      projectActions.message =
        mode === 'finish_all'
          ? `已归档项目 #${projectId}（未结束任务已全部结束；文件夹未动）`
          : `已归档项目 #${projectId}（活跃任务已暂停；文件夹未动）`;
      ok = true;
    }
  } catch (error) {
    projectActions.error = error instanceof Error ? error.message : String(error);
  }
  await refreshProjectListsBestEffort();
  return ok;
}

/** 撤销项目归档（同 `project:archive` 通道的 `{archived:false}`；触发不自动复活）。 */
export async function restoreProject(projectId: number): Promise<boolean> {
  const api = getApi();
  if (!api?.project?.archive) return false;
  projectActions.message = null;
  projectActions.error = null;
  let ok = false;
  try {
    const res = (await api.project.archive({ projectId, archived: false })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) {
      projectActions.error = `恢复失败：${res.message ?? res.code ?? '未知'}`;
    } else {
      projectActions.message = `已恢复项目 #${projectId}（归档时停用的触发需重新创建）`;
      ok = true;
    }
  } catch (error) {
    projectActions.error = error instanceof Error ? error.message : String(error);
  }
  await refreshProjectListsBestEffort();
  return ok;
}

/** R2-3：切到设置视图（左栏 `leftrail-settings`）。 */
export function showSettings(): void {
  session.view = 'settings';
  persistSession();
}

/** 2026-10-16（设置批）：「设置 · 员工」花名册（`employee:list` 真数据；null＝未加载）。 */
export const settingsEmployees = proxy<{
  list: Array<{ id: number; name: string; role: string; mcpRefs: string[]; active: boolean }> | null;
}>({ list: null });

export async function loadSettingsEmployees(): Promise<void> {
  const api = getApi();
  if (!api) return;
  // UG-11：花名册**含已停用**——否则停用后从列表消失，无法重新启用。
  const list = (await api.employee.list({ includeDisabled: true })) as
    | Array<{ id: number; name: string; role: string; mcpRefs?: string[]; active?: boolean }>
    | undefined;
  settingsEmployees.list = (list ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    mcpRefs: Array.isArray(e.mcpRefs) ? e.mcpRefs.map(String) : [],
    active: e.active !== false,
  }));
}

// ── GAP7（M3-N-3）：技能库（列表 / 安装 / 启停 / 删除）＋B3 项目默认技能集 ──────────

export const skillsLibrary = proxy({
  /** null＝未加载；[]＝真空（UI 显空态，不摆假行）。 */
  list: null as SkillDTO[] | null,
  loading: false,
  notice: null as string | null,
  error: null as string | null,
});

/** 技能库列表（含停用；安装/启停后重取，读数以主进程为准）。 */
export async function loadSkills(): Promise<void> {
  const api = getApi();
  if (!api?.skills?.list) return;
  skillsLibrary.loading = true;
  skillsLibrary.error = null;
  try {
    const list = (await api.skills.list({ includeDisabled: true })) as SkillDTO[] | undefined;
    skillsLibrary.list = list ?? [];
  } catch (error) {
    skillsLibrary.list = null;
    skillsLibrary.error = error instanceof Error ? error.message : String(error);
  } finally {
    skillsLibrary.loading = false;
  }
}

function installedNames(res: { installed?: unknown[] } | undefined): string {
  const rows = Array.isArray(res?.installed) ? res.installed : [];
  return rows
    .map((row) => (row && typeof row === 'object' && typeof (row as { name?: unknown }).name === 'string' ? String((row as { name: string }).name) : ''))
    .filter(Boolean)
    .join('、');
}

/** 从文件夹安装（主进程目录选择；路径不进 renderer）。 */
export async function installSkillFolder(): Promise<void> {
  const api = getApi();
  if (!api?.skills?.set) {
    skillsLibrary.error = '技能通道不可用（主进程未连接）';
    return;
  }
  try {
    const res = (await api.skills.set({ action: 'install-local' })) as
      | { ok?: boolean; installed?: unknown[]; errors?: string[]; code?: string; message?: string }
      | undefined;
    if (res?.ok !== true) {
      skillsLibrary.error = `安装未执行：${res?.message ?? res?.code ?? '未知'}`;
      return;
    }
    await loadSkills();
    const names = installedNames(res);
    skillsLibrary.notice = `已安装：${names || '（无）'}${res.errors && res.errors.length > 0 ? `；部分失败：${res.errors.join('；')}` : ''}`;
  } catch (error) {
    skillsLibrary.error = `安装失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 从 URL 安装（直接 .md 或 Git 仓库）。 */
export async function installSkillUrl(url: string): Promise<void> {
  const api = getApi();
  if (!api?.skills?.set) {
    skillsLibrary.error = '技能通道不可用（主进程未连接）';
    return;
  }
  try {
    const res = (await api.skills.set({ action: 'install-url', url })) as
      | { ok?: boolean; installed?: unknown[]; errors?: string[]; code?: string; message?: string }
      | undefined;
    if (res?.ok !== true) {
      skillsLibrary.error = `URL 安装未执行：${res?.message ?? res?.code ?? '未知'}`;
      return;
    }
    await loadSkills();
    const names = installedNames(res);
    skillsLibrary.notice = `已从 URL 安装：${names || '（无）'}${res.errors && res.errors.length > 0 ? `；部分失败：${res.errors.join('；')}` : ''}`;
  } catch (error) {
    skillsLibrary.error = `URL 安装失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 启停技能（内置也可停用；失败显式报错）。 */
export async function toggleSkill(id: number, enabled: boolean): Promise<void> {
  const api = getApi();
  if (!api?.skills?.set) return;
  const res = (await api.skills.set({ action: 'toggle', id, enabled })) as { ok?: boolean; code?: string; message?: string } | undefined;
  if (res?.ok !== true) {
    skillsLibrary.error = `启停失败：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  skillsLibrary.notice = `${enabled ? '已启用' : '已停用'}技能 #${id}`;
  await loadSkills();
}

/** 删除技能（内置/被引用 → 主进程拒；失败显式报错）。 */
export async function removeSkill(id: number): Promise<void> {
  const api = getApi();
  if (!api?.skills?.set) return;
  const res = (await api.skills.set({ action: 'remove', id })) as { ok?: boolean; removed?: string; code?: string; message?: string } | undefined;
  if (res?.ok !== true) {
    skillsLibrary.error = `删除未执行：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  skillsLibrary.notice = `已删除技能：${res.removed ?? `#${id}`}`;
  await loadSkills();
}

// ── GAP9（M3-N-5）：公司配置版本化（项目根 `.aico/company.json`） ────────────────

export interface CompanyDiffDTO {
  added: string[];
  updated: Array<{ name: string; changes: Record<string, { from: unknown; to: unknown }> }>;
  skipped: string[];
  unchanged: number;
  settings: { added: string[]; updated: string[]; unchanged: number };
  errors: string[];
}

export const companyConfig = proxy({
  busy: false,
  preview: null as {
    token: string;
    employees: number;
    settings: number;
    diff: CompanyDiffDTO;
  } | null,
  notice: null as string | null,
  error: null as string | null,
  errorList: [] as string[],
});

function companyActionError(res: { code?: string; message?: string; errors?: string[] } | undefined): string {
  companyConfig.errorList = Array.isArray(res?.errors) ? res.errors : [];
  return `公司配置：${res?.message ?? res?.code ?? '未知错误'}`;
}

/** 导出公司配置到 `<项目根>/.aico/company.json`。 */
export async function exportCompanyConfig(projectId: number): Promise<void> {
  const api = getApi();
  if (!api?.project?.companyConfig) {
    companyConfig.error = '公司配置通道不可用（主进程未连接）';
    return;
  }
  companyConfig.busy = true;
  companyConfig.error = null;
  companyConfig.errorList = [];
  try {
    const res = (await api.project.companyConfig({ projectId, action: 'export' })) as
      | { ok?: boolean; path?: string; employees?: number; settings?: number; code?: string; message?: string }
      | undefined;
    if (res?.ok !== true) {
      companyConfig.error = companyActionError(res);
      return;
    }
    companyConfig.notice = `已导出：${res.path}（${res.employees ?? 0} 员工 · ${res.settings ?? 0} 设置）`;
    companyConfig.preview = null;
  } catch (error) {
    companyConfig.error = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    companyConfig.busy = false;
  }
}

/** 只读预览：从项目根文件计算 diff，返回 token。 */
export async function previewCompanyConfig(projectId: number): Promise<void> {
  const api = getApi();
  if (!api?.project?.companyConfig) {
    companyConfig.error = '公司配置通道不可用（主进程未连接）';
    return;
  }
  companyConfig.busy = true;
  companyConfig.error = null;
  companyConfig.errorList = [];
  companyConfig.preview = null;
  try {
    const res = (await api.project.companyConfig({ projectId, action: 'preview' })) as
      | {
          ok?: boolean;
          token?: string;
          employees?: number;
          settings?: number;
          diff?: CompanyDiffDTO;
          code?: string;
          message?: string;
          errors?: string[];
        }
      | undefined;
    if (res?.ok !== true || typeof res.token !== 'string' || !res.diff) {
      companyConfig.error = companyActionError(res);
      return;
    }
    companyConfig.preview = {
      token: res.token,
      employees: res.employees ?? 0,
      settings: res.settings ?? 0,
      diff: res.diff,
    };
    companyConfig.notice = '已生成预览（未写库）';
  } catch (error) {
    companyConfig.error = `预览失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    companyConfig.busy = false;
  }
}

/** 应用预览（token 防过期）；成功后刷新员工/编制读数。 */
export async function applyCompanyConfig(projectId: number): Promise<void> {
  const api = getApi();
  const preview = companyConfig.preview;
  if (!api?.project?.companyConfig || !preview) {
    companyConfig.error = '没有可应用的预览（先「预览导入」）';
    return;
  }
  companyConfig.busy = true;
  companyConfig.error = null;
  companyConfig.errorList = [];
  try {
    const res = (await api.project.companyConfig({ projectId, action: 'apply', token: preview.token })) as
      | {
          ok?: boolean;
          applied?: { added: string[]; updated: string[]; skipped: string[]; settings: string[] };
          code?: string;
          message?: string;
          errors?: string[];
        }
      | undefined;
    if (res?.ok !== true) {
      companyConfig.error = companyActionError(res);
      return;
    }
    const a = res.applied;
    companyConfig.notice = `已应用：新增 ${a?.added.length ?? 0}、更新 ${a?.updated.length ?? 0}、跳过 ${a?.skipped.length ?? 0}；设置 ${a?.settings.length ?? 0} 项（模型/调度下次装配生效）`;
    companyConfig.preview = null;
    await Promise.all([loadSettingsEmployees(), loadStaffingDefaults()]);
    await loadSettingsView();
  } catch (error) {
    companyConfig.error = `应用失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    companyConfig.busy = false;
  }
}

/** 回滚到 apply 前的 `.aico/company.backup.json`。 */
export async function rollbackCompanyConfig(projectId: number): Promise<void> {
  const api = getApi();
  if (!api?.project?.companyConfig) {
    companyConfig.error = '公司配置通道不可用（主进程未连接）';
    return;
  }
  companyConfig.busy = true;
  companyConfig.error = null;
  companyConfig.errorList = [];
  try {
    const res = (await api.project.companyConfig({ projectId, action: 'rollback' })) as
      | {
          ok?: boolean;
          applied?: { added: string[]; updated: string[]; removed?: string[]; deactivated?: string[] };
          code?: string;
          message?: string;
          errors?: string[];
        }
      | undefined;
    if (res?.ok !== true) {
      companyConfig.error = companyActionError(res);
      return;
    }
    companyConfig.notice =
      `已回滚配置：更新 ${res.applied?.updated.length ?? 0}` +
      `、撤销新增 ${res.applied?.removed?.length ?? 0}` +
      (res.applied?.deactivated && res.applied.deactivated.length > 0
        ? `、有引用改停用 ${res.applied.deactivated.length}`
        : '');
    companyConfig.preview = null;
    await Promise.all([loadSettingsEmployees(), loadStaffingDefaults()]);
    await loadSettingsView();
  } catch (error) {
    companyConfig.error = `回滚失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    companyConfig.busy = false;
  }
}

// ── GAP6（M3-N-4）：MCP server 库（列表/注册/启停/删除；env 值只在主进程） ──────────

export const mcpLibrary = proxy({
  list: null as McpServerDTO[] | null,
  loading: false,
  notice: null as string | null,
  error: null as string | null,
});

export async function loadMcpServers(): Promise<void> {
  const api = getApi();
  if (!api?.mcp?.list) return;
  mcpLibrary.loading = true;
  mcpLibrary.error = null;
  try {
    const list = (await api.mcp.list({ includeDisabled: true })) as McpServerDTO[] | undefined;
    mcpLibrary.list = list ?? [];
  } catch (error) {
    mcpLibrary.list = null;
    mcpLibrary.error = error instanceof Error ? error.message : String(error);
  } finally {
    mcpLibrary.loading = false;
  }
}

export async function saveMcpServer(input: {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  exposure?: string;
  hasExternalActions?: boolean;
  enabled?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.mcp?.set) return { ok: false, error: 'MCP 通道不可用（主进程未连接）' };
  const res = (await api.mcp.set(input)) as { ok?: boolean; code?: string; message?: string } | undefined;
  if (res?.ok !== true) return { ok: false, error: res?.message ?? res?.code ?? '保存失败' };
  await loadMcpServers();
  mcpLibrary.notice = `已保存 MCP server：${input.name}`;
  return { ok: true };
}

export async function toggleMcpServer(id: number, enabled: boolean): Promise<void> {
  const api = getApi();
  if (!api?.mcp?.set) return;
  const res = (await api.mcp.set({ action: 'toggle', id, enabled })) as { ok?: boolean; code?: string; message?: string } | undefined;
  if (res?.ok !== true) {
    mcpLibrary.error = `启停失败：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  mcpLibrary.notice = `${enabled ? '已启用' : '已停用'} MCP server #${id}`;
  await loadMcpServers();
}

export async function removeMcpServer(id: number): Promise<void> {
  const api = getApi();
  if (!api?.mcp?.set) return;
  const res = (await api.mcp.set({ action: 'remove', id })) as { ok?: boolean; removed?: string; code?: string; message?: string } | undefined;
  if (res?.ok !== true) {
    mcpLibrary.error = `删除未执行：${res?.message ?? res?.code ?? '未知'}`;
    return;
  }
  mcpLibrary.notice = `已删除 MCP server：${res.removed ?? `#${id}`}`;
  await loadMcpServers();
}

/** B3：写项目默认技能集（refs＝技能名/id；主进程校验后落库）。 */
export async function saveProjectDefaultSkills(
  projectId: number,
  refs: string[],
): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.skillsSet) return { ok: false, error: '项目技能通道不可用（主进程未连接）' };
  const res = (await api.project.skillsSet({ projectId, refs })) as
    | { ok?: boolean; code?: string; message?: string }
    | undefined;
  if (res?.ok !== true) return { ok: false, error: res?.message ?? res?.code ?? '保存失败' };
  await loadProjectsForOverview();
  return { ok: true };
}

/** M2 尾：招募员工（设置 · 员工「＋招募」；成功刷新花名册/编制下拉）。 */
export async function recruitEmployee(input: {
  name: string;
  role: string;
  persona?: string;
  model?: string | null;
  thinking?: string | null;
  capabilityTier?: string;
}): Promise<{ ok: true; employee: EmployeeDetailDTO } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.employee?.recruit) return { ok: false, error: '员工通道不可用（主进程未连接）' };
  const res = (await api.employee.recruit(input)) as
    | { ok: true; employee: EmployeeDetailDTO }
    | { ok: false; code?: string; message?: string }
    | undefined;
  if (!res || res.ok !== true) {
    return { ok: false, error: res && res.ok === false ? (res.message ?? res.code ?? '招募失败') : '招募失败' };
  }
  await Promise.all([loadSettingsEmployees(), loadStaffingDefaults()]);
  return { ok: true, employee: res.employee };
}

/** M2 尾：改员工档案（设置 · 员工「配置 ▸」；人设/模型/思考强度/停用）。 */
export async function updateEmployee(input: {
  employeeId: number;
  name?: string;
  role?: string;
  persona?: string;
  model?: string | null;
  thinking?: string | null;
  skills?: Array<string | number>;
  mcps?: Array<string | number>;
  capabilityTier?: string;
  active?: boolean;
}): Promise<{ ok: true; employee: EmployeeDetailDTO } | { ok: false; error: string }> {
  const api = getApi();
  if (!api?.employee?.update) return { ok: false, error: '员工通道不可用（主进程未连接）' };
  const res = (await api.employee.update(input)) as
    | { ok: true; employee: EmployeeDetailDTO }
    | { ok: false; code?: string; message?: string }
    | undefined;
  if (!res || res.ok !== true) {
    return { ok: false, error: res && res.ok === false ? (res.message ?? res.code ?? '保存失败') : '保存失败' };
  }
  workstation.data = res.employee;
  await Promise.all([loadSettingsEmployees(), loadStaffingDefaults()]);
  return { ok: true, employee: res.employee };
}

// ── 编制 v1（D-11）：项目三项缺省（默认负责人 / 默认执行员工 / 默认档）──────────────────

/**
 * 编制员工名（下拉/摘要共用）。预填值**不落全局**：由 `loadStaffingDefaults()` 每次返回，
 * 建任务对话框用本地 `prefill` 消费；避免上一个项目/晚到请求串进当前对话框。
 */
export const staffingDefaults = proxy({
  employees: [] as Array<{ id: number; name: string }>,
});

export interface StaffingDefaultsResult {
  projectId: number | null;
  ownerEmployeeId: number | null;
  defaultRiskTier: 0 | 1 | 2 | null;
}

const EMPTY_STAFFING_DEFAULTS: StaffingDefaultsResult = {
  projectId: null,
  ownerEmployeeId: null,
  defaultRiskTier: null,
};

export async function loadStaffingDefaults(
  explicitProjectId: number | null = null,
): Promise<StaffingDefaultsResult> {
  const api = getApi();
  if (!api?.project?.list) return EMPTY_STAFFING_DEFAULTS;
  let result: StaffingDefaultsResult = { ...EMPTY_STAFFING_DEFAULTS };
  try {
    const projects =
      projectActions.list.length > 0
        ? projectActions.list
        : (((await api.project.list({ includeArchived: true })) as ProjectDTO[] | undefined) ?? []);
    // 落点判定：对话框显式项目优先；否则只认 active 默认项目（与主进程 getDefaultProject 同口径）。
    let defaultProjectId: number | null = null;
    if (explicitProjectId == null) {
      const defRes = api.settings?.get
        ? ((await api.settings.get({ key: 'projects.default_id' })) as { value?: unknown } | undefined)
        : undefined;
      if (typeof defRes?.value === 'number') defaultProjectId = defRes.value;
    }
    const picked = resolveStaffingProject(projects, explicitProjectId, defaultProjectId);
    const pid = picked.projectId;
    let project = picked.project;
    const employees = ((await api.employee?.list?.()) as EmployeeDTO[] | undefined) ?? [];
    // 编制只列执行员工：幕僚长只协调，不参与执行/负责人兜底（D-20）。
    staffingDefaults.employees = employees
      .filter((e) => e.isAssistant !== true)
      .map((e) => ({ id: e.id, name: e.name }));
    // 项目列表可能是旧快照；显式项目找不到时用 project:get 真读一次（不猜默认项目）。
    if (pid != null && !project && api.project?.get) {
      project = ((await api.project.get({ projectId: pid })) as ProjectDTO | undefined) ?? null;
    }
    const ownerEmployeeId = typeof project?.defaultOwnerId === 'number' ? project.defaultOwnerId : null;
    const defaultRiskTier =
      project?.defaultRiskTier === 0 || project?.defaultRiskTier === 1 || project?.defaultRiskTier === 2
        ? project.defaultRiskTier
        : null;
    result = { projectId: pid, ownerEmployeeId, defaultRiskTier };
  } catch {
    result = { ...EMPTY_STAFFING_DEFAULTS };
  }
  return result;
}

/**
 * 编制 v1：保存项目三项缺省（写 `project:staffing-set`；**只影响之后派发的工作项；已派发不变**）。
 * 成功 → 刷新项目列表（概览卡/设置页读同一份）与建任务对话框预填源；失败 → 回执（不静默）。
 */
export async function saveProjectStaffing(
  projectId: number,
  patch: { ownerEmployeeId: number | null; defaultEmployeeId: number | null; defaultRiskTier: 0 | 1 | 2 | null },
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const api = getApi();
  if (!api?.project?.staffingSet) return { ok: false, error: '未连接主进程' };
  projectActions.message = null;
  projectActions.error = null;
  try {
    const res = (await api.project.staffingSet({ projectId, ...patch })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) return { ok: false, error: `保存失败：${res.message ?? res.code ?? '未知'}` };
    projectActions.message = '编制已保存（只影响之后派发；已派发不变）';
    await loadProjectsForOverview();
    void loadStaffingDefaults();
    return { ok: true, message: projectActions.message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * D-22：保存项目模型策略（设置·模型与员工）。
 * 成功 → 刷新设置页项目 DTO（读面仍走 `project:get/list`）；失败 → 人话回执（不静默）。
 */
export async function saveProjectModelPolicy(input: {
  projectId: number;
  policy: 'fixed' | 'employee_first' | 'assistant';
  defaultModel: string | null;
  allowedModels: string[];
}): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.modelPolicySet) return { ok: false, error: '未连接主进程' };
  settingsView.error = null;
  settingsView.saved = null;
  try {
    const res = (await api.project.modelPolicySet(input)) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) {
      const error = `保存项目模型失败：${res.message ?? res.code ?? '未知'}`;
      settingsView.error = error;
      return { ok: false, error };
    }
    settingsView.saved = '项目模型策略已保存（只影响之后的员工会话）';
    await loadSettingsView();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settingsView.error = `保存项目模型失败：${message}`;
    return { ok: false, error: message };
  }
}

/** v19：保存项目默认任务预算（NULL＝不限；只影响之后新建且未显式给预算的任务）。 */
export async function saveProjectDefaultBudget(
  projectId: number,
  budgetTokens: number | null,
): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.defaultBudgetSet) return { ok: false, error: '未连接主进程' };
  settingsView.error = null;
  settingsView.saved = null;
  try {
    const res = (await api.project.defaultBudgetSet({ projectId, budgetTokens })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) {
      const error = `保存项目默认预算失败：${res.message ?? res.code ?? '未知'}`;
      settingsView.error = error;
      return { ok: false, error };
    }
    settingsView.saved = '项目默认任务预算已保存（只影响之后新建且未填预算的任务）';
    await loadSettingsView();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settingsView.error = `保存项目默认预算失败：${message}`;
    return { ok: false, error: message };
  }
}

/** S13-G/D-N06：保存项目合并目标分支（null/空串 ⇒ 回到 main/master）。 */
export async function saveProjectTargetBranch(
  projectId: number,
  branch: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.targetBranchSet) return { ok: false, error: '未连接主进程' };
  settingsView.error = null;
  settingsView.saved = null;
  try {
    const res = (await api.project.targetBranchSet({ projectId, branch })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) {
      const error = `保存合并目标分支失败：${res.message ?? res.code ?? '未知'}`;
      settingsView.error = error;
      return { ok: false, error };
    }
    settingsView.saved = branch ? `合并目标分支已设为 ${branch}` : '合并目标分支已清空（沿用 main/master）';
    await loadSettingsView();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settingsView.error = `保存合并目标分支失败：${message}`;
    return { ok: false, error: message };
  }
}

/**
 * M3-DOC-4：保存项目「任务验收默认挂文档检查」开关。
 * 成功 → 刷新项目 DTO；失败 → 回执（不静默）。
 */
export async function saveProjectDocsCheck(projectId: number, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.docsCheckSet) return { ok: false, error: '未连接主进程' };
  projectActions.message = null;
  projectActions.error = null;
  try {
    const res = (await api.project.docsCheckSet({ projectId, enabled })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) return { ok: false, error: `保存失败：${res.message ?? res.code ?? '未知'}` };
    projectActions.message = enabled ? '文档检查：新任务默认开启' : '文档检查：新任务默认关闭';
    await loadProjectsForOverview();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** D-19 P1：项目级频道助手写权限（read-only/confirm/auto；保存后以 project:list 真值为准）。 */
export async function saveProjectAssistantWriteMode(
  projectId: number,
  mode: 'read-only' | 'confirm' | 'auto',
): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.assistantWriteModeSet) return { ok: false, error: '未连接主进程' };
  projectActions.message = null;
  projectActions.error = null;
  try {
    const res = (await api.project.assistantWriteModeSet({ projectId, mode })) as
      | { ok?: boolean; code?: string; message?: string }
      | undefined;
    if (res && res.ok === false) return { ok: false, error: `保存失败：${res.message ?? res.code ?? '未知'}` };
    projectActions.message =
      mode === 'read-only'
        ? '频道助手：只读'
        : mode === 'auto'
          ? '频道助手：项目内自主（写操作留审计）'
          : '频道助手：写前确认';
    await loadProjectsForOverview();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── R2-4：首次启动向导（`onboarding.completed` 真读者：读它决定显示；完成/跳过写 true）────

/** 向导状态机（`unknown` → `show`/`done`；`show` 时预取名册与默认模型现值）。 */
export const onboarding = proxy<{
  state: 'unknown' | 'show' | 'done';
  model: string | null;
  employees: Array<{ id: number; name: string; role: string }>;
  /** 首启一屏：是否已接入项目（决定主按钮「选择文件夹…」还是「开始使用」）。 */
  projectAttached: boolean;
  attach: { status: 'idle' | 'busy'; note: string | null; error: string | null };
}>({ state: 'unknown', model: null, employees: [], projectAttached: false, attach: { status: 'idle', note: null, error: null } });

/** 读 `onboarding.completed`；返回 true＝已完成，false＝确证未完成，null＝读取失败（口径不明）。 */
async function readOnboardingCompleted(): Promise<boolean | null> {
  try {
    const api = getApi();
    const res = (await api?.settings.get({ key: 'onboarding.completed' })) as { value?: unknown } | undefined;
    return res?.value === true;
  } catch {
    return null;
  }
}

/** R2-4：读首启状态（未完成 → 显示向导；顺带预取「默认模型现值 + 员工名册」）。 */
export async function loadOnboarding(): Promise<void> {
  const api = getApi();
  if (!api?.settings) return;
  // RW-11（M5 真机偶发，S6 批登记）：已完成用户遇一次读失败就被打回向导＝打扰。
  // 口径：确证未完成才 show；读失败重试一次，仍失败保持 unknown（本启动不弹向导，下次启动自然再读）。
  let completed = await readOnboardingCompleted();
  if (completed === null) completed = await readOnboardingCompleted();
  onboarding.state = completed === false ? 'show' : completed === true ? 'done' : 'unknown';
  if (onboarding.state !== 'show') return;
  try {
    const model = pickSettingValue(await api.settings.get({ key: 'models.default' }));
    onboarding.model = typeof model === 'string' && model.trim().length > 0 ? model : null;
    onboarding.employees =
      ((await api.employee.list()) as Array<{ id: number; name: string; role: string }> | undefined) ?? [];
  } catch {
    // 预取失败不拦向导（字段留空即可，向导页自会显空态）
  }
}

/** R2-4：完成/跳过向导（写 `onboarding.completed=true`；**写失败不关闭**——不假装完成）。 */
export async function finishOnboarding(): Promise<void> {
  const api = getApi();
  if (!api?.settings) return;
  const res = (await api.settings.set({ key: 'onboarding.completed', value: true })) as { ok?: boolean; message?: string } | undefined;
  if (res && res.ok === false) {
    onboarding.attach.error = `保存失败：${res.message ?? 'onboarding.completed'}`;
    return;
  }
  onboarding.attach.error = null;
  onboarding.state = 'done';
}

/** R2-4：关联已有文件夹（**主进程 dialog 选目录**；探测结果如实回显——真事实，不美化）。 */
/**
 * S13-E P1/D-N02：项目页「接入已有文件夹」——复用首启同一条 `project:attach`（主进程原生选目录）。
 * 成功后把频道范围切到该项目、刷新项目列表，并选中它（与首启接入同口径）。
 */
export async function attachExistingProject(): Promise<{ ok: boolean; error?: string }> {
  const api = getApi();
  if (!api?.project?.attach) return { ok: false, error: '主进程未连接' };
  try {
    const res = (await api.project.attach()) as
      | { ok: true; project: ProjectDTO }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (!res || res.ok !== true) {
      const code = (res as { code?: string } | undefined)?.code;
      if (code === 'cancelled') return { ok: false, error: '' };
      return { ok: false, error: (res as { message?: string } | undefined)?.message ?? '接入失败' };
    }
    session.selectedProjectId = res.project.id;
    persistSession();
    void getApi()?.settings.set({ key: 'channel.scope_project_id', value: res.project.id }).catch(() => {
      /* 落库失败不拦接入 */
    });
    await refreshProjectListsBestEffort();
    showProject(res.project.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function attachProject(): Promise<void> {
  const api = getApi();
  if (!api?.project?.attach) return;
  onboarding.attach.status = 'busy';
  onboarding.attach.error = null;
  try {
    const res = (await api.project.attach()) as
      | {
          ok: true;
          project: ProjectDTO;
          probe: { hasGit: boolean; hasPackageJson: boolean; hasPyproject: boolean; suggestedCheck: string | null };
        }
      | { ok: false; code?: string; message?: string }
      | undefined;
    if (!res || res.ok !== true) {
      if ((res as { code?: string } | undefined)?.code === 'cancelled') {
        onboarding.attach.note = '已取消（未选目录）——可稍后在设置里接入';
        return;
      }
      onboarding.attach.error = (res as { message?: string } | undefined)?.message ?? '接入失败';
      return;
    }
    const p = res.probe;
    const kind = p.hasPackageJson
      ? 'Node/JS 项目（package.json）'
      : p.hasPyproject
        ? 'Python 项目（pyproject.toml）'
        : '（未识别到 Node/Python 标记）';
    onboarding.projectAttached = true;
    onboarding.attach.note =
      `已接入「${res.project.name}」（${res.project.rootDir}）：${kind} · ` +
      (p.hasGit ? 'git ✓（原地模式：每任务一分支）' : '无 git（沙盒模式）') +
      ' · ' +
      (p.suggestedCheck ? `建议验证命令：${p.suggestedCheck}` : '未找到可跑命令（建议第一个任务＝先搭测试底座）');
    // P0/V3（S13-E 对抗审查）：首启接入后频道范围要跟着切到该项目，
    // 否则助手自称「没有绑定项目、动不了文件」，与刚选完文件夹自相矛盾。
    session.selectedProjectId = res.project.id;
    persistSession();
    void getApi()?.settings.set({ key: 'channel.scope_project_id', value: res.project.id }).catch(() => {
      /* 落库失败不拦接入（范围仍在本会话生效） */
    });
    void loadSettingsView(); // 设置页「项目」列表同源刷新
  } finally {
    onboarding.attach.status = 'idle';
  }
}

// ── 自动更新（2026-11-06）────────────────────────────────────────────────
/** `update:get`/`update:status` 的形状（主进程 update.ts 的 UpdateStatus）。 */
export interface AppUpdateStatus {
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error';
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message: string;
  canCheck: boolean;
  canInstall: boolean;
  checkedAt?: number;
}

export const appUpdate = proxy({
  status: null as AppUpdateStatus | null,
  busy: false,
  error: null as string | null,
});

export async function loadAppUpdateStatus(): Promise<void> {
  try {
    const r = (await window.api?.update?.get()) as AppUpdateStatus | null | undefined;
    if (r != null) appUpdate.status = r;
  } catch {
    appUpdate.status = null;
  }
}

export async function checkAppUpdate(): Promise<void> {
  if (appUpdate.busy) return;
  appUpdate.busy = true;
  appUpdate.error = null;
  try {
    const r = (await window.api?.update?.check()) as AppUpdateStatus | null | undefined;
    if (r != null) appUpdate.status = r;
  } catch (error) {
    appUpdate.error = error instanceof Error ? error.message : String(error);
  } finally {
    appUpdate.busy = false;
  }
}

export async function installAppUpdate(): Promise<void> {
  appUpdate.error = null;
  try {
    const r = (await window.api?.update?.install()) as { ok?: boolean; error?: string } | undefined;
    if (r?.ok === false) appUpdate.error = r.error ?? '重启安装失败';
  } catch (error) {
    appUpdate.error = error instanceof Error ? error.message : String(error);
  }
}

export function subscribeAppUpdateStatus(): Unsubscribe | null {
  return window.api?.update?.onStatus((status) => {
    if (status != null) appUpdate.status = status as AppUpdateStatus;
  }) ?? null;
}

// ── UI-2 项目页：行下展开状态（深链可写；同一时间只展开一行）─────────────
export const projectPage = proxy({ expandedTaskId: null as number | null });

/** 展开某任务行（先收起旧的；加载详情但不切视图）。 */
export async function expandTaskRow(taskId: number): Promise<void> {
  const prev = projectPage.expandedTaskId;
  projectPage.expandedTaskId = taskId;
  if (prev !== taskId) await expandTaskInline(taskId);
}

/** 收起当前展开行（Esc / 再点同行）。 */
export function collapseTaskRow(): void {
  if (projectPage.expandedTaskId == null) return;
  projectPage.expandedTaskId = null;
  collapseTaskInline();
}
