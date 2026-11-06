/**
 * OPT-AI-1 · 员工会话生命周期（RC-4：会话池 + **落盘持久化**）。
 *
 * 职责（2278 划定）：
 *  - 会话键解析：`employee:<id>:task:<taskId>:wi:<workItemId>`（员工×任务/工作项隔离，重试复用同键）；
 *  - 落盘：交由 `createPiAgentRuntime({ persistDir })`（`SessionManager.create/open`），重启不丢；
 *  - 复用/回收：同键串行（由 runtime 保证），`dispose()` 统一回收。
 *
 * 本模块**不依赖 Pi**（只依赖 `AgentRuntime` 接口），便于单测用 fake runtime。
 */
import type { AgentEvent, AgentRunResult, AgentRuntime } from './types.js';
import type { SessionToolGate } from './session-tool-gate.js';

/**
 * 会话 id 的**兜底**归一化（fake/旧运行时没有 `sessionIdFor` 时用）。
 * 真实 Pi 运行时用 `sessionIdForCacheKey(sessionKey@cwd)`；工具闸门必须使用后者，
 * 否则 cwd 分区后的真实 id 查不到上下文（D4：曾按 unmanaged 放行）。
 */
export function deriveSessionId(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function employeeSessionKey(input: { employeeId: number; taskId: number; workItemId?: number | null }): string {
  const wi = input.workItemId != null ? `wi:${input.workItemId}` : 'wi:-';
  return `employee:${input.employeeId}:task:${input.taskId}:${wi}`;
}

/** G4：评审会话键（与员工会话**分键**，避免上下文混用）。 */
export function reviewSessionKey(input: { role: 'critic' | 'verifier'; taskId: number; workItemId?: number | null }): string {
  const wi = input.workItemId != null ? `:wi:${input.workItemId}` : '';
  return `role:${input.role}:task:${input.taskId}${wi}`;
}

/** R3-1：规划会话键（`planning` 阶段的 plan 生产；与员工/评审会话**分键**）。 */
export function plannerSessionKey(input: { taskId: number }): string {
  return `role:planner:task:${input.taskId}`;
}

/**
 * 任务取消时要中止的**角色会话键**（C7 真机 2026-10-18）：verifier 键带 `:wi:<id>`，
 * 不能再用不带 wi 的 `role:verifier:task:<id>` 去做前缀匹配（它不匹配 `:wi:`，会话不会停）。
 */
export function roleSessionKeysForCancel(input: { taskId: number; workItemIds: readonly number[] }): string[] {
  return [
    plannerSessionKey({ taskId: input.taskId }),
    reviewSessionKey({ role: 'critic', taskId: input.taskId }),
    ...input.workItemIds.map((workItemId) =>
      reviewSessionKey({ role: 'verifier', taskId: input.taskId, workItemId }),
    ),
  ];
}

/** `EmployeeRunInput` 的会话键可选角色（G4：critic/verifier 与员工会话分键）。 */
export interface EmployeeRunInput {
  employeeId: number;
  taskId: number;
  workItemId?: number | null;
  systemPrompt: string;
  userPrompt: string;
  cwd?: string;
  /** 显式会话键（G4：critic/verifier 用 `role:…` 分键）；缺省用员工键。 */
  sessionKey?: string;
  /** N5（`R3-3`）：逐轮模型（由 `resolveSessionModel` 按角色/风险解析；运行时如实应用）。 */
  model?: string;
  /** N5：逐轮思考强度（缺省＝不动会话档位）。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  /** GAP7：本会话技能白名单（load_skill 只读这些；缺省＝无）。 */
  skills?: readonly import('./types.js').SkillRef[];
  /** GAP6：本会话 MCP server 白名单（缺省＝无）。 */
  mcps?: readonly string[];
}

/** 会话无输出上限（2026-10-24：critic 10 分钟无进展导致动作永久 pending）。 */
export const ROLE_SESSION_TIMEOUT_MS = 10 * 60_000;
/** 员工执行会话更长（真实任务可能跑很久）；超时中止并让 action 失败可见。 */
export const EMPLOYEE_SESSION_TIMEOUT_MS = 30 * 60_000;

export interface EmployeeSessionRuntimeOptions {
  toolGate?: SessionToolGate;
  /** 覆盖超时；`0` = 关闭（仅测试/特殊装配）。 */
  sessionTimeoutMs?: number;
}

export class EmployeeSessionRuntime {
  private readonly toolGate?: SessionToolGate;
  private readonly options: EmployeeSessionRuntimeOptions;

  constructor(
    private readonly runtime: AgentRuntime,
    options: EmployeeSessionRuntimeOptions = {},
  ) {
    this.options = options;
    this.toolGate = options.toolGate;
  }

  sessionKeyFor(input: { employeeId: number; taskId: number; workItemId?: number | null }): string {
    return employeeSessionKey(input);
  }

  async run(input: EmployeeRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult> {
    const sessionKey = input.sessionKey ?? this.sessionKeyFor(input);
    // G1：登记本次运行的归属上下文（门钩子按 sessionId 反查）；无论成败都清除。
    // 2026-10-19 D4：必须用运行时**实际**的 Pi session id（含 cwd 分区）；此前只用 sessionKey 归一化，
    // 落盘会话的真实 id 带 `@cwd` 后缀 ⇒ gate 查不到 ⇒ 全部按 unmanaged 放行。
    const sessionId =
      this.runtime.sessionIdFor?.({ sessionKey, cwd: input.cwd }) ?? deriveSessionId(sessionKey);
    this.toolGate?.setRun(sessionId, {
      employeeId: input.employeeId,
      taskId: input.taskId,
      workItemId: input.workItemId ?? null,
      cwd: input.cwd,
      sessionKey,
    });
    const timeoutMs =
      this.options.sessionTimeoutMs === 0
        ? 0
        : (this.options.sessionTimeoutMs ??
          (sessionKey.startsWith('role:') ? ROLE_SESSION_TIMEOUT_MS : EMPLOYEE_SESSION_TIMEOUT_MS));
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const running = this.runtime.run(
        {
          sessionKey,
          prompt: input.userPrompt,
          systemPrompt: input.systemPrompt,
          cwd: input.cwd,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          skills: input.skills,
          mcps: input.mcps,
        },
        onEvent,
      );
      if (timeoutMs <= 0) return await running;
      const timeout = new Promise<AgentRunResult>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          this.runtime.abortSession?.(sessionKey);
          reject(new Error(`[agent] 会话超时（${timeoutMs}ms，${sessionKey}）——已中止，按失败收场`));
        }, timeoutMs);
      });
      return await Promise.race([running, timeout]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.toolGate?.clearRun(sessionId);
    }
  }

  /** BRK9（挂载 2，2026-10-15）：老板插话 → steer 进行中的员工会话（透传到运行时；返回是否已投递）。 */
  steer(sessionKey: string, text: string): boolean {
    return this.runtime.steer(sessionKey, text);
  }

  /**
   * BRK17（挂载 3 余·取消小步）：**真中止**该会话键下的运行（透传到运行时 `abortSession`；
   * 运行时未实现 ⇒ false——如实，不假装已停）。
   */
  abort(sessionKey: string): boolean {
    return this.runtime.abortSession?.(sessionKey) ?? false;
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
