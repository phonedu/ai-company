/**
 * 空态原语（2026-10-17 细节优化批 B3）。
 *
 * 两种密度：
 *   - `page`：整页无内容（22/500 标题 + 12 提示），如「暂无归档任务」；
 *   - `inline`：卡内/区块内无内容（15/500 标题 + 12 提示），如「计划还没生成」。
 *
 * 纪律：只说真实情况和下一步；不摆假数据、不用开发术语。
 */
import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
  variant?: 'page' | 'inline';
  testid?: string;
}

export function EmptyState({ title, hint, action, variant = 'inline', testid }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state" data-variant={variant} data-testid={testid}>
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
