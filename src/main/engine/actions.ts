/**
 * `actions.ts` —— 副作用动作的登记（事务内）与执行（事务外、幂等）。
 *
 * 流程（/）：
 *   ① 事务内：`registerActions()` 把动作写入 `action_log`（pending，幂等键去重）；
 *   ② 事务外：`executePendingActions()` 逐个执行——**先查 action_log，done 则跳过**；
 *      成功后置 done；失败置 failed。
 * 崩溃重启：pending 的动作被 `executePendingActions()` 幂等重放。
 */
import { getAction, listPendingActions, markActionDone, markActionFailed, registerPendingAction } from '../db/action_log.js';
import { insertApproval, PERMISSION_QUESTION_PREFIX } from '../db/approvals.js';
import { insertTaskEvent } from '../db/task_events.js';
import type { GateResult } from '../permission/index.js';
import type { SqliteDb } from '../db/open.js';
import { actionKeyOf, type EffectExecutor, type EngineAction, type PersistedAction } from './types.js';

export interface RegisterActionsResult {
  registered: string[];
  deduped: string[];
}

/** 事务内登记动作；返回本次新登记 / 命中已有键（去重）的动作键。 */
export function registerActions(db: SqliteDb, actions: EngineAction[], now: number): RegisterActionsResult {
  const registered: string[] = [];
  const deduped: string[] = [];
  for (const action of actions) {
    const key = actionKeyOf(action);
    const inserted = registerPendingAction(db, {
      actionKey: key,
      kind: action.kind,
      taskId: action.taskId,
      payload: action.payload,
      now,
    });
    (inserted ? registered : deduped).push(key);
  }
  return { registered, deduped };
}

export interface ExecuteResult {
  executed: string[];
  skipped: string[];
  failed: Array<{ actionKey: string; error: string }>;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toPersistedAction(actionKey: string, kind: string, taskId: number | null, payloadJson: string): PersistedAction {
  return { actionKey, kind, taskId, payload: parsePayload(payloadJson) };
}

/**
 * 事务外执行所有 pending 动作；已 done/failed 的跳过。
 *
 * `inFlight`（会话实测抓到的真 bug 修复）：**正在执行的动作**集合——执行器内部会 `dispatch` 事件，
 * 该事件 drain 时又列 pending（**在跑的这条还是 `pending`**）⇒ 不加认领会被**重入执行**（会话跑两遍、
 * 第二遍还因状态已前进而失败、动作被误标 `failed`）。重入路径在此**跳过**（不执行、也不标 done——
 * 由**外层**执行完标 done；崩溃时仍是 `pending` ⇒ 恢复重放语义不变）。
 */
export async function executePendingActions(
  db: SqliteDb,
  executor: EffectExecutor,
  now: number = Date.now(),
  gate?: (action: PersistedAction) => GateResult,
  inFlight?: ReadonlySet<string>,
  /** ask 命中的权限请求——把「升级给老板」交回引擎（actions 层无 dispatch；缺省＝不升级，向后兼容/测试不接）。 */
  enqueue?: (event: import('./types.js').EngineEvent) => void,
): Promise<ExecuteResult> {
  const pending = listPendingActions(db);
  const executed: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ actionKey: string; error: string }> = [];

  for (const row of pending) {
    // 执行前再查一遍（防「同一批里已被执行」/ 已被其他路径置 done）；**正在执行中 → 跳过**（防重入）
    const current = getAction(db, row.action_key);
    if (!current || current.state !== 'pending' || inFlight?.has(row.action_key) === true) {
      skipped.push(row.action_key);
      continue;
    }
    const action = toPersistedAction(current.action_key, current.kind, current.task_id, current.payload);

    // OPT-：副作用执行前过权限闸门。
    //  - deny → 置 failed + `permission_decision`（审计），不执行；
    //  - ask → **留 pending** + `permission_requested`（等待批准，批准后重放）；不执行。
    const decision = gate?.(action);
    if (decision && decision.decision !== 'allow') {
      if (action.taskId != null) {
        //  补丁：ask 挂起动作在 tick 每秒排水下会被反复看到——事件按 actionKey 查重
        //（approvals 已有幂等；task_events 此前没有 ⇒ 事件写放大，每秒一条直到批准）。
        const kind = decision.decision === 'deny' ? 'permission_decision' : 'permission_requested';
        const already = db
          .prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND kind = ? AND json_extract(payload, '$.actionKey') = ? LIMIT 1`)
          .get(action.taskId, kind, action.actionKey);
        if (already == null) {
          insertTaskEvent(db, {
            taskId: action.taskId,
            ts: now,
            kind,
            actor: 'system',
            payload: { actionKey: action.actionKey, decision: decision.decision, reason: decision.reason, rule: decision.rule ?? null },
          });
        }
      }
      if (decision.decision === 'deny') {
        markActionFailed(db, action.actionKey, now);
        failed.push({ actionKey: action.actionKey, error: `denied: ${decision.reason}` });
      } else {
        // ask：审批复用 approvals；默认动作 null（对外永不自动）。
        // （审计抓）：**可见化**——此前只建 approvals 行 ⇒ 老板在「待我处理」看不到、任务不转 `needs_decision`；
        // 现：建行 → 派 `escalate`（状态机侧**唯一卡源**合成决策卡、`approvalId` 回挂真卡、`notifyRevision` 按行分卡）；
        // 被闸门跳过的动作**保持 pending**，批准后重放（G1 口径不变）。
        // ⚠️ **幂等**：同 actionKey 的 ask 在每个 drain 都会再看一次 ⇒ 必须查重（否则反复建行/升级/入队，队列不收敛——
        // 2026-10-15 部署自查抓到）；已存在同题审批 ⇒ 只跳过、不重建、不重升级。
        if (action.taskId != null) {
          const question = `${PERMISSION_QUESTION_PREFIX}${action.kind}（${action.actionKey}）`;
          const existingApproval = db
            .prepare('SELECT id FROM approvals WHERE task_id = ? AND question = ? ORDER BY id DESC LIMIT 1')
            .get(action.taskId, question) as { id: number } | undefined;
          if (!existingApproval) {
            const approval = insertApproval(db, {
              taskId: action.taskId,
              question,
              options: [{ key: 'approve', label: '批准一次' }, { key: 'deny', label: '拒绝' }],
              defaultAction: null,
              timeoutAt: null,
            });
            enqueue?.({
              scope: 'task',
              id: action.taskId,
              event: 'escalate',
              actor: 'system',
              payload: {
                reason: 'permission_ask',
                question: `${PERMISSION_QUESTION_PREFIX}${action.kind}`,
                options: [{ key: 'approve', label: '批准一次' }, { key: 'deny', label: '拒绝' }],
                approvalId: approval.id,
                permissionKey: action.kind,
                notifyRevision: approval.id,
              },
            });
          }
        }
        skipped.push(action.actionKey);
      }
      continue;
    }

    try {
      await executor.execute(action);
      markActionDone(db, current.action_key, now);
      executed.push(current.action_key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // OPT-：失败也留痕（task_events.kind='action_failed'）
      if (action.taskId != null) {
        insertTaskEvent(db, {
          taskId: action.taskId,
          ts: now,
          kind: 'action_failed',
          actor: 'system',
          payload: { actionKey: action.actionKey, kind: action.kind, error: message },
        });
      }
      markActionFailed(db, current.action_key, now);
      failed.push({ actionKey: current.action_key, error: message });
    }
  }
  return { executed, skipped, failed };
}

export interface RecordingExecutorState {
  /** 每次 execute 被调用时记录（含重复调用）。 */
  calls: string[];
  /** 实际产生的副作用（幂等去重后）。 */
  effects: string[];
}

export interface RecordingExecutor extends EffectExecutor {
  state: RecordingExecutorState;
}

/**
 * 测试用执行器：记录调用次数，并按 actionKey 幂等去重（模拟"下游幂等键兜底"）。
 * `idempotent=false` 时可观察到重复副作用（用于反例）。
 */
export function makeRecordingExecutor(options: { idempotent?: boolean } = {}): RecordingExecutor {
  const state: RecordingExecutorState = { calls: [], effects: [] };
  const seen = new Set<string>();
  const idempotent = options.idempotent ?? true;
  return {
    state,
    execute(action: PersistedAction) {
      state.calls.push(action.actionKey);
      if (idempotent && seen.has(action.actionKey)) return;
      seen.add(action.actionKey);
      state.effects.push(action.actionKey);
    },
  };
}
