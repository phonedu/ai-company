/**
 * B-1（M4）· 项目概览「定时」纯视图（无 store 依赖，node 静态渲染可测）。
 * 容器见 `ProjectTriggers.tsx`；口径见该文件头注。
 */
import type { CSSProperties, ReactElement } from 'react';

import type { TriggerDTO } from '../types.js';

const MUTED: CSSProperties = { color: 'var(--muted, #888)', fontSize: 12 };

/** 当天分钟数 → `HH:MM`（越界返回 `—`，不写假时间）。 */
export function formatDailyMinute(minute: number | null): string {
  if (minute == null || !Number.isInteger(minute) || minute < 0 || minute > 1439) return '—';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** `HH:MM` → 当天分钟数；非法返回 null（调用方显式禁用/拒绝）。 */
export function parseDailyTime(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 触发的人话「何时」（cron 间隔/每日；event 指向源任务）。 */
export function triggerWhenLabel(trigger: Pick<TriggerDTO, 'kind' | 'intervalMinutes' | 'dailyMinute' | 'sourceTaskId'>): string {
  if (trigger.kind === 'event') return `当 #${trigger.sourceTaskId ?? '?'} 完成`;
  if (trigger.intervalMinutes != null) return `每 ${trigger.intervalMinutes} 分钟`;
  if (trigger.dailyMinute != null) return `每天 ${formatDailyMinute(trigger.dailyMinute)}`;
  return '时间未设置';
}

/** 下次时间（事件触发/无 due → null；渲染层显示「等待源任务完成」）。 */
export function formatNextDue(nextDueAt: number | null): string | null {
  if (nextDueAt == null || !Number.isFinite(nextDueAt)) return null;
  return new Date(nextDueAt).toLocaleString('zh-CN', { hour12: false });
}

export interface ProjectTriggersViewProps {
  projectId: number | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  triggers: readonly TriggerDTO[];
  goal: string;
  kind: 'interval' | 'daily' | 'event';
  interval: string;
  daily: string;
  /** 事件触发的源任务短号（如 `T-1042`）。 */
  source: string;
  creating: boolean;
  cancelingId: number | null;
  onGoalChange: (value: string) => void;
  onKindChange: (value: 'interval' | 'daily' | 'event') => void;
  onIntervalChange: (value: string) => void;
  onDailyChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onCreate: () => void;
  onCancel: (id: number) => void;
  onRefresh: () => void;
}

/** 选项值 → 触发类型；未知值落回 `interval`（不静默变成别的类型）。 */
export function triggerKindFromSelect(value: string): 'interval' | 'daily' | 'event' {
  return value === 'daily' ? 'daily' : value === 'event' ? 'event' : 'interval';
}

/** 纯视图：无 store 依赖，node 静态渲染可测。 */
export function ProjectTriggersView(props: ProjectTriggersViewProps): ReactElement {
  const interval = Number(props.interval);
  const dailyMinute = parseDailyTime(props.daily);
  const scheduleOk =
    props.kind === 'interval'
      ? Number.isInteger(interval) && interval > 0 && interval <= 10_080
      : props.kind === 'daily'
        ? dailyMinute != null
        : props.source.trim().length > 0;
  const canCreate = props.projectId != null && props.goal.trim().length > 0 && scheduleOk && !props.creating;
  return (
    <section className="project-pane__card" data-testid="project-triggers">
      <h3 className="project-view__state-title">定时</h3>
      <p className="project-view__docs-text">
        定时到点或源任务完成时，自动在本项目新建任务；与频道命令同源（<code>定时 每30分钟 …</code> / <code>当 T1042 完成 …</code> / <code>触发列表</code> / <code>取消触发 &lt;id&gt;</code>）。
      </p>

      <div className="project-view__docs-row project-view__trigger-form" data-testid="project-trigger-form">
        <input
          className="project-view__trigger-input"
          data-testid="project-trigger-goal"
          placeholder="要做什么（如：每天对账）"
          value={props.goal}
          onChange={(event) => props.onGoalChange(event.target.value)}
          disabled={props.projectId == null || props.creating}
        />
        <select
          className="project-view__trigger-input"
          data-testid="project-trigger-kind"
          value={props.kind}
          onChange={(event) => props.onKindChange(triggerKindFromSelect(event.target.value))}
          disabled={props.projectId == null || props.creating}
        >
          <option value="interval">每 N 分钟</option>
          <option value="daily">每天</option>
          <option value="event">源任务完成时</option>
        </select>
        {props.kind === 'interval' ? (
          <input
            className="project-view__trigger-input"
            data-testid="project-trigger-interval"
            type="number"
            min={1}
            max={10080}
            placeholder="30"
            value={props.interval}
            onChange={(event) => props.onIntervalChange(event.target.value)}
            disabled={props.projectId == null || props.creating}
            style={{ width: 80 }}
          />
        ) : props.kind === 'daily' ? (
          <input
            className="project-view__trigger-input"
            data-testid="project-trigger-daily"
            type="time"
            value={props.daily}
            onChange={(event) => props.onDailyChange(event.target.value)}
            disabled={props.projectId == null || props.creating}
            style={{ width: 110 }}
          />
        ) : (
          <input
            className="project-view__trigger-input"
            data-testid="project-trigger-source"
            placeholder="源任务短号（如 T-1042）"
            value={props.source}
            onChange={(event) => props.onSourceChange(event.target.value)}
            disabled={props.projectId == null || props.creating}
            style={{ width: 150 }}
          />
        )}
        <button type="button" data-testid="project-trigger-create" disabled={!canCreate} onClick={props.onCreate}>
          {props.creating ? '创建中…' : '创建'}
        </button>
        <button type="button" data-testid="project-trigger-refresh" disabled={props.loading || props.projectId == null} onClick={props.onRefresh}>
          刷新
        </button>
      </div>

      {props.notice ? (
        <p className="project-pane__message" data-testid="project-trigger-notice" role="status">
          {props.notice}
        </p>
      ) : null}
      {props.error ? (
        <p className="project-view__error" data-testid="project-trigger-error" role="alert">
          {props.error}
        </p>
      ) : null}

      {props.loading ? (
        <p className="project-view__docs-text" data-testid="project-trigger-loading">
          读取中…
        </p>
      ) : props.triggers.length === 0 ? (
        props.error ? null : (
          <p className="project-view__docs-text" data-testid="project-trigger-empty">
            暂无定时/事件触发。
          </p>
        )
      ) : (
        <ul className="project-view__trigger-list" data-testid="project-trigger-list">
          {props.triggers.map((trigger) => {
            const next = formatNextDue(trigger.nextDueAt);
            return (
              <li
                className="project-view__trigger-row"
                data-testid="project-trigger-row"
                data-trigger-id={trigger.id}
                data-kind={trigger.kind}
                key={trigger.id}
              >
                <span className="project-view__trigger-id">#{trigger.id}</span>
                <span data-testid="project-trigger-when">{triggerWhenLabel(trigger)}</span>
                <span className="project-view__trigger-goal" data-testid="project-trigger-goal-text">
                  {trigger.goal}
                </span>
                <span style={MUTED} data-testid="project-trigger-next">
                  {next != null ? `下次 ${next}` : '等待源任务完成'}
                </span>
                <button
                  type="button"
                  data-testid="project-trigger-cancel"
                  disabled={props.cancelingId === trigger.id}
                  onClick={() => props.onCancel(trigger.id)}
                >
                  {props.cancelingId === trigger.id ? '取消中…' : '取消'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
