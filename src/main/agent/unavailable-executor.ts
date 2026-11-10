/**
 *  · 员工执行器「**不可用**」态（无凭据时）。
 *
 * 口径（2398/2402 硬线）：老板规则 —— **「缺 key 必须响、不许 mock 兜底」**。
 * 因此**绝不回落到记录式/mock 执行器**（那 = 流程照跑、员工其实没干活 = 假完成）。
 * 缺凭据时：**任何 work_item `dispatch` 立即失败** → 派工作项机**真事件** `error`（`running --error--> failed`；
 * ）→ 件 `failed`（任务级失败聚合出异常卡）+ **error 级日志**。
 * ⚠️ 教训：此前派 `work_item_failed`——**工作项机没有这个事件** ⇒ 真引擎抛 `UnknownTransitionError`，
 * 件卡 `running`、任务永停 `executing`、无卡（只有行为日志一条 `action_failed`）；假 dispatch 的单测看不出。
 * ⚠️ 规划静默（2026-10-15，矩阵格 `no-credential×planning-stage` 抓到）：**任务级 phase 派发**
 * （`dispatch_planning`/`dispatch_critic`/`dispatch_verifier`）此前被**静默跳过**——任务无卡、无工作项、
 * 配好 Key 也不重试。现按同型派 **`escalate`**（任务进 `needs_decision` ＋决策卡，老板可见）。
 * （「答卡后再派规划」属**恢复面共缺口**——`decision_made` 回边无再派发＋幂等键轮次问题——已报备，随批 R 一并设计。）
 *
 * 本模块**不依赖 Pi**、不碰他人文件；`dispatch` 由 `index.ts` 接线为 `engine.dispatch`。
 */
import type { EffectExecutor, EngineEvent, PersistedAction } from '../engine/types.js';
import { isProviderUnavailableError } from './model-policy.js';

export const NO_CREDENTIAL_REASON = 'no_credential';

export interface UnavailableExecutorDeps {
  dispatch?: (event: EngineEvent) => Promise<void> | void;
  /** 装配失败原因（C1b：模型不存在/不可用要区别于完全无凭据；缺省＝no_credential）。 */
  reason?: string;
  /** 员工不可用时的改派策略（返回 true＝已改派，不再落 error）。 */
  onWorkItemUnavailable?: (info: { workItemId: number; taskId: number; reason: string }) => Promise<boolean> | boolean;
  /** 日志（默认 `console.error`；可注入便于单测/降噪）。 */
  log?: (message: string) => void;
}

export function createUnavailableExecutor(deps: UnavailableExecutorDeps = {}): EffectExecutor {
  const log = deps.log ?? ((message: string) => console.error(message));
  return {
    async execute(action: PersistedAction): Promise<void> {
      const reason = deps.reason ?? NO_CREDENTIAL_REASON;
      // 任务级 phase 派发：装配不可用时必须**响亮**（此前静默跳过； 同型 → escalate＋决策卡；见头注）。
      if (action.kind === 'dispatch_planning' || action.kind === 'dispatch_critic' || action.kind === 'dispatch_verifier') {
        if (action.taskId == null) return;
        // C1b 真机（2026-10-17）：装配期“模型不存在/不可用”不是“完全无凭据”，走 failed＋异常卡；
        // 完全无凭据仍按 C8 升级为决策卡（no_credential）。
        if (action.kind === 'dispatch_planning' && isProviderUnavailableError(reason)) {
          const taskReason = `模型/凭据不可用：${reason}`;
          log(`[engine] 模型/凭据不可用（${reason}）→ ${action.kind} 进 failed（task ${action.taskId}）`);
          await deps.dispatch?.({
            scope: 'task',
            id: action.taskId,
            event: 'error',
            actor: 'system',
            payload: { reason: taskReason, phase: 'planning' },
          });
          return;
        }
        log(`[engine] 无凭据 → 员工会话不可用（${action.kind}，task ${action.taskId}）→ 升级给老板（escalate）`);
        await deps.dispatch?.({
          scope: 'task',
          id: action.taskId,
          event: 'escalate',
          actor: 'system',
          payload: { reason: NO_CREDENTIAL_REASON, phase: action.kind.slice('dispatch_'.length) },
        });
        return;
      }
      // 只接管 work_item 的 `dispatch`（与真执行器一致）。
      if (action.kind !== 'dispatch') return;
      const [, subjectKind, subjectId] = action.actionKey.split(':');
      if (subjectKind !== 'work_item' || action.taskId == null) return;
      const workItemId = Number(subjectId);
      if (!Number.isInteger(workItemId)) return;

      // 先按策略改派同角色在职员工（真中断→reassign）；无候选才落 error。
      const handled = await deps.onWorkItemUnavailable?.({ workItemId, taskId: action.taskId, reason });
      if (handled) {
        log(`[engine] 员工不可用 → 工作项 ${workItemId} 已改派同角色员工（reason=${reason}）`);
        return;
      }
      log(`[engine] 无凭据 → 员工会话不可用，未执行任何动作（work_item ${workItemId}）`);
      await deps.dispatch?.({
        scope: 'work_item',
        id: workItemId,
        event: 'error',
        actor: 'system',
        payload: { reason: NO_CREDENTIAL_REASON },
      });
    },
  };
}
