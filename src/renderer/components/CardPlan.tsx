/**
 * GAP8：批准卡上的计划全文（纯展示，不依赖 store/API——可独立单测）。
 * 数据来源＝`reports.payload.planSteps`；编辑计划后由主进程合并刷新同一份卡 payload。
 */
import type { ReactElement } from 'react';

export function CardPlan({ steps }: { steps: readonly string[] }): ReactElement {
  return (
    <div className="card__plan" data-testid="card-plan" data-count={steps.length}>
      <span className="card__planhead">计划（{steps.length} 步）</span>
      <ol className="card__planlist">
        {steps.map((step, index) => (
          <li key={`plan-${index}`}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
