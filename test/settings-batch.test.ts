/**
 * 设置批（2026-10-16，替换批·第六批）——判据：
 *   ① 分区行「未实现」＝丸（`settings-pill` + testid；不再裸文本）；
 *   ② 「员工」分区＝**花名册**（真数据）＋「配置 ▸」（缺接线 ⇒ disabled）＋「＋招募」（NI ⇒ disabled＋理由）；
 *   ③ 「模型与供应商」＝**供应商连接区**（NI 如实：disabled 测试钮＋理由）＋默认模型**脏值标记**
 *      （accent 描边＋「已改待存」）＋「开发档 · JSON」两档口径；
 *   ④ 数字键行（高级/通知）同款脏值标记；输入控件自绘基样式在场。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import { SettingsPane, type SettingsPaneProps } from '../src/renderer/components/SettingsPane.js';

function base(over: Partial<SettingsPaneProps> = {}): SettingsPaneProps {
  return {
    section: 'models',
    onSectionChange: () => {},
    loading: false,
    error: null,
    saved: null,
    model: 'deepseek/deepseek-flash',
    modelDraft: 'deepseek/deepseek-flash',
    onModelDraftChange: () => {},
    onSaveModel: () => {},
    defaultProjectId: null,
    projects: [],
    onSetDefaultProject: () => {},
    tuningValues: {},
    tuningDrafts: {},
    onTuningDraftChange: () => {},
    onSaveTuning: () => {},
    ...over,
  };
}

function render(over: Partial<SettingsPaneProps> = {}): string {
  return renderToStaticMarkup(createElement(SettingsPane, base(over)));
}

test('分区行未实现丸：当前所有分区已实现 → 不出现；裸文本退役', () => {
  const html = render({ section: 'general' });
  assert.doesNotMatch(html, /data-testid="settings-unimplemented"/, '权限已实现后不再挂未实现丸');
  assert.equal(html.includes('·未实现'), false, '裸文本标记退役');
});

test('员工分区：花名册（真数据）＋「配置 ▸」（接线可点/缺接线禁用）＋「＋招募」接线可点/缺接线禁用', () => {
  const employees = [
    { id: 0, name: '幕僚长', role: '编排' },
    { id: 1, name: '研究员', role: 'researcher' },
  ];
  const wired = render({ section: 'employees', employees, onOpenEmployee: () => {}, onRecruit: () => {} });
  assert.match(wired, /data-testid="settings-employee-row"[^>]*data-employee-id="0"/);
  assert.match(wired, /data-testid="settings-employee-row"[^>]*data-employee-id="1"/);
  assert.match(wired, /研究员/);
  const configTags = wired.match(/<button[^>]*data-testid="settings-employee-config"[^>]*>/g) ?? [];
  assert.equal(configTags.length, 2, '每人一枚「配置 ▸」');
  assert.equal(configTags.every((t) => !t.includes('disabled')), true, '接线在场 ⇒ 可点');
  const recruitTag = wired.match(/<button[^>]*data-testid="settings-employee-recruit"[^>]*>/)?.[0] ?? '';
  assert.equal(recruitTag.includes('disabled'), false, '接线在场 ⇒ 招募可点');
  assert.match(recruitTag, /title="招募一名员工（名字\/角色\/偏好模型）"/);

  // 加载中/空态：不摆假行。
  assert.match(render({ section: 'employees', employees: null }), /data-testid="settings-employees-loading"/);
  assert.match(render({ section: 'employees', employees: [] }), /data-testid="settings-employees-empty"/);
  const inert = render({ section: 'employees', employees, onOpenEmployee: undefined });
  assert.match(inert, /data-testid="settings-employee-config"[^>]*disabled/, '缺接线 ⇒ 禁用（不假装可点）');
  assert.match(inert, /data-testid="settings-employee-recruit"[^>]*disabled/, '缺接线 ⇒ 招募禁用');
});

test('模型与供应商：供应商 Key 状态/输入/保存/清除（env 优先时只读）；默认模型脏值标记；开发档标', () => {
  const providers = [
    { provider: 'deepseek', label: 'DeepSeek', configured: true, source: 'file' as const, masked: '••••1234', envConfigured: false, fileConfigured: true },
    { provider: 'anthropic', label: 'Anthropic', configured: false, source: null, masked: null, envConfigured: false, fileConfigured: false },
  ];
  const html = render({
    section: 'providers',
    providers,
    providerDrafts: {},
    onSaveProviderKey: () => undefined,
    onClearProviderKey: () => undefined,
  });
  assert.match(html, /data-testid="settings-providers"/);
  assert.match(html, /data-testid="settings-provider-deepseek"/);
  assert.match(html, /已配置（本机 · ••••1234）/);
  assert.match(html, /data-testid="settings-provider-key-anthropic"/);
  assert.match(html, /data-testid="settings-provider-clear-deepseek"/);
  assert.equal(html.includes('settings-provider-test'), false, '不再摆假的“测试连通”按钮');
  assert.match(render({ section: 'models' }), /data-testid="settings-devblock-title"/, 'JSON 收进「高级」折叠');
  assert.equal(html.includes('后续件'), false, '不得再用开发备注「后续件」');
  assert.equal(/data-testid="settings-model-dirty"/.test(html), false, '未改动 ⇒ 无脏标记');

  // 环境变量优先：输入框只读，且明确说明不覆盖。
  const env = render({
    section: 'providers',
    providers: [{ provider: 'deepseek', label: 'DeepSeek', configured: true, source: 'env' as const, masked: '••••9999', envConfigured: true, fileConfigured: false }],
    providerDrafts: {},
  });
  assert.match(env, /data-testid="settings-provider-key-deepseek"[^>]*disabled/);
  assert.match(env, /data-testid="settings-provider-env-deepseek"/);
  // 未加载：如实空态（不摆假供应商）。
  assert.match(render({ section: 'providers', providers: [] }), /data-testid="settings-providers-empty"/);

  const dirty = render({ section: 'models', modelDraft: 'deepseek/deepseek-v4-pro' });
  assert.match(dirty, /data-testid="settings-model-input"[^>]*data-dirty="true"/);
  assert.match(dirty, /data-testid="settings-model-dirty"[^>]*>已改待存/);
  assert.equal(/data-testid="settings-model-dirty"/.test(render({ section: 'models' })), false, '草稿＝现值 ⇒ 不显');
});

test('数字键行同款脏值标记（高级）：改一行只脏该行', () => {
  const html = render({
    section: 'tuning',
    tuningValues: { 'scheduler.agingMinutes': 30 },
    tuningDrafts: { 'scheduler.agingMinutes': '45' },
  });
  assert.match(html, /data-testid="settings-tuning-input-scheduler\.agingMinutes"[^>]*data-dirty="true"/);
  assert.match(html, /data-testid="settings-tuning-dirty-scheduler\.agingMinutes"[^>]*>已改待存/);
  assert.match(html, /data-testid="settings-tuning-input-scheduler\.maxActiveTasks"[^>]*data-dirty="false"/, '未改的行不脏');
});

test('样式守门：丸/脏值/输入控件基样式在场（原生控件收编）', () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `缺规则 ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.settings-pill'), /border-radius:\s*var\(--radius-pill\)/);
  assert.match(rule('.settings-dirty'), /color:\s*var\(--accent-ink\)/);
  assert.match(rule('.settings-view__input'), /background:\s*var\(--panel-2\)/, '输入控件基样式＝令牌');
  assert.match(rule(".settings-view__input[data-dirty='true']"), /border-color:\s*var\(--accent\)/);
});
