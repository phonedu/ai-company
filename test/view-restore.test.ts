/**
 * M2-A · `OPT-EXT-6`「UI 现场恢复」纯逻辑（含"有牙"）。
 * 口径（3185）：重启回上次视图；**失真回落 `channel`**（不白屏/不空壳）。
 * D-5 补位 ①：新增 `employee`（员工工位页）——同 task/project 口径（id 不存在 → 回落）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIEW,
  loadViewState,
  resolveView,
  saveViewState,
  type ViewState,
} from '../src/renderer/components/viewCursor.js';

const T = new Set([1, 2]);
const P = new Set([10, 20]);
const E = new Set([0, 5]);

test('OPT-EXT-6 恢复：task/project id 存在 → 原样恢复', () => {
  assert.deepEqual(resolveView({ view: 'task', selectedTaskId: 2, selectedProjectId: null, selectedEmployeeId: null }, T, P), {
    view: 'task',
    selectedTaskId: 2,
    selectedProjectId: null,
    selectedEmployeeId: null,
  });
  // 2026-10-17（双栏改版）：旧游标 project → projects（右栏选中保留）。
  assert.deepEqual(resolveView({ view: 'project', selectedTaskId: null, selectedProjectId: 20, selectedEmployeeId: null }, T, P), {
    view: 'projects',
    selectedTaskId: null,
    selectedProjectId: 20,
    selectedEmployeeId: null,
  });
  assert.deepEqual(resolveView({ view: 'projects', selectedTaskId: null, selectedProjectId: 20, selectedEmployeeId: null }, T, P), {
    view: 'projects',
    selectedTaskId: null,
    selectedProjectId: 20,
    selectedEmployeeId: null,
  });
});

test('OPT-EXT-6 ★失真回落：task/project id 已不存在 → channel（不白屏/不空壳）', () => {
  assert.deepEqual(
    resolveView({ view: 'task', selectedTaskId: 999, selectedProjectId: null, selectedEmployeeId: null }, T, P),
    DEFAULT_VIEW,
  );
  assert.deepEqual(
    resolveView({ view: 'task', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null }, T, P),
    DEFAULT_VIEW,
  );
  assert.deepEqual(
    // 项目 id 失真 ⇒ 仍进项目树页（页面自动选第一个项目；不白屏）。
    resolveView({ view: 'project', selectedTaskId: null, selectedProjectId: 999, selectedEmployeeId: null }, T, P),
    { view: 'projects', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null },
  );
});

test('D-5 工位页恢复：员工 id 存在 → 原样恢复；不存在/缺 id/未传集合 → 回落 channel', () => {
  assert.deepEqual(resolveView({ view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: 5 }, T, P, E), {
    view: 'employee',
    selectedTaskId: null,
    selectedProjectId: null,
    selectedEmployeeId: 5,
  });
  assert.deepEqual(
    resolveView({ view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: 999 }, T, P, E),
    DEFAULT_VIEW,
    '员工已删除 → 回落（不白屏）',
  );
  assert.deepEqual(
    resolveView({ view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null }, T, P, E),
    DEFAULT_VIEW,
    '缺 id → 回落',
  );
  assert.deepEqual(
    resolveView({ view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: 5 }, T, P),
    DEFAULT_VIEW,
    '未传员工集合（取不到名册）→ 回落（宁回落不停在空壳上）',
  );
});

test('OPT-EXT-6 无选中依赖的视图：channel/hall/inbox 原样恢复；null/未知 → channel', () => {
  assert.equal(resolveView({ view: 'hall', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null }, T, P).view, 'hall');
  assert.equal(resolveView({ view: 'inbox', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null }, T, P).view, 'inbox');
  assert.equal(resolveView({ view: 'channel', selectedTaskId: 3, selectedProjectId: 4, selectedEmployeeId: 5 }, T, P).view, 'channel');
  // R2-3 第二批：设置视图无选中依赖 → 原样恢复
  assert.equal(
    resolveView({ view: 'settings', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: null }, T, P).view,
    'settings',
  );
  assert.deepEqual(resolveView(null, T, P), DEFAULT_VIEW, '无存档 → channel');
});

test('OPT-EXT-6 "有牙"：若不做失真校验（把存档原样返回）→ 会停在不存在的 task 上（证明校验承重）', () => {
  const saved: ViewState = { view: 'task', selectedTaskId: 999, selectedProjectId: null, selectedEmployeeId: null };
  const guarded = resolveView(saved, T, P);
  const unguarded = saved; // 模拟"直接采信存档"
  assert.equal(guarded.view, 'channel', '校验后回落 channel');
  assert.equal(unguarded.view, 'task', '不校验 → 停在不存在的 task');
  assert.notEqual(guarded.view, unguarded.view);
});

test('OPT-EXT-6 游标往返：save→load 保留；非法/未知 → null；无 storage 安全降级', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  try {
    const s: ViewState = { view: 'employee', selectedTaskId: null, selectedProjectId: null, selectedEmployeeId: 5 };
    saveViewState(s);
    assert.deepEqual(loadViewState(), s, '往返保留（= 重启后仍在；含工位页选中员工）');
    mem.set('aico.session.view', JSON.stringify({ view: 'project', selectedTaskId: null, selectedProjectId: 7 }));
    assert.equal(loadViewState()?.selectedEmployeeId, null, '旧存档（无该字段）→ 读为 null（向后兼容，不抛）');
    mem.set('aico.session.view', 'not json');
    assert.equal(loadViewState(), null, '非法 JSON → null');
    mem.set('aico.session.view', JSON.stringify({ view: 'bogus' }));
    assert.equal(loadViewState(), null, '未知 view → null');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.equal(loadViewState(), null, '无 storage → 安全降级');
  assert.doesNotThrow(() => saveViewState(DEFAULT_VIEW));
});

test('OPT-EXT-6 恢复不写中间态（3189①）：最终写入必须是"目标视图"，不是中间态 channel', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  try {
    saveViewState({ view: 'task', selectedTaskId: 2, selectedProjectId: null, selectedEmployeeId: null }); // 上次视图
    // 模拟 restoreSession 的"最终一次写入"（store 里就是 resolveView 的结果；openTaskDetail 写的是 task）：
    const resolved = resolveView(loadViewState(), T, P, E);
    saveViewState(resolved);
    assert.equal(loadViewState()?.view, 'task', '恢复成功后存储里仍是 task（游标不会被中间态自己覆盖）');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('OPT-EXT-6 幂等（双挂载，3189②）：同一存档跑两次 resolveView+save → 结果一致', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  try {
    saveViewState({ view: 'project', selectedTaskId: null, selectedProjectId: 20, selectedEmployeeId: null });
    const first = resolveView(loadViewState(), T, P, E);
    saveViewState(first);
    const second = resolveView(loadViewState(), T, P, E);
    saveViewState(second);
    assert.deepEqual(second, first, '两次恢复结果一致（不互相覆盖）');
    assert.equal(loadViewState()?.selectedProjectId, 20);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
