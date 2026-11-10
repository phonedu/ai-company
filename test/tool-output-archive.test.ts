/**
 * （P2）· 工具大输出归档/摘要/受控读取 + 时间线展开。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  archiveToolOutput,
  readArchivedToolOutput,
  summarizeToolOutput,
  TOOL_OUTPUT_THRESHOLD_CHARS,
  toolResultText,
} from '../src/main/agent/tool-output-archive.js';
import { handleReadToolOutput } from '../src/main/ipc/tool-output.js';
import { payloadFlags, TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

test('P2：结果文本提取（string/ content[] / text 对象 / JSON 兜底）', () => {
  assert.equal(toolResultText('abc'), 'abc');
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolResultText({ text: 'x' }), 'x');
  assert.equal(toolResultText({ foo: 1 }), '{"foo":1}');
});

test('P2：摘要保留头尾；小输出原样', () => {
  assert.equal(summarizeToolOutput('short'), 'short');
  const long = `${'头'.repeat(300)}${'尾'.repeat(300)}`;
  const summary = summarizeToolOutput(long, 100);
  assert.ok(summary.length <= 105);
  assert.ok(summary.startsWith('头'));
  assert.ok(summary.includes('…'));
  assert.ok(summary.endsWith('尾'));
});

test('P2：归档落盘 → 受控读取；路径逃逸/不存在返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-tool-output-'));
  try {
    const text = 'x'.repeat(TOOL_OUTPUT_THRESHOLD_CHARS + 100);
    const archived = archiveToolOutput({
      root,
      sessionKey: 'employee:1/task:2',
      toolCallId: 'call/1',
      toolName: 'bash',
      text,
      now: 123,
    });
    assert.match(archived.ref, /^employee_1_task_2\//);
    assert.equal(archived.bytes, Buffer.byteLength(text));
    assert.equal(readArchivedToolOutput(root, archived.ref), text);
    assert.equal(readArchivedToolOutput(root, '../outside.txt'), null);
    assert.equal(readArchivedToolOutput(root, 'missing.txt'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2：IPC 读取入参/归档根/不存在显式拒；成功回文本', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-tool-output-ipc-'));
  try {
    const archived = archiveToolOutput({ root, sessionKey: 's', toolCallId: 'c', toolName: 'bash', text: 'hello', now: 1 });
    assert.equal(handleReadToolOutput({}, { ref: archived.ref }).ok, false);
    assert.equal(handleReadToolOutput({ toolOutputDir: root }, {}).ok, false);
    assert.equal(handleReadToolOutput({ toolOutputDir: root }, { ref: '../x' }).ok, false);
    const ok = handleReadToolOutput({ toolOutputDir: root }, { ref: archived.ref });
    assert.deepEqual(ok, { ok: true, ref: archived.ref, text: 'hello' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2：payloadFlags 读 outputSummary/ref/bytes；时间线渲染摘要与展开按钮', () => {
  const flags = payloadFlags({ outputSummary: '摘要', outputRef: 's/f.txt', outputBytes: 9000 });
  assert.equal(flags.outputSummary, '摘要');
  assert.equal(flags.outputRef, 's/f.txt');
  assert.equal(flags.outputBytes, 9000);

  const at = 1_800_000_000_000;
  const data: TaskDetailDTO = {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: 't',
      goal: 'g',
      state: 'executing',
      riskLevel: 1,
      priority: 0,
      createdAt: at,
      updatedAt: at,
      acceptance: [],
      projectAccessMode: 'staging',
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [
      {
        id: 1,
        ts: at,
        kind: 'tool_call',
        actor: 'employee:7',
        payload: { toolName: 'bash', phase: 'end', outputSummary: '大输出摘要', outputRef: 's/f.txt', outputBytes: 9000 },
      },
    ],
    behaviorLog: [],
    artifacts: [],
    changesets: [],
    counts: { planSteps: 0, timeline: 1, behaviorLog: 0, acceptance: 0 },
  };
  const html = renderToStaticMarkup(createElement(TaskDetail, { data, initialTab: 'timeline' }));
  assert.match(html, /data-testid="tool-output-summary"/);
  assert.match(html, /大输出摘要/);
  assert.match(html, /data-testid="tool-output-expand"/);
});
