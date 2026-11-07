/**
 * `submit_review` customTool（G4/RC-5：critic / verifier 会话的**结构化结论**信号）。
 *
 * ⚠️ **只做信号**：真正的状态驱动（critic→`plan_reviewed`/`revise`；verifier→`verification_completed` + `recordVerdict`）
 * 由宿主（`employee-executor.ts` 读 `toolCalls`）完成，避免双写。
 * ESM/CJS 约束同其它工具：异步工厂内动态 `import()`。
 */
export const REVIEW_VERDICTS = ['approve', 'revise', 'pass', 'fail'] as const;

export async function createSubmitReviewTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'submit_review',
    label: 'Submit Review',
    description:
      '提交评审结论（critic 用 approve|revise；verifier 用 pass|fail）。notes 写明理由/证据。**verifier 证据不足必须 fail**。' +
      ' verifier：只要计划步骤不是**全部 done**，pass 就必须填 planStepsNote 逐条交代（宿主机器校验：未交代的 pass 会被改判 fail 并返工）。',
    parameters: Type.Object({
      verdict: Type.Union(REVIEW_VERDICTS.map((v) => Type.Literal(v)), { description: '评审结论' }),
      notes: Type.Optional(Type.String({ description: '理由/证据（可选）' })),
      // F-02（2026-11-06 老板裁）：计划步骤未完成**不是硬门**，但必须交代；
      // 独立字段便于宿主机器校验（写在 notes 里不算），也便于 UI 定向展示。
      planStepsNote: Type.Optional(
        Type.String({
          description:
            '仅 verifier：计划有未完成步骤时**必填**——逐条写「第 N 步：状态 / 为什么没做 / 结论」；全部完成或 critic 可省略',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: 'text', text: `已提交评审结论：${params.verdict}` }], details: params };
    },
  });
}
