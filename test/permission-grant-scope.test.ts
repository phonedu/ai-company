/**
 * M3 联动修复 P1：grant 最小范围（rule + toolName + sessionKey）。
 * 批准一次 mcp_call 不得顺带放行 web/git_push 等其它 external 工具。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { permissionGate, type GateContext } from '../src/main/permission/gate.js';

function ctx(grants: NonNullable<GateContext['policy']>['grants']): GateContext {
  return {
    capabilityTier: 'trusted',
    autonomy: 'loose',
    riskLevel: 0,
    projectRoot: 'C:/p',
    policy: { grants },
  };
}

test('grant 带 toolName：只放行同名工具', () => {
  const grant = { rule: 'consent:external', scope: 'session' as const, toolName: 'mcp_call', sessionKey: 's1', expiresAt: null };
  assert.equal(permissionGate({ name: 'mcp_call' }, ctx([grant])).decision, 'allow');
  assert.equal(permissionGate({ name: 'web' }, ctx([grant])).decision, 'ask', '批准 mcp_call 不得顺带放行 web');
});

test('旧 grant 无 toolName：保持兼容（放行同类）', () => {
  const grant = { rule: 'consent:external', scope: 'task' as const, expiresAt: null };
  assert.equal(permissionGate({ name: 'web' }, ctx([grant])).decision, 'allow');
});
