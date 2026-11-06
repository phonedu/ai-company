/**
 * RW-52（2026-11-05 真机定位）· 持久化会话恢复**丢新工具**的守卫。
 *
 * 现场：幕僚长频道说「请用 boss_inbox 列一下待办」，LLM 答「不在本次会话注册的工具里」。
 * SDK 实证（@earendil-works/pi-coding-agent 1.3.0 `core/agent-session.js`，独立脚本 A/B 对照）：
 * 持久化会话 resume 时 `_restoreToolsFromTranscript()` 把活动工具集**整体替换**为转录
 * system 消息的 `toolsAdded` 快照（建于 boss 工具出现之前）⇒ `boss_inbox` / `boss_card_resolve`
 * 已注册但**永不激活**（不声明给模型）；`task_status` 等照常＝快照内工具；全新会话正常；
 * 重启/重构建无效（会话文件本身带旧快照）。
 *
 * 修法（官方扩展口）：`before_agent_start`（每轮先于 loadout 定稿触发）**幂等补齐**
 * 本工厂注册的工具 ⇒ 同一请求里 `declareToolChanges` 把缺失工具作为 `toolsAdded` delta
 * 声明给模型。SDK 的 `createAgentSession` 路径不发 `session_start`（CLI 模式专属），
 * 故守卫必须挂 `before_agent_start`。
 *
 * 覆盖面：fake pi 钩子行为（补齐 / 幂等 / SDK 面变化不炸）＋ pi-assistant 接线守卫
 * （防「写了没人调」）＋ 有牙（改坏即红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerToolActivationGuard } from '../src/main/agent/pi-runtime.js';

/** fake pi：`on` 注册表 + 可控的活动工具集（`getActiveTools`/`setActiveTools` 记调用次数）。 */
function makeFakePi(active: string[]): {
  handlers: Map<string, (ev: unknown) => unknown>;
  setActiveCalls: string[][];
  pi: {
    on(event: string, handler: (ev: unknown) => unknown): () => void;
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
  };
} {
  const handlers = new Map<string, (ev: unknown) => unknown>();
  const setActiveCalls: string[][] = [];
  const pi = {
    on(event: string, handler: (ev: unknown) => unknown): () => void {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    getActiveTools(): string[] {
      return [...active];
    },
    setActiveTools(names: string[]): void {
      setActiveCalls.push([...names]);
      active.length = 0;
      active.push(...names);
    },
  };
  return { handlers, setActiveCalls, pi };
}

test('RW-52: fake pi → 注册 before_agent_start；快照缺新工具时补进活动集', () => {
  const { handlers, setActiveCalls, pi } = makeFakePi(['read', 'bash', 'task_status']);
  registerToolActivationGuard(pi, ['task_status', 'boss_inbox', 'boss_card_resolve']);

  const h = handlers.get('before_agent_start');
  assert.ok(h, '必须订阅 before_agent_start（否则守卫没人调＝RW-52 原样）');
  assert.equal(h({ type: 'before_agent_start' }), undefined, '不干预系统提示词（那是提示注入器的职责）');

  assert.deepEqual(setActiveCalls, [['read', 'bash', 'task_status', 'boss_inbox', 'boss_card_resolve']], '缺失工具按原顺序补齐');
  assert.deepEqual(pi.getActiveTools(), ['read', 'bash', 'task_status', 'boss_inbox', 'boss_card_resolve']);
});

test('RW-52: 活动集已齐 → 不调 setActiveTools（幂等，不重排不重写）', () => {
  const { handlers, setActiveCalls, pi } = makeFakePi(['boss_inbox', 'boss_card_resolve', 'task_status']);
  registerToolActivationGuard(pi, ['boss_inbox', 'boss_card_resolve']);
  handlers.get('before_agent_start')!({});
  assert.equal(setActiveCalls.length, 0, '一个不缺就不动（避免无谓的 loadout 抖动）');
  assert.deepEqual(pi.getActiveTools(), ['boss_inbox', 'boss_card_resolve', 'task_status'], '顺序保持原样');
});

test('RW-52: 只补缺的那一个（部分缺失场景）', () => {
  const { handlers, setActiveCalls, pi } = makeFakePi(['boss_inbox']);
  registerToolActivationGuard(pi, ['boss_inbox', 'boss_card_resolve']);
  handlers.get('before_agent_start')!({});
  assert.deepEqual(setActiveCalls, [['boss_inbox', 'boss_card_resolve']]);
  assert.deepEqual(pi.getActiveTools(), ['boss_inbox', 'boss_card_resolve']);
});

test('RW-52: 空名单 → 不订阅（无事可守，不挂空钩子）', () => {
  const { handlers, pi } = makeFakePi([]);
  registerToolActivationGuard(pi, []);
  assert.equal(handlers.get('before_agent_start'), undefined);
});

test('RW-52: pi 无 on / 无 getActiveTools（SDK 面变化）→ 静默不炸（不绊倒整个装配）', () => {
  assert.doesNotThrow(() => registerToolActivationGuard({}, ['boss_inbox']));
  // 有 on 但没有工具 API：注册不炸，触发也不炸
  const handlers = new Map<string, (ev: unknown) => unknown>();
  const bare = {
    on(event: string, handler: (ev: unknown) => unknown): () => void {
      handlers.set(event, handler);
      return () => undefined;
    },
  };
  registerToolActivationGuard(bare, ['boss_inbox']);
  assert.equal(handlers.get('before_agent_start')!({}), undefined);
});

test('RW-52 接线: pi-assistant 必须把守卫与注册名单接进 extensionFactories（防「写了没人调」）', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'pi-assistant.ts'), 'utf8');
  assert.ok(
    /registerToolActivationGuard\(pi,/.test(src),
    'extensionFactories 里必须调 registerToolActivationGuard（否则持久化会话恢复仍丢新工具）',
  );
  assert.ok(
    /assistantTools\.map\(\(tool\) => \(tool as \{ name: string \}\)\.name\)/.test(src),
    '守卫名单必须取自工具对象本身（单一真值；手抄名单会漂移）',
  );
  assert.ok(
    /for \(const tool of assistantTools\) api\.registerTool\(tool\)/.test(src),
    '注册与守卫必须共用同一名单（防注册了 A 守卫的是 B）',
  );
});

test('RW-52 "有牙": 接线退回逐个 registerTool、无守卫 → 对应判据必红（合成，证明断言承重）', () => {
  const brokenOld = [
    'extensionFactories: [',
    '  (pi) => {',
    '    const api = pi as { registerTool(tool: unknown): void };',
    '    api.registerTool(reportProgress);',
    '    api.registerTool(cardTools.inboxTool);',
    '  },',
    '],',
  ].join('\n');
  assert.ok(!/registerToolActivationGuard\(pi,/.test(brokenOld), '旧写法无守卫＝本测该咬住');
  assert.ok(!/assistantTools\.map\(/.test(brokenOld));
});

test('RW-52 接线(员工侧): employee-factory 同因同修——注册与守卫共用 employeeTools 名单', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'employee-factory.ts'), 'utf8');
  assert.ok(
    /registerToolActivationGuard\(api,/.test(src),
    '员工侧 extensionFactories 必须也调 registerToolActivationGuard（员工会话同样落盘，同因潜伏）',
  );
  assert.ok(
    /for \(const tool of employeeTools\) register\.call\(api, tool\)/.test(src),
    '注册必须遍历 employeeTools 名单（与守卫同一来源，防注册了 A 守卫的是 B）',
  );
  assert.ok(
    /employeeTools\.map\(\(tool\) => \(tool as \{ name: string \}\)\.name\)/.test(src),
    '守卫名单必须取自工具对象本身（单一真值；手抄名单会漂移）',
  );
});
