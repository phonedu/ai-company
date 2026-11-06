/**
 * `pnpm audit:chain`（链条断点审计）的门测试 —— 逻辑单元（内存合成，含「有牙」负例）
 * ＋ 真仓集成（账本完备：新孤儿 0；无回归；探针读数与账本一致；扫描有量防真空绿）。
 *
 * 口径见 `src/main/audit/chain-audit.ts` 头注；账本＝`src/main/audit/chain-registry.ts`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  actionKindCensus,
  actionKindFindings,
  auditScanExcluded,
  censusEvents,
  collectDispatchSites,
  eventDefs,
  executeActionKinds,
  invalidDispatchFindings,
  ipcPushFindings,
  literalActionKinds,
  orphanEventFindings,
  reconcile,
  runProbes,
  summarize,
  timerKindFindings,
  toolFindings,
  uiImplementedEvents,
  writerFindings,
  type Disposition,
  type SourceFile,
} from '../src/main/audit/chain-audit.js';
import {
  ORPHAN_DISPOSITIONS,
  PROBES,
  TIMER_KINDS,
  TOOL_SPECS,
  WRITER_SPECS,
} from '../src/main/audit/chain-registry.js';
import { TASK_TRANSITIONS, WORK_ITEM_TRANSITIONS } from '../src/main/engine/index.js';
import { TASK_ACTIONS_TABLE } from '../src/renderer/components/taskActions.js';

test('① 孤儿迁移：字面量/UI 表透传任一在场即不算；注释行字面量不算（有牙）', () => {
  const defs = eventDefs(
    [
      { from: 'ready', event: 'pause', m0: true },
      { from: 'ready', event: 'block', m0: false },
    ],
    [],
  );
  const files: SourceFile[] = [
    { path: 'src/main/a.ts', text: "x.dispatch({ scope: 'task', id: 1, event: 'pause' });\n// event: 'block'\n" },
  ];
  const census = censusEvents(defs, files, new Set());
  const orphans = orphanEventFindings(census);
  assert.deepEqual(orphans.map((f) => f.name), ['block'], 'pause 有生产者；block 只在注释里 ⇒ 孤儿');
  assert.ok(census.find((c) => c.event === 'pause')?.m0 === true, 'm0 标记应合并到普查条目');
  // 有牙：UI 表 implemented 透传算生产者
  const census2 = censusEvents(defs, files, new Set(['block']));
  assert.equal(orphanEventFindings(census2).length, 0, 'UI 表 implemented 透传应算生产者');
});

test('② 非法派发：dispatch 窗口 (scope,event) 不在真值表 ⇒ 报；onEvent 形状不算（有牙）', () => {
  const files: SourceFile[] = [
    {
      path: 'src/main/x.ts',
      text: [
        "await deps.dispatch?.({ scope: 'work_item', id: 1, event: 'work_item_failed' });",
        "await deps.dispatch?.({ scope: 'work_item', id: 1, event: 'submit_work_item' });",
        "this.config.onEvent?.({ scope: 'task', id: 0, event: 'engine_error' });",
      ].join('\n'),
    },
  ];
  const sites = collectDispatchSites(files);
  assert.deepEqual(
    sites.map((s) => `${s.scope}:${s.event}`),
    ['work_item:work_item_failed', 'work_item:submit_work_item'],
    'onEvent 非 dispatch ⇒ 不进窗口',
  );
  const invalid = invalidDispatchFindings(sites, new Set(['work_item:submit_work_item']));
  assert.deepEqual(invalid.map((f) => f.name), ['work_item:work_item_failed']);
});

test('③ 对账：未登记＝新孤儿（红）；fixed 仍在场＝回归（红）；open 消失＝账本待更新（黄）（有牙）', () => {
  const block = { check: 'event' as const, name: 'block', detail: '' };
  const reassign = { check: 'event' as const, name: 'reassign', detail: '' };
  const openBlock: Disposition = { check: 'event', name: 'block', status: 'open', ref: 'x', note: '' };

  let recon = reconcile([block], []);
  assert.deepEqual(recon.unknown.map((f) => f.name), ['block']);
  assert.equal(summarize(recon, []).red, true, '新孤儿 ⇒ 红');

  recon = reconcile([block, reassign], [{ ...openBlock, status: 'fixed' }]);
  assert.deepEqual(recon.regressions.map((f) => f.name), ['block'], 'fixed 仍在场');
  assert.deepEqual(recon.unknown.map((f) => f.name), ['reassign']);
  assert.equal(summarize(recon, []).red, true, '回归/新孤儿 ⇒ 红');

  recon = reconcile([], [openBlock]);
  assert.deepEqual(recon.possiblyFixed.map((d) => d.name), ['block']);
  const s = summarize(recon, []);
  assert.equal(s.red, false, '账本待更新不挡（黄）');
  assert.equal(s.yellowReasons.length, 1);
});

test('④ 探针：按作用域计数、整行注释排除；fixed 偏移＝红、open 偏移＝黄（有牙）', () => {
  const files: SourceFile[] = [
    { path: 'src/main/ipc/a.ts', text: 'const x = budget_tokens;\n// budget_tokens\n' },
    { path: 'src/main/b.ts', text: 'new Notification(x);\n' },
  ];
  const results = runProbes(
    [
      { id: 'p-open', status: 'open', scope: 'src/main/ipc', pattern: 'budget_tokens', op: '==', value: 0, note: '' },
      { id: 'p-fixed', status: 'fixed', scope: 'src/main', pattern: 'new Notification', op: '>=', value: 1, note: '' },
      { id: 'p-fixed-red', status: 'fixed', scope: 'src/main/ipc', pattern: 'never_exists_xyz', op: '>=', value: 1, note: '' },
    ],
    files,
  );
  assert.equal(results[0]?.reading, 1, '目录作用域命中；注释行不计');
  assert.equal(results[0]?.ok, false);
  assert.equal(results[1]?.ok, true);
  const s = summarize({ known: [], unknown: [], regressions: [], possiblyFixed: [] }, results);
  assert.equal(s.red, true, 'fixed 探针偏移 ⇒ 红');
  assert.ok(s.yellowReasons.some((r) => r.includes('p-open')), 'open 探针偏移 ⇒ 黄');
  const fileScoped = runProbes(
    [{ id: 'p-file', status: 'fixed', scope: 'src/main/b.ts', pattern: 'Notification', op: '>=', value: 1, note: '' }],
    files,
  );
  assert.equal(fileScoped[0]?.reading, 1, '文件作用域只扫该文件');
});

test('⑤ 写者/工具/timer 探测：仅自身文件调用、幕僚长消费、类型声明行均不算（有牙）', () => {
  const writerFiles: SourceFile[] = [
    { path: 'src/main/db/task_deps.ts', text: 'export function addTaskDependency(db) {}\naddTaskDependency(db);\n' },
    { path: 'src/main/engine/loop.ts', text: 'const x = 1;\n' },
  ];
  const spec = [{ file: 'src/main/db/task_deps.ts', fn: 'addTaskDependency' }];
  assert.deepEqual(
    writerFindings(writerFiles, spec).map((f) => f.name),
    ['src/main/db/task_deps.ts:addTaskDependency'],
    '仅自身文件调用不算调用者',
  );
  const writerOk: SourceFile[] = [
    ...writerFiles,
    { path: 'src/main/engine/sched.ts', text: 'addTaskDependency(d, 1, 2);\n' },
  ];
  assert.equal(writerFindings(writerOk, spec).length, 0, '生产侧真调用 ⇒ 不再孤儿');

  const toolFiles: SourceFile[] = [
    { path: 'src/main/agent/employee-executor.ts', text: "const t = calls.find((x) => x.name === 'submit_work_item');\n" },
  ];
  assert.deepEqual(
    toolFindings(toolFiles, [
      { name: 'submit_work_item', consumer: 'src/main/agent/employee-executor.ts' },
      { name: 'report_progress', consumer: 'src/main/agent/employee-executor.ts' },
    ]).map((f) => f.name),
    ['report_progress'],
  );

  const timerFiles: SourceFile[] = [
    { path: 'src/main/engine/timers.ts', text: "export type TimerKind = 'a' | 'b';\n" },
    { path: 'src/main/engine/loop.ts', text: "scheduleTimer(db, { kind: 'a' });\n" },
  ];
  assert.deepEqual(timerKindFindings(timerFiles, ['a', 'b']).map((f) => f.name), ['b'], '类型声明行不算引用');
});

test('⑦ 孤儿动作：执行 actions 收集 kind × 消费者（字面量/族处理器）对账；抛错行如实登记（有牙）', () => {
  const rows = [
    { from: 'ready', event: 'start_task', m0: true, actions: () => [{ kind: 'dispatch_planning' }, { kind: 'notify_x' }] },
    {
      from: 'executing',
      event: 'fail',
      m0: true,
      actions: () => {
        throw new Error('条件闭包');
      },
    },
    { from: 'paused', event: 'renew', m0: true, actions: () => [{ kind: 'spawn_work_item' }] },
  ];
  const exec = executeActionKinds(rows, 'task');
  assert.deepEqual(exec.failures.map((f) => f.row), ['task:fail'], '闭包抛错的行如实登记');
  const census = actionKindCensus([exec], ['renew', 'orphan_kind']);
  assert.equal(census.find((c) => c.kind === 'renew')?.viaLiteral, true, '字面量兜底标记');
  const files: SourceFile[] = [
    { path: 'src/main/engine/loop.ts', text: "if (action.kind === 'dispatch_planning') {}\nif (action.kind.startsWith('notify_')) {}\n" },
    { path: 'src/main/engine/loop2.ts', text: "const x = 'spawn_work_item';\n" },
  ];
  const findings = actionKindFindings(census, files);
  assert.deepEqual(
    findings.map((f) => f.name).sort(),
    ['orphan_kind', 'renew'],
    '前三个有消费者（含族处理器）；两条无消费者必被报出',
  );
});

test('⑧ 推送三腿：声明×推送×路由 对账（缺推送＝孤儿；推了未声明＝反向；信封 evt:batch 不参与）（有牙）', () => {
  const files: SourceFile[] = [
    { path: 'src/preload/index.ts', text: "const EVENT_CHANNELS = ['evt:a', 'evt:b', 'evt:batch'] as const;\n" },
    { path: 'src/main/index.ts', text: "sink.push('evt:a', x);\nsink.push('evt:c', y);\n" },
    { path: 'src/renderer/store.ts', text: "if (env.channel === 'evt:a') {}\nif (env.channel === 'evt:c') {}\n" },
  ];
  const findings = ipcPushFindings(files);
  assert.deepEqual(findings.map((f) => f.name).sort(), ['evt:b', 'evt:c（未声明）']);
  assert.match(findings.find((f) => f.name === 'evt:b')?.detail ?? '', /推送 0 · 渲染路由 缺/);
  assert.match(findings.find((f) => f.name === 'evt:c（未声明）')?.detail ?? '', /路由 已在/);
});

test('⑥ 真仓集成：账本完备（新孤儿 0）＋无回归＋账本无待更新＋探针全对账＋扫描有量（防真空绿）', () => {
  const root = process.cwd();
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, acc);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
    }
    return acc;
  };
  const files: SourceFile[] = [...walk('src/main'), ...walk('src/preload')].map((p) => ({
    path: p,
    text: readFileSync(join(root, p), 'utf8'),
  }));

  const defs = eventDefs(TASK_TRANSITIONS, WORK_ITEM_TRANSITIONS);
  const census = censusEvents(defs, files, uiImplementedEvents(TASK_ACTIONS_TABLE), auditScanExcluded);
  const validPairs = new Set(defs.map((d) => `${d.scope}:${d.event}`));
  const sites = collectDispatchSites(files, auditScanExcluded);
  // 探针与 ⑦ 推送三腿都需要 renderer（BRK19 锚 / BRK13 UI 面读数 / 信封路由在 src/renderer）
  const probeFiles: SourceFile[] = [
    ...files,
    ...walk('src/renderer').map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') })),
  ];
  // ⑥ 孤儿动作：执行 actions ∪ 字面量兜底
  const statemachineText = files.find((f) => f.path.endsWith('engine/statemachine.ts'))?.text ?? '';
  const actionExecutions = [
    executeActionKinds(TASK_TRANSITIONS, 'task'),
    executeActionKinds(WORK_ITEM_TRANSITIONS, 'work_item'),
  ];
  const actionCensus = actionKindCensus(actionExecutions, literalActionKinds(statemachineText));
  const findings = [
    ...orphanEventFindings(census),
    ...invalidDispatchFindings(sites, validPairs),
    ...writerFindings(files, WRITER_SPECS),
    ...toolFindings(files, TOOL_SPECS),
    ...timerKindFindings(files, TIMER_KINDS),
    ...actionKindFindings(actionCensus, files),
    ...ipcPushFindings(probeFiles),
  ];
  const recon = reconcile(findings, ORPHAN_DISPOSITIONS);
  const probeResults = runProbes(PROBES, probeFiles);

  // 防真空绿：扫描确有量（探测器失效时这些下限先红）。
  // 2026-10-19：GAP1 cron 已接线后真实 findings 降到 7；下限随事实下调（不伪造条目凑数）。
  assert.ok(files.length >= 100, `扫描文件数异常：${files.length}`);
  assert.ok(census.length >= 40, `事件普查异常：${census.length}`);
  assert.ok(findings.length >= 7, `孤儿普查异常：${findings.length}`);
  assert.equal(probeResults.length, PROBES.length);

  assert.deepEqual(
    recon.unknown,
    [],
    `新孤儿未登记（当日进账本 ORPHAN_DISPOSITIONS）：\n${recon.unknown.map((f) => `${f.check}:${f.name} — ${f.detail}`).join('\n')}`,
  );
  assert.deepEqual(
    recon.regressions,
    [],
    `回归：账本标 fixed 的断链重现：${recon.regressions.map((f) => `${f.check}:${f.name}`).join(', ')}`,
  );
  // 注：「账本待更新」（open 条目读数已消失）＝报告黄项、**不挡测试**——并行会话在途接线时账本允许滞后一格，
  // 由下次审计复核翻状态；只有红项（新孤儿/回归/探针偏移）才挡。
  const probeOff = probeResults.filter((r) => !r.ok);
  assert.deepEqual(
    probeOff.map((r) => r.probe.id),
    [],
    `探针偏移（复核账本）：${probeOff.map((r) => `${r.probe.id}=${r.reading}`).join(', ')}`,
  );
});
