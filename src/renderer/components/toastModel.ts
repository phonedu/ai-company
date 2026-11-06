/**
 * 应用内通知浮层的数据口径（纯函数；可单测、无 React/valtio 依赖）。
 *
 * 为什么要有它：`notify()` 的 desktop 投递在 Windows 上依赖 AUMID/开始菜单注册，
 * 系统通知被静默丢弃时用户什么都看不到（2026-10-17 真机反馈「没通知」）。
 * 主进程仍走 OS 通知；同时推 `evt:toast`，由本层在应用右下角给出**同内容**的可见回执。
 */
export interface ToastDTO {
  id: number;
  title: string;
  text: string;
}

/** 同时最多叠 3 条（再旧的自动顶掉；不无限堆叠遮挡界面）。 */
export const TOAST_LIMIT = 3;

/** 追加一条；超过上限只留最新 `limit` 条。 */
export function appendToast(list: readonly ToastDTO[], toast: ToastDTO, limit = TOAST_LIMIT): ToastDTO[] {
  return [...list, toast].slice(-Math.max(1, limit));
}

/** 关掉指定 id；不存在时原样返回（不抛）。 */
export function removeToast(list: readonly ToastDTO[], id: number): ToastDTO[] {
  return list.filter((toast) => toast.id !== id);
}
