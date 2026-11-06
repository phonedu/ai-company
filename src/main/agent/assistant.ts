/**
 * 幕僚长（0 号员工）会话运行时 —— T0.4 主体（DEV §8 T0.4）。
 *
 * 职责：把一次「老板频道」对话跑成一转会话，并把结果落库：
 *  - 真实回复 → `human_messages(direction='out')`（T0.5 消息流渲染）；
 *  - `tool_call`（start/end）→ `task_events.kind='tool_call'`（行为日志 / 员工墙）；
 *  - `report_progress` 工具 → `progress_reported` 事件 + `plan_steps` 投影（DEV §4.8）；
 *  - `text_delta` 只推流、不落库（DEV §6.2）。
 *
 * 会话运行时（`AgentRuntime`）**可插拔**：真实 Pi 实现（`pi-runtime.ts`）或 fake；
 * 这样本模块可脱离 Pi/网络单测（DEV §9）。
 */
import { randomUUID } from 'node:crypto';

import { getProjectById, getTaskById, insertHumanMessage, insertTaskEvent, recordCost } from '../db/index.js';
import type { PlanStepState } from '../db/plan_steps.js';
import type { SqliteDb } from '../db/open.js';
import { SqliteMemoryStore, renderBrief } from '../memory/index.js';
import { assistantGatePolicy, assistantWriteModePrompt, resolveAssistantWriteMode } from '../permission/assistant-write.js';
import { persistToolCallEvent, projectProgressReported } from './tool-events.js';
import type { AgentEvent, AgentToolCallRecord, AgentUsage, AgentRuntime } from './types.js';
import type { SessionToolGate } from './session-tool-gate.js';

export interface AssistantRuntimeOptions {
  db: SqliteDb;
  runtime: AgentRuntime;
  /** 会话键（缺省 boss-channel:assistant）。 */
  sessionKey?: string;
  /** 幕僚长五层拼装的系统提示词。 */
  systemPrompt?: string;
  cwd?: string;
  /** D-19：会话内工具闸门（与员工会话同一 `permissionGate`）；缺省不拦（仅测试/旧装配）。 */
  toolGate?: SessionToolGate;
  clock?: () => number;
  /** 流式文本回调（→ 渲染层推送；不落库）。 */
  onTextDelta?: (delta: string) => void;
}

export interface AssistantTurnInput {
  /** 老板这句话（任务层简报）。 */
  text: string;
  /** 归属任务（可空 = 全局对话）。 */
  taskId?: number | null;
  /** D-19：无任务时绑定的当前项目（任务消息仍以任务 project_id 优先）。 */
  projectId?: number | null;
}

export interface AssistantTurnResult {
  reply: string;
  replyMessageId: number;
  toolCalls: AgentToolCallRecord[];
  usage?: AgentUsage;
}

export class AssistantRuntime {
  private readonly sessionKey: string;
  /**
   * D-19 P1：闸门会话维度（grant 过滤用）。与 Pi 的持久 sessionKey 分开：
   * 「本次允许」只在本应用进程内有效，重启后不会因为固定 sessionKey 变成永久授权。
   */
  private readonly gateSessionKey: string;
  private readonly now: () => number;
  /** RM-5：当前这一转归属的任务；卡片落库时只中止同一任务，不误伤别的对话。 */
  private currentTaskId: number | null = null;

  constructor(private readonly options: AssistantRuntimeOptions) {
    this.sessionKey = options.sessionKey ?? 'boss-channel:assistant';
    this.gateSessionKey = `${this.sessionKey}:${randomUUID()}`;
    this.now = options.clock ?? (() => Date.now());
  }

  /** 跑一转：返回幕僚长回复（已落 `human_messages(out)`）。 */
  async runTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
    const { db, runtime } = this.options;
    const taskId = input.taskId ?? null;
    this.currentTaskId = taskId;
    const startedArgs = new Map<string, Record<string, unknown>>();

    const onEvent = (event: AgentEvent): void => {
      if (event.type === 'text_delta') {
        this.options.onTextDelta?.(event.delta);
        return;
      }
      // G5：思考流（幕僚长频道不入库；仅显式分支以保持下面的 `tool_call_end` 窄化）
      if (event.type === 'thinking_delta') return;
      if (event.type === 'tool_call_start') {
        startedArgs.set(event.toolCallId, event.input);
        persistToolCallEvent(
          db,
          { taskId, actor: 'assistant' },
          { toolCallId: event.toolCallId, toolName: event.toolName, phase: 'start', input: event.input },
          this.now(),
        );
        return;
      }
      // tool_call_end
      let isError = event.isError;
      let errorMsg: string | undefined;
      if (event.toolName === 'report_progress' && taskId != null) {
        const args = startedArgs.get(event.toolCallId) ?? {};
        try {
          projectProgressReported(db, {
            taskId,
            stepIdx: Number(args.stepIdx),
            state: args.state as PlanStepState,
            note: typeof args.note === 'string' ? args.note : undefined,
            actor: 'assistant',
            at: this.now(),
          });
        } catch (error) {
          // 参数非法不静默：记为 error 的 tool_call（审计可见），但不阻断回复落库
          isError = true;
          errorMsg = error instanceof Error ? error.message : String(error);
        }
      }
      // OPT-M3-1：`request_review` 工具 → 落 `review_requested` 事件（指派/强制度由引擎 requestReview 决定）
      if (event.toolName === 'request_review' && taskId != null) {
        const args = startedArgs.get(event.toolCallId) ?? {};
        insertTaskEvent(db, {
          taskId,
          ts: this.now(),
          kind: 'review_requested',
          actor: 'assistant',
          payload: { reason: typeof args.reason === 'string' ? args.reason : null },
        });
      }
      persistToolCallEvent(
        db,
        { taskId, actor: 'assistant' },
        { toolCallId: event.toolCallId, toolName: event.toolName, phase: 'end', isError, error: errorMsg },
        this.now(),
      );
    };

    const task = taskId != null ? (getTaskById(db, taskId) as { project_id?: number | null } | undefined) : undefined;
    // D-19：当前项目优先级＝任务 project_id → 桌面当前选中项目 → 无（只读）。
    const projectId = task?.project_id ?? input.projectId ?? null;
    const project = projectId != null ? getProjectById(db, projectId) : undefined;
    const runCwd = project?.root_dir ?? this.options.cwd;
    // D-19 P1：项目写模式（read-only/confirm/auto；无项目恒只读）。判定仍由同一 `permissionGate`。
    const writeMode = resolveAssistantWriteMode(db, projectId);
    const gatePolicy = assistantGatePolicy(writeMode);
    const gateSessionId =
      this.options.toolGate && typeof runtime.sessionIdFor === 'function'
        ? runtime.sessionIdFor({ sessionKey: this.sessionKey, cwd: runCwd })
        : null;
    if (gateSessionId && this.options.toolGate) {
      this.options.toolGate.setRun(gateSessionId, {
        employeeId: 0,
        taskId,
        projectId,
        cwd: runCwd,
        projectRoot: project?.root_dir ?? this.options.cwd,
        capabilityTier: gatePolicy.capabilityTier,
        autonomy: gatePolicy.autonomy,
        writeMode,
        // 本次应用会话维度：`approve_once` 的 grant 只在这里生效；重启/换会话不会变成永久授权。
        sessionKey: this.gateSessionKey,
      });
    }
    const memoryText = renderBrief(
      new SqliteMemoryStore(db).brief({
        principal: { kind: 'assistant' },
        projectId,
        taskId,
        text: input.text,
      }).sections,
    );
    const scopePrompt =
      project != null
        ? // 范围规则（2026-10-26 频道范围选择器）：读放写收——查任何项目都可，动只能动当前项目。
          assistantWriteModePrompt(writeMode, project.name, project.root_dir) +
          `
范围规则：你可以用 task_status 查任何项目的任务状态（按任务号）；但命令与文件读写只限当前项目「${project.name}」。` +
          '老板要你动其他项目时，请他在频道上方「当前范围」切换后再说，不要越界尝试。'
        : '本轮未绑定项目（只读档）：可以聊天、可以用 task_status 查任务状态；命令与文件读写都不可用。'
          + '若老板要你执行命令、列目录或读写文件，不要反复尝试被拦的命令——直接回复：「请先在左栏『项目树』选择一个项目，选中后我才能在项目里干活。」';
    const systemPrompt = [this.options.systemPrompt, scopePrompt, memoryText]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n\n');

    let result: Awaited<ReturnType<AgentRuntime['run']>>;
    try {
      result = await runtime.run(
        {
          sessionKey: this.sessionKey,
          prompt: input.text,
          systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined,
          cwd: runCwd,
        },
        onEvent,
      );
    } finally {
      if (gateSessionId) this.options.toolGate?.clearRun(gateSessionId);
      this.currentTaskId = null;
    }

    // C2：幕僚长会话＝**公司级开销**（无任务可挂；taskId=null）。无用量不写行（不臆造）。
    const usage = result.usage;
    if (usage && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.costUsd ?? 0) > 0) {
      try {
        recordCost(db, {
          taskId: null,
          employeeId: 0,
          model: usage.model ?? 'unknown',
          tokensIn: usage.inputTokens ?? 0,
          tokensOut: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          usd: usage.costUsd ?? 0,
          now: Date.now(),
        });
      } catch (error) {
        console.error('[cost] 公司级成本落库失败（会话继续）', error);
      }
    }
    const reply = insertHumanMessage(db, {
      direction: 'out',
      taskId,
      content: result.text,
      now: this.now(),
    });

    return { reply: result.text, replyMessageId: reply.id, toolCalls: result.toolCalls, usage: result.usage };
  }

  /**
   * RM-5：卡片落库时中止**同一任务**的幕僚长会话，避免批准前继续写文件/外发。
   * 不是当前任务 → false（不误伤别的对话）；运行时未实现 abort → false（如实）。
   */
  abortForTask(taskId: number | null): boolean {
    if (this.currentTaskId !== taskId) return false;
    return this.options.runtime.abortSession?.(this.sessionKey) ?? false;
  }

  /** 老板插话 → steer 目标会话（FLOWS F4）。 */
  steer(text: string): boolean {
    return this.options.runtime.steer(this.sessionKey, text);
  }

  dispose(): void {
    this.options.runtime.dispose();
  }
}
