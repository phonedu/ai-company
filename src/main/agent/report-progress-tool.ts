/**
 * `report_progress` customTool 定义（五工具之一； 只实做这一个）。
 *
 * 参数（字段契约权威：``；与 `` 第 8 条投影对齐）：
 *   `{ stepIdx: number(>=1), state: 'pending'|'running'|'done'|'skipped'|'failed', note?: string }`
 *
 * ⚠️ 本工具**只做信号**：真正的落库（`progress_reported` 事件 + `plan_steps` 投影）由宿主
 * （`AssistantRuntime` 观察 tool_call 事件）统一完成，避免双写。execute 仅回执。
 */
export const REPORT_PROGRESS_STATES = ['pending', 'running', 'done', 'skipped', 'failed'] as const;

/**
 * ⚠️ ESM/CJS 集成约束（spike 结论）：`@earendil-works/pi-coding-agent` 与 `pi-ai` 都是
 * **ESM-only**（`exports` 无 `require` 条件），而主进程被打成 **CJS**。故本模块**不得静态 import**
 * 二者（静态 import 在 CJS bundle 里会变成 `require()` → `ERR_PACKAGE_PATH_NOT_EXPORTED`）；
 * 一律在**异步工厂内动态 `import()`**，与 `pi-runtime.ts` 的懒加载策略一致。
 */
export async function createReportProgressTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'report_progress',
    label: 'Report Progress',
    description:
      '上报计划步骤进度。stepIdx 从 1 起；state ∈ pending|running|done|skipped|failed；可选 note 说明。' +
      '宿主会把这一步投影进任务进度条。',
    parameters: Type.Object({
      stepIdx: Type.Number({ minimum: 1, description: '计划步骤序号（从 1 起）' }),
      state: Type.Union(
        REPORT_PROGRESS_STATES.map((s) => Type.Literal(s)),
        { description: '该步骤当前状态' },
      ),
      note: Type.Optional(Type.String({ description: '可选补充说明' })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: 'text',
            text: `已上报进度：第 ${params.stepIdx} 步 → ${params.state}${params.note ? `（${params.note}）` : ''}`,
          },
        ],
        details: { stepIdx: params.stepIdx, state: params.state },
      };
    },
  });
}
