/**
 *  文案守门（2026-10-17）——把开发语言挡在主界面之外。
 *
 * 规则：
 *   ① 首启 / 建任务 / 命令面板 / 设置的主界面（非注释行）不得出现：
 *      `回落 env` / `后续件` / `N1` / `开发档` / `装配` / `预算 tokens` / `全局组＝跨项目`；
 *   ② 首启主按钮必须是 primary，跳过类为 ghost；
 *   ③ 设置的 JSON 路由必须收进 `<details>`（高级折叠），不再平铺。
 *
 * 注释行不参与（注释是给开发者的；这里锁的是会渲染出去的文案）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = [
  'src/renderer/components/OnboardingWizard.tsx',
  'src/renderer/components/TaskCreateDialog.tsx',
  'src/renderer/components/CommandPalette.tsx',
  'src/renderer/components/SettingsPane.tsx',
];

const BANNED = ['回落 env', '后续件', 'N1', '开发档', '装配', '预算 tokens', '全局组＝跨项目'];

function visibleSource(path: string): string {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

test('B4 主界面不得再出现开发语言（按文件逐条锁）', () => {
  for (const file of FILES) {
    const source = visibleSource(file);
    for (const term of BANNED) {
      assert.equal(source.includes(term), false, `${file} 仍出现开发术语「${term}」`);
    }
  }
});

test('B4 首启：主按钮 primary、跳过 ghost（只有一个主行动）', () => {
  const source = readFileSync('src/renderer/components/OnboardingWizard.tsx', 'utf8');
  assert.match(source, /className="card__btn card__btn--primary"[\s\S]{0,160}data-testid="onboarding-next"/, '下一步应为实底主按钮');
  assert.match(source, /className="card__btn card__btn--ghost"[\s\S]{0,160}data-testid="onboarding-finish-all"/, '全部跳过应为幽灵按钮');
  assert.equal(source.includes('API Key 的界面配置未实现'), false, '旧开发备注应已删');
});

test('B4 设置：JSON 路由收进高级折叠，供应商 Key 可填写（不再摆技术说明）', () => {
  const source = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
  assert.match(source, /<details className="settings-advanced" data-testid="settings-advanced-json">/);
  assert.match(source, /<summary className="settings-advanced__summary" data-testid="settings-devblock-title">/);
  assert.match(source, /data-testid=\{`settings-provider-key-\$\{provider\.provider\}`\}/, '供应商 Key 输入框在场');
  assert.equal(source.includes('settings-provider-test'), false, '不再摆假的“测试连通”按钮');
});

test('B4 建任务：执行方式 / 谁来做 / 预算按 token 计（人话）', () => {
  const source = readFileSync('src/renderer/components/TaskCreateDialog.tsx', 'utf8');
  assert.match(source, /执行方式/);
  assert.match(source, /谁来做/);
  assert.match(source, /预算上限（可选，按 token 计）/);
  assert.match(source, /先审计划（推荐）/);
});
