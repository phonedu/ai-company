import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppChrome } from '../src/renderer/components/AppChrome.js';
import {
  agentBannerOf,
  maskSecrets,
  type AgentStatusDTO,
} from '../src/renderer/components/agentStatus.js';

// ─────────── G8：员工运行时「不可用态」界面提示（2876）───────────
// 口径：① **只在 `failed` 出提示**（其余状态零渲染 —— 不假装在跑、也不假报故障）
//       ② 提示**可点到原因**；原因文本**再脱敏一次**（绝不把疑似密钥写进 DOM）
//       ③ 员工不可用时**不得**出现"运行中"这类正面读数

const chrome = (agent?: AgentStatusDTO | null): string =>
  renderToStaticMarkup(createElement(AppChrome, { todoCount: 0, agent: agent ?? null }));

function countTestId(html: string, id: string): number {
  const needle = `data-testid="${id}"`;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at === -1) break;
    n += 1;
    from = at + needle.length;
  }
  return n;
}

test('① 只有 `failed` 出横幅；其余状态（含缺省/未知）**零渲染**（负例）', () => {
  for (const state of [undefined, null, {}, { state: 'idle' }, { state: 'assembling' }, { state: 'ready' }, { state: 'weird_state' }]) {
    assert.equal(agentBannerOf(state as AgentStatusDTO | null), null, `state=${JSON.stringify(state)} 不得出横幅`);
    const html = chrome(state as AgentStatusDTO | null);
    assert.equal(countTestId(html, 'agent-unavailable'), 0);
    // 也不得出现任何"正在运行/已就绪"的正面读数（不假装在跑）
    assert.equal(html.includes('运行中'), false);
    assert.equal(html.includes('已就绪'), false);
  }
});

test('② `failed` + 凭据类原因 → 标题「未配置凭据 → 员工不可用」，可点开看原因', () => {
  const html = chrome({ state: 'failed', reason: '缺少 deepseek 凭据：未找到 env DEEPSEEK_API_KEY 或 ~/.aico/secrets/deepseek_api_key' });
  assert.equal(countTestId(html, 'agent-unavailable'), 1);
  assert.match(html, /未配置凭据 → 员工不可用/);
  assert.match(html, /data-testid="agent-unavailable-reason"/);
  assert.match(html, /缺少 deepseek 凭据/);
  // `<details>` 默认折叠（点到才展开）→ 不得带 open
  assert.doesNotMatch(html, /<details[^>]*data-testid="agent-unavailable"[^>]*\sopen/);
});

test('③ `failed` + 非凭据原因（如装配超时）→ 用中性标题，不误报为凭据问题', () => {
  const banner = agentBannerOf({ state: 'failed', reason: 'assembly timeout after 30000ms' });
  assert.ok(banner);
  assert.equal(banner.title, '员工运行时不可用');
  assert.match(banner.detail, /timeout/);
});

test('④ 原因文本**再脱敏**：`sk-…` / `Bearer …` 不得进 DOM', () => {
  assert.equal(maskSecrets('key=sk-abcdef123456 here'), 'key=«redacted» here');
  assert.equal(maskSecrets('Authorization: Bearer abcdef.123456'), 'Authorization: «redacted»');
  const html = chrome({ state: 'failed', reason: 'credential sk-abcdef123456 rejected' });
  assert.equal(html.includes('sk-abcdef123456'), false);
  assert.match(html, /«redacted»/);
  assert.match(html, /未配置凭据 → 员工不可用/);
});

test('⑤ 集成：`ready` 之后横幅必须消失（状态被新事件覆盖）', () => {
  // 模拟事件序列：failed → ready（store 只保留最后一条）
  assert.ok(agentBannerOf({ state: 'failed', reason: '缺少凭据' }));
  assert.equal(agentBannerOf({ state: 'ready', modelRef: 'deepseek-flash', credentialSource: 'file' }), null);
  assert.equal(countTestId(chrome({ state: 'ready', credentialSource: 'file' }), 'agent-unavailable'), 0);
});

test('⑥ 顶栏既有读数不受影响（横幅是"附加"而非替换）', () => {
  const html = chrome({ state: 'failed', reason: '缺少凭据' });
  assert.match(html, /data-testid="statusbar-todo"[^>]*>待办 0/);
  assert.match(html, /data-testid="statusbar-cost"[^>]*>今日成本 —/);
  assert.match(html, /data-testid="right-rail-overview"/);
  assert.equal(html.includes('其余概览摘要待做'), false, '右栏开发备注必须已删');
});
