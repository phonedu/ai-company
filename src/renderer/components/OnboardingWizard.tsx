import { useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { useFocusTrap } from './useFocusTrap.js';

// ─────────────────────────────────────────────────────────────────────────────
// 首启向导（2026-10-23 UI 简化）——**一屏**：只问「项目文件夹」。
//   · 模型/Key 延后到设置·模型与供应商；员工模板库不做。
//   · B-5 底线保留：缺独立评审员工时，在同一屏给强提示＋一键添加（不静默种人）。
//   · 纯组件：props 进 DOM 出，不依赖 store。
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingEmployee {
  id: number;
  name: string;
  role: string;
}

/** B-5：名册里是否已有独立评审员工（按角色/名字识别；空库不静默种人，只提示/一键添加）。 */
export function hasReviewerEmployee(employees: readonly OnboardingEmployee[]): boolean {
  return employees.some((e) => /评审|review/i.test(e.role) || /评审|review/i.test(e.name));
}

export interface OnboardingWizardProps {
  /** 「先逛逛」/完成——写 `onboarding.completed` 并关闭。 */
  onFinish: () => void;
  /** 选项目文件夹（主进程 dialog；只记录路径）。 */
  onAttach: () => void;
  attaching: boolean;
  /** 已接入项目（主按钮变「开始使用」；未接入＝「选择文件夹…」）。 */
  attached: boolean;
  attachNote: string | null;
  employees: readonly OnboardingEmployee[];
  error: string | null;
  /** B-5：缺评审时的一键添加（缺省 ⇒ 按钮 disabled，不假装可点）。 */
  onAddReviewer?: () => void;
  addingReviewer?: boolean;
  reviewerNotice?: string | null;
  reviewerError?: string | null;
}

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.45)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 50,
};
const CARD: CSSProperties = { width: 560, maxWidth: '92vw', display: 'grid', gap: 12, padding: 20 };
const MUTED: CSSProperties = { color: 'var(--text-dim)', fontSize: 'var(--text-note)' };
const ERR: CSSProperties = { color: 'var(--danger)', fontSize: 'var(--text-note)' };
const HEAD: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };

export function OnboardingWizard(props: OnboardingWizardProps): ReactElement {
  const cardRef = useRef<HTMLElement | null>(null);
  useFocusTrap(true, cardRef);
  const primaryLabel = props.attached ? '开始使用' : props.attaching ? '选择中…' : '选择文件夹…';
  return (
    <div className="onboarding" data-testid="onboarding-wizard" style={OVERLAY}>
      <section
        ref={cardRef}
        className="onboarding__card card"
        style={CARD}
        role="dialog"
        aria-modal="true"
        aria-label="首次设置"
      >
        <header style={HEAD}>
          <span style={MUTED}>首次设置</span>
          <span style={MUTED} data-testid="onboarding-progress">
            1/1
          </span>
        </header>
        <h2 data-testid="onboarding-title" style={{ margin: 0, fontSize: 'var(--text-title)', fontWeight: 600 }}>
          给公司一个项目文件夹
        </h2>
        <p style={MUTED}>只记录路径，不搬动你的文件。之后可以在设置里改。</p>

        {props.error ? (
          <p data-testid="onboarding-error" style={ERR}>
            {props.error}
          </p>
        ) : null}

        <div data-testid="onboarding-step-project" style={{ display: 'grid', gap: 8 }}>
          {props.attachNote ? (
            <p data-testid="onboarding-attach-note" style={MUTED}>
              {props.attachNote}
            </p>
          ) : (
            <p style={MUTED} data-testid="onboarding-attach-empty">
              还没有选择文件夹
            </p>
          )}
          <button
            type="button"
            className="card__btn card__btn--primary"
            data-testid="onboarding-next"
            data-autofocus
            disabled={props.attaching}
            onClick={() => {
              if (props.attached) {
                props.onFinish();
                return;
              }
              props.onAttach();
            }}
          >
            {primaryLabel}
          </button>
          <button type="button" className="card__btn card__btn--ghost" data-testid="onboarding-finish-all" onClick={props.onFinish}>
            先逛逛
          </button>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {hasReviewerEmployee(props.employees) ? (
            <p data-testid="onboarding-reviewer-present" style={MUTED}>
              评审员工已就位：中/高风险任务可以做到「评审 ≠ 执行」。
            </p>
          ) : (
            <div data-testid="onboarding-reviewer-missing" style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0 }}>
                <strong>还缺独立评审员工。</strong>中/高风险任务要求「评审 ≠ 执行」；可一键补上，或稍后在设置·员工里加。
              </p>
              <button
                type="button"
                className="card__btn card__btn--ghost"
                data-testid="onboarding-add-reviewer"
                disabled={!props.onAddReviewer || props.addingReviewer === true}
                onClick={props.onAddReviewer}
              >
                {props.addingReviewer ? '添加中…' : '一键添加评审员工'}
              </button>
            </div>
          )}
          {props.reviewerNotice ? (
            <p data-testid="onboarding-reviewer-notice" style={MUTED}>
              {props.reviewerNotice}
            </p>
          ) : null}
          {props.reviewerError ? (
            <p data-testid="onboarding-reviewer-error" style={ERR}>
              {props.reviewerError}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
