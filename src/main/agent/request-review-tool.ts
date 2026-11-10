/**
 * `request_review` customTool（五工具之一；OPT- 接通）。
 *
 * 语义：员工请求**独立验证**（`` verify；强制度按 `tasks.risk_level` L0 免 / L1 抽验 / L2 强制，
 * 验证者由宿主指派且 **≠实现者** —— 见 `engine/verification.ts` 与 `Engine.requestReview`）。
 *
 * ⚠️ 本工具**只做信号**：真正的指派/落库由宿主（
 * `AssistantRuntime` 观察 tool_call → 落 `review_requested`）
 * 与引擎（`requestReview`）完成，避免双写（与 `report_progress` 同构）。
 *
 * ⚠️ ESM/CJS 约束（在 `d58f6ff` 查实）：`pi-ai`/`pi-coding-agent` **ESM-only**，主进程是 **CJS**；
 * **不得静态值导入**（会被打成 `require()` → `No "exports" main defined`，且**静默降级**）。
 * 一律在**异步工厂内动态 `import()`**（同 `report-progress-tool.ts`）。
 */
export async function createRequestReviewTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'request_review',
    label: 'Request Review',
    description:
      '请求独立验证（L2 强制 / L1 抽验；验证者由宿主指派且≠实现者）。可选 reason 说明验证重点。',
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: '验证重点（可选）' })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: `已请求独立验证${params.reason ? `（${params.reason}）` : ''}` }],
        details: {},
      };
    },
  });
}
