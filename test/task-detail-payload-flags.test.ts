/**
 * G3/G6 上屏：`payload.durationMs` 与 `payload.sessionPersisted:false`（含"有牙"）。
 * 口径（3251）：数据已就位、只差渲染；**字段缺失不许显示假值/空白异常**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, formatDuration, payloadFlags, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

const AT = 1_700_000_000_000;

function detail(over: { timeline?: unknown[]; behaviorLog?: unknown[] }): TaskDetailDTO {
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: 't',
      goal: 'g',
      state: 'executing',
      riskLevel: 1,
      priority: 0,
      createdAt: AT,
      updatedAt: AT,
      acceptance: [],
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: (over.timeline ?? []) as TaskDetailDTO['timeline'],
    behaviorLog: (over.behaviorLog ?? []) as TaskDetailDTO['behaviorLog'],
    counts: { planSteps: 0, timeline: (over.timeline ?? []).length, behaviorLog: (over.behaviorLog ?? []).length, acceptance: 0 },
  };
}

test('G3/G6 payloadFlags：读 durationMs（有限数字）与 sessionPersisted===false；缺/类型不对 → 空', () => {
  assert.deepEqual(payloadFlags({ toolName: 'bash', durationMs: 77 }), { durationMs: 77 });
  assert.deepEqual(payloadFlags({ sessionPersisted: false }), { notPersisted: true });
  assert.deepEqual(payloadFlags({ durationMs: 0 }), { durationMs: 0 }, '0 是合法时长');
  assert.deepEqual(payloadFlags({ durationMs: '77' }), {}, '字符串不认（不臆造）');
  assert.deepEqual(payloadFlags({ sessionPersisted: true }), {}, 'true 不算异常');
  assert.deepEqual(payloadFlags(null), {});
  assert.deepEqual(payloadFlags('x'), {});
});

test('G3 时长人读格式：<1000 用 `Nms`；≥1000 用 `1.2s`（3265）', () => {
  assert.equal(formatDuration(77), '77ms');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(1234), '1.2s');
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({ timeline: [{ id: 1, ts: AT, kind: 'tool_call', actor: 'employee:0', payload: { toolName: 'bash', durationMs: 1234 } }] }),
      initialTab: 'timeline',
    }),
  );
  assert.match(html, /data-testid="tl-duration"[^>]*>[\s\S]*?1\.2s/);
});

test('G6 文案：未落盘带后果（可能丢失 / 数据库为准）（3265）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({ timeline: [{ id: 9, ts: AT, kind: 'agent_settled', actor: 'system', payload: { sessionPersisted: false } }] }),
      initialTab: 'timeline',
    }),
  );
  assert.match(html, /未落盘（会话历史可能丢失）/);
  assert.match(html, /数据库为准/);
});

test('G3 上屏：时间线行的 tool_call 显示 `Nms`（字段在才显）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({ timeline: [{ id: 1, ts: AT, kind: 'tool_call', actor: 'employee:0', payload: { toolName: 'bash', durationMs: 77 } }] }),
      initialTab: 'timeline',
    }),
  );
  assert.match(html, /data-testid="tl-duration"[^>]*>[\s\S]*?77ms/);
});

test('G3 上屏：行为日志行的 tool_call 显示 `Nms`（字段在才显）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({ behaviorLog: [{ id: 1, ts: AT, actor: 'employee:0', payload: { toolName: 'bash', durationMs: 77 } }] }),
      initialTab: 'behavior',
    }),
  );
  assert.match(html, /data-testid="behavior-duration"[^>]*>[\s\S]*?77ms/);
});

test('G6 上屏：`sessionPersisted:false` → 时间线行出现「未落盘」标记', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({ timeline: [{ id: 9, ts: AT, kind: 'agent_settled', actor: 'system', payload: { sessionPersisted: false, summary: 'done' } }] }),
      initialTab: 'timeline',
    }),
  );
  assert.match(html, /data-testid="tl-not-persisted"[^>]*>[\s\S]*?未落盘/);
  assert.match(html, /会话历史可能丢失/, 'B-10：不承诺不丢数据，只说可能丢失');
  assert.match(html, /数据库为准/, 'B-10：已完成的事件/产物仍以数据库为准');
});

test('G3/G6 不臆造：无字段 → 不渲染 duration/not-persisted（无假值、无空白异常）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail({
        timeline: [{ id: 1, ts: AT, kind: 'tool_call', actor: 'employee:0', payload: { toolName: 'bash' } }],
        behaviorLog: [{ id: 1, ts: AT, actor: 'employee:0', payload: { toolName: 'bash' } }],
      }),
      initialTab: 'timeline',
    }),
  );
  assert.equal(html.includes('ms<'), false, '无 durationMs → 不显 ms');
  assert.equal(html.includes('未落盘'), false, '无标记 → 不显未落盘');
});

test('G3/G6 "有牙"：若 payloadFlags 给缺失字段补默认值 → 会凭空多出 ms/未落盘（证明按字段显式判定）', () => {
  assert.deepEqual(payloadFlags({ toolName: 'bash' }), {}, '缺字段 → 空（不补默认）');
  assert.equal(payloadFlags({ toolName: 'bash' }).durationMs, undefined);
  assert.equal(payloadFlags({ sessionPersisted: true }).notPersisted, undefined);
});

