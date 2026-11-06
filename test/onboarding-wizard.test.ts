import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { hasReviewerEmployee, OnboardingWizard, type OnboardingWizardProps } from '../src/renderer/components/OnboardingWizard.js';

// ── 2026-10-23 UI 简化：首启一屏（只选项目文件夹）；模型/员工细节延后到设置/首次需要 ──

const BASE: OnboardingWizardProps = {
  onFinish: () => undefined,
  onAttach: () => undefined,
  attaching: false,
  attached: false,
  attachNote: null,
  employees: [],
  error: null,
};

function render(overrides: Partial<OnboardingWizardProps> = {}): string {
  return renderToStaticMarkup(createElement(OnboardingWizard, { ...BASE, ...overrides }));
}

test('首启一屏：标题「给公司一个项目文件夹」；主按钮选文件夹；「先逛逛」幽灵；不再有分步/跳过/模型/员工屏', () => {
  const html = render();
  assert.match(html, /data-testid="onboarding-title"[^>]*>给公司一个项目文件夹/);
  assert.match(html, /data-testid="onboarding-progress"[^>]*>1\/1/);
  assert.ok(html.includes('data-testid="onboarding-step-project"'), '唯一屏在场');
  const next = html.match(/<button[^>]*data-testid="onboarding-next"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
  assert.match(next, /选择文件夹/);
  assert.ok(html.includes('data-testid="onboarding-finish-all"'), '「先逛逛」恒在场');
  assert.equal(html.includes('data-testid="onboarding-skip"'), false, '不再有分步跳过');
  assert.equal(html.includes('data-testid="onboarding-step-model"'), false, '模型屏退出首启');
  assert.equal(html.includes('data-testid="onboarding-step-employees"'), false, '员工屏退出首启');
  assert.equal(html.includes('data-testid="onboarding-model-input"'), false, '首启不再填模型名');
});

test('首启一屏 · 探测结果如实回显：未选不显示；已接入原样上屏；已接入主按钮变「开始使用」', () => {
  assert.equal(render().includes('data-testid="onboarding-attach-note"'), false, '未探测不显示结果');
  const note = '已接入「billing」（D:/projects/billing）：Python 项目（pyproject.toml） · git ✓（原地模式：每任务一分支）';
  const html = render({ attachNote: note });
  assert.ok(html.includes('data-testid="onboarding-attach-note"'), '探测结果上屏');
  assert.ok(html.includes('billing'), '原样上屏');
  const attached = render({ attached: true, attachNote: note });
  const next = attached.match(/<button[^>]*data-testid="onboarding-next"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
  assert.match(next, /开始使用/);
});

test('B-5 首启仍保留缺评审强提示：缺 → 提示＋一键添加；有 → 不再出按钮；缺接线 → disabled', () => {
  const reviewer = { id: 2, name: '评审员工', role: '评审' };
  assert.equal(hasReviewerEmployee([{ id: 0, name: '幕僚长', role: '编排/调度' }]), false);
  assert.equal(hasReviewerEmployee([reviewer]), true);

  const missing = render({ employees: [{ id: 0, name: '幕僚长', role: '编排/调度' }], onAddReviewer: () => undefined });
  assert.ok(missing.includes('data-testid="onboarding-reviewer-missing"'), '缺评审时强提示');
  assert.ok(missing.includes('data-testid="onboarding-add-reviewer"'), '缺评审时一键添加');
  assert.doesNotMatch(missing, /data-testid="onboarding-add-reviewer"[^>]*disabled/, '已接线时按钮可点');

  const inert = render({ employees: [] });
  assert.match(inert, /data-testid="onboarding-add-reviewer"[^>]*disabled/, '缺接线时 disabled（不假装可点）');

  const withReviewer = render({ employees: [reviewer], onAddReviewer: () => undefined });
  assert.ok(withReviewer.includes('data-testid="onboarding-reviewer-present"'), '有评审时显示已就绪');
  assert.equal(withReviewer.includes('data-testid="onboarding-add-reviewer"'), false, '有评审时不再出添加按钮');

  const gate = readFileSync('src/renderer/components/OnboardingGate.tsx', 'utf8');
  assert.match(gate, /recruitEmployee\(/, '容器必须走真实招募通道');
  assert.match(gate, /role:\s*'评审'/, '一键添加的是评审员工（不是静默种执行员工）');
});

test('首启不再承诺模型/Key/员工模板：没有 Key 输入、没有假模板按钮', () => {
  const html = render();
  assert.equal(html.includes('onboarding-api-key'), false);
  assert.equal(html.includes('员工模板库'), false);
  assert.equal(html.includes('模型库'), false);
});
