/**
 * OPT-AI-7 省回合一环：提交工具后，同轮后续工具调用 → `{block:true, terminate:true}`（SDK 官方口）。
 * 断言：未提交 → 放行；提交 → 下一步拦截并 terminate；agent_start 重置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSubmitTerminate, SUBMIT_TOOL_NAMES } from '../src/main/agent/pi-runtime.js';

function fakePi(): {
  emit(event: string, payload?: unknown): unknown;
  on(event: string, handler: (ev: unknown) => unknown): void;
  handlers: Map<string, (ev: unknown) => unknown>;
} {
  const handlers = new Map<string, (ev: unknown) => unknown>();
  return {
    handlers,
    on(event: string, handler: (ev: unknown) => unknown): void {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      return handlers.get(event)?.(payload);
    },
  };
}

test('OPT-AI-7：提交后下一个工具调用被 block＋terminate；agent_start 重置', () => {
  const pi = fakePi();
  registerSubmitTerminate(pi as never);
  assert.equal(pi.emit('tool_call', { toolName: 'read' }), undefined, '未提交 → 放行');

  assert.equal(pi.emit('tool_call', { toolName: 'submit_work_item' }), undefined, '提交本身放行');
  const blocked = pi.emit('tool_call', { toolName: 'write' }) as { block?: boolean; terminate?: boolean };
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true, '终止提示已接（省回合）');

  pi.emit('agent_start');
  assert.equal(pi.emit('tool_call', { toolName: 'write' }), undefined, '下一轮重置');
});

test('OPT-AI-7：提交工具名单含三种结构化提交', () => {
  assert.deepEqual([...SUBMIT_TOOL_NAMES], ['submit_work_item', 'submit_plan', 'submit_review']);
});
