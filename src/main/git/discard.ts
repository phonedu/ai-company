/**
 * B-2· `task:discard` —— 丢弃一个变更集（不合并）。
 *
 * 口径：
 *  - 真值表：`open → discarded`；`discarded` 幂等；`merged`/`rolled_back`/`superseded` 显式拒；
 *  - **只改清单**：不动主分支、不跑 git、不删 worktree/分支（保留作证据；retention 另行清理）；
 *  - **只影响该工作项**：按 changesetId 定位，不碰同任务其它变更集；
 *  - 成功后写 `changeset_discarded` 事件；二次调用不再写事件（幂等）。
 *
 * 与回滚的区别：回滚产生反向提交（保留改动痕迹）；丢弃只让这个变更集**永远不进入合并**，
 * `mergeChangeset` 对 `discarded` 显式拒绝（不偷偷复活）。
 */
import type { SqliteDb } from '../db/open.js';
import { getChangeset, getTaskById, insertTaskEvent, markChangesetDiscarded } from '../db/index.js';

export type DiscardChangesetResult =
  | {
      ok: true;
      changesetId: number;
      alreadyDiscarded: boolean;
      filesChanged: number;
      message: string;
    }
  | {
      ok: false;
      code: 'bad_request' | 'not_found' | 'task_archived' | 'task_state' | 'changeset_state';
      message: string;
    };

export interface DiscardChangesetInput {
  db: SqliteDb;
  taskId: number;
  changesetId: number;
  now?: number;
}

export function discardChangeset(input: DiscardChangesetInput): DiscardChangesetResult {
  const now = input.now ?? Date.now();
  const task = getTaskById(input.db, input.taskId);
  if (!task) return { ok: false, code: 'not_found', message: '任务不存在' };
  if (task.archived === 1) return { ok: false, code: 'task_archived', message: '任务已归档——先恢复再丢弃' };
  if (task.state === 'cancelled') return { ok: false, code: 'task_state', message: '任务已取消，不能丢弃变更' };
  const cs = getChangeset(input.db, input.changesetId);
  if (!cs || cs.task_id !== input.taskId) {
    return { ok: false, code: 'not_found', message: '变更集不存在或不属于该任务' };
  }
  if (cs.state === 'discarded') {
    return {
      ok: true,
      changesetId: cs.id,
      alreadyDiscarded: true,
      filesChanged: cs.files_changed,
      message: '该变更集已丢弃（幂等，不重复执行）',
    };
  }
  if (cs.state !== 'open') {
    return {
      ok: false,
      code: 'changeset_state',
      message: `变更集状态为 ${cs.state}，不能丢弃（只接受 open）`,
    };
  }
  const changed = markChangesetDiscarded(input.db, cs.id, now);
  if (changed === 0) {
    const after = getChangeset(input.db, cs.id);
    if (after?.state === 'discarded') {
      return {
        ok: true,
        changesetId: cs.id,
        alreadyDiscarded: true,
        filesChanged: cs.files_changed,
        message: '该变更集已丢弃（并发幂等）',
      };
    }
    return { ok: false, code: 'changeset_state', message: '变更集状态已变化，请刷新后重试' };
  }
  insertTaskEvent(input.db, {
    taskId: task.id,
    ts: now,
    kind: 'changeset_discarded',
    actor: 'boss',
    payload: {
      changesetId: cs.id,
      workItemId: cs.work_item_id,
      branch: cs.branch,
      headSha: cs.head_sha,
      filesChanged: cs.files_changed,
    },
  });
  return {
    ok: true,
    changesetId: cs.id,
    alreadyDiscarded: false,
    filesChanged: cs.files_changed,
    message: '已丢弃：该变更集不会再合并到主分支；主分支/其他工作项未动',
  };
}
