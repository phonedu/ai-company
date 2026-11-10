/**
 *  · 懒装配工厂（2564/2570：启动不被装配阻塞 + 超时 + 三态可见 + 不换桩）。
 * 用**注入的 fake 装配器**测，不花真金、不启 Pi。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toPersistedAction } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { setFallbackChain } from '../src/main/agent/model-policy.js';
import {
  createLazyEmployeeRuntime,
  type AssemblyStatus,
  type EmployeeRuntimeBundle,
} from '../src/main/agent/employee-factory.js';

const dispatchAction = () => toPersistedAction('dispatch:work_item:7:0', 'dispatch', 3, '{"attempt":0}');

function bundle(over: Partial<EmployeeRuntimeBundle> = {}): EmployeeRuntimeBundle {
  return {
    runtime: undefined as never,
    createExecutor: () => ({ execute: async () => void calls.push('real') }),
    dispose: () => undefined,
    modelRef: 'fake/model',
    credentialSource: 'file',
    ...over,
  };
}
const calls: string[] = [];

test('C1：装配期默认模型不存在 + 兜底链 → 用链首模型重试装配（会话级降级仍由执行器记录）', async () => {
  calls.length = 0;
  const attempts: string[] = [];
  setFallbackChain(['deepseek/deepseek-flash']);
  try {
    const lazy = createLazyEmployeeRuntime({
      db: {},
      cwd: 'D:/x',
      sessionDir: 'D:/s',
      resolveModel: () => ({ provider: 'deepseek', model: 'nonexistent-c1' }),
      assemble: async (o) => {
        attempts.push(`${o.provider}/${o.model}`);
        if (o.model === 'nonexistent-c1') throw new Error('[agent] 模型不存在：deepseek/nonexistent-c1');
        return bundle({ modelRef: `${o.provider}/${o.model}` });
      },
    });
    const st = await lazy.warmUp();
    assert.equal(st.state, 'ready', '兜底模型应完成装配');
    assert.deepEqual(attempts, ['deepseek/nonexistent-c1', 'deepseek/deepseek-flash']);
    assert.equal(st.state === 'ready' ? st.modelRef : '', 'deepseek/deepseek-flash');
  } finally {
    setFallbackChain(null);
  }
});

test('OPT-AI-1 lazy: 构造期零阻塞（不调装配器）；状态 idle', () => {
  calls.length = 0;
  let assembled = 0;
  const lazy = createLazyEmployeeRuntime({ db: {}, cwd: 'D:/x', sessionDir: 'D:/s', assemble: async () => (assembled++, bundle()) });
  assert.equal(assembled, 0, '构造不得触发装配');
  assert.deepEqual(lazy.status(), { state: 'idle' });
  const exec = lazy.createExecutor(() => undefined);
  assert.equal(assembled, 0, '取执行器也不得触发装配');
  assert.equal(typeof exec.execute, 'function');
});

test('OPT-AI-1 lazy: 首次派发才装配一次（memo 化）→ 就绪三态 + 真执行', async () => {
  calls.length = 0;
  let assembled = 0;
  const statuses: AssemblyStatus[] = [];
  const lazy = createLazyEmployeeRuntime({
    db: {},
    cwd: 'D:/x',
    sessionDir: 'D:/s',
    onStatus: (s) => statuses.push(s),
    assemble: async () => (assembled++, bundle()),
  });
  const exec = lazy.createExecutor(() => undefined);
  await exec.execute(dispatchAction());
  await exec.execute(dispatchAction());
  assert.equal(assembled, 1, '装配只发生一次');
  assert.deepEqual(calls, ['real', 'real']);
  assert.deepEqual(statuses.map((s) => s.state), ['assembling', 'ready']);
  const st = lazy.status();
  assert.equal(st.state, 'ready');
  if (st.state === 'ready') {
    assert.equal(st.modelRef, 'fake/model');
    assert.equal(st.credentialSource, 'file');
    assert.ok(typeof st.elapsedMs === 'number');
  }
});

test('OPT-AI-1 lazy: 装配超时 → 失败态（失败可见）+ 不换桩（不调真执行器）', async () => {
  calls.length = 0;
  const events: EngineEvent[] = [];
  const lazy = createLazyEmployeeRuntime({
    db: {},
    cwd: 'D:/x',
    sessionDir: 'D:/s',
    timeoutMs: 20,
    assemble: () => new Promise((r) => setTimeout(() => r(bundle()), 500)),
  });
  const exec = lazy.createExecutor((e) => void events.push(e));
  await exec.execute(dispatchAction());
  assert.equal(lazy.status().state, 'failed');
  assert.deepEqual(calls, [], '超时后绝不执行真会话');
  // 事件名＝工作项机真事件 `error`（此前 `work_item_failed` 不在工作项机 ⇒ 真引擎抛错）
  assert.equal(events[0]!.event, 'error');
  // 2026-10-29：超时文案改人话（网络不可用/服务不可达），仍要含「超时」语义。
  assert.match(String((events[0]!.payload as { reason: string }).reason), /timeout|连接超时/i);
});

test('OPT-AI-1 lazy: 装配抛错（如缺凭据）→ 失败态 + `error`{reason}（BRK2 真事件名）+ 不误伤非派发', async () => {
  calls.length = 0;
  const events: EngineEvent[] = [];
  const lazy = createLazyEmployeeRuntime({
    db: {},
    cwd: 'D:/x',
    sessionDir: 'D:/s',
    assemble: async () => {
      throw new Error('缺少 deepseek 凭据');
    },
  });
  const exec = lazy.createExecutor((e) => void events.push(e));
  await exec.execute(dispatchAction());
  const st = lazy.status();
  assert.equal(st.state, 'failed');
  assert.match(st.state === 'failed' ? st.reason : '', /凭据/);
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as { reason: string }).reason, '缺少 deepseek 凭据');
  // 非 work_item dispatch 不误伤
  await exec.execute(toPersistedAction('notify_report:task:3:0', 'notify_report', 3, '{}'));
  assert.equal(events.length, 1, '非派发动作不得产生事件');
});

test('OPT-AI-1 lazy "有牙": 去掉超时（timeoutMs 极大）→ 慢装配不会被判失败（证明上面的超时断言有意义）', async () => {
  calls.length = 0;
  const lazy = createLazyEmployeeRuntime({
    db: {},
    cwd: 'D:/x',
    sessionDir: 'D:/s',
    timeoutMs: 100_000,
    assemble: () => new Promise((r) => setTimeout(() => r(bundle()), 30)),
  });
  await lazy.createExecutor(() => undefined).execute(dispatchAction());
  assert.equal(lazy.status().state, 'ready');
  assert.deepEqual(calls, ['real']);
});

test('M4-B-9: reset 丢弃旧 bundle，下一次 warmUp 用新凭据重新装配', async () => {
  let assembled = 0;
  let disposed = 0;
  const lazy = createLazyEmployeeRuntime({
    db: {},
    cwd: 'D:/x',
    sessionDir: 'D:/s',
    assemble: async () => {
      assembled += 1;
      return bundle({ dispose: () => { disposed += 1; } });
    },
  });
  const first = await lazy.warmUp();
  assert.equal(first.state, 'ready');
  assert.equal(assembled, 1);
  lazy.reset();
  assert.deepEqual(lazy.status(), { state: 'idle' }, 'reset 后回到未装配');
  assert.equal(disposed, 1, '旧 bundle 必须 dispose');
  const second = await lazy.warmUp();
  assert.equal(second.state, 'ready');
  assert.equal(assembled, 2, '下一次会话重新装配（新 Key 生效）');
  lazy.dispose();
});
