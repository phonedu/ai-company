/**
 * 测试用 fake 会话运行时（DEV §9：AgentRuntime 设计成接口 → 用 fake 实现单测）。
 * 不碰网络、不花真金；按脚本产出事件与结果。
 */
import type { AgentEvent, AgentRunInput, AgentRunResult, AgentRuntime } from './types.js';

export interface FakeAgentRuntime extends AgentRuntime {
  runs: AgentRunInput[];
  steers: Array<{ sessionKey: string; text: string }>;
  disposed: boolean;
}

export function makeFakeAgentRuntime(
  script: AgentRunResult[] | ((input: AgentRunInput, callIndex: number) => AgentRunResult),
): FakeAgentRuntime {
  const runs: AgentRunInput[] = [];
  const steers: Array<{ sessionKey: string; text: string }> = [];
  const fake: FakeAgentRuntime = {
    runs,
    steers,
    disposed: false,
    async run(input: AgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult> {
      const callIndex = runs.length;
      runs.push(input);
      const result =
        typeof script === 'function' ? script(input, callIndex) : (script[callIndex] ?? { text: '', toolCalls: [] });
      if (result.text) onEvent({ type: 'text_delta', delta: result.text });
      if (result.thinking) onEvent({ type: 'thinking_delta', delta: result.thinking });
      for (const call of result.toolCalls) {
        onEvent({ type: 'tool_call_start', toolCallId: call.id, toolName: call.name, input: call.input });
        onEvent({ type: 'tool_call_end', toolCallId: call.id, toolName: call.name, isError: call.isError });
      }
      return result;
    },
    steer(sessionKey: string, text: string): boolean {
      steers.push({ sessionKey, text });
      return true;
    },
    dispose(): void {
      fake.disposed = true;
    },
  };
  return fake;
}
