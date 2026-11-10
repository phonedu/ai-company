/**
 * 右栏纯展示层（2026-10-17 细节优化批）。
 *
 * 两种上下文：
 *   - 全局：今日概览 + 资源占用 + 「谁在忙」；回答"为什么慢"的入口去公司大厅。
 *   - 任务：产物 / 证据 / 成本（复用 `task:get` 与 `cost:summary{taskId}`，不另造数据源）。
 *
 * 纪律：
 *   - 只吃 props（可 node 渲染断言）；取数/导航在 `RightRail.tsx` 容器。
 *   - 无数据显式 `—` / 空态，不写假 0、不摆"看起来像真的"占位块。
 *   - 不再出现开发备注（如"概览摘要未完成"）。
 */
import type { ReactElement } from 'react';

import type { CostSummaryDTO, EmployeeDTO } from '../types.js';
import type { TaskDetailDTO, ContextMetricDTO } from './TaskDetail.js';

export interface OverviewRailProps {
  cost?: CostSummaryDTO | null;
  slots?: { running: number; total: number } | null;
  /** 大厅聚合（可选；未加载/无数据 => 不摆假动作）。 */
  employees?: readonly EmployeeDTO[] | null;
  /** 去公司大厅（全局态）；缺省不渲染入口（纯组件测试用）。 */
  onOpenHall?: () => void;
  /** 点「谁在忙」里的员工 → 大厅右栏**精准选中该员工**（右栏↔大厅互跳）。 */
  onOpenEmployee?: (employeeId: number) => void;
}

export interface TaskRailProps {
  detail: TaskDetailDTO | null;
  cost?: CostSummaryDTO | null;
  loading?: boolean;
  error?: string | null;
  /** 产物名可点开统一预览抽屉（缺省 → 纯文本，不假装可点）。 */
  onPreviewArtifact?: (artifactId: number) => void;
}

/** 「成本」文案：有真数据才显值；无数据显 `—`（不写假 0）。 */
function costLine(cost: CostSummaryDTO | null | undefined, prefix = '成本'): string {
  if (!cost || cost.costRows === 0 || (cost.usd <= 0 && cost.tokens <= 0)) return `${prefix} —`;
  return cost.usd > 0 ? `${prefix} $${cost.usd.toFixed(4)}` : `${prefix} ${cost.tokens} tok`;
}

function statusLabel(status: 'running' | 'waiting' | 'idle' | 'stuck'): string {
  if (status === 'running') return '思考中';
  if (status === 'waiting') return '等你';
  if (status === 'stuck') return '卡住了';
  return '空闲';
}

/** 产物类型人话（不上英文 kind 原值）。 */
function artifactKindLabel(kind: string): string {
  if (kind === 'file') return '文件';
  if (kind === 'link') return '链接';
  if (kind === 'dir') return '目录';
  return kind;
}

export function OverviewRail({ cost, slots, employees, onOpenHall, onOpenEmployee }: OverviewRailProps): ReactElement {
  const active = (employees ?? [])
    .filter((employee) => employee.activity != null && employee.activity.status !== 'idle')
    .slice(0, 3);
  const hasCost = !!cost && cost.costRows > 0 && (cost.usd > 0 || cost.tokens > 0);

  return (
    <section className="right-rail__section" data-testid="right-rail-overview">
      <h2 className="right-rail__title">今日概览</h2>
      <div
        className="right-rail__row"
        data-testid="right-rail-slots"
        data-has-slots={slots ? 'true' : 'false'}
        title="调度器槽位占用/上限（scheduler:slots，真实读数）"
      >
        资源占用 {slots ? `${slots.running}/${slots.total} 槽` : '—'}
      </div>
      <div
        className="right-rail__row"
        data-testid="right-rail-cost"
        data-has-cost={hasCost ? 'true' : 'false'}
        title={hasCost ? '今日成本（cost:summary，真实数据）' : '暂无今日成本数据'}
      >
        {costLine(cost)}
      </div>

      <h3 className="right-rail__sectionhead">谁在忙</h3>
      {active.length > 0 ? (
        <ul className="right-rail__list" data-testid="right-rail-active">
          {active.map((employee) => (
            <li key={employee.id}>
              <button
                type="button"
                className="right-rail__emp"
                data-testid="right-rail-active-employee"
                title={`${employee.name} · ${statusLabel(employee.activity?.status ?? 'idle')}（去大厅看 TA）`}
                onClick={() => {
                  if (onOpenEmployee) onOpenEmployee(employee.id);
                  else onOpenHall?.();
                }}
              >
                <span className="right-rail__name">{employee.name}</span>
                <span className="right-rail__meta">
                  {statusLabel(employee.activity?.status ?? 'idle')}
                  {employee.activity?.taskShortId ? ` · ${employee.activity.taskShortId}` : ''}
                </span>
                {employee.activity?.currentAction ? (
                  <span className="right-rail__action">{employee.activity.currentAction}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="right-rail__empty" data-testid="right-rail-active-empty">
          {employees == null ? '调度详情在公司大厅。' : '现在没有员工在跑。'}
        </p>
      )}

      {onOpenHall ? (
        <button type="button" className="right-rail__link" data-testid="right-rail-open-hall" onClick={onOpenHall}>
          去公司大厅看调度 →
        </button>
      ) : null}
    </section>
  );
}

export function TaskRail({ detail, cost, loading, error, onPreviewArtifact }: TaskRailProps): ReactElement {
  if (loading) {
    return (
      <section className="right-rail__section" data-testid="right-rail-task">
        <h2 className="right-rail__title">任务上下文</h2>
        <p className="right-rail__empty">加载中…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="right-rail__section" data-testid="right-rail-task">
        <h2 className="right-rail__title">任务上下文</h2>
        <p className="right-rail__empty" role="status">
          {error}
        </p>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="right-rail__section" data-testid="right-rail-task">
        <h2 className="right-rail__title">任务上下文</h2>
        <p className="right-rail__empty">未选择任务。</p>
      </section>
    );
  }

  const artifacts = detail.artifacts ?? [];
  const evidence = detail.planSteps.filter((step) => typeof step.evidenceRef === 'string' && step.evidenceRef.length > 0);
  const title = detail.task.shortId ? `${detail.task.shortId} · ${detail.task.title}` : detail.task.title;

  return (
    <section className="right-rail__section" data-testid="right-rail-task">
      <h2 className="right-rail__title">任务上下文</h2>
      <p className="right-rail__taskhead" data-testid="right-rail-task-head">
        {title}
      </p>

      <h3 className="right-rail__sectionhead">产物（{artifacts.length}）</h3>
      {artifacts.length > 0 ? (
        <ul className="right-rail__list" data-testid="right-rail-task-artifacts">
          {artifacts.slice(0, 3).map((artifact) => (
            <li key={artifact.id} className="right-rail__item">
              {onPreviewArtifact ? (
                <button
                  type="button"
                  className="right-rail__artifact"
                  data-testid="right-rail-task-artifact"
                  data-artifact-id={artifact.id}
                  title="预览产物"
                  onClick={() => onPreviewArtifact(artifact.id)}
                >
                  <span className="right-rail__name">{artifact.name}</span>
                  <span className="right-rail__meta">{artifactKindLabel(artifact.kind)}</span>
                </button>
              ) : (
                <>
                  <span className="right-rail__name">{artifact.name}</span>
                  <span className="right-rail__meta">{artifactKindLabel(artifact.kind)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="right-rail__empty">暂无产物。</p>
      )}

      <h3 className="right-rail__sectionhead">证据（{evidence.length}）</h3>
      {evidence.length > 0 ? (
        <ul className="right-rail__list" data-testid="right-rail-task-evidence">
          {evidence.slice(0, 3).map((step) => (
            <li key={`evidence-${step.idx}`} className="right-rail__item">
              <span className="right-rail__name">步骤 {step.idx}</span>
              <span className="right-rail__meta">{step.evidenceRef}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="right-rail__empty">暂无证据。</p>
      )}

      <h3 className="right-rail__sectionhead">成本</h3>
      <div
        className="right-rail__row"
        data-testid="right-rail-task-cost"
        data-has-cost={cost && cost.costRows > 0 ? 'true' : 'false'}
      >
        {costLine(cost)}
      </div>

      {/* CTX1-2：上下文遥测（最近一轮；窗口/用量未知显 —；分层折叠，不铺成仪表盘）。 */}
      <h3 className="right-rail__sectionhead">上下文</h3>
      <TaskContextMetrics rows={detail.contextMetrics} />
    </section>
  );
}

function TaskContextMetrics({ rows }: { rows?: readonly ContextMetricDTO[] | null }): ReactElement {
  const list = rows ?? [];
  if (list.length === 0) {
    return (
      <p className="right-rail__empty" data-testid="right-rail-task-context-empty">
        还没有上下文遥测。
      </p>
    );
  }
  const latest = list[0]!;
  const used = latest.utilization != null ? `${Math.round(latest.utilization * 100)}%` : '—';
  const compaction = latest.compactionCount == null ? '—' : `${latest.compactionCount} 次`;
  const cache =
    latest.cacheReadTokens == null && latest.cacheWriteTokens == null
      ? '—'
      : `读 ${latest.cacheReadTokens ?? 0} / 写 ${latest.cacheWriteTokens ?? 0}`;
  return (
    <>
      <div className="right-rail__row" data-testid="right-rail-task-context">
        最近一轮 {latest.totalTokens} tok · 窗口 {latest.contextWindow ?? '—'} · 占用 {used}
      </div>
      <div className="right-rail__row" data-testid="right-rail-task-context-meta">
        压缩 {compaction} · 缓存 {cache}
      </div>
      <details data-testid="right-rail-task-context-layers">
        <summary className="right-rail__meta">分层（{latest.layers.length}）</summary>
        <ul className="right-rail__list">
          {latest.layers.map((layer) => (
            <li key={layer.name} className="right-rail__item" data-testid="right-rail-task-context-layer" data-layer={layer.name}>
              <span className="right-rail__name">{layer.name}</span>
              <span className="right-rail__meta">
                {layer.estTokens} tok{layer.truncated ? ` · 截断（${layer.tokensBeforeCap}→${layer.estTokens}）` : ''}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
