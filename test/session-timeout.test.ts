/**
 * 会话超时（2026-10-24）：critic 会话 10 分钟无输出、动作永久 pending。
 * 口径：role 会话 10 分钟、员工 30 分钟；超时 abort 并要求调用方按失败可见收场。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPLOYEE_SESSION_TIMEOUT_MS,
  EmployeeSessionRuntime,
  ROLE_SESSION_TIMEOUT_MS,
} from '../src/main/agent/employee-runtime.js';

const input = { employeeId: 1, taskId: 1, systemPrompt: '', userPrompt: '' };

test('会话超时：role 超时 → abortSession 被调用，Promise reject（不再永久 pending）', async () => {
  let aborted = false;
  const runtime = {
    run: (): Promise<never> => new Promise(() => undefined),
    steer: (): boolean => true,
    dispose: (): void => undefined,
    abortSession: (): boolean => {
      aborted = true;
      return true;
    },
  };
  const session = new EmployeeSessionRuntime(runtime as never, { sessionTimeoutMs: 30 });
  await assert.rejects(session.run({ ...input, sessionKey: 'role:critic:task:1' }, () => undefined), /会话超时/);
  assert.equal(aborted, true, '超时必须尝试中止底层会话');
});

test('会话超时：员工上限长于角色上限；0 可显式关闭', async () => {
  assert.ok(EMPLOYEE_SESSION_TIMEOUT_MS > ROLE_SESSION_TIMEOUT_MS);
  const runtime = {
    run: (): Promise<{ text: string; toolCalls: never[] }> =>
      new Promise((resolve) => setTimeout(() => resolve({ text: 'ok', toolCalls: [] }), 20)),
    steer: (): boolean => true,
    dispose: (): void => undefined,
  };
  const session = new EmployeeSessionRuntime(runtime as never, { sessionTimeoutMs: 0 });
  const result = await session.run(input, () => undefined);
  assert.equal(result.text, 'ok', '0 = 关闭超时，长/慢会话不被误杀');
});
