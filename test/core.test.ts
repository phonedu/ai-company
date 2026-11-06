import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateTaskShortId,
  extractProjectAlias,
  extractTaskRef,
  parseTaskRef,
  validateAlias,
} from '../src/core/short-id.js';
import { FOCUS_TTL_MS, resolveInbound } from '../src/core/resolver.js';
import type {
  Classify,
  ConversationState,
  Inbound,
  PendingList,
  Resolution,
  ResolverStore,
  SemanticSignal,
} from '../src/core/resolver.js';
import { DEFAULT_SCHEDULER_CONFIG, effectivePriority, planScheduling } from '../src/core/scheduler.js';
import type { TaskSnapshot, WorkItemSnapshot } from '../src/core/types.js';

// ───────────────────────── 测试脚手架 ─────────────────────────

let seq = 0;
function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  seq += 1;
  return {
    id: over.id ?? seq,
    shortId: over.shortId ?? `T-${1000 + seq}`,
    title: over.title ?? `任务 ${seq}`,
    projectId: 1,
    state: 'ready',
    priority: 0,
    riskLevel: 1,
    createdAt: 1000,
    readySince: 2000,
    deadline: null,
    budgetLeftTokens: null,
    parentTaskId: null,
    ...over,
  };
}

function wi(id: number, taskId: number, employeeId: number, over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return { id, taskId, employeeId, state: 'queued', createdAt: 0, ...over };
}

interface FakeStoreOptions {
  /** key: `${channel}|${conversationRef}` */
  convos?: Record<string, ConversationState>;
  /** key: `${channel}|${platformMsgId}` */
  outbound?: Record<string, { taskId: number; reportId: number | null }>;
  tasks?: TaskSnapshot[];
  pendingList?: PendingList | null;
  aliases?: Record<string, { id: number; name: string }>;
  defaultProject?: { id: number; name: string } | null;
}

function makeStore(o: FakeStoreOptions = {}) {
  const convos = new Map<string, ConversationState>(Object.entries(o.convos ?? {}));
  const tasks = new Map<number, TaskSnapshot>((o.tasks ?? []).map((t) => [t.id, t]));
  const focusSets: Array<{ key: string; taskId: number; at: number }> = [];
  let pendingClears = 0;
  const pendingSets: Array<{ key: string; list: { messageRef: string; items: PendingList['items'] } }> = [];

  const store: ResolverStore = {
    getConversation: (ch, ref) => convos.get(`${ch}|${ref}`) ?? null,
    setFocus: (ch, ref, taskId, at) => {
      focusSets.push({ key: `${ch}|${ref}`, taskId, at });
      const key = `${ch}|${ref}`;
      const cur =
        convos.get(key) ??
        ({ kind: 'private', projectId: null, focusTaskId: null, focusUpdatedAt: null } as ConversationState);
      convos.set(key, { ...cur, focusTaskId: taskId, focusUpdatedAt: at });
    },
    findOutboundRef: (ch, msgId) => o.outbound?.[`${ch}|${msgId}`] ?? null,
    getTaskByShortId: (sid) => [...tasks.values()].find((t) => t.shortId === sid) ?? null,
    getTaskById: (id) => tasks.get(id) ?? null,
    getRecentActiveTasks: (limit) =>
      [...tasks.values()]
        .filter((t) => !['done', 'failed', 'cancelled'].includes(t.state))
        .slice(0, limit),
    getProjectByAlias: (alias) => o.aliases?.[alias] ?? null,
    getDefaultProject: () => o.defaultProject ?? null,
    getPendingList: () => o.pendingList ?? null,
    setPendingList: (ch, ref, list) => {
      pendingSets.push({ key: `${ch}|${ref}`, list: { messageRef: list.messageRef, items: list.items } });
    },
    clearPendingList: () => {
      pendingClears += 1;
    },
  };

  return { store, focusSets: () => focusSets, pendingClears: () => pendingClears, pendingSets: () => pendingSets };
}

const noClassify: Classify = async () => {
  throw new Error('classify must not be called on this path');
};

function classifier(signal: SemanticSignal) {
  let calls = 0;
  const fn: Classify = async () => {
    calls += 1;
    return signal;
  };
  return { fn, calls: () => calls };
}

function inbound(over: Partial<Inbound> = {}): Inbound {
  return {
    source: 'im:wechat',
    conversationRef: 'wx-private',
    platformMsgId: null,
    replyToMsgId: null,
    text: '',
    receivedAt: 1_000_000,
    ...over,
  };
}

function expectKind<K extends Resolution['kind']>(
  r: Resolution,
  kind: K,
): Extract<Resolution, { kind: K }> {
  if (r.kind !== kind) assert.fail(`expected ${kind}, got ${r.kind}`);
  return r as Extract<Resolution, { kind: K }>;
}

// ───────────────────────── short-id ─────────────────────────

test('short-id: 从 T-1001 起单调递增，永不复用', () => {
  let n = 1000;
  const counter = {
    nextCounter: (_name: string, _start: number) => {
      n += 1;
      return n;
    },
  };
  assert.equal(allocateTaskShortId(counter), 'T-1001');
  assert.equal(allocateTaskShortId(counter), 'T-1002');
});

test('short-id: 引用解析宽松、输出规范', () => {
  assert.equal(extractTaskRef('#T1042 把超时改成 30 秒'), 'T-1042');
  assert.equal(extractTaskRef('# t-1042 改一下'), 'T-1042');
  assert.equal(extractTaskRef('版本 T-1042 的说明'), null); // 无 # 不算地址
  assert.equal(parseTaskRef('  #T1042 '), 'T-1042');
  assert.equal(parseTaskRef('T1042'), 'T-1042');
  assert.equal(extractProjectAlias('#记账 加个导出功能'), '记账');
  assert.equal(extractProjectAlias('#T1042 改一下'), null); // 任务号不会被当成项目别名
});

test('short-id: 项目别名校验', () => {
  assert.equal(validateAlias('记账').ok, true);
  assert.equal(validateAlias('#记账').ok, true);
  assert.equal(validateAlias('T-1042').ok, false);
  assert.equal(validateAlias('a'.repeat(9)).ok, false);
  assert.equal(validateAlias('有 空格').ok, false);
  assert.equal(validateAlias('').ok, false);
});

// ───────────────────────── resolver ─────────────────────────

test('resolver: #T1042 显式地址 → task_message(address)，且不调用 LLM', async () => {
  const t = task({ id: 42, shortId: 'T-1042', title: '对账脚本' });
  const { store, focusSets } = makeStore({ tasks: [t] });
  const r = await resolveInbound(inbound({ text: '#T1042 把超时改成 30 秒' }), store, noClassify);
  const m = expectKind(r, 'task_message');
  assert.equal(m.taskId, 42);
  assert.equal(m.via, 'address');
  assert.equal(m.updatesFocus, true);
  assert.equal(focusSets().length, 1);
});

test('resolver: 回复旧卡片优先于 sticky 焦点（多项目串台用例）', async () => {
  const focusTask = task({ id: 1, shortId: 'T-1042', title: '记账：对账' });
  const pushed = task({ id: 2, shortId: 'T-1051', title: '官网：定价页' });
  const { store } = makeStore({
    tasks: [focusTask, pushed],
    convos: {
      'im:wechat|wx-private': {
        kind: 'private',
        projectId: null,
        focusTaskId: 1,
        focusUpdatedAt: 999_999,
      },
    },
    outbound: { 'im:wechat|msg-9001': { taskId: 2, reportId: null } },
  });
  const r = await resolveInbound(inbound({ text: '2', replyToMsgId: 'msg-9001' }), store, noClassify);
  const m = expectKind(r, 'task_message');
  assert.equal(m.taskId, 2); // 归位到被回复的任务，而不是当前焦点
  assert.equal(m.via, 'reply');
});

test('resolver: 列表序号回复 → pending_answer', async () => {
  const { store, pendingClears } = makeStore({
    pendingList: { messageRef: 'msg-list-1', createdAt: 0, items: [{ index: 1, taskId: 7, reportId: 3 }] },
  });
  const r = await resolveInbound(inbound({ text: '1' }), store, noClassify);
  const p = expectKind(r, 'pending_answer');
  assert.equal(p.messageRef, 'msg-list-1');
  assert.equal(p.taskId, 7);
  assert.equal(p.reportId, 3);
  assert.equal(pendingClears(), 1);
});

test('resolver: 跨项目只读查询 → query，且不改焦点', async () => {
  const focusTask = task({ id: 1, shortId: 'T-1042' });
  const { store, focusSets } = makeStore({
    tasks: [focusTask],
    convos: {
      'im:wechat|wx-private': {
        kind: 'private',
        projectId: null,
        focusTaskId: 1,
        focusUpdatedAt: 999_000,
      },
    },
  });
  const { fn, calls } = classifier({ intent: 'query', projectId: 2, confidence: 0.9 });
  const r = await resolveInbound(inbound({ text: 'B 项目的周报写得怎么样了' }), store, fn);
  const q = expectKind(r, 'query');
  assert.equal(q.projectId, 2);
  assert.equal(calls(), 1);
  assert.equal(focusSets().length, 0); // 关键：查询不更新焦点
});

test('resolver: 工作性消息命中 sticky 焦点 → via focus 并续期', async () => {
  const focusTask = task({ id: 1, shortId: 'T-1042' });
  const { store, focusSets } = makeStore({
    tasks: [focusTask],
    convos: {
      'im:wechat|wx-private': {
        kind: 'private',
        projectId: null,
        focusTaskId: 1,
        focusUpdatedAt: 990_000,
      },
    },
  });
  const { fn } = classifier({ intent: 'work', confidence: 0.4 });
  const r = await resolveInbound(inbound({ text: '把刚才那版的措辞再收紧一点' }), store, fn);
  const m = expectKind(r, 'task_message');
  assert.equal(m.via, 'focus');
  assert.equal(m.taskId, 1);
  assert.equal(focusSets()[0]?.taskId, 1);
});

test('resolver: 焦点过期（15 分钟窗口）→ 不使用焦点，进入确认', async () => {
  const focusTask = task({ id: 1, shortId: 'T-1042' });
  const { store } = makeStore({
    tasks: [focusTask],
    convos: {
      'im:wechat|wx-private': {
        kind: 'private',
        projectId: null,
        focusTaskId: 1,
        focusUpdatedAt: 1_000_000 - FOCUS_TTL_MS - 1,
      },
    },
  });
  const { fn } = classifier({ intent: 'work', confidence: 0.3 });
  const r = await resolveInbound(inbound({ text: '继续改一下' }), store, fn);
  expectKind(r, 'confirm'); // 不悄悄归到过期焦点
});

test('resolver: 新需求语义归位 → new_task（带项目）', async () => {
  const { store } = makeStore({ defaultProject: { id: 2, name: '官网' } });
  const { fn } = classifier({
    intent: 'new_task',
    projectId: 2,
    confidence: 0.9,
    titleGuess: '定价页改版',
  });
  const r = await resolveInbound(inbound({ text: '帮我把官网的定价页改一版' }), store, fn);
  const n = expectKind(r, 'new_task');
  assert.equal(n.projectId, 2);
  assert.equal(n.titleGuess, '定价页改版');
});

test('resolver: 模糊消息 → confirm（只问一次），零副作用', async () => {
  const focusTask = task({ id: 1, shortId: 'T-1042' });
  const { store, focusSets } = makeStore({
    tasks: [focusTask],
    convos: {
      'im:wechat|wx-private': {
        kind: 'private',
        projectId: null,
        focusTaskId: 1,
        focusUpdatedAt: 999_500,
      },
    },
    defaultProject: { id: 2, name: '官网' },
  });
  const { fn } = classifier({ intent: 'new_task', confidence: 0.4 }); // 不够自信
  const r = await resolveInbound(inbound({ text: '嗯，你看看' }), store, fn);
  const c = expectKind(r, 'confirm');
  assert.ok(c.options.length >= 2);
  assert.equal(focusSets().length, 0); // 不创建、不焦点漂移
});

test('resolver: 命令直通（暂停/列表）→ 不调用 LLM', async () => {
  const t = task({ id: 5, shortId: 'T-1042' });
  const { store } = makeStore({ tasks: [t] });
  const r1 = await resolveInbound(inbound({ text: '暂停 T1042' }), store, noClassify);
  const c1 = expectKind(r1, 'command');
  assert.equal(c1.name, 'pause');
  assert.equal(c1.taskId, 5);
  const r2 = await resolveInbound(inbound({ text: '列表' }), store, noClassify);
  assert.equal(expectKind(r2, 'command').name, 'list');
});

test('resolver: 闲聊 → chat，零对象创建', async () => {
  const { store, focusSets } = makeStore({});
  const { fn } = classifier({ intent: 'chat', confidence: 0.95 });
  const r = await resolveInbound(inbound({ text: '今天天气不错' }), store, fn);
  expectKind(r, 'chat');
  assert.equal(focusSets().length, 0);
});

test('resolver: #记账 显式项目寻址 → new_task(该项目)', async () => {
  const { store } = makeStore({ aliases: { 记账: { id: 1, name: '记账系统' } } });
  const { fn } = classifier({ intent: 'work', confidence: 0.2, titleGuess: '加个导出功能' });
  const r = await resolveInbound(inbound({ text: '#记账 加个导出功能' }), store, fn);
  const n = expectKind(r, 'new_task');
  assert.equal(n.projectId, 1);
  assert.equal(n.via, 'address');
});

test('resolver: 未知任务号 → 确认，绝不当作新任务静默创建', async () => {
  const { store } = makeStore({ tasks: [task({ id: 9, shortId: 'T-1001' })] });
  const r = await resolveInbound(inbound({ text: '#T9999 继续' }), store, noClassify);
  expectKind(r, 'confirm');
});

// ───────────────────────── scheduler ─────────────────────────

test('scheduler: 槽位上限——4 个就绪任务只启动 3 个，第 4 个显式 hold', () => {
  const tasks = [
    task({ id: 1, state: 'ready', priority: 5 }),
    task({ id: 2, state: 'ready', priority: 4 }),
    task({ id: 3, state: 'ready', priority: 3 }),
    task({ id: 4, state: 'ready', priority: 1 }),
  ];
  const actions = planScheduling({
    now: 100_000,
    tasks,
    workItems: [],
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'start_task').map((a) => a.taskId),
    [1, 2, 3],
  );
  assert.ok(actions.some((a) => a.type === 'hold' && a.taskId === 4 && a.reason === 'no_slot'));
});

test('scheduler: 老化——等待 90 分钟的低优先级超过新来的高优先级', () => {
  const old = task({ id: 1, state: 'ready', priority: 0, readySince: 0 });
  const fresh = task({ id: 2, state: 'ready', priority: 2, readySince: 90 * 60_000 });
  const now = 90 * 60_000;
  assert.equal(effectivePriority(old, now, DEFAULT_SCHEDULER_CONFIG), 3); // 0 + min(5, 3)
  assert.equal(effectivePriority(fresh, now, DEFAULT_SCHEDULER_CONFIG), 2);
  const actions = planScheduling({
    now,
    config: { maxActiveTasks: 1 },
    tasks: [old, fresh],
    workItems: [],
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'start_task').map((a) => a.taskId),
    [1],
  );
});

test('scheduler: 员工占用——同一员工排队，空闲后按任务优先级派发', () => {
  const t1 = task({ id: 1, state: 'executing', priority: 5 });
  const t2 = task({ id: 2, state: 'executing', priority: 1 });
  const items = [wi(11, 1, 7, { createdAt: 10 }), wi(21, 2, 7, { createdAt: 5 })];

  // 员工 7 正忙 → 不派发，并显式 hold
  let actions = planScheduling({
    now: 10_000,
    tasks: [t1, t2],
    workItems: items,
    deps: new Map(),
    runningByEmployee: new Map([[7, 99]]),
  });
  assert.equal(actions.filter((a) => a.type === 'dispatch_work_item').length, 0);
  assert.ok(actions.some((a) => a.type === 'hold' && a.reason === 'employee_busy'));
  // MP1-3：占用者可指认——hold 带占用 work item（99 正占用员工 7）
  assert.ok(
    actions.some((a) => a.type === 'hold' && a.reason === 'employee_busy' && a.occupiedBy === 99),
    'employee_busy hold 必须带 occupiedBy（占用 work item id）',
  );

  // 员工 7 空闲 → 高优先级任务（t1）的 work item 先派
  actions = planScheduling({
    now: 10_000,
    tasks: [t1, t2],
    workItems: items,
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'dispatch_work_item').map((a) => a.workItemId),
    [11],
  );
});

test('scheduler: 依赖满足自动激活，并进入调度', () => {
  const dep = task({ id: 1, state: 'done' });
  const blocked = task({ id: 2, state: 'blocked', priority: 1 });

  let actions = planScheduling({
    now: 5000,
    tasks: [dep, blocked],
    workItems: [],
    deps: new Map([[2, [1]]]),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'activate_task').map((a) => a.taskId),
    [2],
  );

  // 调用方应用 activate 之后再跑一次：blocked → ready 后应拿到槽位
  const ready: TaskSnapshot = { ...blocked, state: 'ready', readySince: 5000 };
  actions = planScheduling({
    now: 5000,
    tasks: [dep, ready],
    workItems: [],
    deps: new Map([[2, [1]]]),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'start_task').map((a) => a.taskId),
    [2],
  );
});

test('scheduler: 超预算任务只暂停自己，不占槽位、不影响其他任务', () => {
  const broke = task({ id: 1, state: 'ready', priority: 9, budgetLeftTokens: 0 });
  const healthy = task({ id: 2, state: 'ready', priority: 1, budgetLeftTokens: null });
  const actions = planScheduling({
    now: 5000,
    config: { maxActiveTasks: 1 },
    tasks: [broke, healthy],
    workItems: [],
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.ok(actions.some((a) => a.type === 'hold' && a.taskId === 1 && a.reason === 'budget'));
  assert.deepEqual(
    actions.filter((a) => a.type === 'start_task').map((a) => a.taskId),
    [2],
  );
});

test('scheduler: 子任务全部完成 → 父任务推进 verifying', () => {
  const parent = task({ id: 1, state: 'executing' });
  const c1 = task({ id: 2, state: 'done', parentTaskId: 1 });
  const c2 = task({ id: 3, state: 'done', parentTaskId: 1 });
  const actions = planScheduling({
    now: 5000,
    tasks: [parent, c1, c2],
    workItems: [],
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions.filter((a) => a.type === 'advance_parent').map((a) => a.taskId),
    [1],
  );
});

test('resolver: 结束/续办命令直通（终态任务也可续办）', async () => {
  const running = task({ id: 5, shortId: 'T-1042', state: 'executing' });
  const finished = task({ id: 6, shortId: 'T-1007', state: 'done' });
  const { store } = makeStore({ tasks: [running, finished] });

  const r1 = await resolveInbound(inbound({ text: '结束 T1042' }), store, noClassify);
  const c1 = expectKind(r1, 'command');
  assert.equal(c1.name, 'finish');
  assert.equal(c1.taskId, 5);

  const r2 = await resolveInbound(inbound({ text: '重开 T1007' }), store, noClassify);
  const c2 = expectKind(r2, 'command');
  assert.equal(c2.name, 'renew'); // 续办：对终态任务也生效
  assert.equal(c2.taskId, 6);
});

test('resolver: 自然语言含命令词不直通（走语义分类，防误伤）', async () => {
  const { store } = makeStore({});
  const { fn, calls } = classifier({ intent: 'chat', confidence: 0.9 });
  const r = await resolveInbound(inbound({ text: '暂停一下这个想法，我考虑考虑' }), store, fn);
  expectKind(r, 'chat');
  assert.equal(calls(), 1); // 没有被命令文法直通，落到了 LLM 分类
});

test('scheduler: 暂停任务不占槽位、不派发；继续后立即恢复调度', () => {
  const pausedTask = task({ id: 1, state: 'paused', priority: 9 });
  const items = [wi(11, 1, 7)];

  const actions = planScheduling({
    now: 5000,
    tasks: [pausedTask],
    workItems: items,
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.equal(actions.filter((a) => a.type === 'start_task').length, 0);
  assert.equal(actions.filter((a) => a.type === 'dispatch_work_item').length, 0);

  // 「继续」把 state 写回 ready（编排器负责）→ 立刻能拿槽位
  const resumed: TaskSnapshot = { ...pausedTask, state: 'ready', readySince: 5000 };
  const actions2 = planScheduling({
    now: 5000,
    tasks: [resumed],
    workItems: items,
    deps: new Map(),
    runningByEmployee: new Map(),
  });
  assert.deepEqual(
    actions2.filter((a) => a.type === 'start_task').map((a) => a.taskId),
    [1],
  );
});

test('scheduler: occupancyAware——关键员工忙时不空占槽位', () => {
  const a = task({ id: 1, state: 'ready', priority: 5 });
  const b = task({ id: 2, state: 'ready', priority: 1 });
  const items = [wi(11, 1, 7), wi(21, 2, 8)];
  const actions = planScheduling({
    now: 5000,
    config: { maxActiveTasks: 1, occupancyAware: true },
    tasks: [a, b],
    workItems: items,
    deps: new Map(),
    runningByEmployee: new Map([[7, 99]]),
  });
  assert.deepEqual(
    actions.filter((x) => x.type === 'start_task').map((x) => x.taskId),
    [2], // a 的关键员工忙 → 槽位让给 b
  );
});
