import test from 'node:test';
import assert from 'node:assert/strict';

import { EvtSink, type EvtBatchEnvelope } from '../src/main/evt-sink.js';

// ───────────────────── evt-sink（最小版）单元测试 ─────────────────────
// 断言：统一信封形状、单批 ≤500 拆批、同窗口同 key last-wins、窗口自动 flush、销毁目标不抛。

interface Recorded {
  channel: string;
  payload: EvtBatchEnvelope;
}

function recorder(): { target: { send: (c: string, p: unknown) => void }; got: Recorded[] } {
  const got: Recorded[] = [];
  return {
    got,
    target: {
      send(channel: string, payload: unknown): void {
        got.push({ channel, payload: payload as EvtBatchEnvelope });
      },
    },
  };
}

test('evt-sink：1000 条不同 key → 拆成 2 批（各 ≤500），信封形状正确', () => {
  const { target, got } = recorder();
  const sink = new EvtSink(() => target);
  for (let i = 0; i < 1000; i += 1) sink.push('evt:task', { seq: i }, `k${i}`);
  sink.flush();

  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((g) => g.payload.items.length),
    [500, 500],
  );
  for (const g of got) {
    assert.equal(g.channel, 'evt:batch');
    assert.equal(g.payload.channel, 'evt:task');
    assert.ok(g.payload.items.length <= 500);
    assert.equal(typeof g.payload.batchSeq, 'number');
  }
  // batchSeq 递增且唯一
  assert.deepEqual(
    got.map((g) => g.payload.batchSeq),
    [1, 2],
  );
  assert.deepEqual(sink.stats(), { batches: 2, items: 1000, coalesced: 0, maxBatchObserved: 500 });
});

test('evt-sink：同窗口同 key last-wins（去重）', () => {
  const { target, got } = recorder();
  const sink = new EvtSink(() => target);
  sink.push('evt:task', { seq: 1 }, 'task:1');
  sink.push('evt:task', { seq: 2 }, 'task:1');
  sink.push('evt:task', { seq: 3 }, 'task:1');
  sink.flush();

  assert.equal(got.length, 1);
  assert.deepEqual(got[0].payload.items, [{ seq: 3 }]);
  assert.equal(sink.stats().coalesced, 2);
});

test('evt-sink：同主体多事件只留最新 —— 中间态被吞、终态不丢', () => {
  const { target, got } = recorder();
  const sink = new EvtSink(() => target);
  sink.push('evt:task', { state: 'planning' }, 'task:1');
  sink.push('evt:task', { state: 'ready' }, 'task:1');
  sink.push('evt:task', { state: 'done' }, 'task:1'); // 终态最后到达 → 必须保留
  sink.flush();

  assert.equal(got.length, 1);
  assert.deepEqual(got[0].payload.items, [{ state: 'done' }], '终态不得被中间态覆盖/丢弃');
  assert.equal(sink.stats().coalesced, 2, '两个中间态被吞');
});

test('evt-sink：batchSeq 跨多次 flush 单调递增', () => {
  const { target, got } = recorder();
  const sink = new EvtSink(() => target);
  sink.push('evt:task', { i: 0 }, 'a');
  sink.flush();
  sink.push('evt:task', { i: 1 }, 'b');
  sink.flush();
  sink.push('evt:message', { i: 2 }, 'c');
  sink.flush();

  assert.deepEqual(
    got.map((g) => g.payload.batchSeq),
    [1, 2, 3],
  );
});

test('evt-sink：窗口到期自动 flush（16ms）', async () => {
  const { target, got } = recorder();
  const sink = new EvtSink(() => target, 16);
  sink.push('evt:message', { hello: 1 });
  assert.equal(got.length, 0, '窗口内不应立即发送');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.channel, 'evt:message');
});

test('evt-sink：目标已销毁 → 静默丢弃、不抛', () => {
  let destroyed = true;
  const got: unknown[] = [];
  const sink = new EvtSink(() => ({
    send: (_channel: string, payload: unknown): void => {
      got.push(payload);
    },
    isDestroyed: () => destroyed,
  }));
  sink.push('evt:task', { seq: 1 }, 'k');
  assert.doesNotThrow(() => sink.flush());
  assert.equal(got.length, 0, '目标已销毁时不得发送');

  destroyed = false;
  sink.push('evt:task', { seq: 2 }, 'k');
  sink.flush();
  assert.equal(got.length, 1, '目标可用时正常发送');
});

// ── F-G8：每通道最新值快照（订阅时回放，补上订阅前丢失的事件）──

test('evt-sink F-G8：snapshot() 保留每通道最新一批；再次 flush 覆盖为最新', () => {
  const { target } = recorder();
  const sink = new EvtSink(() => target);
  sink.push('evt:agent', { state: 'failed' });
  sink.flush();
  assert.deepEqual(sink.snapshot(), [{ channel: 'evt:agent', items: [{ state: 'failed' }] }]);

  sink.push('evt:agent', { state: 'ready' });
  sink.flush();
  assert.deepEqual(sink.snapshot(), [{ channel: 'evt:agent', items: [{ state: 'ready' }] }], '覆盖为最新');
});

test('evt-sink F-G8：target 不可用（订阅前）也缓存 —— 订阅前事件不丢', () => {
  const sink = new EvtSink(() => null);
  sink.push('evt:agent', { state: 'failed' });
  sink.flush();
  assert.deepEqual(
    sink.snapshot(),
    [{ channel: 'evt:agent', items: [{ state: 'failed' }] }],
    '无 target 时也进缓存（这正是订阅前装配失败要补的那条）',
  );
});

test('evt-sink F-G8：未 flush 的通道不入快照（快照=已推送过的最新值）', () => {
  const { target } = recorder();
  const sink = new EvtSink(() => target);
  sink.push('evt:other', { x: 1 });
  assert.equal(sink.snapshot().length, 0, '未 flush 不入缓存');
  sink.flush();
  assert.equal(sink.snapshot().length, 1);
});
