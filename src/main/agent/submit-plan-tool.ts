/**
 * `submit_plan` customTool（R3-1：**planning 会话的结构化信号**）。
 *
 * ⚠️ **只做信号**：真正的状态驱动（`plan_drafted` 事件 → `ready`（L0 直通）/ 启动 critic（L1/L2）、
 * `plan_steps` 投影）由宿主（`employee-executor.ts` 读 `toolCalls` 后 dispatch）完成，避免双写。
 * ESM/CJS 约束同其它工具：异步工厂内动态 `import()`。
 */
import { PLAN_STEPS_MAX, PLAN_WORK_ITEMS_MAX, PLAN_WORK_ITEM_TITLE_MAX_CHARS } from '../../core/plan.js';

export { PLAN_STEPS_MAX, PLAN_WORK_ITEMS_MAX };

export async function createSubmitPlanTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'submit_plan',
    label: 'Submit Plan',
    description: `提交任务计划：1–${PLAN_STEPS_MAX} 步，每步一句**可执行、可验收**的话（不写代码、不做调研）。steps 会投影到任务详情的「计划与验收」。任务天然可并行时用 workItems 拆 2–${PLAN_WORK_ITEMS_MAX} 件（可带 dependsOn 依赖，1-based 件序号）——调度器会无依赖并行、有依赖等前置；不确定就只给 steps（回落单件）。`,
    parameters: Type.Object({
      steps: Type.Array(Type.String({ description: '一步一句话' }), { description: `计划步骤（1–${PLAN_STEPS_MAX}）` }),
      notes: Type.Optional(Type.String({ description: '补充说明（可选；不得替代 steps）' })),
      workItems: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: `件标题（必填，≤${PLAN_WORK_ITEM_TITLE_MAX_CHARS} 字；一句话说清这件做什么）` }),
            brief: Type.Optional(Type.String({ description: '件的补充说明（可省；目标/验收已在任务级）' })),
            dependsOn: Type.Optional(Type.Array(Type.Number({ description: '依赖的件序号（1-based）' }), { description: '前置件（可省＝无依赖，可并行）' })),
            employeeId: Type.Optional(Type.Number({ description: '本件执行员工 id（可省＝按项目编制缺省链；指定在职非幕僚长员工才生效）' })),
          }),
          { description: `结构化工作项（1–${PLAN_WORK_ITEMS_MAX} 件；D-30② 多件 DAG）` },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: 'text', text: `已提交计划：${params.steps.length} 步` }], details: params };
    },
  });
}
