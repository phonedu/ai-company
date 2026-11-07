/**
 * OPT-AI-1 · 员工运行时**封装工厂**（2398② 拍板：装配方只调一个工厂，工具装配与持久化在工厂内）。
 *
 * 装配方（在 `src/main/index.ts`）：
 * ```ts
 * const emp = await createEmployeeRuntime({ db, cwd: projectRoot, sessionDir: join(userData,'sessions'), buildContext });
 * // 再把 emp.createExecutor((e) => engine.dispatch(e)) 交给 new Engine(db, executor, ...)
 * ```
 *
 * **层归属（2398①）**：构造期 `systemPrompt` 只是**占位/回退**；**五层真值由 `buildContext` 在 `run(input)` 时逐次传入**——
 * 逐轮生效的承接在 `pi-runtime`（`sessionSystemPrompts` ＋ `before_agent_start` 强制注入）；
 * 注：2026-10-14 真机暴露过"传了没生效"（override 只求值一次被占位符锁死），见 `pi-runtime.registerSystemPromptInjection` 头注。
 *
 * **无凭据（2402③）**：本工厂**抛错**（`createPiAgentRuntime` 缺凭据即抛）；**装配方不得回落录制桩**，
 * 应转为「不可用执行器」：`dispatch` 立即失败 + `work_item_failed{reason:'no_credential'}` + error 日志。
 *
 * **cwd 限制（如实）**：会话 cwd = 构造期 `cwd`（M1 默认 `inplace`，任务工作目录 == 项目根，成立）；
 * **按 worktree/staging 的任务级 cwd 隔离留 M2**（需会话按 `(sessionKey,cwd)` 分区）。
 */
import { join } from 'node:path';

import { createPiAgentRuntime, registerToolActivationGuard, type PiAgentRuntime } from './pi-runtime.js';
import { TouchedPathRecorder } from './touched-path-recorder.js';
import { createCompactionHandoffProvider } from './compaction-handoff.js';
import { createRepoMapTool } from './repo-map-tool.js';
import { isRepoMapEnabled } from './repo-map.js';
import { getFallbackChain, isModelKeyAvailable, isProviderUnavailableError, resolveAssembleModel, type AssembleModel } from './model-policy.js';
import { EmployeeSessionRuntime } from './employee-runtime.js';
import { createEmployeeExecutor, type EmployeeExecutorDeps } from './employee-executor.js';
import { createAssistantModelChooser } from './assistant-model.js';
import { SessionToolGate, persistSessionGateDecision } from './session-tool-gate.js';
import { createReportProgressTool } from './report-progress-tool.js';
import { createRequestReviewTool } from './request-review-tool.js';
import { createSubmitWorkItemTool } from './submit-work-item-tool.js';
import { createSubmitReviewTool } from './submit-review-tool.js';
import { createSubmitPlanTool } from './submit-plan-tool.js';
import { createAskColleagueTool } from './ask-colleague-tool.js';
import { createAnswerColleagueTool } from './answer-colleague-tool.js';
import { createEscalateToBossTool } from './escalate-to-boss-tool.js';
import { createMcpTools } from './mcp-tool.js';
import { createLoadSkillTool } from './skill-tool.js';
import type { BuildEmployeeContext } from './types.js';
import type { EffectExecutor, EngineEvent } from '../engine/types.js';
import { createWriteNoteTool } from './write-note-tool.js';

/** 构造期占位提示词（真值由 `buildContext` 在 run 时逐次传入并由 `pi-runtime` 每轮强制注入；此处仅防「没传」的空洞）。 */
export const EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER =
  '[平台底座] ai-company 员工（层真值由执行器在运行时注入）。';

export interface CreateEmployeeRuntimeOptions {
  /** SQLite 句柄。 */
  db: unknown;
  /** 构造期 cwd（M1 默认 = 项目根；见文件头 cwd 限制）。 */
  cwd: string;
  /** 会话落盘目录（用户数据目录，如 `<userData>/sessions`）。 */
  sessionDir: string;
  /** P2：工具大输出归档根（缺省不归档；小输出不受影响）。 */
  toolOutputDir?: string;
  /** 上下文组装（`agent/context.ts`）。 */
  buildContext?: BuildEmployeeContext;
  provider?: string;
  model?: string;
  /** G1：会话内工具闸门开关（默认开）；`false` 仅用于测试。 */
  sessionToolGate?: boolean;
  /** G1：决策写入者（缺省 `persistSessionGateDecision`：deny→事件 / ask→事件+approvals）。 */
  onPermissionDecision?: (info: import('./session-tool-gate.js').GateDecisionInfo) => void;
  /** B2-4/D-30：实测路径登记回调（引擎 `recordWorkItemTouchedPaths`；缺省不采集，如实降级）。 */
  onTouchedPaths?: (workItemId: number, paths: string[]) => void;
}

export interface EmployeeRuntimeBundle {
  /** 会话运行时（如需单独用/测试）。 */
  runtime: EmployeeSessionRuntime;
  /** 建执行器；`dispatch`/`recordCost` 由装配方接成引擎入口（解决 engine↔executor 循环）。 */
  createExecutor(
    dispatch?: (event: EngineEvent) => Promise<void> | void,
    recordCost?: EmployeeExecutorDeps['recordCost'],
  ): EffectExecutor;
  dispose(): void;
  modelRef: string;
  credentialSource: 'env' | 'file';
}

export async function createEmployeeRuntime(options: CreateEmployeeRuntimeOptions): Promise<EmployeeRuntimeBundle> {
  // 工具**先造好**（异步工厂），再在同步的 extensionFactories 闭包里注册（与 pi-assistant 同构）。
  const [reportProgress, requestReview, submitWorkItem, askColleague, answerColleague, submitReview, escalateToBoss, submitPlan, loadSkill, writeNote] = await Promise.all([
    createReportProgressTool(),
    createRequestReviewTool(),
    createSubmitWorkItemTool(),
    createAskColleagueTool(),
    createAnswerColleagueTool(),
    createSubmitReviewTool(),
    createEscalateToBossTool(),
    createSubmitPlanTool(),
    createLoadSkillTool(),
    // RW-22（M5 真机 S9 批）：此前只 import 未挂载＝员工会话里根本没有 write_note——
    // K1 的「员工写项目笔记」通路是死功能（真机实锤：mcp_list 未分配、tool_search 无果、验证 fail）。
    createWriteNoteTool(options.db as never),
  ]);
  // OPT-AI-10：MCP 工具（mcp_list 只读 / mcp_call 逐次过闸门）。
  const { mcpList, mcpCall, toolSearch } = await createMcpTools(options.db as never);

  // G1：会话内工具闸门（与引擎动作同一套解析；决策缺省由 agent 层落库，装配层可覆盖）。
  const toolGate =
    options.sessionToolGate === false
      ? undefined
      : new SessionToolGate({
          db: options.db as never,
          defaults: { projectRoot: options.cwd },
          onDecision: options.onPermissionDecision ?? ((info) => persistSessionGateDecision(options.db as never, info)),
        });

  // B2-4/D-30：实测路径采集器（与权限闸门同点位 `tool_call` 执行前；复用闸门登记的会话归属）。
  const touchedPathRecorder = options.onTouchedPaths
    ? new TouchedPathRecorder({
        sessionFor: (sessionId) => {
          const run = toolGate?.runOf(sessionId) ?? null;
          return run ? { workItemId: run.workItemId ?? null, cwd: run.cwd, projectRoot: run.projectRoot ?? null } : null;
        },
        report: (workItemId, paths) => options.onTouchedPaths!(workItemId, paths),
      })
    : null;

  // RET-1 P3（A/B）：`AICO_REPO_MAP=on` 时注册确定性 repo_map（只读、零 LLM）。
  const repoMapTool = isRepoMapEnabled() ? await createRepoMapTool(options.cwd) : null;

  // RW-52 同因（2026-11-05）：员工会话同样落盘（persistDir）——注册与守卫共用**同一名单**
  // （名单取自工具对象本身，单一真值）；resume 快照丢新工具的机制与守卫口径见
  // `pi-runtime.ts registerToolActivationGuard`。全部为默认 `direct` 曝光（可声明给模型）。
  const employeeTools: unknown[] = [
    reportProgress,
    requestReview,
    submitWorkItem,
    askColleague,
    answerColleague, // BRK12：被问员工作答（宿主校验归属并唤醒提问者）
    submitReview,
    escalateToBoss, // R2-2（G9）：升级给老板（宿主落 AskCard ＋ 任务转 needs_decision）
    submitPlan, // R3-1：规划会话的结构化计划信号（宿主发 `plan_drafted`）
    loadSkill, // GAP7：按需加载本会话白名单内的技能全文
    mcpList, // GAP6：本会话分配的 MCP server/工具发现（deferred 不预列）
    toolSearch, // B5：按需发现 MCP 工具（含 deferred/codemode）
    mcpCall, // GAP6：MCP 调用（external；逐次批准）
    writeNote, // K1/RW-22：员工 write_note（当前任务项目的 .aico/notes/ 沉淀）
  ];
  if (repoMapTool) employeeTools.push(repoMapTool); // RET-1 P3：确定性仓库地图（A/B）

  const pi: PiAgentRuntime = await createPiAgentRuntime({
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    systemPrompt: EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER,
    persistDir: options.sessionDir,
    toolOutputDir: options.toolOutputDir,
    // CTX1-3：压缩成功后从真库重建交接块（并落 compaction_handoff 审计事件）。
    buildCompactionHandoff: createCompactionHandoffProvider(options.db as never),
    extensionFactories: [
      (api) => {
        const register = (api as { registerTool(t: unknown): void }).registerTool;
        for (const tool of employeeTools) register.call(api, tool);
        registerToolActivationGuard(api, employeeTools.map((tool) => (tool as { name: string }).name));
        // G1：会话内工具调用过 `permissionGate`（同一套解析）。
        toolGate?.register(api as never);
        // B2-4：实测路径采集（工具执行前登记；采集失败不反噬会话）。
        touchedPathRecorder?.register(api as never);
      },
    ],
  });

  const runtime = new EmployeeSessionRuntime(pi, { toolGate });
  // D-22 assistant：选型缓存挂在 bundle 上（lazy 装配每次 execute 都会 createExecutor；
  // 若 chooser 建在里面，每次派发都重建缓存，重试/重规划会重复真实选型并计费）。
  let chooser: ReturnType<typeof createAssistantModelChooser> | null = null;
  let chooserCostSink: EmployeeExecutorDeps['recordCost'];
  const getChooser = (): ReturnType<typeof createAssistantModelChooser> => {
    if (chooser) return chooser;
    chooser = createAssistantModelChooser({
      onUsage: (usage, input) => {
        const sink = chooserCostSink;
        if (!sink) return;
        void Promise.resolve(
          sink({
            taskId: input.taskId,
            workItemId: null,
            employeeId: 0,
            model: usage.model,
            tokensIn: usage.input,
            tokensOut: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            usd: usage.costUsd,
            projectId: input.projectId ?? null,
            source: 'assistant_selection',
            now: Date.now(),
          }),
        ).catch((error: unknown) => {
          console.warn(`[cost] 幕僚长选型用量记账失败：${error instanceof Error ? error.message : String(error)}`);
        });
      },
    });
    return chooser;
  };
  return {
    runtime,
    createExecutor: (dispatch, recordCost) => {
      chooserCostSink = recordCost;
      const chooseAssistantModel = getChooser();
      return createEmployeeExecutor({
        db: options.db,
        runtime,
        buildContext: options.buildContext,
        dispatch,
        recordCost,
        // D-22：选择期 Key 硬校验（真凭据面；只看可用性，不返回明文）。
        modelKeyConfigured: isModelKeyAvailable,
        chooseAssistantModel,
      });
    },
    dispose: () => runtime.dispose(),
    modelRef: pi.modelRef,
    credentialSource: pi.credentialSource,
  };
}

/** 默认会话落盘目录（用户数据目录约定；装配方传入 `<userData>/sessions` 亦可）。 */
export function defaultSessionDir(userDataDir: string): string {
  return join(userDataDir, 'sessions');
}

// ───────────────────────── OPT-AI-1 · 懒装配（启动不被阻塞；2564/2570） ─────────────────────────

/** 装配状态（**三态可见**：装配中 / 就绪(credentialSource,model,耗时) / 失败(原因)）。 */
export type AssemblyStatus =
  | { state: 'idle' }
  | { state: 'assembling'; startedAt: number }
  | { state: 'ready'; modelRef: string; credentialSource: 'env' | 'file'; elapsedMs: number }
  | { state: 'failed'; reason: string; elapsedMs: number };

const NO_CREDENTIAL_REASON_ASSEMBLY_FAILED = 'assembly_failed';

export interface CreateLazyEmployeeRuntimeOptions extends CreateEmployeeRuntimeOptions {
  /** 装配超时（ms；默认 30s）——超时/失败 → 不可用态，**不换桩**。 */
  timeoutMs?: number;
  /** 状态变更回调（打日志/UI 可见用）。 */
  onStatus?: (status: AssemblyStatus) => void;
  /** 可注入的装配器（默认真实工厂；测试用 fake）。 */
  assemble?: (o: CreateEmployeeRuntimeOptions) => Promise<EmployeeRuntimeBundle>;
  /** N2：装配期档位解析（缺省＝ `resolveAssembleModel`，按 `AICO_MODEL`/`AICO_ECONOMY_MODEL` 与当前档位）。 */
  resolveModel?: () => AssembleModel;
  /** 失败时的执行器（默认：内置"失败可见"不可用执行器）。 */
  onUnavailable?: (reason: string) => EffectExecutor;
}

export interface LazyEmployeeRuntime {
  /** 交给 `new Engine(db, executor)` 的执行器：**首次派发时才装配**（不阻塞启动）。 */
  createExecutor(
    dispatch?: (event: EngineEvent) => Promise<void> | void,
    recordCost?: EmployeeExecutorDeps['recordCost'],
  ): EffectExecutor;
  /** 主动预热（后台/首次派发前）；幂等。 */
  warmUp(): Promise<AssemblyStatus>;
  /** 凭据变更后丢弃已装配运行时；下一次派发重新装配（保存/清除 Key 即时生效）。 */
  reset(): void;
  status(): AssemblyStatus;
  /** BRK9（挂载 2）：老板插话（steer）——透传到已装配的员工会话；未装配/装配失败 ⇒ `false`（如实，不假装送出）。 */
  steer(sessionKey: string, text: string): boolean;
  /** BRK17（挂载 3 余·取消小步）：**真中止**员工会话（任务级取消 → 停在该件上跑着的会话）；未装配 ⇒ `false`（如实）。 */
  abort(sessionKey: string): boolean;
  dispose(): void;
}

/** 内置不可用执行器：work_item `dispatch` 立即 `error{reason}`（工作项机真事件，BRK2）＋ 任务级 phase 派发
 *  **升级给老板**（`escalate`，规划静默修 2026-10-15）＋ error 日志（**绝不换桩**）。 */
export function createUnavailableExecutorInline(
  reason: string,
): (dispatch?: (event: EngineEvent) => Promise<void> | void) => EffectExecutor {
  return (dispatch) => ({
    async execute(action): Promise<void> {
      // 任务级 phase 派发：装配不可用时必须响亮（与独立模块同款；见 unavailable-executor.ts 头注）。
      if (action.kind === 'dispatch_planning' || action.kind === 'dispatch_critic' || action.kind === 'dispatch_verifier') {
        if (action.taskId == null) return;
        // C1b：装配期“模型不存在/不可用”走 failed＋异常卡；完全无凭据仍按 C8 出决策卡。
        if (action.kind === 'dispatch_planning' && isProviderUnavailableError(reason)) {
          const taskReason = `模型/凭据不可用：${reason}`;
          console.error(`[agent] 模型/凭据不可用（${reason}）→ ${action.kind} 进 failed（task ${action.taskId}）`);
          await dispatch?.({
            scope: 'task',
            id: action.taskId,
            event: 'error',
            actor: 'system',
            payload: { reason: taskReason, phase: 'planning' },
          });
          return;
        }
        console.error(`[agent] 员工会话不可用（${reason}）→ ${action.kind} 升级给老板（task ${action.taskId}）`);
        await dispatch?.({
          scope: 'task',
          id: action.taskId,
          event: 'escalate',
          actor: 'system',
          payload: { reason, phase: action.kind.slice('dispatch_'.length) },
        });
        return;
      }
      const parts = action.actionKey.split(':');
      if (action.kind !== 'dispatch' || parts[1] !== 'work_item' || action.taskId == null) return;
      const workItemId = Number(parts[2]);
      console.error(`[agent] 员工会话不可用（${reason}）→ 未执行任何动作（work_item ${workItemId}）`);
      await dispatch?.({ scope: 'work_item', id: workItemId, event: 'error', actor: 'system', payload: { reason } });
    },
  });
}

/**
 * **懒装配**：构造期**零阻塞**（不 await Pi）；首次 `createExecutor().execute()` 或显式 `warmUp()` 才装配，
 * 带超时；超时/失败 → 不可用态（失败可见），**绝不回落录制桩**。
 */
export function createLazyEmployeeRuntime(options: CreateLazyEmployeeRuntimeOptions): LazyEmployeeRuntime {
  const assemble = options.assemble ?? createEmployeeRuntime;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let status: AssemblyStatus = { state: 'idle' };
  let bundle: EmployeeRuntimeBundle | null = null;
  let inflight: Promise<AssemblyStatus> | null = null;
  let epoch = 0;

  const set = (s: AssemblyStatus): AssemblyStatus => {
    status = s;
    options.onStatus?.(s);
    return s;
  };

  const doAssemble = (): Promise<AssemblyStatus> => {
    const myEpoch = epoch;
    const startedAt = Date.now();
    set({ state: 'assembling', startedAt });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`模型服务连接超时（${timeoutMs}ms）：网络不可用或服务不可达`)),
        timeoutMs,
      );
    });
    // N2：**装配期**解析档位（超阈后新装配的会话走省钱档；在跑会话不打断）
    const modelRef = (options.resolveModel ?? resolveAssembleModel)();
    const provider = options.provider ?? modelRef.provider;
    const model = options.model ?? modelRef.model;
    const assembleWith = (p: string | undefined, m: string | undefined) =>
      Promise.race([assemble({ ...options, provider: p, model: m }), timeout]);
    return assembleWith(provider, model)
      .catch((e: unknown) => {
        // C1 真机（2026-10-17）：默认模型不存在时装配失败，兜底链此前完全没有机会启动。
        // 装配期若命中供应商不可用，先用链首模型把会话装配起来；每个会话仍按默认档解析，
        // 后续 `runSessionWithFallback` 会真实失败→降级→记 `agent_model_fallback`（不伪造降级）。
        const message = e instanceof Error ? e.message : String(e);
        const fallback = getFallbackChain().find((m) => m !== `${provider}/${model}`) ?? null;
        if (!isProviderUnavailableError(message) || fallback == null) throw e;
        const slash = fallback.indexOf('/');
        const fbProvider = slash > 0 ? fallback.slice(0, slash) : provider;
        const fbModel = slash > 0 ? fallback.slice(slash + 1) : fallback;
        console.warn(`[agent] 装配期模型不可用 → 用兜底档重试装配：${provider}/${model} → ${fbProvider}/${fbModel}（${message.slice(0, 140)}）`);
        return assembleWith(fbProvider, fbModel);
      })
      .then((b) => {
        if (myEpoch !== epoch) {
          (b as EmployeeRuntimeBundle).dispose();
          return status;
        }
        bundle = b as EmployeeRuntimeBundle;
        return set({ state: 'ready', modelRef: (b as EmployeeRuntimeBundle).modelRef, credentialSource: (b as EmployeeRuntimeBundle).credentialSource, elapsedMs: Date.now() - startedAt });
      })
      .catch((e: unknown) => {
        if (myEpoch !== epoch) return status;
        const reason = e instanceof Error ? e.message : String(e);
        return set({ state: 'failed', reason, elapsedMs: Date.now() - startedAt });
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  };

  const warmUp = (): Promise<AssemblyStatus> => {
    if (status.state === 'ready' || status.state === 'failed') return Promise.resolve(status);
    if (!inflight) inflight = doAssemble();
    return inflight;
  };

  return {
    async warmUp() {
      return warmUp();
    },
    status: () => status,
    reset(): void {
      epoch += 1;
      bundle?.dispose();
      bundle = null;
      inflight = null;
      set({ state: 'idle' });
    },
    steer(sessionKey: string, text: string): boolean {
      // BRK9：未装配/装配失败 ⇒ false（如实）；装配就绪 ⇒ 透传（会话不在飞也会 false——由 pi-runtime 判）。
      if (!bundle || status.state !== 'ready') return false;
      return bundle.runtime.steer(sessionKey, text);
    },
    abort(sessionKey: string): boolean {
      // BRK17（取消小步）：未装配/装配失败 ⇒ false（如实——停不了就别说停了）；就绪 ⇒ 透传真中止。
      if (!bundle || status.state !== 'ready') return false;
      return bundle.runtime.abort(sessionKey);
    },
    dispose: () => bundle?.dispose(),
    createExecutor(dispatch, recordCost) {
      const unavailableFactory = options.onUnavailable;
      const fallback = (reason: string): EffectExecutor =>
        unavailableFactory ? unavailableFactory(reason) : createUnavailableExecutorInline(reason)(dispatch);
      return {
        async execute(action): Promise<void> {
          const s = await warmUp();
          if (s.state !== 'ready' || !bundle) {
            await fallback(s.state === 'failed' ? s.reason : NO_CREDENTIAL_REASON_ASSEMBLY_FAILED).execute(action);
            return;
          }
          await bundle.createExecutor(dispatch, recordCost).execute(action);
        },
      };
    },
  };
}
