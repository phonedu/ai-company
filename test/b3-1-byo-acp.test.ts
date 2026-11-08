/**
 * B3-1/D-31①：BYO 执行体 PoC——ACP client 结构验证＋员工接口适配层。
 * PoC 层：验证类存在/接口形状/接线点（真 opencode 联调随 B3b 真机批）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { AcpClient } from '../src/main/agent/byo/acp-client.js';
import { ByoExecutor } from '../src/main/agent/byo/opencode-adapter.js';

test('B3-1: AcpClient——JSON-RPC 基础设施（send/feedStdout/事件分发）', () => {
  const client = new AcpClient({ command: 'mock-opencode', args: ['acp'] });
  assert.ok(typeof client.start === 'function');
  assert.ok(typeof client.sessionNew === 'function');
  assert.ok(typeof client.sessionPrompt === 'function');
  assert.ok(typeof client.stop === 'function');
  assert.ok(typeof (client as unknown as { feedStdout: unknown }).feedStdout === 'function');
  assert.ok(typeof (client as unknown as { overrideSend: unknown }).overrideSend === 'function');
  assert.doesNotThrow(() => {
    (client as unknown as { send: (m: unknown) => void }).send({ jsonrpc: '2.0', id: 1, method: 'test' });
  });
  assert.doesNotThrow(() => client.feedStdout('not json\n'));
  client.stop();
});

test('B3-1: ByoExecutor——员工接口适配层（四验收接线点在位）', () => {
  const usageRecords: Array<{ tokensIn: number; tokensOut: number; costUsd?: number }> = [];
  const permissionAllowed: boolean[] = [];
  const byo = new ByoExecutor({
    command: 'mock-opencode',
    args: ['acp'],
    cwd: '/tmp',
    onUsage: (u) => usageRecords.push({ tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd }),
    onPermissionRequest: async () => { permissionAllowed.push(true); return true; },
  });
  const client = (byo as unknown as { client: { on: (e: string, h: (d: unknown) => void) => void } }).client;
  assert.ok(client, 'AcpClient 实例挂在 ByoExecutor 内');
  // 模拟 usage_update 事件 → onUsage 回调（成本落账验收③）
  (client as EventEmitter).emit('usage_update', { sessionId: 's1', tokensIn: 100, tokensOut: 50, costUsd: 0.001 });
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0]!.tokensIn, 100);
  // 模拟 permission_request 事件 → onPermissionRequest 回调（审批门验收②）
  return new Promise<void>((resolve) => {
    (client as EventEmitter).emit('permission_request', {
      requestId: 42,
      params: { toolCall: { title: 'write file', kind: 'edit' }, options: [] },
    });
    setTimeout(() => {
      assert.ok(permissionAllowed.length > 0, '审批门回调触发（放行）');
      byo.stop();
      resolve();
    }, 50);
  });
});
