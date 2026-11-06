import { Toaster as Sonner } from 'sonner';
import type * as React from 'react';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * 应用内通知：用 sonner 的行为（队列/计时/关闭），外观映射到 E 系 token。
 * `theme="system"` 跟随系统；颜色变量本身已经随 prefers-color-scheme 切换。
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-text-dim',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-secondary group-[.toast]:text-secondary-foreground',
        },
      }}
      {...props}
    />
  );
}
