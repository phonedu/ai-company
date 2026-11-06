/**
 * B-6（M4）· 项目概览「项目记忆」纯视图（无 store 依赖，node 静态渲染可测）。
 * 容器见 `ProjectMemory.tsx`；口径：老板显式写、项目作用域、pin/忘记/提升全局。
 */
import type { CSSProperties, ReactElement } from 'react';

import type { MemoryAuditDTO, MemoryHitDTO, MemoryItemDTO } from '../types.js';

const MUTED: CSSProperties = { color: 'var(--muted, #888)', fontSize: 12 };

export const MEMORY_KIND_LABEL: Readonly<Record<MemoryItemDTO['kind'], string>> = {
  fact: '事实',
  decision: '决定',
  preference: '偏好',
  glossary: '术语',
  constraint: '约束',
};

/** 人话日期（无有效时间 → `—`，不写假 0）。 */
export function memoryTimeText(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export interface ProjectMemoryViewProps {
  projectId: number | null;
  /** P-03：项目 / 全局双 tab；全局不依赖项目。 */
  scope: 'project' | 'global';
  items: readonly MemoryItemDTO[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  draft: string;
  kind: MemoryItemDTO['kind'];
  busy: boolean;
  actingId: number | null;
  onScopeChange: (scope: 'project' | 'global') => void;
  onDraftChange: (value: string) => void;
  onKindChange: (kind: MemoryItemDTO['kind']) => void;
  onRemember: () => void;
  onTogglePin: (item: MemoryItemDTO) => void;
  onForget: (item: MemoryItemDTO) => void;
  onPromote: (item: MemoryItemDTO) => void;
  onRefresh: () => void;
  /** UG-09：列表 / 搜索 / 审计（搜索/审计只读）。 */
  mode?: 'list' | 'search' | 'audit';
  query?: string;
  hits?: readonly MemoryHitDTO[];
  audit?: MemoryAuditDTO | null;
  searching?: boolean;
  auditLoading?: boolean;
  onModeChange?: (mode: 'list' | 'search' | 'audit') => void;
  onQueryChange?: (value: string) => void;
  onSearch?: () => void;
  onLoadAudit?: () => void;
}

export function ProjectMemoryView(props: ProjectMemoryViewProps): ReactElement {
  const formAvailable = props.scope === 'global' || props.projectId != null;
  const canRemember = formAvailable && props.draft.trim().length > 0 && !props.busy;
  const mode = props.mode ?? 'list';
  return (
    <section className="project-pane__card" data-testid="project-memory">
      <h3 className="project-view__state-title">{props.scope === 'global' ? '全局记忆' : '项目记忆'}</h3>
      <p className="project-view__docs-text">
        老板显式记住的事实；项目记忆只注入该项目，全局记忆所有项目可见。项目条目可提升为全局。
      </p>

      <div className="project-view__docs-row" data-testid="project-memory-scope">
        <button
          type="button"
          className={`project-pane__btn${props.scope === 'project' ? ' project-pane__btn--primary' : ''}`}
          data-testid="project-memory-scope-project"
          aria-pressed={props.scope === 'project'}
          onClick={() => props.onScopeChange('project')}
        >
          项目
        </button>
        <button
          type="button"
          className={`project-pane__btn${props.scope === 'global' ? ' project-pane__btn--primary' : ''}`}
          data-testid="project-memory-scope-global"
          aria-pressed={props.scope === 'global'}
          onClick={() => props.onScopeChange('global')}
        >
          全局
        </button>
      </div>

      <div className="project-view__docs-row" data-testid="project-memory-modes">
        {([
          ['list', '列表'],
          ['search', '搜索'],
          ['audit', '审计'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`project-pane__btn${mode === key ? ' project-pane__btn--primary' : ''}`}
            data-testid={`project-memory-mode-${key}`}
            aria-pressed={mode === key}
            onClick={() => props.onModeChange?.(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'search' ? (
        <div data-testid="project-memory-search">
          <div className="project-view__docs-row project-view__trigger-form">
            <input
              className="project-view__trigger-input"
              data-testid="project-memory-search-input"
              placeholder="搜索记忆（只读）"
              value={props.query ?? ''}
              onChange={(event) => props.onQueryChange?.(event.target.value)}
              disabled={!formAvailable || props.searching}
            />
            <button
              type="button"
              data-testid="project-memory-search-run"
              disabled={!formAvailable || props.searching || (props.query ?? '').trim().length === 0}
              onClick={props.onSearch}
            >
              {props.searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          {props.hits === undefined ? (
            <p className="project-view__docs-text" data-testid="project-memory-search-hint">
              输入关键词搜索当前作用域的记忆；只读，不改动条目。
            </p>
          ) : props.hits.length === 0 ? (
            <p className="project-view__docs-text" data-testid="project-memory-search-empty">
              没有命中。
            </p>
          ) : (
            <ul className="project-view__trigger-list" data-testid="project-memory-search-list">
              {props.hits.map((hit) => (
                <li className="project-view__trigger-row" data-testid="project-memory-search-hit" key={hit.item.id}>
                  <span className="project-view__trigger-id">#{hit.item.id}</span>
                  <span>{MEMORY_KIND_LABEL[hit.item.kind]}</span>
                  <span className="project-view__trigger-goal">
                    {hit.item.key ? `[${hit.item.key}] ` : ''}
                    {hit.snippet}
                  </span>
                  <span style={MUTED} data-testid="project-memory-search-score">
                    score {hit.score}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {mode === 'audit' ? (
        <div data-testid="project-memory-audit">
          <div className="project-view__docs-row">
            <button
              type="button"
              data-testid="project-memory-audit-run"
              disabled={!formAvailable || props.auditLoading}
              onClick={props.onLoadAudit}
            >
              {props.auditLoading ? '读取中…' : '读取审计'}
            </button>
          </div>
          {props.audit == null ? (
            <p className="project-view__docs-text" data-testid="project-memory-audit-hint">
              读取当前作用域的记忆审计（只读）：总数/活跃/token、重复、冲突、过期、超长、缺来源。
            </p>
          ) : (
            <div data-testid="project-memory-audit-result">
              <p className="project-view__docs-text" data-testid="project-memory-audit-summary">
                总数 {props.audit.total} · 活跃 {props.audit.active} · token {props.audit.tokens}
              </p>
              {([
                ['duplicates', '重复'],
                ['conflicts', '冲突'],
                ['stale', '过期'],
                ['oversize', '超长'],
                ['missingSource', '缺来源'],
              ] as const).map(([key, label]) => {
                const rows = props.audit?.[key] ?? [];
                return (
                  <section key={key} data-testid={`project-memory-audit-${key}`}>
                    <h4>{label}（{rows.length}）</h4>
                    {rows.length === 0 ? (
                      <p className="project-view__docs-text">无</p>
                    ) : (
                      <ul className="project-view__trigger-list">
                        {rows.map((item) => (
                          <li className="project-view__trigger-row" key={item.id}>
                            <span className="project-view__trigger-id">#{item.id}</span>
                            <span>{item.key ? `[${item.key}] ` : ''}{item.value}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      <div className="project-view__docs-row project-view__trigger-form" data-testid="project-memory-form">
        <select
          className="project-view__trigger-input"
          data-testid="project-memory-kind"
          value={props.kind}
          onChange={(event) => props.onKindChange(event.target.value as MemoryItemDTO['kind'])}
          disabled={!formAvailable || props.busy}
        >
          {(Object.keys(MEMORY_KIND_LABEL) as Array<MemoryItemDTO['kind']>).map((kind) => (
            <option key={kind} value={kind}>
              {MEMORY_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
        <input
          className="project-view__trigger-input"
          data-testid="project-memory-input"
          placeholder={props.scope === 'global' ? '例如：输出一律用中文' : '例如：对账单以万元为单位'}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          disabled={!formAvailable || props.busy}
        />
        <button type="button" data-testid="project-memory-add" disabled={!canRemember} onClick={props.onRemember}>
          {props.busy ? '写入中…' : '记住'}
        </button>
        <button type="button" data-testid="project-memory-refresh" disabled={props.loading || props.projectId == null} onClick={props.onRefresh}>
          刷新
        </button>
      </div>

      {props.notice ? (
        <p className="project-pane__message" data-testid="project-memory-notice" role="status">
          {props.notice}
        </p>
      ) : null}
      {props.error ? (
        <p className="project-view__error" data-testid="project-memory-error" role="alert">
          {props.error}
        </p>
      ) : null}

      {props.loading ? (
        <p className="project-view__docs-text" data-testid="project-memory-loading">
          读取中…
        </p>
      ) : props.items.length === 0 ? (
        props.error ? null : (
          <p className="project-view__docs-text" data-testid="project-memory-empty">
            {props.scope === 'global'
              ? '还没有全局记忆。全局事实对所有项目生效；也可在项目记忆里把一条提升为全局。'
              : '还没有项目记忆。记住一条事实，之后员工会话会按项目注入。'}
          </p>
        )
      ) : (
        <ul className="project-view__trigger-list" data-testid="project-memory-list">
          {props.items.map((item) => (
            <li className="project-view__trigger-row" data-testid="project-memory-row" data-memory-id={item.id} key={item.id}>
              <span className="project-view__trigger-id">#{item.id}</span>
              <span data-testid="project-memory-kind-label">{MEMORY_KIND_LABEL[item.kind]}</span>
              <span className="project-view__trigger-goal" data-testid="project-memory-value">
                {item.key ? `[${item.key}] ` : ''}
                {item.value}
                {item.pinned ? ' 📌' : ''}
              </span>
              <span style={MUTED} data-testid="project-memory-updated">
                {memoryTimeText(item.updatedAt)}
              </span>
              <button
                type="button"
                data-testid="project-memory-pin"
                disabled={props.actingId === item.id}
                onClick={() => props.onTogglePin(item)}
              >
                {item.pinned ? '取消置顶' : '置顶'}
              </button>
              {item.scope.type === 'project' ? (
                <button
                  type="button"
                  data-testid="project-memory-promote"
                  disabled={props.actingId === item.id}
                  onClick={() => props.onPromote(item)}
                >
                  提升为全局
                </button>
              ) : null}
              <button
                type="button"
                data-testid="project-memory-forget"
                disabled={props.actingId === item.id}
                onClick={() => props.onForget(item)}
              >
                忘记
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
