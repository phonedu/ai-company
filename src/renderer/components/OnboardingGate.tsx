import { useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { attachProject, finishOnboarding, loadOnboarding, onboarding, recruitEmployee } from '../store';
import { OnboardingWizard } from './OnboardingWizard';

// ─────────────────────────────────────────────────────────────────────────────
// 首启向导**容器**：store ↔ 纯组件 `OnboardingWizard` 的接线。
//   2026-10-23 UI 简化：一屏只接项目文件夹；模型/Key 去设置页，评审员工仍可一键补。
//   真机验（CDP：`scripts/verification/onboarding.mjs`，空库首启）＋ 纯组件 node 测。
// ─────────────────────────────────────────────────────────────────────────────

export function OnboardingGate(): ReactElement {
  const snap = useSnapshot(onboarding);
  /** B-5：缺评审时的一键添加（只由老板点击，不静默种人）。 */
  const [addingReviewer, setAddingReviewer] = useState(false);
  const [reviewerNotice, setReviewerNotice] = useState<string | null>(null);
  const [reviewerError, setReviewerError] = useState<string | null>(null);

  const addReviewer = async (): Promise<void> => {
    if (addingReviewer) return;
    setAddingReviewer(true);
    setReviewerNotice(null);
    setReviewerError(null);
    const res = await recruitEmployee({
      name: '评审员工',
      role: '评审',
      persona: '首启一键添加：独立评审/验证，不执行生产；可在设置·员工细化。',
      capabilityTier: 'standard',
    });
    setAddingReviewer(false);
    if (!res.ok) {
      setReviewerError(res.error);
      return;
    }
    setReviewerNotice(`已添加 ${res.employee.employee.name}（#${res.employee.employee.id}）——中/高风险任务可独立评审。`);
    await loadOnboarding();
  };

  return (
    <OnboardingWizard
      onFinish={() => void finishOnboarding()}
      onAttach={() => void attachProject()}
      attaching={snap.attach.status === 'busy'}
      attached={snap.projectAttached}
      attachNote={snap.attach.note}
      employees={snap.employees}
      error={snap.attach.error}
      onAddReviewer={() => void addReviewer()}
      addingReviewer={addingReviewer}
      reviewerNotice={reviewerNotice}
      reviewerError={reviewerError}
    />
  );
}

/** 供 `AppShell` 在挂载时调用（读 `onboarding.completed` ＋ 预取名册）。 */
export { loadOnboarding };
