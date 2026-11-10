/**
 *  · few-shot 模板库（集中管理；与契约同源）。
 *
 * 口径：模板**只示范形状**（字段名/必填/粒度），不教模型编内容；示例本身不是事实、不得抄进产出。
 * 开关：`settings['prompt.fewShot']`（缺省开；显式 `false` 关——用户可关，关后本层整段不注入）。
 * 注入点：员工/规划/评审三个 system prompt（`agent/context.ts`）；模板文本只在这里维护一份。
 */

export type PromptRole = 'employee' | 'planner' | 'critic' | 'verifier';

export const FEW_SHOT_TEMPLATES: Record<PromptRole, string> = {
  employee: [
    '示例（形状，不是内容）：调用 `submit_work_item` 时提交',
    '{"summary":"一句话结论","artifacts":[{"path":"相对路径","note":"这是什么"}],"acceptance":[{"text":"验收项","passed":true}],"notes":"做了什么/没做什么"}',
    '验收项逐条给 passed；不确定就写 notes 说明，不要编造证据。',
  ].join('\n'),
  planner: [
    '示例（形状，不是内容）：调用 `submit_plan` 提交',
    '{"steps":["1. 读现有实现并定位问题","2. 做最小修改","3. 跑指定测试并留证","4. 汇报产物与未做项"]}',
    '每步一句、可执行/可验收；不要写"先向老板澄清"这类空步。',
  ].join('\n'),
  critic: [
    '示例（形状，不是内容）：调用 `submit_review` 提交',
    '{"verdict":"approve|revise","notes":"哪一步不可执行/缺哪条验收；revise 必须给出可改的具体点"}',
    '不得改需求；证据不足 → revise。',
  ].join('\n'),
  verifier: [
    '示例（形状，不是内容）：调用 `submit_review` 提交',
    '{"verdict":"pass|fail","notes":"逐条验收的证据/命令输出摘要；证据不足 → fail","planStepsNote":"计划有未完成步骤时逐条交代：第 N 步 / 状态 / 为什么没做 / 结论；全部完成可省略"}',
    '不采信实现者自述；只认证据。未完成计划步骤不是硬门，但不交代 → 宿主会把 pass 改为 fail。',
  ].join('\n'),
};

/** 生成 few-shot 层；`enabled=false` → 空串（调用方 join 时自然省略）。 */
export function fewShotLayer(role: PromptRole, enabled = true): string {
  if (!enabled) return '';
  return `[示例模板 · ${role}]（只示范形状，不示范内容；不得把示例当事实）\n${FEW_SHOT_TEMPLATES[role]}`;
}

/** 从 settings 读开关：缺省开；只有显式 `false` 才关（`null`/未设＝开）。 */
export function fewShotEnabled(value: unknown): boolean {
  return value !== false;
}
