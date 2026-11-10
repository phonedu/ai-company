/**
 *  P0 批守卫（2026-10-28）：V1 作答失败可见/待处理、V2 文案一致、V3 首启范围、
 * V4 推荐项 hover、F-N02 幕僚长失败回执。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = readFileSync('src/renderer/store.ts', 'utf8');
const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
const settings = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');
const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');

test('V1 作答失败可见且不推进已读：answerCard 检查 ok、异常捕获、pending/错误节点', () => {
  assert.match(store, /res\.ok === false/, '必须检查返回 ok');
  assert.match(store, /作答失败/, '失败要有回执');
  assert.match(store, /if \(res && res\.ok === false\) \{[\s\S]*?return \{ ok: false/, '失败分支必须先返回，不推进已读');
  assert.match(card, /card-answer-error/, '卡上需显示失败原因');
  assert.match(card, /answerPending/, '作答期间需禁用');
});

test('V2 供应商测试连接文案不再与实现矛盾', () => {
  assert.doesNotMatch(settings, /测试连接未实现/);
  assert.match(settings, /会真发一次极短请求/);
});

test('V3 首启接入后频道范围跟随项目', () => {
  assert.match(store, /session\.selectedProjectId = res\.project\.id/, '接入成功要切范围');
  assert.match(store, /channel\.scope_project_id[\s\S]{0,80}value: res\.project\.id/, '并把范围落库');
});

test('V4 推荐项 hover 不得实底 accent-ink + 蓝字', () => {
  assert.match(css, /\.card__options \.card__btn--primary:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--pressed-layer\)/s);
});

test('F-N02 幕僚长不可用/失败要写频道回执', () => {
  assert.match(ipc, /reportAssistantFailure/, '需有失败回执函数');
  assert.match(ipc, /幕僚长没有回复/, '回执文案');
});
