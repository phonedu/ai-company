/**
 * 归属解析器（resolver）—— 桌面与 IM 共用同一套逻辑（PLAN §14.3）。
 *
 * 目标：把一条入站消息按【固定优先级的链条】归属到
 *   任务 / 待办序号 / 项目 / 命令 / 新任务 / 闲聊，命中即停。
 *
 * 优先级链（前面的永远赢，这是"多项目不串台"的关键）：
 *   0. 文本命令（严格文法直通，不调用 LLM）
 *   1. 显式任务地址 #T1042
 *   2. 待办列表序号回复（"列表"推送之后的 1/2/3）
 *   3. 回复链：回复了某条推送 → outbound_refs 精确归位
 *   4. 项目别名 #记账（项目级寻址，需语义区分 查询/新任务）
 *   5. sticky 焦点：会话焦点任务 + 15 分钟窗口（仅"工作性消息"更新焦点）
 *   6. 语义归位：classify 给出 taskId 且置信度 ≥ 0.8
 *   7. 兜底：按 intent 分派（查询/闲聊/新任务）；模糊时 confirm —— 只问一次
 *
 * 两个不变式：
 *   * 本函数【不创建任何对象】（new_task / confirm 只是决议，创建由编排器执行）；
 *   * classify（LLM）只提供"语义信号"，最终归属由链条顺序决定 ——
 *     所以"回复旧卡片"永远优先于"当前焦点"（PLAN §14.5 用例①）。
 *
 * confirm 的"只问一次"由编排器落地：把 options 登记为 pending list（`setPendingList`），
 * 用户回序号后走第 2 步精确解析（选项带 `then` 时直通该决议），不会二次追问。
 */

import { extractProjectAlias, extractTaskRef, parseTaskRef } from './short-id.js';
import type { TaskSnapshot, TaskState } from './types.js';

export interface Inbound {
  /** 'desktop' | 'im:wechat' | 'im:qq' | ... */
  source: string;
  /** 平台会话（私聊/群）；desktop 可用固定值如 'desktop:boss' */
  conversationRef: string | null;
  platformMsgId: string | null;
  /** 回复/引用某条推送时的消息 id（回复链锚点） */
  replyToMsgId: string | null;
  text: string;
  /** epoch ms */
  receivedAt: number;
}

export interface ProjectRef {
  id: number;
  name: string;
}

export interface ConversationState {
  kind: 'private' | 'group';
  projectId: number | null;
  /** sticky 焦点任务（只被工作性消息更新） */
  focusTaskId: number | null;
  focusUpdatedAt: number | null;
}

export interface PendingList {
  messageRef: string;
  createdAt: number;
  items: Array<{
    index: number;
    /** 归属候选任务（`then.kind==='task_message'` 时非空；其余选项可为 null）。 */
    taskId: number | null;
    reportId: number | null;
    /**
     * 该选项的完整决议（编排器登记时写入）。序号回复 = **第 2 步精确解析**：
     * `then` 非 task_message 时**直通该决议**（「新建任务/闲聊」这类选项也能被序号命中，
     * 「只问一次」不落空）；task_message / 历史无 then 行仍走 `pending_answer`（保留 report 关联语义）。
     */
    then?: Resolution;
  }>;
}

/** 存储接口：实现层 = better-sqlite3；测试层 = 内存假实现。 */
export interface ResolverStore {
  getConversation(channel: string, conversationRef: string): ConversationState | null;
  setFocus(channel: string, conversationRef: string, taskId: number, at: number): void;
  findOutboundRef(
    channel: string,
    platformMsgId: string,
  ): { taskId: number; reportId: number | null } | null;
  getTaskByShortId(shortId: string): TaskSnapshot | null;
  /** 任意状态（含终态）；终态任务在回复链场景仍需要能取到 */
  getTaskById(id: number): TaskSnapshot | null;
  getRecentActiveTasks(limit: number): TaskSnapshot[];
  getProjectByAlias(alias: string): ProjectRef | null;
  getDefaultProject(): ProjectRef | null;
  getPendingList(channel: string, conversationRef: string): PendingList | null;
  /**
   * 登记「只问一次」的候选清单（编排器在 `confirm` 裁定时调用；覆盖式写入——同一会话只留最新一份）。
   * 实现层 = `pending_lists` 表（`UNIQUE(channel, conversation_ref)`；见 `DEV §7`）。
   */
  setPendingList(
    channel: string,
    conversationRef: string,
    list: { messageRef: string; items: PendingList['items']; ttlMs?: number },
  ): void;
  clearPendingList(channel: string, conversationRef: string): void;
}

export interface SemanticSignal {
  intent: 'work' | 'query' | 'chat' | 'command' | 'new_task';
  taskId?: number;
  projectId?: number;
  /** 0..1 */
  confidence: number;
  titleGuess?: string;
}

export type Classify = (inbound: Inbound) => Promise<SemanticSignal>;

export type CommandName =
  | 'list'
  | 'daily'
  | 'pause'
  | 'resume'
  | 'archive'
  | 'finish' // 结束任务（桌面/IM 都先走确认卡，见 docs/FLOWS.md F5）
  | 'renew'; // 续办：为终态任务创建引用它的新任务（docs/FLOWS.md F6）

export type Resolution =
  | {
      kind: 'task_message';
      taskId: number;
      via: 'address' | 'reply' | 'focus' | 'semantic';
      updatesFocus: boolean;
    }
  | {
      kind: 'pending_answer';
      messageRef: string;
      index: number;
      taskId: number;
      reportId: number | null;
    }
  | { kind: 'command'; name: CommandName; taskId?: number }
  | { kind: 'query'; projectId: number | null; taskId: number | null; via: 'address' | 'semantic' }
  | {
      kind: 'new_task';
      projectId: number | null;
      confidence: number;
      titleGuess: string | null;
      via: 'address' | 'semantic' | 'default';
    }
  | { kind: 'chat'; /** B2-2：assistant 模式下别名寻址解析出的项目随消息带给幕僚长（缺省无） */ projectId?: number | null }
  | {
      kind: 'confirm';
      question: string;
      options: Array<{ index: number; label: string; then: Resolution }>;
    };

export const FOCUS_TTL_MS = 15 * 60 * 1000;
export const SEMANTIC_THRESHOLD = 0.8;

// ─────────────────────────────── 命令解析 ───────────────────────────────

interface ParsedCommand {
  name: CommandName;
  needsTask: boolean;
  ref: string | null;
}

// 文法故意收紧：只允许「命令词 + 可选任务短号 + 可选句末标点」。
// 「暂停一下这个想法」这类自然语言不该被直通成命令——让它落到语义分类 + 兜底确认，
// 避免"只是想聊聊"却把某个任务真暂停了。
const COMMAND_PATTERNS: Array<{ name: CommandName; needsTask: boolean; re: RegExp }> = [
  { name: 'list', needsTask: false, re: /^\s*(列表|待办|list)\s*[?？]?\s*$/i },
  { name: 'daily', needsTask: false, re: /^\s*(日报|daily)\s*[?？]?\s*$/i },
  { name: 'pause', needsTask: true, re: /^\s*暂停\s*(T-?\d{3,})?\s*[。！!]?\s*$/i },
  { name: 'resume', needsTask: true, re: /^\s*继续\s*(T-?\d{3,})?\s*[。！!]?\s*$/i },
  { name: 'archive', needsTask: true, re: /^\s*归档\s*(T-?\d{3,})?\s*[。！!]?\s*$/i },
  // 注意：命令词必须用非捕获组 (?:…)，保证 group 1 始终是任务短号
  { name: 'finish', needsTask: true, re: /^\s*(?:结束|完成)\s*(T-?\d{3,})?\s*[。！!]?\s*$/i },
  { name: 'renew', needsTask: true, re: /^\s*(?:重开|续办)\s*(T-?\d{3,})?\s*[。！!]?\s*$/i },
];

/** 严格文法（整条匹配、极短）→ 高置信，直通不烧 token。 */
/**
 * T8b/RW-48（2026-11-05）：显式建任务前缀直通。
 * 背景：语义分类器缺位（defaultClassify 一律 'chat'），「建任务：/派任务：」开头的
 * 高置信意图被退化成闲聊——频道/IM 自由文本派任务整条链失效（真机 T8b 实证）。
 * 本解析器＝确定性兜底：不改语义路由，只认 显式前缀。
 */
export interface CreateTaskDirective {
  /** 前缀后的任务目标（原话，含落点等细节） */
  goal: string;
  /** 开头的 #别名（无则 null；归属由调用方按 别名→上下文→默认 解析） */
  alias: string | null;
}

export function parseCreateTaskDirective(text: string): CreateTaskDirective | null {
  const m = /^\s*(?:#([^\s#：:,，]+)\s*)?(?:建任务|派任务)\s*[：:,，、]?\s*(\S[\s\S]*)$/.exec(text);
  if (!m) return null;
  const goal = m[2].trim();
  if (goal.length === 0) return null;
  return { goal, alias: m[1] ?? null };
}

export function parseCommand(text: string): ParsedCommand | null {
  for (const p of COMMAND_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const ref = p.needsTask ? parseTaskRef(m[1] ?? '') : null;
    return { name: p.name, needsTask: p.needsTask, ref };
  }
  return null;
}

// ─────────────────────────────── 主入口 ───────────────────────────────

export async function resolveInbound(
  inbound: Inbound,
  store: ResolverStore,
  classify: Classify,
): Promise<Resolution> {
  const channel = inbound.source;
  const convRef = inbound.conversationRef;
  const convo = convRef ? store.getConversation(channel, convRef) : null;

  // classify 是异步且可能花钱的：只有链条走到需要"语义信号"时才调用一次。
  let signalCache: SemanticSignal | null = null;
  const signal = async (): Promise<SemanticSignal> => {
    signalCache ??= await classify(inbound);
    return signalCache;
  };

  // ── 0. 文本命令：严格文法直通 ─────────────────────────────────────
  const cmd = parseCommand(inbound.text);
  if (cmd) {
    if (!cmd.needsTask) return { kind: 'command', name: cmd.name };
    const taskId = cmd.ref
      ? (store.getTaskByShortId(cmd.ref)?.id ?? null)
      : focusTaskId(convo, inbound.receivedAt, store);
    if (taskId != null) return { kind: 'command', name: cmd.name, taskId };
    return pickTaskConfirm(`要${cmdLabel(cmd.name)}哪个任务？`, store);
  }

  // ── 1. 显式任务地址 #T1042 ───────────────────────────────────────
  const refText = extractTaskRef(inbound.text);
  if (refText) {
    const task = store.getTaskByShortId(refText);
    if (task && !isTerminal(task.state)) {
      if (convRef) store.setFocus(channel, convRef, task.id, inbound.receivedAt);
      return { kind: 'task_message', taskId: task.id, via: 'address', updatesFocus: true };
    }
    return pickTaskConfirm(
      task
        ? `任务 ${refText} 已${stateLabel(task.state)}。你的意思是：`
        : `没找到任务 ${refText}（可能已归档）。你的意思是：`,
      store,
    );
  }

  // ── 2. 待办列表序号回复（"列表"之后回 1/2/3；confirm 登记后同路）────
  const ordinal = parseOrdinal(inbound.text);
  if (ordinal != null && convRef) {
    const list = store.getPendingList(channel, convRef);
    const item = list?.items.find((i) => i.index === ordinal);
    if (list && item) {
      store.clearPendingList(channel, convRef);
      // 序号回复＝「第 2 步精确解析」：选项带完整决议（`then`）且非任务归属时**直通该决议**——
      // 「新建任务/闲聊」这类选项也能被序号命中（只问一次不落空）。
      if (item.then && item.then.kind !== 'task_message') return item.then;
      if (item.taskId != null) {
        return {
          kind: 'pending_answer',
          messageRef: list.messageRef,
          index: ordinal,
          taskId: item.taskId,
          reportId: item.reportId,
        };
      }
      // 无 then 且无 taskId（历史行/空项）→ 视为未命中，继续下述链条
    }
  }

  // ── 3. 回复链：回复了某条推送 → 精确归位（最高置信路径）──────────
  if (inbound.replyToMsgId) {
    const ref = store.findOutboundRef(channel, inbound.replyToMsgId);
    if (ref) {
      const task = store.getTaskById(ref.taskId);
      const isOpen = task != null && !isTerminal(task.state);
      if (isOpen && convRef) store.setFocus(channel, convRef, task.id, inbound.receivedAt);
      // 任务已终态也照样返回 taskId：由编排器决定（如"这任务不是完成了吗"）
      return { kind: 'task_message', taskId: ref.taskId, via: 'reply', updatesFocus: isOpen };
    }
  }

  // ── 4. 项目别名 #记账（项目级寻址；语义决定 查询 or 新任务）───────
  const alias = extractProjectAlias(inbound.text);
  if (alias) {
    const project = store.getProjectByAlias(alias);
    if (project) {
      const s = await signal();
      if (s.intent === 'query') {
        return { kind: 'query', projectId: project.id, taskId: s.taskId ?? null, via: 'address' };
      }
      return {
        kind: 'new_task',
        projectId: project.id,
        confidence: Math.max(s.confidence, 0.9),
        titleGuess: s.titleGuess ?? null,
        via: 'address',
      };
    }
    // 别名不存在 → 落到兜底确认，绝不把 '#xxx' 当需求内容直接建任务
  }

  // ── 5 & 6 & 7 需要语义信号 ───────────────────────────────────────
  const s = await signal();

  // 5. sticky 焦点：仅工作性消息，且窗口内
  if (s.intent === 'work') {
    const focusId = focusTaskId(convo, inbound.receivedAt, store);
    if (focusId != null && convRef) {
      store.setFocus(channel, convRef, focusId, inbound.receivedAt);
      return { kind: 'task_message', taskId: focusId, via: 'focus', updatesFocus: true };
    }
  }

  // 6. 语义归位
  if (s.taskId != null && s.confidence >= SEMANTIC_THRESHOLD) {
    const task = store.getTaskById(s.taskId);
    if (task && !isTerminal(task.state)) {
      const updatesFocus = s.intent === 'work';
      if (updatesFocus && convRef) store.setFocus(channel, convRef, task.id, inbound.receivedAt);
      return { kind: 'task_message', taskId: task.id, via: 'semantic', updatesFocus };
    }
  }

  // 7. 兜底：查询 / 闲聊 / 新任务；模糊 → confirm（只问一次）
  if (s.intent === 'query') {
    const projectId = s.projectId ?? convo?.projectId ?? store.getDefaultProject()?.id ?? null;
    // 只读查询不改焦点：你可以连续问多个项目而不串台
    return { kind: 'query', projectId, taskId: s.taskId ?? null, via: 'semantic' };
  }
  if (s.intent === 'chat') return { kind: 'chat' };

  if (s.intent === 'new_task' && s.confidence >= SEMANTIC_THRESHOLD) {
    const projectId = s.projectId ?? convo?.projectId ?? store.getDefaultProject()?.id ?? null;
    if (projectId != null) {
      return {
        kind: 'new_task',
        projectId,
        confidence: s.confidence,
        titleGuess: s.titleGuess ?? null,
        via: 'semantic',
      };
    }
  }

  return buildConfirm(store, convo, s, inbound.receivedAt);
}

// ─────────────────────────────── 工具函数 ───────────────────────────────

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled']);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

function focusTaskId(convo: ConversationState | null, now: number, store: ResolverStore): number | null {
  if (!convo || convo.focusTaskId == null || convo.focusUpdatedAt == null) return null;
  if (now - convo.focusUpdatedAt > FOCUS_TTL_MS) return null;
  const t = store.getTaskById(convo.focusTaskId);
  if (!t || isTerminal(t.state)) return null;
  return t.id;
}

function parseOrdinal(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*[.、]?\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

function cmdLabel(name: CommandName): string {
  const map: Record<CommandName, string> = {
    list: '列出',
    daily: '出日报',
    pause: '暂停',
    resume: '继续',
    archive: '归档',
    finish: '结束',
    renew: '续办',
  };
  return map[name];
}

function stateLabel(state: TaskState): string {
  const map: Record<TaskState, string> = {
    inbox: '待分诊',
    planning: '规划中',
    awaiting_approval: '待批准',
    ready: '排队中',
    executing: '执行中',
    paused: '已暂停',
    verifying: '验证中',
    needs_decision: '等你决策',
    blocked: '被阻塞',
    done: '完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return map[state];
}

function pickTaskConfirm(question: string, store: ResolverStore): Resolution {
  const options: Array<{ index: number; label: string; then: Resolution }> = [];
  let i = 1;
  for (const t of store.getRecentActiveTasks(3)) {
    options.push({
      index: i++,
      label: `${t.shortId} ${t.title}`,
      then: { kind: 'task_message', taskId: t.id, via: 'address', updatesFocus: true },
    });
  }
  options.push({ index: i, label: '都不是，重新说明', then: { kind: 'chat' } });
  return { kind: 'confirm', question, options };
}

function buildConfirm(
  store: ResolverStore,
  convo: ConversationState | null,
  s: SemanticSignal,
  now: number,
): Resolution {
  const options: Array<{ index: number; label: string; then: Resolution }> = [];
  let i = 1;

  const focusId = focusTaskId(convo, now, store);
  if (focusId != null) {
    const t = store.getTaskById(focusId);
    if (t) {
      options.push({
        index: i++,
        label: `续 ${t.shortId}（${t.title}）`,
        then: { kind: 'task_message', taskId: t.id, via: 'focus', updatesFocus: true },
      });
    }
  }

  const projectId = s.projectId ?? convo?.projectId ?? store.getDefaultProject()?.id ?? null;
  if (projectId != null) {
    options.push({
      index: i++,
      label: '新建任务',
      then: {
        kind: 'new_task',
        projectId,
        confidence: Math.max(s.confidence, 0.9),
        titleGuess: s.titleGuess ?? null,
        via: 'default',
      },
    });
  }

  options.push({ index: i, label: '闲聊，直接回答', then: { kind: 'chat' } });
  return { kind: 'confirm', question: '我没把握这条消息的归属，我理解为：', options };
}
