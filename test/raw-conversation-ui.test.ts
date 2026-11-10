import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  RawConversation,
  rawDisplayName,
  sortRawItems,
  type RawItemDTO,
} from '../src/renderer/components/RawConversation.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

// ─────────── 「原始交流」UI（2303 / 2328 / 2641，逐条写死）───────────
// ① text/thinking 各自成条（思考条不渲染气泡正文） ② mentions 显式（不解析文本）
// ③ argsDigest 主进程截断/脱敏（渲染层不展开） ④ 排序 at↑ / 同 at 按 id↑（**id 为 string**，2641）
// ⑤ 缺数据 = 显式空态（不做假气泡） ⑥ 只读、只在本机
// ⚠️ 本文件投影测试（`test/raw-conversation.test.ts`）**刻意分名**：
//    `997913c` 曾用同名文件覆盖过这份 UI 测试 → 改名 `raw-conversation-ui.test.ts` 防再撞。

const AT = 1_700_000_000_000;

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

function render(items: readonly RawItemDTO[] | null | undefined): string {
  return renderToStaticMarkup(createElement(RawConversation, { items: items as RawItemDTO[] }));
}

const SAMPLE: RawItemDTO[] = [
  {
    id: 'task_event:1',
    role: 'employee',
    employeeId: 2,
    name: '陈默',
    at: AT + 10,
    text: '我先读一下入口文件。',
    mentions: [0],
  },
  { id: 'task_event:2', role: 'employee', employeeId: 2, at: AT + 20, thinking: '（推理：先确认 schema 再改 DAO）' },
  {
    id: 'task_event:3',
    role: 'employee',
    employeeId: 2,
    at: AT + 30,
    toolCall: { name: 'run_command', argsDigest: 'pytest -q', ok: true },
  },
  {
    id: 'task_event:4',
    role: 'employee',
    employeeId: 2,
    at: AT + 40,
    toolCall: { name: 'write_file', argsDigest: 'src/a.py', ok: false, error: 'permission denied' },
  },
  { id: 'human_msg:5', role: 'boss', at: AT, text: '把这个任务做完。' },
];

test('① 缺数据/空数组 → **显式空态**，且不得出现任何气泡（负例）', () => {
  for (const empty of [undefined, null, []]) {
    const html = render(empty as RawItemDTO[]);
    assert.match(html, /data-testid="raw-empty"/);
    assert.equal(countTestId(html, 'raw-bubble'), 0, '空态不得摆假气泡');
    assert.equal(html.includes('raw-conversation'), false, '空态不得渲染容器');
  }
});

test('② 有数据 → 行数 == DTO 条数；气泡数 == **有 `text` 的条数**（思考条不兜底成气泡）', () => {
  const html = render(SAMPLE);
  assert.match(html, /data-testid="raw-conversation" data-count="5"/);
  assert.equal(countTestId(html, 'raw-row'), 5);
  assert.equal(countTestId(html, 'raw-bubble'), 2, '只有 id=1/5 有 text');
  assert.equal(countTestId(html, 'raw-thinking'), 1);
  assert.equal(countTestId(html, 'raw-toolchip'), 2);
});

test('③ 💭 思考**默认折叠**（`<details>` 不得带 `open`），且思考条不渲染气泡正文', () => {
  const only = render([{ id: 'task_event:9', role: 'employee', employeeId: 1, at: AT, thinking: '（只有思考）' }]);
  assert.equal(countTestId(only, 'raw-thinking'), 1);
  assert.equal(countTestId(only, 'raw-bubble'), 0, '思考条不得兜底成气泡');
  assert.doesNotMatch(only, /<details[^>]*\sopen/);
  assert.match(only, /💭 思考/);
});

test('④ 工具 chip：`ok=false` → ⚠️ + error 可见；`ok=true` → ⌨️ + 摘要', () => {
  const html = render(SAMPLE);
  assert.match(html, /data-testid="raw-toolchip" data-ok="true"/);
  assert.match(html, /data-testid="raw-toolchip" data-ok="false"/);
  assert.match(html, /⌨️ run_command · pytest -q/);
  assert.match(html, /⚠️ write_file · src\/a\.py · permission denied/);
});

test('⑤ `mentions` **显式字段**渲染为 `@员工#<id>`；无 `mentions` → 不出现 `@`', () => {
  const html = render(SAMPLE);
  assert.match(html, /data-testid="raw-mentions"[^>]*>@员工#0/);
  const noMention = render([{ id: 'task_event:7', role: 'employee', employeeId: 3, at: AT, text: '没有提及' }]);
  assert.equal(noMention.includes('@员工#'), false);
});

test('⑥ 缺 `name` → 降级 `员工#<id>`（**不臆造人名**）；无 id/name → 退回 role 文本', () => {
  assert.equal(rawDisplayName({ id: 'task_event:1', role: 'employee', employeeId: 4, at: AT }), '员工#4');
  assert.equal(rawDisplayName({ id: 'task_event:1', role: 'employee', employeeId: 4, at: AT, name: '林悦' }), '林悦');
  assert.equal(rawDisplayName({ id: 'task_event:1', role: 'system', at: AT }), 'system');
});

test('⑦ 契约外 `role` → 按 system 渲染但**原样显示**（不隐藏、不崩），并标注未知角色', () => {
  const html = render([{ id: 'task_event:8', role: 'visitor', at: AT, text: '我是契约外的角色' }]);
  assert.match(html, /data-role="visitor" data-known-role="false"/);
  assert.match(html, /未知角色 visitor/);
  assert.match(html, /我是契约外的角色/);
});

test('⑧ 排序：`at` 升序、同 `at` 按 `id`（**字符串**比较，2641）', () => {
  const shuffled: RawItemDTO[] = [
    { id: 'task_event:3', role: 'employee', employeeId: 1, at: AT + 30, text: 'C' },
    { id: 'task_event:2', role: 'employee', employeeId: 1, at: AT + 10, text: 'B' },
    { id: 'task_event:1', role: 'employee', employeeId: 1, at: AT + 10, text: 'A' },
    { id: 'human_msg:1', role: 'boss', at: AT + 10, text: 'boss' },
  ];
  const sorted = sortRawItems(shuffled).map((item) => item.text);
  assert.deepEqual(sorted, ['boss', 'A', 'B', 'C'], '同 at 时按 id 字符串升序（human_msg:1 < task_event:1 < …）');
  // 不改原数组（纯函数）
  assert.equal(shuffled[0]?.text, 'C');
});

test('⑨ 集成：`TaskDetail` 时间线面板带开关；**无 `rawConversation` 时开关 disabled + 显式理由**', () => {
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
      createdAt: AT,
      updatedAt: AT,
      acceptance: [],
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [{ id: 1, ts: AT, kind: 'task_created', actor: 'boss', payload: {} }],
    behaviorLog: [],
    counts: { planSteps: 0, timeline: 1, behaviorLog: 0, acceptance: 0 },
  };
  const html = renderToStaticMarkup(createElement(TaskDetail, { data, initialTab: 'timeline' }));
  assert.match(html, /data-testid="timeline-raw-toggle"[^>]*disabled/);
  assert.match(html, /title="无原始交流数据（M1）"/);
  assert.equal(countTestId(html, 'raw-conversation'), 0, '默认不展开原始交流');
  // 有数据时：开关可用（不 disabled）
  const withRaw = renderToStaticMarkup(
    createElement(TaskDetail, { data: { ...data, rawConversation: SAMPLE }, initialTab: 'timeline' }),
  );
  assert.doesNotMatch(withRaw, /data-testid="timeline-raw-toggle"[^>]*disabled/);
  assert.match(withRaw, /data-testid="timeline-item"/, '默认仍显示时间线投影');
});

test('⑩ 泛化负例（照 M7-1）：本视图不得自造"有数据源形状"的读数；空态就一句', () => {
  const empty = render([]);
  const text = empty.replace(/data-[a-z-]+="[^"]*"/g, '');
  assert.doesNotMatch(text, /\d+\s*\/\s*\d+/);
  assert.doesNotMatch(text, /[$￥]\s*\d/);
  assert.match(text, /本任务暂无原始交流/);
});
