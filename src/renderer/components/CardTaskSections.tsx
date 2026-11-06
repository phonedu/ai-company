/**
 * UG-10 · 汇报卡任务分区（产物 / 变更 / 证据 / 成本）。
 *
 * 只在卡片展开时拉 `task:get` + `cost:summary`；不复制 payload、不假设 0。
 * 数字来自主进程；空数据显式 `—`/空态。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getApi } from '../api.js';

interface CardTaskArtifact {
  id: number;
  name: string;
  kind?: string;
  path?: string;
}

interface CardTaskChangeset {
  filesChanged: number;
  insertions: number;
  deletions: number;
  state: string;
}

interface CardTaskDetail {
  artifacts?: CardTaskArtifact[];
  changesets?: CardTaskChangeset[] | null;
  planSteps?: Array<{ text: string; evidenceRef?: string | null }>;
}

interface CardTaskCost {
  costRows?: number;
  tokens?: number;
  usd?: number;
  cacheHitRate?: number | null;
}

function sumChanges(changesets: readonly CardTaskChangeset[] | null | undefined): {
  files: number;
  insertions: number;
  deletions: number;
} {
  const rows = changesets ?? [];
  return {
    files: rows.reduce((n, c) => n + (Number(c.filesChanged) || 0), 0),
    insertions: rows.reduce((n, c) => n + (Number(c.insertions) || 0), 0),
    deletions: rows.reduce((n, c) => n + (Number(c.deletions) || 0), 0),
  };
}

export function CardTaskSections({
  taskId,
  onPreviewArtifact,
}: {
  taskId: number;
  /** UG-05/10：汇报卡产物入口——打开任务详情并把该产物预览放进抽屉。 */
  onPreviewArtifact?: (artifactId: number) => void;
}): ReactElement {
  const [detail, setDetail] = useState<CardTaskDetail | null>(null);
  const [cost, setCost] = useState<CardTaskCost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const api = getApi();
    if (!api?.task?.get) {
      setLoading(false);
      setError('任务通道不可用');
      return () => {
        alive = false;
      };
    }
    void Promise.all([
      api.task.get({ taskId }) as Promise<CardTaskDetail | null>,
      api.cost?.summary ? (api.cost.summary({ taskId }) as Promise<CardTaskCost | null>) : Promise.resolve(null),
    ])
      .then(([nextDetail, nextCost]) => {
        if (!alive) return;
        setDetail(nextDetail ?? null);
        setCost(nextCost ?? null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  if (loading) {
    return (
      <p className="card__sections-note" data-testid="card-task-sections-loading">
        读取任务产物/变更/证据/成本…
      </p>
    );
  }
  if (error) {
    return (
      <p className="card__sections-error" data-testid="card-task-sections-error" role="alert">
        任务数据读取失败：{error}
      </p>
    );
  }

  const artifacts = detail?.artifacts ?? [];
  const changes = sumChanges(detail?.changesets);
  const evidence = (detail?.planSteps ?? []).filter(
    (step) => typeof step.evidenceRef === 'string' && step.evidenceRef.length > 0,
  );
  const usd = cost?.usd;
  const tokens = cost?.tokens;
  const cacheHit = cost?.cacheHitRate;

  return (
    <div className="card__sections" data-testid="card-task-sections">
      <section data-testid="card-task-artifacts">
        <span className="card__sections-label">产物（{artifacts.length}）</span>
        {artifacts.length === 0 ? (
          <span className="card__sections-empty">—</span>
        ) : (
          <span className="card__sections-value">
            {artifacts.slice(0, 3).map((a) => (
              <button
                key={a.id}
                type="button"
                className="card__sections-link"
                data-testid="card-task-artifact-preview"
                disabled={!onPreviewArtifact}
                title={onPreviewArtifact ? '在任务详情抽屉里预览' : '预览入口未接线'}
                onClick={() => onPreviewArtifact?.(a.id)}
              >
                {a.name}
              </button>
            ))}
            {artifacts.length > 3 ? ` 等 ${artifacts.length} 个` : ''}
          </span>
        )}
      </section>
      <section data-testid="card-task-changes">
        <span className="card__sections-label">变更</span>
        <span className="card__sections-value">
          {detail?.changesets == null || detail.changesets.length === 0
            ? '—'
            : `${changes.files} 文件 · +${changes.insertions} −${changes.deletions}`}
        </span>
      </section>
      <section data-testid="card-task-evidence">
        <span className="card__sections-label">证据（{evidence.length}）</span>
        <span className="card__sections-value">
          {evidence.length === 0
            ? '—'
            : evidence
                .slice(0, 2)
                .map((s) => s.evidenceRef)
                .join('、')}
        </span>
      </section>
      <section data-testid="card-task-cost">
        <span className="card__sections-label">成本</span>
        <span className="card__sections-value">
          {usd == null && tokens == null
            ? '—'
            : `${usd == null ? '—' : `$${usd.toFixed(4)}`}${tokens == null ? '' : ` · ${tokens} tokens`}${
                cacheHit == null ? '' : ` · 缓存命中 ${(cacheHit * 100).toFixed(0)}%`
              }`}
        </span>
      </section>
    </div>
  );
}
