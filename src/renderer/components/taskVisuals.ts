// ─────────────────────────────────────────────────────────────────────────────
// 任务行公共小件（2026-10-18「项目树/归档改页」批）：状态色 tone ＋ 头像首字 ＋ 行 tooltip。
//   自 LeftRail 抽出——左栏、项目树页、归档页三处共用（防三份漂移）。
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskDTO } from '../types.js';

/**
 * 状态点语义色：绿＝在跑、黄＝等你（含暂停/阻塞）、红＝失败、灰＝其他
 * （含完成/取消——完成不是"在跑"，不用绿色再抢一次注意力）。
 */
export const STATE_TONE: Record<string, string> = {
  executing: 'accent',
  verifying: 'accent',
  awaiting_approval: 'warn',
  needs_decision: 'warn',
  paused: 'warn',
  blocked: 'warn',
  failed: 'danger',
  done: 'dim',
  cancelled: 'dim',
  inbox: 'dim',
  planning: 'dim',
  ready: 'dim',
};

/** 头像字符：员工名首字；名字查无 ⇒ `#`（不臆造人名）。 */
export function avatarChar(name: string | null): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1) : '#';
}

/** 行 tooltip：标题 ＋（若有）等待原因——真读数，不裁不拼。 */
export function rowTooltip(task: TaskDTO, waitText: string | null = null): string {
  return waitText ? `${task.title}\n${waitText}` : task.title;
}
