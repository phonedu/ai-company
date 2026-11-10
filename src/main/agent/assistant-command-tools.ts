/**
 * · 幕僚长指挥四工具：`create_task` / `dispatch` / `steer` / `list_holds`。
 *
 * 背景：幕僚长头衔宣称「拆解与规划、分派员工」但无建派工具——头衔与能力结构矛盾；
 * hold 状态读不到（P3）。本模块把四工具落地，口径：
 *  - `create_task`：**复用 `handleTaskCreate` 全部门**（预算预检/模型白名单/ 分诊/归属问一次）——
 *    建任务回调由 `main/index.ts` 注入（`agent` 层不 import `ipc`，避免层向倒挂）；工具层只做
 *    入参校验与缺省（projectId 缺省＝频道范围，与分诊器口径一致）、origin/via 标记。
 *  - `dispatch`：`schedule`＝引擎调度 tick（空队列也跑 fixpoint）；`retry`＝对任务最新失败
 *    工作项发 `retry` 事件（attempt+1，statemachine 既有迁移）。无引擎如实说（不假装派发）。
 *  - `steer`：复用通路投话到**在跑员工会话**（`steerEmployee` 由 index 注入，与
 *    `#短号` 插话同一实现）；任务不在跑 → **记入任务上下文并明说**（绝不假装送达）。
 *    两种情况消息都落 `human_messages(in)`（审计可见）。
 *  - `list_holds`：`engine.listDispatchHolds()`＋`schedulerSlots()` 真读数；空态明说，不臆造。
 *
 * ESM/CJS 约束同 `task-status-tool.ts`：Pi SDK 只能异步动态 import。
 */
import { insertHumanMessage, listWorkItemsByTask } from '../db/index.js';
import type { SqliteDb } from '../db/open.js';
import { employeeSessionKey } from './employee-runtime.js';
import type { EngineEvent } from '../engine/types.js';

/** 引擎能力子集（`main/index.ts` 传引擎实例；缺方法时工具如实降级）。 */
export interface AssistantEnginePort {
  dispatch(event: EngineEvent): Promise<void>;
  /** 手动调度 tick（引擎已有 `tick()`；旧装配缺失 → dispatch 工具如实降级）。 */
  tick?(): Promise<void>;
  /** 派发等待读数（WI 级＋任务级）。 */
  listDispatchHolds?(): Array<{
    workItemId: number | null;
    taskId?: number;
    reason: string;
    conflictsWith: number[];
    detail?: string;
  }>;
  /** R3-2：顶栏槽位真读数。 */
  schedulerSlots?(): { running: number; total: number };
}

/** `create_task` 的回调（index 注入＝`handleTaskCreate`；缺省未接线 → 工具如实说）。 */
export type AssistantCreateTaskFn = (
  input: Record<string, unknown>,
) => Promise<{ id: number; shortId?: string | null; title?: string | null; state?: string }>;

export interface AssistantCommandDeps {
  db: SqliteDb;
  engine?: AssistantEnginePort | null;
  steerEmployee?: ((sessionKey: string, text: string) => boolean) | null;
  createTask?: AssistantCreateTaskFn | null;
  /** 频道范围项目（与 note/memory 工具同源：`channel.scope_project_id`）。 */
  scopeProjectId?: () => number | null;
}

interface TaskRef {
  id: number;
  shortId: string | null;
  state: string;
}

/** 任务引用解析：`T-1042` / `T1042` / `1042` / 纯数字 id。查无 → null（不臆造）。 */
function resolveTask(db: SqliteDb, ref: string): TaskRef | null {
  const raw = ref.trim();
  if (raw.length === 0) return null;
  const m = /^T-?(\d+)$/i.exec(raw);
  const shortId = m != null ? `T-${m[1]}` : /^T-\d+$/.test(raw) ? raw : null;
  if (shortId != null) {
    const row = db.prepare('SELECT id, short_id, state FROM tasks WHERE short_id = ?').get(shortId) as
      | { id: number; short_id: string | null; state: string }
      | undefined;
    if (row) return { id: row.id, shortId: row.short_id, state: row.state };
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) {
    const row = db.prepare('SELECT id, short_id, state FROM tasks WHERE id = ?').get(n) as
      | { id: number; short_id: string | null; state: string }
      | undefined;
    if (row) return { id: row.id, shortId: row.short_id, state: row.state };
  }
  return null;
}

function label(t: TaskRef): string {
  return t.shortId ?? `#${t.id}`;
}

const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: s }], details });

export async function createAssistantCommandTools(deps: AssistantCommandDeps) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  const { db } = deps;

  const createTaskTool = defineTool({
    name: 'create_task',
    label: 'Create Task',
    description:
      '建任务（唯一指挥入口）：老板明确要做一件事时调用。走与「＋建任务」完全相同的门'
      + '（预算预检/模型白名单/归属确认），建完自动进入规划。goal 必填；归属拿不准先问老板。',
    parameters: Type.Object({
      goal: Type.String({ description: '任务目标（做什么、做到什么程度）——必填' }),
      title: Type.Optional(Type.String({ description: '任务标题（≤40 字；缺省取 goal 前 40 字）' })),
      acceptance: Type.Optional(Type.Array(Type.String(), { description: '验收标准（每条一句人话）' })),
      projectId: Type.Optional(Type.Number({ description: '归属项目 id；缺省＝当前频道范围项目' })),
      riskLevel: Type.Optional(Type.Number({ description: '风险档 0/1/2（0 直通；缺省＝项目编制默认）' })),
      budgetTokens: Type.Optional(Type.Number({ description: '任务 token 预算；缺省＝项目默认预算' })),
    }),
    async execute(_toolCallId, params) {
      const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
      if (goal.length === 0) {
        return text('建任务被拒：goal（目标）必填——请补一句「要做什么」再建；不要替老板猜。');
      }
      if (deps.createTask == null) {
        return text('建任务通道未接线（回调缺失）——请老板用左栏「＋建任务」，或稍后再试。');
      }
      const input: Record<string, unknown> = {
        goal,
        origin: 'assistant',
        via: 'assistant_create_task',
      };
      if (typeof params.title === 'string' && params.title.trim().length > 0) input['title'] = params.title.trim();
      if (Array.isArray(params.acceptance)) {
        input['acceptance'] = params.acceptance.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
      }
      if (typeof params.projectId === 'number' && Number.isInteger(params.projectId)) input['projectId'] = params.projectId;
      else {
        const scope = deps.scopeProjectId?.() ?? null;
        if (scope != null) input['projectId'] = scope;
      }
      if (typeof params.riskLevel === 'number' && Number.isInteger(params.riskLevel)) input['riskLevel'] = params.riskLevel;
      if (typeof params.budgetTokens === 'number' && Number.isInteger(params.budgetTokens) && params.budgetTokens > 0) {
        input['budgetTokens'] = params.budgetTokens;
      }
      try {
        const task = await deps.createTask(input);
        const title = typeof task.title === 'string' && task.title.length > 0 ? task.title : goal.slice(0, 40);
        return text(
          `已建任务 ${task.shortId ?? `#${task.id}`}「${title}」（状态 ${task.state ?? 'inbox'}）。`
            + '规划开始后会有受理卡；用 task_status 跟进进度。',
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text(`建任务被拒：${msg}——把原因如实告诉老板，不要重试掩盖。`);
      }
    },
  });

  const dispatchTool = defineTool({
    name: 'dispatch',
    label: 'Dispatch',
    description:
      '推动任务调度：action="schedule"（缺省）触发一次调度（等槽位/等员工的任务会按优先级开工）；'
      + 'action="retry" 对任务最新失败的工作项发起重试（attempt+1）。推动前先用 list_holds 看原因。',
    parameters: Type.Object({
      task: Type.String({ description: '任务短号（如 T-1002）或任务 id' }),
      action: Type.Optional(Type.String({ description: '"schedule"（缺省）|"retry"' })),
    }),
    async execute(_toolCallId, params) {
      const task = resolveTask(db, String(params.task ?? ''));
      if (task == null) return text(`没找到任务 ${String(params.task ?? '')}——请核对短号后重试。`);
      const action = params.action === 'retry' ? 'retry' : 'schedule';
      if (deps.engine == null) return text(`引擎未装配——无法对 ${label(task)} 触发${action === 'retry' ? '重试' : '调度'}（如实告知老板，不假装派发）。`);
      if (action === 'schedule') {
        if (typeof deps.engine.tick !== 'function') {
          return text(`引擎不支持手动调度 tick——${label(task)} 会按每秒 tick 自动推进（任务 ready 即会被调度）。`);
        }
        await deps.engine.tick();
        const slots = deps.engine.schedulerSlots?.() ?? null;
        const holds = deps.engine.listDispatchHolds?.() ?? [];
        const slotText = slots != null ? `槽位 ${slots.running}/${slots.total}` : '槽位读数不可用';
        const holdText = holds.length > 0 ? `；仍有 ${holds.length} 件等待（可用 list_holds 看原因）` : '；当前无等待';
        return text(`已对 ${label(task)} 触发调度（${slotText}${holdText}）。`);
      }
      // retry：任务最新失败件
      const failed = listWorkItemsByTask(db, task.id).filter((w) => w.state === 'failed');
      const target = failed.length > 0 ? failed[failed.length - 1] : null;
      if (target == null) return text(`${label(task)} 没有失败的工作项可重试。`);
      await deps.engine.dispatch({ scope: 'work_item', id: target.id, event: 'retry', actor: 'assistant', payload: {} });
      return text(`已对 ${label(task)} 的失败工作件 #${target.id} 发起重试（attempt+1）；结果看 task_status。`);
    },
  });

  const steerTool = defineTool({
    name: 'steer',
    label: 'Steer',
    description:
      '向在跑任务的员工会话插话纠偏（不打断、下一个工具调用前生效）。任务不在跑时会把话'
      + '记入任务上下文（下一工作项带上）并明说——绝不假装送达。',
    parameters: Type.Object({
      task: Type.String({ description: '任务短号（如 T-1002）或任务 id' }),
      message: Type.String({ description: '要带给员工的一句话（纠偏/补充要求）' }),
    }),
    async execute(_toolCallId, params) {
      const task = resolveTask(db, String(params.task ?? ''));
      if (task == null) return text(`没找到任务 ${String(params.task ?? '')}——请核对短号后重试。`);
      const message = typeof params.message === 'string' ? params.message.trim() : '';
      if (message.length === 0) return text('steer 被拒：message 不能为空——要带给员工的话必须说清。');
      // 审计先行：无论是否送达，这句话都进任务消息流（口径：不石沉大海）。
      insertHumanMessage(db, { direction: 'in', taskId: task.id, content: message, now: Date.now() });
      const running = listWorkItemsByTask(db, task.id).find((w) => w.state === 'running');
      if (running == null) {
        return text(`${label(task)} 不在跑：这句话已记入任务上下文（下一工作项会带上），没有投给任何会话。`);
      }
      const sessionKey = employeeSessionKey({ employeeId: running.employee_id, taskId: task.id, workItemId: running.id });
      const delivered = deps.steerEmployee?.(sessionKey, message) ?? false;
      //  出口 E 发现：chat 裁定（taskId=null）下 task_events 收不了（task_id NOT NULL）
      // ⇒ 工具调用曾无痕。steer 结果落 action_log 全局审计（幂等键含随机 id；不依赖任务锚）。
      try {
        const { registerPendingAction, markActionDone } = await import('../db/action_log.js');
        const auditKey = `assistant_steer:${task.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        registerPendingAction(db, {
          actionKey: auditKey,
          kind: 'assistant_tool',
          taskId: task.id,
          payload: { tool: 'steer', taskShortId: task.shortId, delivered, sessionKey, messageChars: message.length },
          now: Date.now(),
        });
        markActionDone(db, auditKey, Date.now());
      } catch (auditError) {
        console.error('[assistant-steer] 审计落库失败（投递不回滚，响亮报错）', auditError);
      }
      if (!delivered) {
        return text(`${label(task)} 的会话未在飞——没送出去（消息已记入任务上下文）；请如实告知老板稍后再试。`);
      }
      return text(`已把话投给 ${label(task)} 在跑的员工（下一个工具调用前生效）。`);
    },
  });

  const listHoldsTool = defineTool({
    name: 'list_holds',
    label: 'List Holds',
    description:
      '查当前所有等待/排队原因（任务级＋工作项级：无槽位/超预算/员工正忙/路径冲突）与调度槽位。'
      + '老板问「为什么不动/卡在哪」时先用本工具，再据实回答；空态明说。',
    parameters: Type.Object({}),
    async execute() {
      if (deps.engine == null || typeof deps.engine.listDispatchHolds !== 'function') {
        return text('引擎未装配（或版本过旧）——查不到等待原因（如实告知老板，不臆造）。');
      }
      const holds = deps.engine.listDispatchHolds();
      const slots = deps.engine.schedulerSlots?.() ?? null;
      const slotText = slots != null ? `槽位 ${slots.running}/${slots.total}。` : '';
      if (holds.length === 0) {
        return text(`当前没有等待/排队的件。${slotText}`);
      }
      const lines = holds.map((h) => {
        const t = h.taskId != null ? (db.prepare('SELECT short_id FROM tasks WHERE id = ?').get(h.taskId) as { short_id: string | null } | undefined) : undefined;
        const taskLabel = t?.short_id ?? (h.taskId != null ? `#${h.taskId}` : '?');
        const wi = h.workItemId != null ? ` 件#${h.workItemId}` : '';
        const detail = typeof h.detail === 'string' && h.detail.length > 0 ? `：${h.detail}` : '';
        const conflict = h.conflictsWith.length > 0 ? `（占用方 ${h.conflictsWith.join(',')}）` : '';
        return `- ${taskLabel}${wi}：${h.reason}${conflict}${detail}`;
      });
      return text(`等待原因 ${holds.length} 条。${slotText}\n${lines.join('\n')}`);
    },
  });

  return { createTaskTool, dispatchTool, steerTool, listHoldsTool };
}


// ──：draft_sop——为新角色起草 SOP → 确认卡（老板批准才入库） ──────────

/** 幕僚长 draft_sop 工具：起草新角色 SOP（工作方法/输出规范/自检清单）→ 确认卡。 */
export async function createDraftSopTool(deps: AssistantCommandDeps) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'draft_sop',
    label: 'Draft SOP',
    description:
      '为新角色起草 SOP（工作方法/输出规范/自检清单三段，各至少 5 条）。草案出确认卡由老板批准，批准后由宿主落库到 .aico/sops 目录并对该角色员工生效。已有内置 SOP 的预设角色不需要起草。',
    parameters: Type.Object({
      role: Type.String({ description: '角色名（与招募角色一致，如 数据分析师）' }),
      method: Type.String({ description: '工作方法：≥5 条「怎么做这类活」' }),
      outputSpec: Type.String({ description: '输出规范：交付物长什么样、怎么提交' }),
      checklist: Type.String({ description: '自检清单：交付前逐条过的 ≥5 条' }),
    }),
    async execute(_toolCallId: string, params: { role: string; method: string; outputSpec: string; checklist: string }) {
      const role = String(params.role ?? '').trim();
      const method = String(params.method ?? '').trim();
      const outputSpec = String(params.outputSpec ?? '').trim();
      const checklist = String(params.checklist ?? '').trim();
      if (role.length === 0 || method.length < 80 || outputSpec.length < 60 || checklist.length < 60) {
        const details: { outcome: string; approvalId: number | null } = { outcome: 'rejected', approvalId: null };
        return { content: [{ type: 'text' as const, text: 'draft_sop 被拒：role 必填，三段各需实质内容（方法≥80 字/规范≥60 字/清单≥60 字）。' }], details };
      }
      const { insertApproval, linkApprovalReport } = await import('../db/approvals.js');
      const { notify } = await import('../notify/index.js');
      const now = Date.now();
      let details: { outcome: string; approvalId: number | null };
      try {
        const question = `SOP 草案待批准：${role}（三段，共 ${method.length + outputSpec.length + checklist.length} 字）`;
        const options = [
          { key: 'approve_sop', label: '批准入库' },
          { key: 'reject_sop', label: '不采用' },
        ];
        const approval = insertApproval(deps.db, { taskId: null, question, options, defaultAction: null, timeoutAt: null });
        const card = notify(deps.db, {
          taskId: null,
          kind: 'ask',
          dedupeKey: `sop_draft:${role}:${now}`,
          payload: {
            title: `SOP 草案：${role}`,
            card: 'sop_draft',
            question,
            options,
            sopDraft: { role, method, outputSpec, checklist },
            via: 'draft_sop',
          },
          now,
        });
        if (card.reportId != null) linkApprovalReport(deps.db, approval.id, card.reportId);
        const details: { outcome: string; approvalId: number | null } = { outcome: 'card', approvalId: approval.id };
        return { content: [{ type: 'text' as const, text: `SOP 草案已出确认卡（角色：${role}）——老板批准后由宿主落库生效。` }], details };
      } catch (error) {
        const errDetails: { outcome: string; approvalId: number | null } = { outcome: 'error', approvalId: null };
        return { content: [{ type: 'text' as const, text: `SOP 草案出卡失败：${error instanceof Error ? error.message : String(error)}` }], details: errDetails };
      }
    },
  });
}
