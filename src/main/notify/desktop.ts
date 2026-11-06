/**
 * 桌面通知投递（M3-P-3 GAP3 收口）——把 `NotifyDelivery` 变成可单测的 OS 通知/浮层动作。
 *
 * 口径：
 *  - 只有 `desktop` 通道弹（静默期 `digest` 不弹；员工间 mailbox `employee:*` 不弹）；
 *  - 同一投递**先推应用内浮层**（OS 被系统吞掉时仍可见），再尝试 OS 通知；
 *  - OS 通知点击 → 回到对应任务（无任务卡片 → 老板频道）；
 *  - 不支持/构造失败**如实记日志**，但绝不打断已落库的通知。
 */
import type { NotifyDelivery } from './index.js';

export interface DesktopNotificationLike {
  on(event: 'click', listener: () => void): void;
  show(): void;
}

export interface OpenViewTarget {
  taskId?: number;
  view?: 'inbox' | 'channel' | 'hall';
}

export interface DesktopNotifyDeps {
  isSupported(): boolean;
  createNotification(options: { title: string; body: string }): DesktopNotificationLike | null;
  pushToast(input: { title: string; text: string; reportId: number | null }): void;
  openView(target: OpenViewTarget): void;
  logError(message: string, error?: unknown): void;
}

export type DesktopNotifyStatus = 'skipped' | 'unsupported' | 'shown' | 'failed';

export interface DesktopNotifyResult {
  status: DesktopNotifyStatus;
  title: string | null;
  body: string | null;
}

/** 从通知载荷提取人话标题/正文（与既有桌面旁路口径一致；缺省给可理解的兜底）。 */
export function desktopNotificationText(payload: unknown): { title: string; body: string } {
  const record = (payload ?? {}) as Record<string, unknown>;
  const title =
    typeof record.title === 'string'
      ? record.title
      : typeof record.question === 'string'
        ? '需要你处理'
        : 'AI 一人公司';
  const body =
    typeof record.question === 'string'
      ? record.question
      : typeof record.text === 'string'
        ? record.text
        : typeof record.body === 'string'
          ? record.body
          : '有新消息';
  return { title: title.slice(0, 80), body: body.slice(0, 200) };
}

export function deliverDesktopNotification(
  delivery: NotifyDelivery,
  deps: DesktopNotifyDeps,
): DesktopNotifyResult {
  if (delivery.channel !== 'desktop') return { status: 'skipped', title: null, body: null };
  const { title, body } = desktopNotificationText(delivery.payload);

  // 浮层先走：OS 通知是否真正弹出受系统开关/焦点辅助影响，应用内必须有同内容回执。
  try {
    deps.pushToast({ title, text: body, reportId: delivery.reportId });
  } catch (error) {
    deps.logError('应用内通知浮层失败（通知已落库）', error);
  }

  if (!deps.isSupported()) {
    deps.logError('系统通知不可用（通知已落库；应用内浮层仍可见）');
    return { status: 'unsupported', title, body };
  }
  try {
    const notification = deps.createNotification({ title, body });
    if (!notification) {
      deps.logError('系统通知构造失败（通知已落库；应用内浮层仍可见）');
      return { status: 'failed', title, body };
    }
    notification.on('click', () => {
      deps.openView(delivery.taskId != null ? { taskId: delivery.taskId } : { view: 'channel' });
    });
    notification.show();
    return { status: 'shown', title, body };
  } catch (error) {
    deps.logError('系统通知失败（通知已落库，不静默）', error);
    return { status: 'failed', title, body };
  }
}
