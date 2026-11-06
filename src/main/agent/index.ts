/**
 * `src/main/agent` 公共出口 —— 会话运行时接缝 + 幕僚长运行时 + 工具事件落库。
 *
 * 真实 Pi 实现（`@earendil-works/pi-coding-agent`）在 `pi-runtime.ts`（装配时接上）；
 * 单测用 `makeFakeAgentRuntime`（DEV §9）。
 */
export type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentRuntime,
  AgentToolCallRecord,
  AgentUsage,
  EmployeeContextInput,
  EmployeeContext,
  BuildEmployeeContext,
} from './types.js';
export { employeeSessionKey, EmployeeSessionRuntime, type EmployeeRunInput } from './employee-runtime.js';
export { createEmployeeExecutor, parseDispatchAction, parsePlanningAction, parseReviewAction, sanitizeThinking, AGENT_THINKING_MAX, type EmployeeExecutorDeps } from './employee-executor.js';
export { buildPlanningContext, buildReviewContext, plannerRoleLayer, reviewRoleLayer, type PlanningContextInput, type ReviewContextInput } from './context.js';
export { plannerSessionKey, reviewSessionKey, deriveSessionId } from './employee-runtime.js';
export {
  createLazyEmployeeRuntime,
  createUnavailableExecutorInline,
  defaultSessionDir,
  EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER,
  type CreateEmployeeRuntimeOptions,
  type CreateLazyEmployeeRuntimeOptions,
  type EmployeeRuntimeBundle,
  type LazyEmployeeRuntime,
  type AssemblyStatus,
} from './employee-factory.js';
export { projectRawConversation, redactArgsDigest, ARGS_DIGEST_MAX, type RawItem, type ProjectRawConversationOptions } from './raw-conversation.js';
export { makeFakeAgentRuntime, type FakeAgentRuntime } from './fake-runtime.js';
export {
  persistToolCallEvent,
  projectProgressReported,
  type ToolCallContext,
  type ToolCallEventInput,
  type ProgressReportedInput,
} from './tool-events.js';
export {
  AssistantRuntime,
  type AssistantRuntimeOptions,
  type AssistantTurnInput,
  type AssistantTurnResult,
} from './assistant.js';
