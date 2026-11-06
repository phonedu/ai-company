/**
 * 应用内通知浮层（2026-10-17 真机反馈「没通知」）：
 * 主进程 `notify()` 的 desktop 投递除 OS 通知外，还推 `evt:toast`（同标题/同正文）；
 * 本组件固定在右下角，6 秒自动消失，也可点 × 关闭。OS 通知被系统吞掉时仍**可见**。
 *
 * 纯展示组件（props 驱动）——容器接线在 `AppShell`（store 的 `toasts` / `dismissToast`）。
 */
import type { ReactElement } from 'react';

import type { ToastDTO } from './toastModel.js';

export interface ToastHostProps {
  items: readonly ToastDTO[];
  onDismiss: (id: number) => void;
}

export function ToastHost({ items, onDismiss }: ToastHostProps): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="toast-host" data-testid="toast-host" role="status" aria-live="polite">
      {items.map((toast) => (
        <div className="toast" data-testid="toast" key={toast.id}>
          <div className="toast__title">{toast.title}</div>
          <div className="toast__text">{toast.text}</div>
          <button
            type="button"
            className="toast__close"
            data-testid="toast-close"
            aria-label="关闭通知"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
