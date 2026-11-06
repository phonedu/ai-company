/**
 * `test:invariants`（引擎不变量探测）的门测试 —— 纯逻辑单元（内存合成，含「有牙」负例）。
 *
 * 口径见 `src/main/audit/invariants.ts` 头注；跑器＝`scripts/invariants/run.mjs`（真引擎装配，
 * 不进本测试——需 dist 全量装配，由 `pnpm test:invariants` 承担）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_INVARIANT_VIOLATIONS,
  applicableCommands,
  checkInvariants,
  matchKnownViolation,
  minimizeSequence,
  mulberry32,
  type EngineSnapshot,
} from '../src/main/audit/invariants.js';

const snap = (over: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
  taskId: 1,
  taskState: 'executing',
  wiStates: [],
  terminalTasks: [],
  pendingActions: 0,
  ...over,
});

test('I0 有牙：幽灵任务/工作项状态必被报出', () => {
  assert.equal(
    checkInvariants({ prev: null, cur: snap({ taskState: 'zombie' }), commands: [] })[0]?.key,
    'I0:task:zombie',
  );
  assert.ok(
    checkInvariants({ prev: null, cur: snap({ wiStates: ['haunted'] }), commands: [] }).some((v) => v.key === 'I0:wi:haunted'),
  );
});

test('I1 有牙：executing ＋ 全件 settled ＋ 静默 ⇒ 卡死（BRK4 签名）；有 pending/有活件/零件 ⇒ 不触发 I1', () => {
  const v = checkInvariants({ prev: null, cur: snap({ wiStates: ['submitted'] }), commands: ['resume'] });
  assert.deepEqual(v.map((x) => x.key), ['I1:executing-settled']);
  const noI1 = (cur2: EngineSnapshot): boolean =>
    checkInvariants({ prev: null, cur: cur2, commands: [] }).every((x) => x.invariant !== 'I1');
  assert.ok(noI1(snap({ wiStates: ['submitted'], pendingActions: 1 })), '有 pending 不触发 I1');
  assert.ok(noI1(snap({ wiStates: ['running'] })), '有活件不触发 I1（running 由 I2 管）');
  assert.ok(noI1(snap({ wiStates: [] })), '零件不触发 I1');
});

test('I2 有牙：静默后 running 工作项 ⇒ 孤儿会话；非静默不报', () => {
  const v = checkInvariants({ prev: null, cur: snap({ wiStates: ['running'] }), commands: [] });
  assert.ok(v.some((x) => x.key === 'I2:running-orphan'));
  assert.equal(
    checkInvariants({ prev: null, cur: snap({ wiStates: ['running'], pendingActions: 2 }), commands: [] }).length,
    0,
    '有 pending（会话进行中）不报',
  );
});

test('I3 有牙：终态任务离终态必被报出；本波含命中自身的 undo_finish ⇒ 合法', () => {
  const prev = snap({ terminalTasks: [{ id: 5, state: 'done' }] });
  assert.ok(
    checkInvariants({ prev, cur: snap({ terminalTasks: [] }), commands: ['renew'] }).some((x) => x.key === 'I3:left-terminal'),
  );
  assert.equal(
    checkInvariants({ prev, cur: snap({ taskId: 5, terminalTasks: [] }), commands: ['pause', 'undo_finish'] }).length,
    0,
    '本波含 undo_finish（目标＝当前任务）合法',
  );
  assert.equal(
    checkInvariants({ prev, cur: snap({ terminalTasks: [{ id: 5, state: 'done' }] }), commands: ['pause'] }).length,
    0,
    '终态未变不报',
  );
});

test('命令目录：适用性过滤正确（inbox ⇒ discard/triage；executing ⇒ cancel/finish_manual/pause；done ⇒ renew/undo_finish）', () => {
  assert.deepEqual(applicableCommands('inbox').map((c) => c.id).sort(), ['discard', 'triage'], 'inbox 的关闭是 discard 而非 cancel（首跑 I4 抓到的表笔误）');
  assert.deepEqual(applicableCommands('executing').map((c) => c.id).sort(), ['cancel', 'finish_manual', 'pause']);
  assert.deepEqual(applicableCommands('done').map((c) => c.id).sort(), ['renew', 'undo_finish']);
  assert.deepEqual(applicableCommands('needs_decision').map((c) => c.id), ['cancel']);
});

test('mulberry32：同种子必得同序列（可复跑口径）', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const c = mulberry32(8);
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
});

test('已知账本：BRK4 已修 → 账本清空；非账本违规不误配；minimizeSequence 贪心收缩（有牙）', async () => {
  assert.equal(matchKnownViolation({ invariant: 'I1', key: 'I1:executing-settled', detail: '' }), null, 'BRK4 修好后账本清空');
  assert.equal(matchKnownViolation({ invariant: 'I2', key: 'I2:running-orphan', detail: '' }), null);
  assert.equal(KNOWN_INVARIANT_VIOLATIONS.length, 0, '账本已清空（BRK4/undo_finish 统一修复）');

  const seq = ['x', 'a', 'y', 'boom', 'z'];
  const minimized = await minimizeSequence(seq, async (candidate) => candidate.includes('boom'));
  assert.deepEqual(minimized, ['boom'], '不可删的要素保留、其余删净');
});
