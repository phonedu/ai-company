/**
 * G1（M2）· **会话内工具调用过 `permissionGate`**。
 *
 * 缺口（`docs/work/ledger-m2-engine-gaps.md` G1）：闸门此前只作用于**引擎动作**，Pi 会话内建的
 * `write`/`edit`/`bash` 等**不过闸** → 会话内可直接写文件/跑命令。
 *
 * 上游能力（实测 d.ts）：`pi.on('tool_call', (event, ctx) => ToolCallEventResult{ block?, reason? })`
 * 就是"工具执行前"的拦截点（含 `ctx.executeTool()` 的嵌套调用）。
 *
 * 口径（2641/2856 裁定）：
 *  - **复用** `resolveGateContext`（与引擎动作同一套解析，避免两套口径）；
 *  - `allow → {}`（放行）；`deny → {block:true,reason}`；`ask → {block:true,reason}`（**提示式**：批准后下次调用放行，不阻塞回合）；
 *  - **对外/花钱/安装/危险命令永不自动放行**（由 `permissionGate` 保证）；
 *  - 决策留痕**经注入回调** `onDecision` 交给 engine/agent 写（**单写者**）；
 *  - 会话**无归属上下文**（非受管会话）→ **不拦**（避免误伤幕僚长等其它会话），但如实记 `unmanaged`。
 */
import { randomUUID } from 'node:crypto';

import { resolveGateContext, type GateDefaults } from '../engine/gate-context.js';
import {
  permissionGate,
  toolCategory,
  type AssistantWriteMode,
  type Autonomy,
  type CapabilityTier,
  type GateResult,
  type ToolCall,
} from '../permission/gate.js';
import { formatChannelPermissionQuestion } from '../permission/grants.js';
import { insertTaskEvent } from '../db/task_events.js';
import { insertApproval, linkApprovalReport, PERMISSION_QUESTION_PREFIX } from '../db/approvals.js';
import { markActionDone, registerPendingAction } from '../db/action_log.js';
import { getNotificationByDedupeKey } from '../db/notifications.js';
import { notify } from '../notify/index.js';
import { redactPayload } from '../notify/redact.js';
import type { SqliteDb } from '../db/open.js';

/** 一次运行的归属上下文（`run()` 前写入、`finally` 清除）。 */
export interface RunGateContext {
  employeeId: number;
  /** D-19：频道助手等无任务会话可为 null；有任务时仍走任务项目。 */
  taskId: number | null;
  /** D-19：无任务时显式绑定的项目（频道助手当前项目）。 */
  projectId?: number | null;
  workItemId?: number | null;
  cwd?: string;
  /** D-19：覆盖项目根解析（幕僚长项目 cwd；无项目时仍以该 cwd 作为只读根）。 */
  projectRoot?: string;
  /** D-19：无项目→sandbox（只读）；有项目→standard。 */
  capabilityTier?: CapabilityTier;
  /** D-19：项目放行档覆盖（缺省用项目/全局策略）。 */
  autonomy?: Autonomy;
  /** D-19 P1：频道助手项目写模式（审计/确认卡展示用；判定仍由 autonomy/capabilityTier 决定）。 */
  writeMode?: AssistantWriteMode;
  /** G1 余项：会话维度（最小范围 = 会话 × 规则）；缺省时仅享任务级 grant。 */
  sessionKey?: string;
}

export interface ToolCallGateEvent {
  toolName: string;
  input?: Record<string, unknown>;
  parentToolCallId?: string;
}
export interface ToolCallGateResult {
  block?: boolean;
  reason?: string;
}

export interface GateDecisionInfo {
  decision: GateResult['decision'];
  reason: string;
  rule?: string;
  toolName: string;
  run: RunGateContext | null;
  sessionId: string | null;
}

export interface SessionToolGateDeps {
  db: SqliteDb;
  /** 上下文缺省（能力档/放行档/项目根）。 */
  defaults?: GateDefaults;
  /** 决策回调（engine/agent 侧写 `permission_decision` / `permission_requested`+`approvals`）——**单写者**。 */
  onDecision?: (info: GateDecisionInfo) => void;
  /**
   * D-19 P1：放行回调（仅 `allow`；不改既有 `onDecision` 只在 deny/ask 回调的契约）。
   * 频道助手用它把**实际执行的写/命令**落审计；任务会话不接。
   */
  onAllow?: (info: GateDecisionInfo) => void;
  /** 可注入的闸门（测试用）。 */
  gate?: (call: ToolCall, ctx: ReturnType<typeof resolveGateContext>) => GateResult;
}

export class SessionToolGate {
  private readonly contexts = new Map<string, RunGateContext>();

  constructor(private readonly deps: SessionToolGateDeps) {}

  setRun(sessionId: string, run: RunGateContext): void {
    this.contexts.set(sessionId, run);
  }
  clearRun(sessionId: string): void {
    this.contexts.delete(sessionId);
  }
  hasRun(sessionId: string): boolean {
    return this.contexts.has(sessionId);
  }
  /** B2-4：会话归属读口（实测路径采集与闸门同一 sessionId 事实源）；查无 → null。 */
  runOf(sessionId: string): RunGateContext | null {
    return this.contexts.get(sessionId) ?? null;
  }

  /** 纯决策：给定事件 + 归属上下文 → 拦截结果（可单测，无需 Pi）。 */
  evaluate(event: ToolCallGateEvent, run: RunGateContext | null, sessionId: string | null = null): ToolCallGateResult {
    if (!run) {
      this.deps.onDecision?.({
        decision: 'allow',
        reason: '会话无归属上下文（unmanaged）→ 不拦',
        rule: 'unmanaged_session',
        toolName: event.toolName,
        run: null,
        sessionId,
      });
      return {};
    }
    const gate = this.deps.gate ?? permissionGate;
    const base = resolveGateContext(
      this.deps.db,
      { taskId: run.taskId, projectId: run.projectId ?? null, employeeId: run.employeeId, cwd: run.cwd },
      this.deps.defaults ?? {},
    );
    // D-19：频道助手按“当前项目”覆盖根/能力档/放行档；无项目时 sandbox（只读）。
    const ctx = {
      ...base,
      ...(run.projectRoot != null ? { projectRoot: run.projectRoot } : {}),
      ...(run.capabilityTier != null ? { capabilityTier: run.capabilityTier } : {}),
      ...(run.autonomy != null ? { autonomy: run.autonomy } : {}),
      // B2-7：员工任务会话（employeeId>0）标记——bash 内 git 写子命令一律 deny（宿主收口）。
      employeeSession: run.employeeId > 0,
    };
    // G1 余项（最小范围 = 会话 × 规则）：只享「本会话」或「任务级（回落）」的 grant。
    // D-19 P1：频道 grant（assistantOnly）不得扩散到同项目员工任务会话。
    const grants = (ctx.policy?.grants ?? []).filter(
      (g) =>
        (!g.assistantOnly || run.employeeId === 0) &&
        (!g.sessionKey || (run.sessionKey != null && g.sessionKey === run.sessionKey)),
    );
    const scopedCtx = { ...ctx, policy: { ...(ctx.policy ?? {}), grants } };
    const result = gate({ name: event.toolName, args: event.input ?? {} }, scopedCtx);
    const info: GateDecisionInfo = {
      decision: result.decision,
      reason: result.reason,
      rule: result.rule,
      toolName: event.toolName,
      run,
      sessionId,
    };
    if (result.decision === 'allow') {
      // D-19 P1：只给显式接线的装配层（频道助手）审计放行；既有调用方不接＝行为不变。
      this.deps.onAllow?.(info);
      return {};
    }
    this.deps.onDecision?.(info);
    return { block: true, reason: `${result.reason}` };
  }

  /** 注册到 Pi 扩展 API（`pi.on('tool_call', …)`）。 */
  register(pi: { on(event: 'tool_call', handler: (event: ToolCallGateEvent, ctx: unknown) => ToolCallGateResult): unknown }): void {
    pi.on('tool_call', (event, ctx) => {
      const sessionId = extractSessionId(ctx);
      const run = sessionId ? this.contexts.get(sessionId) ?? null : null;
      return this.evaluate(event, run, sessionId);
    });
  }
}

/** 从扩展 `ctx` 里取会话 id（`sessionManager.getSessionId()`）；取不到返回 null。 */
export function extractSessionId(ctx: unknown): string | null {
  const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
  const id = typeof sm?.getSessionId === 'function' ? sm.getSessionId() : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * **默认决策写入者**（agent 层；`onDecision` 的缺省实现）——保持单写者：
 * `deny → task_events.permission_decision`；`ask → permission_requested` + `approvals`（`[权限]` 前缀、无默认动作）。
 * `allow`/unmanaged 不落库。装配层可注入自己的写入者覆盖。
 */
export function persistSessionGateDecision(db: SqliteDb, info: GateDecisionInfo, now: number = Date.now()): void {
  // D-19：频道助手无任务时没有 task_events/approvals 的锚点——由装配层走频道审计；此处不臆造 taskId。
  if (!info.run || info.run.taskId == null || info.decision === 'allow') return;
  insertTaskEvent(db, {
    taskId: info.run.taskId,
    workItemId: info.run.workItemId ?? null,
    ts: now,
    kind: info.decision === 'deny' ? 'permission_decision' : 'permission_requested',
    actor: `employee:${info.run.employeeId}`,
    payload: { scope: 'session_tool', toolName: info.toolName, decision: info.decision, reason: info.reason, rule: info.rule ?? null },
  });
  if (info.decision === 'ask') {
    // BRK10（挂载 2，2026-10-15）：会话工具权限请求**可见化**——此前只建 approvals 行 ⇒「待我处理」看不到。
    // 现：建审批行 → 落真卡（`待我处理` 数据源＝reports）→ `report_id` 回挂（批准按钮寻址）。
    // 任务机**不动**（会话闸门无引擎句柄；批准后 grant 生效、工具重试即放行——G1 口径不变）。
    // 去重键＝(会话, 工具, 规则)：同规则在批前只出**一张**卡（作答后 grant 生效不再问）。
    const question = `${PERMISSION_QUESTION_PREFIX}会话工具 ${info.toolName}（${info.rule ?? 'unknown'}）[${info.run.sessionKey ?? '-'}]`;
    const options = [
      { key: 'approve', label: '批准一次' },
      { key: 'deny', label: '拒绝' },
    ];
    const approval = insertApproval(db, { taskId: info.run.taskId, question, options, defaultAction: null, timeoutAt: null });
    const card = notify(db, {
      taskId: info.run.taskId,
      kind: 'ask',
      dedupeKey: `permission:${info.run.sessionKey ?? '-'}:${info.toolName}:${info.rule ?? '-'}`,
      payload: {
        title: `权限请求：${info.toolName}`,
        card: 'permission',
        question,
        // 卡片可读性批（老板 2026-10-28）：结构化「谁/干什么/哪个项目」——渲染层优先三行人话。
        permissionDetail: sessionPermissionDetail(db, info, '会话工具'),
        options,
        employeeId: info.run.employeeId,
        workItemId: info.run.workItemId ?? null,
        via: 'session_tool_gate',
        permissionKey: info.rule ?? info.toolName,
      },
      now,
    });
    if (card.reportId != null) linkApprovalReport(db, approval.id, card.reportId);
  }
}

/** D-19 P1：频道助手哪些工具算“写操作/外发”（放行时要落审计）。 */
function isAuditedChannelTool(toolName: string): boolean {
  const category = toolCategory(toolName);
  return category === 'write' || category === 'command' || category === 'install' || category === 'external' || category === 'spend';
}

/**
 * D-19 P1：频道助手（无任务会话）的权限决策落库。
 *
 * - `ask`：建 `approvals`（`task_id=null`）+ 全局权限卡（`reports`/`notifications`）；
 *   选项 `approve_once`（本应用会话）/`approve_project`（本项目）/`deny`。
 * - `deny`：不建卡，落审计（`action_log`，`task_id=null`）。
 * - `allow`：由 `onAllow` + `recordChannelAllowAudit` 处理（本函数不重复写）。
 *
 * 口径：**无任务不等于无痕**；频道助手的每次越界/批准/实际写都必须能回指项目与会话。
 */
export function persistChannelGateDecision(
  db: SqliteDb,
  info: GateDecisionInfo,
  now: number = Date.now(),
): void {
  const run = info.run;
  if (!run || run.taskId != null) return;
  if (info.decision === 'allow') return;

  if (info.decision === 'deny') {
    recordChannelAudit(db, info, now);
    console.warn(
      `[assistant-gate] deny tool=${info.toolName} rule=${info.rule ?? '-'} project=${run.projectId ?? 'none'} reason=${info.reason}`,
    );
    return;
  }

  // ask：无项目时没有可落 grant 的锚点；不建“批了也不知道批给谁”的卡。
  if (run.projectId == null) {
    recordChannelAudit(db, info, now);
    console.warn(`[assistant-gate] ask-without-project tool=${info.toolName} rule=${info.rule ?? '-'}`);
    return;
  }

  const sessionKey = run.sessionKey ?? '-';
  const rule = info.rule ?? info.toolName;
  const question = formatChannelPermissionQuestion(info.toolName, rule, run.projectId, sessionKey);
  const options = [
    { key: 'approve_once', label: '本次允许' },
    { key: 'approve_project', label: '本项目允许' },
    { key: 'deny', label: '拒绝' },
  ];
  const dedupeKey = `permission:channel:${run.projectId}:${sessionKey}:${info.toolName}:${rule}`;
  // 同会话/同工具/同规则只出**一张**卡；重复 ask 不再堆 approvals 行（卡仍是同一张）。
  if (getNotificationByDedupeKey(db, dedupeKey)) {
    recordChannelAudit(db, info, now);
    return;
  }
  const approval = insertApproval(db, { taskId: null, question, options, defaultAction: null, timeoutAt: null });
  const card = notify(db, {
    taskId: null,
    kind: 'ask',
    dedupeKey,
    payload: {
      title: `权限请求：${info.toolName}`,
      card: 'permission',
      question,
      // 卡片可读性批（老板 2026-10-28）：结构化「谁/干什么/哪个项目」。
      permissionDetail: channelPermissionDetail(db, info),
      options,
      employeeId: run.employeeId,
      via: 'assistant_gate',
      permissionKey: rule,
      projectId: run.projectId,
      writeMode: run.writeMode ?? null,
    },
    now,
  });
  if (card.reportId != null) linkApprovalReport(db, approval.id, card.reportId);
  recordChannelAudit(db, info, now, approval.id);
  console.warn(
    `[assistant-gate] ask tool=${info.toolName} rule=${rule} project=${run.projectId} session=${sessionKey} approval=${approval.id}`,
  );
}

/** D-19 P1：频道助手**实际放行**的写/命令/外发落审计（不改闸门判定）。 */
export function recordChannelAllowAudit(
  db: SqliteDb,
  info: GateDecisionInfo,
  now: number = Date.now(),
): void {
  const run = info.run;
  if (!run || run.taskId != null) return;
  if (!isAuditedChannelTool(info.toolName)) return;
  recordChannelAudit(db, info, now, null, 'allow');
}

/** 频道助手审计（`action_log`，`task_id=null`；立即 done，不参与崩溃重放）。 */
// ── 卡片可读性批（老板 2026-10-28）：权限卡结构化 detail 构造 ─────────────────

/** 员工名查表；查不到回落「员工 #id」，assistant（id 0）＝幕僚长。 */
function employeeDisplayName(db: SqliteDb, employeeId: number | null | undefined): string {
  if (employeeId == null) return '未知员工';
  const row = db.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId) as { name: string | null } | undefined;
  if (row?.name && row.name.trim().length > 0) return row.name.trim();
  return `员工 #${employeeId}`;
}

/** 项目名查表（经 taskId 反查或直查 projectId）；查不到回落「全局」。 */
function projectNameOf(db: SqliteDb, ref: { projectId?: number | null; taskId?: number | null }): string {
  if (typeof ref.projectId === 'number') {
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(ref.projectId) as { name: string | null } | undefined;
    if (row?.name) return row.name;
  }
  if (typeof ref.taskId === 'number') {
    const row = db
      .prepare('SELECT p.name AS name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
      .get(ref.taskId) as { name: string | null } | undefined;
    if (row?.name) return row.name;
  }
  return '全局';
}

/** 员工会话权限卡 detail（action 前缀「会话工具」由调用方给）。 */
function sessionPermissionDetail(
  db: SqliteDb,
  info: GateDecisionInfo,
  actionPrefix: string,
): { who: string; action: string; project: string; session: string | null } {
  const run = info.run;
  return {
    who: employeeDisplayName(db, run?.employeeId),
    action: `${actionPrefix} ${info.toolName}（规则 ${info.rule ?? info.toolName}）`,
    project: projectNameOf(db, { taskId: run?.taskId ?? null }),
    session: run?.sessionKey ?? null,
  };
}

/** 频道助手权限卡 detail（频道写/外发类动作）。 */
function channelPermissionDetail(db: SqliteDb, info: GateDecisionInfo): {
  who: string;
  action: string;
  project: string;
  session: string | null;
} {
  const run = info.run;
  return {
    who: employeeDisplayName(db, run?.employeeId),
    action: `频道写操作 ${info.toolName}（规则 ${info.rule ?? info.toolName}）`,
    project: projectNameOf(db, { projectId: run?.projectId ?? null }),
    session: run?.sessionKey ?? null,
  };
}

function recordChannelAudit(
  db: SqliteDb,
  info: GateDecisionInfo,
  now: number,
  approvalId: number | null = null,
  decisionOverride?: GateResult['decision'],
): void {
  const run = info.run;
  if (!run) return;
  const decision = decisionOverride ?? info.decision;
  const actionKey = `assistant_gate:${decision}:${randomUUID()}`;
  try {
    registerPendingAction(db, {
      actionKey,
      kind: 'assistant_gate',
      taskId: null,
      payload: redactPayload({
        decision,
        toolName: info.toolName,
        rule: info.rule ?? null,
        reason: info.reason,
        projectId: run.projectId ?? null,
        sessionKey: run.sessionKey ?? null,
        writeMode: run.writeMode ?? null,
        approvalId,
      }),
      now,
    });
    markActionDone(db, actionKey, now);
  } catch (error) {
    // 审计写失败不能反噬会话，但必须响（不静默）。
    console.error('[assistant-gate] audit write failed', error);
  }
}
