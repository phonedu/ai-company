/**
 * `submit_work_item` customTool（EMPLOYEES §2 五工具之一；OPT-AI-1 接入；**OPT-AI-7 加校验**）。
 *
 * ⚠️ **只做信号**：真正的状态迁移（`running → submitted`）由宿主（`employee-executor.ts`
 * 观察 tool_call 结果）发引擎事件 `submit_work_item` 统一完成，避免双写。
 * **校验**（OPT-AI-7）：入参在**工具侧先校验**（`validateSubmission`，单一真源）——非法即抛错回模型
 * （模型可据此重交）；宿主侧**再审一遍**兜底（防绕过）。
 *
 * ESM/CJS 约束同 `report-progress-tool.ts`：不得静态 import，异步工厂内动态 `import()`。
 */
import { validateSubmission } from './submission.js';

export async function createSubmitWorkItemTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'submit_work_item',
    label: 'Submit Work Item',
    description:
      '提交本工作项成果。调用后本工作项进入 `submitted`（等待验证）。summary 必填（一句话结论，≤500 字）；artifacts/evidence/assumptions/unclosed 可选（字符串数组，各 ≤50 条）。**校验不过会被拒绝并说明原因——按提示修正后重交。**',
    parameters: Type.Object({
      summary: Type.String({ description: '一句话结论（必填，≤500 字）' }),
      artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '产物路径/URL/产出的文件名列表（≤50 条）；**不要放说明文字或提交号**（含空白/控制字符会被拒——说明放 summary/evidence，提交号由系统自己记录）',
        }),
      ),
      evidence: Type.Optional(Type.Array(Type.String(), { description: '证据（命令/输出/URL）列表（≤50 条）' })),
      assumptions: Type.Optional(Type.Array(Type.String(), { description: '所做假设（≤50 条）' })),
      unclosed: Type.Optional(Type.Array(Type.String(), { description: '未决/遗留项（≤50 条）' })),
    }),
    async execute(_toolCallId, params) {
      // OPT-AI-7：校验不过 → **抛错**（模型能看到原因并重交；不静默收下脏提交）
      const checked = validateSubmission(params);
      if (!checked.ok) {
        throw new Error(`submit_work_item 校验失败：${checked.errors.join('；')}`);
      }
      return {
        content: [{ type: 'text', text: `已提交工作项：${checked.value.summary}` }],
        details: checked.value,
      };
    },
  });
}
