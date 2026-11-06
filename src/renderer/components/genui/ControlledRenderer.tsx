/**
 * GenUI 受控渲染器（M1 最小版）—— 契约 `UI.md §4.7`。
 *
 * **同进程白名单渲染**：模型只提供 JSON，这里 `switch(component.type)` 渲染**我们自己的组件**，
 * **绝不执行模型生成的 JS**（`index.html` CSP 不改、不引入 `unsafe-eval`）。
 * - 只发**意图**（`GenUiIntent`）→ 主进程过 `permissionGate`（渲染层无副作用能力）；
 * - 来源标注：卡片头 `card-provenance`；
 * - `meta.provenance === 'external-echo'` 或 `complete === false` → **强制只读**（禁用交互）。
 */
import type { CSSProperties, ReactElement } from 'react';

import type { GenUiActionDef, GenUiComponent, GenUiIntent, GenUiSchema } from './schema';

const PROVENANCE_STYLE: CSSProperties = { color: 'var(--text-dim)', fontSize: 'var(--text-micro)', marginBottom: 6 };
const BTN_STYLE: CSSProperties = {
  minHeight: 32,
  padding: '0 14px',
  border: 0,
  borderRadius: 'var(--radius-pill)',
  background: 'var(--fill)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 'var(--text-body)',
  fontWeight: 500,
  cursor: 'pointer',
};
// 2026-10-23 UI 简化：卡片推荐项用浅色选中；整屏的实心主按钮只留给真正的动作（如「去验收」）。
const BTN_PRIMARY_STYLE: CSSProperties = { ...BTN_STYLE, background: 'var(--tint-soft)', color: 'var(--accent-ink)' };
const BTN_DANGER_STYLE: CSSProperties = { ...BTN_STYLE, background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)' };
const PROGRESS_BAR_STYLE: CSSProperties = { position: 'relative', height: 5, borderRadius: 'var(--radius-pill)', background: 'var(--fill)', overflow: 'hidden', flex: '1 1 auto' };
const PROGRESS_FILL_STYLE: CSSProperties = { position: 'absolute', inset: '0 auto 0 0', background: 'var(--accent)' };

function btnStyle(variant: GenUiActionDef['variant']): CSSProperties {
  if (variant === 'primary') return BTN_PRIMARY_STYLE;
  if (variant === 'danger') return BTN_DANGER_STYLE;
  return BTN_STYLE;
}

function formatAt(at: number | undefined): string {
  if (typeof at !== 'number') return '';
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 组件渲染（受控；未知类型已在 `validateSchema` 处拦截 → 不会走到这里）。 */
function renderComponent(
  node: GenUiComponent,
  schemaId: string,
  readOnly: boolean,
  onIntent?: (intent: GenUiIntent) => void,
): ReactElement | null {
  const props = node.props ?? {};
  switch (node.type) {
    case 'stack':
      return (
        <div className="genui-stack" data-testid="genui-stack" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(node.children ?? []).map((child) => (
            <ControlledNode key={child.id} node={child} schemaId={schemaId} readOnly={readOnly} onIntent={onIntent} />
          ))}
        </div>
      );
    case 'text': {
      const text = typeof props.text === 'string' ? props.text : '';
      return (
        <div className="genui-text" data-testid="genui-text" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {text}
        </div>
      );
    }
    case 'progress': {
      const value = typeof props.value === 'number' ? props.value : 0;
      const max = typeof props.max === 'number' && props.max > 0 ? props.max : 1;
      const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
      return (
        <div className="genui-progress" data-testid="genui-progress" data-value={value} data-max={max} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={PROGRESS_BAR_STYLE}>
            <span style={{ ...PROGRESS_FILL_STYLE, width: `${pct}%` }} />
          </span>
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {typeof props.label === 'string' && props.label.length > 0 ? `${props.label} ` : ''}
            {value}/{max}
          </span>
        </div>
      );
    }
    case 'disclosure': {
      const summary = typeof props.summary === 'string' ? props.summary : '';
      // 本地展开，**不回传意图**。
      return (
        <details className="genui-disclosure" data-testid="genui-disclosure">
          <summary style={{ cursor: 'pointer' }}>{summary}</summary>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(node.children ?? []).map((child) => (
              <ControlledNode key={child.id} node={child} schemaId={schemaId} readOnly={readOnly} onIntent={onIntent} />
            ))}
          </div>
        </details>
      );
    }
    case 'button-group': {
      const actions = Array.isArray(props.actions) ? (props.actions as GenUiActionDef[]) : [];
      return (
        <div className="genui-button-group" data-testid="genui-button-group" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              data-testid="genui-button"
              data-action={action.action ?? 'select'}
              data-key={action.key}
              disabled={readOnly || action.disabled === true}
              style={btnStyle(action.variant)}
              onClick={() => {
                if (readOnly) return;
                onIntent?.({
                  schemaId,
                  componentId: node.id,
                  action: action.action ?? 'select',
                  payload: { key: action.key },
                });
              }}
            >
              {action.label}
              {action.recommended === true ? '（推荐）' : ''}
            </button>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

function ControlledNode(props: {
  node: GenUiComponent;
  schemaId: string;
  readOnly: boolean;
  onIntent?: (intent: GenUiIntent) => void;
}): ReactElement | null {
  return renderComponent(props.node, props.schemaId, props.readOnly, props.onIntent);
}

export function ControlledRenderer({
  schema,
  onIntent,
}: {
  schema: GenUiSchema;
  onIntent?: (intent: GenUiIntent) => void;
}): ReactElement {
  // `external-echo`（外部回显）或未完成 → 强制只读（安全：危险/未定界面不可点）。
  const readOnly = schema.meta.provenance === 'external-echo' || schema.complete === false;
  const gb = schema.meta.generatedBy;
  const who = gb.employeeName ?? (gb.employeeId != null ? `员工#${gb.employeeId}` : '系统');
  const when = formatAt(schema.meta.at);

  return (
    <article className="genui-card" data-testid="genui-card" data-schema-id={schema.id} data-provenance={schema.meta.provenance} data-complete={String(schema.complete)}>
      <div className="genui-provenance" data-testid="card-provenance" style={PROVENANCE_STYLE}>
        由 {who}
        {gb.taskShortId ? ` · ${gb.taskShortId}` : ''} 生成{when ? ` · ${when}` : ''}
        {schema.meta.provenance === 'external-echo' ? ' · 外部内容（只读）' : ''}
      </div>
      <ControlledNode node={schema.root} schemaId={schema.id} readOnly={readOnly} onIntent={onIntent} />
    </article>
  );
}
