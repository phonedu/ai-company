/**
 * 托盘状态（M3-P-3 GAP3 收口）——纯函数，可单测。
 *
 * 口径（`UI §6.5`）：有事等你＝橙、有人干活＝绿、都没有＝普通图标。
 * 两种都有时**橙色优先**（需要你处理的事更急）；tooltip 同时如实给出两个读数。
 */
export type TrayState = 'waiting' | 'working' | 'idle';

export interface TrayStatusInput {
  /** 待我处理卡片数（`reports.state='pending'`）。 */
  pending: number;
  /** 正在跑的工作项数（`work_items.state='running'`）。 */
  running: number;
}

export interface TrayStatusView {
  state: TrayState;
  pending: number;
  running: number;
  tooltip: string;
  /** 菜单首项文案；`null`＝没有需要单独列出的状态项。 */
  menuLabel: string | null;
}

const count = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function trayStatusView(input: TrayStatusInput): TrayStatusView {
  const pending = count(input.pending);
  const running = count(input.running);
  const state: TrayState = pending > 0 ? 'waiting' : running > 0 ? 'working' : 'idle';
  const parts: string[] = [];
  if (pending > 0) parts.push(`待我处理 ${pending}`);
  if (running > 0) parts.push(`正在干活 ${running}`);
  return {
    state,
    pending,
    running,
    tooltip: parts.length > 0 ? `AI 一人公司 · ${parts.join(' · ')}` : 'AI 一人公司',
    menuLabel:
      pending > 0 ? `待我处理（${pending}）` : running > 0 ? `正在干活（${running}）` : null,
  };
}
