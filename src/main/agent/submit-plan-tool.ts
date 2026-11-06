/**
 * `submit_plan` customTool（R3-1：**planning 会话的结构化信号**）。
 *
 * ⚠️ **只做信号**：真正的状态驱动（`plan_drafted` 事件 → `ready`（L0 直通）/ 启动 critic（L1/L2）、
 * `plan_steps` 投影）由宿主（`employee-executor.ts` 读 `toolCalls` 后 dispatch）完成，避免双写。
 * ESM/CJS 约束同其它工具：异步工厂内动态 `import()`。
 */
import { PLAN_STEPS_MAX } from '../../core/plan.js';

export { PLAN_STEPS_MAX };

export async function createSubmitPlanTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'submit_plan',
    label: 'Submit Plan',
    description: `提交任务计划：1–${PLAN_STEPS_MAX} 步，每步一句**可执行、可验收**的话（不写代码、不做调研）。steps 会投影到任务详情的「计划与验收」。`,
    parameters: Type.Object({
      steps: Type.Array(Type.String({ description: '一步一句话' }), { description: `计划步骤（1–${PLAN_STEPS_MAX}）` }),
      notes: Type.Optional(Type.String({ description: '补充说明（可选；不得替代 steps）' })),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: 'text', text: `已提交计划：${params.steps.length} 步` }], details: params };
    },
  });
}
