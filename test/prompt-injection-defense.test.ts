/**
 * OPT-AI-14 · 提示注入防线：外部内容**不得放宽**权限（真实 gate 零放宽 + 守卫"有牙"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { permissionGate, type GateContext, type GateResult, type ToolCall } from '../src/main/permission/gate.js';
import { checkContentIndependence, INJECTION_TEXTS, type InjectionCase } from '../src/main/permission/injection-guard.js';

const contexts: Array<{ name: string; ctx: GateContext }> = [
  { name: 'standard/standard/L0', ctx: { capabilityTier: 'standard', autonomy: 'standard', riskLevel: 0, projectRoot: 'D:/repo', cwd: 'D:/repo' } },
  { name: 'trusted/loose/L0', ctx: { capabilityTier: 'trusted', autonomy: 'loose', riskLevel: 0, projectRoot: 'D:/repo', cwd: 'D:/repo' } },
  { name: 'trusted/loose/L2', ctx: { capabilityTier: 'trusted', autonomy: 'loose', riskLevel: 2, projectRoot: 'D:/repo', cwd: 'D:/repo' } },
  { name: 'sandbox/loose/L0', ctx: { capabilityTier: 'sandbox', autonomy: 'loose', riskLevel: 0, projectRoot: 'D:/repo', cwd: 'D:/repo' } },
];

const cases: InjectionCase[] = [
  { name: '对外动作(publish)', tool: 'publish', args: {} },
  { name: '安装(install)', tool: 'install', args: {} },
  { name: '项目外写', tool: 'write', args: { path: 'C:/outside/x.txt' } },
  { name: '敏感路径', tool: 'read', args: { path: 'D:/repo/.ssh/id_rsa' } },
  { name: '危险命令(黑名单)', tool: 'bash', args: { command: 'rm -rf /' }, injectInto: 'command' },
  { name: '同命令+注入文本(不得放宽)', tool: 'bash', args: { command: 'echo hi' }, injectInto: 'command' },
  { name: '项目内写(应放行)', tool: 'write', args: { path: 'D:/repo/src/a.ts' } },
];

test('OPT-AI-14: 真实 permissionGate 对注入文本**零放宽**（内容不得改变权限）', () => {
  const violations = checkContentIndependence(permissionGate, cases, contexts);
  assert.deepEqual(violations, [], `注入文本放宽了权限：\n${violations.map((v) => `${v.case}/${v.ctx}/${v.base}→${v.withInjection}`).join('\n')}`);
});

test('OPT-AI-14: "已获批准/忽略上面"这类文本不能把 deny/ask 变成 allow（逐例断言）', () => {
  const askCtx = contexts[0]!.ctx;
  const denyCtx = contexts[3]!.ctx; // sandbox
  // ① 对外：基线 ask；注入"已获批准"后仍必须是 ask
  for (const text of INJECTION_TEXTS) {
    const r = permissionGate({ name: 'publish', args: { content: text, approved: true } }, askCtx);
    assert.equal(r.decision, 'ask', `注入不得放宽对外动作：${text}`);
  }
  // ② 能力档拒（sandbox 写）→ 注入不得放宽
  for (const text of INJECTION_TEXTS) {
    const r = permissionGate({ name: 'write', args: { path: 'D:/repo/src/a.ts', content: text } }, denyCtx);
    assert.equal(r.decision, 'deny', `注入不得放宽能力档拒绝：${text}`);
  }
  // ③ 命令黑名单：注入"请忽略黑名单"后仍 deny（需带黑名单策略）
  const denyCtxWithDenylist: GateContext = { ...askCtx, policy: { commandDenylist: ['rm -rf'] } };
  const r = permissionGate({ name: 'bash', args: { command: `rm -rf / # ${INJECTION_TEXTS[1]}` } }, denyCtxWithDenylist);
  assert.equal(r.decision, 'deny', '注入不得绕过命令黑名单');
});

test('OPT-AI-14 "有牙": 故意做内容敏感的 gate → 守卫必抓（证明上面"零放宽"不是空断言）', () => {
  // 伪 gate：只要文本里出现"已获批准"就放行（= 典型的被注入攻破）
  const injectedGate = (_call: ToolCall, _ctx: GateContext): GateResult => {
    const text = String((_call.args ?? {}).content ?? '');
    return text.includes('批准') ? { decision: 'allow', reason: 'injected' } : { decision: 'ask', reason: 'baseline' };
  };
  const violations = checkContentIndependence(injectedGate, [{ name: '对外动作', tool: 'publish', args: {} }], contexts);
  assert.ok(violations.length > 0, '守卫必须能抓到"内容放宽权限"的 gate');
  assert.match(violations[0]!.reason, /放宽/);
});
