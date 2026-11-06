/**
 * B-4（M4）· 设置·高级「数据保留」纯视图（无 store 依赖，node 静态渲染可测）。
 * 容器见 `MaintenancePanel.tsx`；口径：只清四张临时表，不删任务/报告/产物/变更集。
 */
import type { CSSProperties, ReactElement } from 'react';

const MUTED: CSSProperties = { color: 'var(--muted, #888)', fontSize: 12 };

export interface RetentionCounts {
  remoteEvents: number;
  outbox: number;
  checkpoints: number;
  timers: number;
}

export interface MaintenanceViewProps {
  loading: boolean;
  error: string | null;
  notice: string | null;
  counts: RetentionCounts | null;
  confirming: boolean;
  onPreview: () => void;
  onAskRun: () => void;
  onRun: () => void;
  onCancelRun: () => void;
}

const LABEL: Readonly<Record<keyof RetentionCounts, string>> = {
  remoteEvents: '过期远端事件',
  outbox: '已发/取消/过期 outbox',
  checkpoints: '已恢复/失效检查点',
  timers: '已触发定时器',
};

export function MaintenanceView(props: MaintenanceViewProps): ReactElement {
  return (
    <section data-testid="settings-maintenance" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <h4>清理临时表</h4>
      <p style={MUTED}>
        保留期 30 天；只清四张临时表（过期远端事件 / 已发或取消的 outbox / 已恢复或失效的检查点 / 已触发的定时器）。
        <strong>不删任务、报告、产物、变更集。</strong>
      </p>
      {props.counts ? (
        <div data-testid="maintenance-counts" style={{ display: 'grid', gap: 4 }}>
          {(Object.keys(LABEL) as Array<keyof RetentionCounts>).map((key) => (
            <span key={key} data-testid={`maintenance-count-${key}`} style={MUTED}>
              {LABEL[key]}：{props.counts?.[key] ?? '—'}
            </span>
          ))}
        </div>
      ) : (
        <p style={MUTED} data-testid="maintenance-counts-empty">
          {props.loading ? '读取中…' : '尚未预览（点「预览」看将清理的真实行数）。'}
        </p>
      )}
      {props.error ? (
        <p style={{ color: 'var(--danger)', fontSize: 12 }} data-testid="maintenance-error" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.notice ? (
        <p style={MUTED} data-testid="maintenance-notice" role="status">
          {props.notice}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="maintenance-preview" disabled={props.loading || props.confirming} onClick={props.onPreview}>
          预览
        </button>
        {props.confirming ? (
          <>
            <button type="button" data-testid="maintenance-run-yes" disabled={props.loading} onClick={props.onRun}>
              确认清理
            </button>
            <button type="button" data-testid="maintenance-run-no" disabled={props.loading} onClick={props.onCancelRun}>
              返回
            </button>
          </>
        ) : (
          <button type="button" data-testid="maintenance-run" disabled={props.loading} onClick={props.onAskRun}>
            运行清理
          </button>
        )}
      </div>
    </section>
  );
}
