/**
 * B-7（M4）· 建任务「建议档＋一句理由」（N5）。
 *
 * 口径：
 *  - **先读项目默认档**（D-11 编制）；项目有默认档时，建议＝项目默认档，理由明说来源；
 *  - 无项目默认档才用目标文本的保守启发式（不冒充模型判断）；
 *  - 只是建议：不覆盖用户手选；采用必须由用户点「采用建议」。
 */
export type TaskRiskTier = 0 | 1 | 2;

export interface TaskTierSuggestion {
  tier: TaskRiskTier;
  reason: string;
  source: 'project-default' | 'heuristic';
}

export function taskRiskTierLabel(tier: TaskRiskTier): string {
  if (tier === 0) return '直接执行';
  if (tier === 2) return '全流程（严格）';
  return '先审计划';
}

const HIGH_RISK_RE = /发布|上线|部署|删除|迁移|付款|支付|合同|隐私|安全|生产|客户|密钥|凭据|权限|法务|财务|对账/;
const LOW_RISK_RE = /查一下|查下|看看|整理|调研|总结|翻译|列一下|草稿|概览|简报|收集/;

export function suggestTaskTier(input: {
  goal: string;
  projectDefaultTier?: number | null;
}): TaskTierSuggestion {
  if (input.projectDefaultTier === 0 || input.projectDefaultTier === 1 || input.projectDefaultTier === 2) {
    return {
      tier: input.projectDefaultTier,
      reason: `项目默认档：${taskRiskTierLabel(input.projectDefaultTier)}`,
      source: 'project-default',
    };
  }
  const goal = input.goal.trim();
  if (HIGH_RISK_RE.test(goal)) {
    return { tier: 2, reason: '目标涉及发布/删除/权限/资金等高风险动作', source: 'heuristic' };
  }
  if (LOW_RISK_RE.test(goal)) {
    return { tier: 0, reason: '目标偏只读/整理，可直接执行', source: 'heuristic' };
  }
  return { tier: 1, reason: '常规任务，建议先审计划', source: 'heuristic' };
}
