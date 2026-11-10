/**
 *  · 员工运行时封装工厂（2398②）——**模块形状**守卫（不建真会话，不花真金）。
 * 真实端到端见 `test/fixtures/employee-e2e.ts`（真 LLM）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  createEmployeeRuntime,
  defaultSessionDir,
  EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER,
} from '../src/main/agent/employee-factory.js';
import { createSubmitWorkItemTool } from '../src/main/agent/submit-work-item-tool.js';
import { createAskColleagueTool } from '../src/main/agent/ask-colleague-tool.js';
import { createEmployeeExecutor, parseDispatchAction } from '../src/main/agent/employee-executor.js';

test('OPT-AI-1 factory: 导出可用；会话目录默认 <userData>/sessions；构造期提示词为占位（层真值运行期注入）', () => {
  assert.equal(typeof createEmployeeRuntime, 'function');
  assert.equal(defaultSessionDir('C:/ud'), join('C:/ud', 'sessions'));
  assert.match(EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER, /占位|运行时注入/);
});

test('OPT-AI-1 factory: 工具工厂与执行器可加载（submit_work_item / ask_colleague / parseDispatchAction）', () => {
  assert.equal(typeof createSubmitWorkItemTool, 'function');
  assert.equal(typeof createAskColleagueTool, 'function');
  assert.equal(typeof createEmployeeExecutor, 'function');
  // 执行器只接管 work_item dispatch（其余交装配层/后续里程碑）
  assert.equal(parseDispatchAction({ actionKey: 'dispatch:work_item:7:1', kind: 'dispatch', taskId: 3, payload: {} })?.workItemId, 7);
  assert.equal(parseDispatchAction({ actionKey: 'dispatch_planning:task:3:0', kind: 'dispatch_planning', taskId: 3, payload: {} }), null);
});

test('OPT-AI-1 factory "有牙": 占位提示词非空且标"占位"（防止有人把五层接进构造期）', () => {
  assert.ok(EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER.length > 0);
  assert.ok(!/\{employeeId\}|\{taskId\}/.test(EMPLOYEE_SYSTEM_PROMPT_PLACEHOLDER), '构造期不得含运行期模板');
});
