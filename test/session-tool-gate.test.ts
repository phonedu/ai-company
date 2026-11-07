/**
 * G1（M2）· 会话内工具过 `permissionGate`：表驱动纯映射 + 假 `pi` 捕获 + 有牙。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  setPermissionPolicy,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SessionToolGate, type GateDecisionInfo, type RunGateContext, type ToolCallGateEvent } from '../src/main/agent/session-tool-gate.js';
import { EmployeeSessionRuntime } from '../src/main/agent/employee-runtime.js';
import { permissionGate, resolvePathArgument } from '../src/main/permission/gate.js';

function setup(tier = 'standard'): { db: SqliteDb; taskId: number; wiId: number; run: RunGateContext } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare(`INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev',?,1)`).run(tier);
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id, run: { employeeId: 7, taskId: task.id, workItemId: wi.id, cwd: 'D:/repo' } };
}

test('G1: 表驱动 —— 会话内工具按三层闸门判定（含能力档/路径/敏感/黑名单/对外/安装）', () => {
  const { db, taskId, run } = setup();
  try {
    setPermissionPolicy(db, { scopeType: 'task', scopeId: taskId, tier: 'standard', policy: { commandDenylist: ['rm -rf'] } });
    const gate = new SessionToolGate({ db });
    const cases: Array<[string, ToolCallGateEvent, boolean]> = [
      ['项目内写 → 放行', { toolName: 'write', input: { path: 'D:/repo/src/a.ts' } }, false],
      ['项目外写 → 拦', { toolName: 'write', input: { path: 'C:/outside/evil.txt' } }, true],
      ['.. 穿越 → 拦', { toolName: 'read', input: { path: 'D:/repo/../../etc/passwd' } }, true],
      ['敏感路径 → 拦', { toolName: 'read', input: { path: 'D:/repo/.ssh/id_rsa' } }, true],
      ['命令黑名单 → 拦', { toolName: 'bash', input: { command: 'rm -rf /' } }, true],
      ['普通命令 → 放行', { toolName: 'bash', input: { command: 'ls' } }, false],
      ['对外动作 → 拦(ask)', { toolName: 'publish', input: {} }, true],
      ['安装依赖 → 拦(ask)', { toolName: 'install', input: {} }, true],
      ['嵌套调用(parentToolCallId) 同样过闸', { toolName: 'write', input: { path: 'C:/outside/x' }, parentToolCallId: 'p1/1' }, true],
    ];
    for (const [label, event, shouldBlock] of cases) {
      const res = gate.evaluate(event, run);
      assert.equal(res.block === true, shouldBlock, `${label} → 期望 block=${shouldBlock}，实际 ${JSON.stringify(res)}`);
      if (shouldBlock) assert.ok(res.reason && res.reason.length > 0, `${label} 必须给出 reason`);
    }
    // sandbox 能力档 ∩ 写类 → 能力档层拒绝
    const sb = new SessionToolGate({ db });
    db.prepare("UPDATE employees SET capability_tier='sandbox' WHERE id=7").run();
    const res = sb.evaluate({ toolName: 'write', input: { path: 'D:/repo/x.ts' } }, run);
    assert.equal(res.block, true);
    assert.match(res.reason ?? '', /能力档|capability/);
  } finally {
    db.close();
  }
});

test('G1/G2: EmployeeSessionRuntime 用运行时实际 sessionIdFor（含 cwd）登记 gate', async () => {
  const seen: Array<{ id: string; ctx?: RunGateContext; clear?: string }> = [];
  const fakeGate = {
    setRun: (id: string, ctx: RunGateContext) => seen.push({ id, ctx }),
    clearRun: (id: string) => seen.push({ id, clear: id }),
  } as unknown as SessionToolGate;
  const fakeRuntime = {
    sessionIdFor: ({ sessionKey, cwd }: { sessionKey: string; cwd?: string }) => `${sessionKey}@${cwd}`,
    run: async () => ({ text: '', toolCalls: [], usage: { model: 'm' } }),
    steer: () => false,
    dispose: () => undefined,
  };
  const runtime = new EmployeeSessionRuntime(fakeRuntime as never, { toolGate: fakeGate });
  await runtime.run(
    { employeeId: 7, taskId: 1, systemPrompt: 's', userPrompt: 'u', cwd: 'D:/w' },
    () => undefined,
  );
  const expected = 'employee:7:task:1:wi:-@D:/w';
  assert.equal(seen[0]?.id, expected, 'gate 必须用运行时真实 id（含 cwd）');
  assert.equal(seen[0]?.ctx?.cwd, 'D:/w');
  assert.equal(seen[1]?.clear, expected, '清理同一个 id');
});

test('G1: 无归属上下文（unmanaged 会话）→ 不拦，但如实记 onDecision(rule=unmanaged_session)', () => {
  const { db } = setup();
  try {
    const decisions: GateDecisionInfo[] = [];
    const gate = new SessionToolGate({ db, onDecision: (d) => decisions.push(d) });
    const res = gate.evaluate({ toolName: 'write', input: { path: 'C:/outside/x' } }, null, 'some-other-session');
    assert.deepEqual(res, {});
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.rule, 'unmanaged_session');
  } finally {
    db.close();
  }
});

test('G1: 决策留痕经回调（deny/ask 都回调；单写者由装配层负责）', () => {
  const { db, taskId, run } = setup();
  try {
    const decisions: GateDecisionInfo[] = [];
    const gate = new SessionToolGate({ db, onDecision: (d) => decisions.push(d) });
    gate.evaluate({ toolName: 'write', input: { path: 'C:/outside/evil.txt' } }, run); // deny
    gate.evaluate({ toolName: 'publish', input: {} }, run); // ask
    gate.evaluate({ toolName: 'read', input: { path: 'D:/repo/a.ts' } }, run); // allow → 不回调
    assert.deepEqual(decisions.map((d) => d.decision), ['deny', 'ask']);
    assert.equal(decisions[0]!.toolName, 'write');
    assert.equal(decisions[1]!.rule, 'consent:external');
    void taskId;
  } finally {
    db.close();
  }
});

test('G1: register(pi) 用 sessionManager 取会话 id 命中/未命中上下文（假 pi 捕获 handler）', () => {
  const { db, run } = setup();
  try {
    const gate = new SessionToolGate({ db });
    let handler: (e: ToolCallGateEvent, ctx: unknown) => { block?: boolean } = () => ({});
    const fakePi = {
      on: (_ev: string, h: (e: ToolCallGateEvent, ctx: unknown) => { block?: boolean }) => {
        handler = h;
        return () => undefined;
      },
    };
    gate.register(fakePi as never);
    const ctxFor = (id: string) => ({ sessionManager: { getSessionId: () => id } });

    gate.setRun('employee_7_task_1_wi_1', run);
    const blocked = handler({ toolName: 'write', input: { path: 'C:/outside/x' } }, ctxFor('employee_7_task_1_wi_1'));
    assert.equal(blocked.block, true, '已登记会话：项目外写应被拦');
    const other = handler({ toolName: 'write', input: { path: 'C:/outside/x' } }, ctxFor('some-other-session'));
    assert.deepEqual(other, {}, '未登记会话不拦');
    gate.clearRun('employee_7_task_1_wi_1');
    assert.deepEqual(handler({ toolName: 'write', input: { path: 'C:/outside/x' } }, ctxFor('employee_7_task_1_wi_1')), {});
  } finally {
    db.close();
  }
});

test('F1 修复: 相对路径按 cwd/projectRoot 解析 —— 项目内（相对/./ /绝对）allow，项目外/.. deny（会话侧 + 引擎侧同一解析）', () => {
  const { db, run } = setup();
  try {
    const gate = new SessionToolGate({ db });
    const allowCases = ['src/a.ts', './src/a.ts', 'D:/repo/src/a.ts', 'D:\\repo\\src\\a.ts'];
    for (const path of allowCases) {
      const res = gate.evaluate({ toolName: 'write', input: { path } }, run);
      assert.deepEqual(res, {}, `项目内相对/绝对写法应放行：${path}（实际 ${JSON.stringify(res)}）`);
    }
    const denyCases = ['../outside/x.txt', 'D:/repo/../outside/x.txt', 'C:/outside/x.txt', 'D:/other/x.txt'];
    for (const path of denyCases) {
      const res = gate.evaluate({ toolName: 'write', input: { path } }, run);
      assert.equal(res.block, true, `项目外/穿越应拦：${path}`);
      assert.match(res.reason ?? '', /项目根|工作目录|拒绝/);
    }
    // 敏感路径仍拒（相对写法也不能绕）
    const sens = gate.evaluate({ toolName: 'read', input: { path: '.ssh/id_rsa' } }, run);
    assert.equal(sens.block, true, '相对写法的敏感路径仍拒');
    // 引擎侧同一解析（直接调 permissionGate + cwd）
    const engineSide = permissionGate({ name: 'write', args: { path: 'src/a.ts' } }, {
      capabilityTier: 'standard',
      autonomy: 'standard',
      riskLevel: 0,
      projectRoot: 'D:/repo',
      cwd: 'D:/repo',
    });
    assert.equal(engineSide.decision, 'allow', '引擎侧同样按 cwd 解析相对路径');
    // 返回值规范化（2983）：去掉 `./` 等，行为不变
    assert.equal(resolvePathArgument('./src/a.ts', { cwd: 'D:/repo', projectRoot: 'D:/repo' }), 'D:/repo/src/a.ts');
    assert.equal(resolvePathArgument('src/a.ts', { cwd: 'D:/repo', projectRoot: 'D:/repo' }), 'D:/repo/src/a.ts');
    assert.equal(resolvePathArgument('D:\\repo\\.\\src\\a.ts', { cwd: 'D:/repo', projectRoot: 'D:/repo' }), 'D:/repo/src/a.ts');
    assert.equal(resolvePathArgument('src/../a.ts', { cwd: 'D:/repo', projectRoot: 'D:/repo' }), 'D:/repo/a.ts');
  } finally {
    db.close();
  }
});

test('D-19: 频道助手项目上下文 —— 项目内可写、越界拒；无项目 sandbox 只读', () => {
  const { db } = setup();
  try {
    const projectId = Number((db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number }).id);
    const gate = new SessionToolGate({ db });
    const projectRun: RunGateContext = {
      employeeId: 0,
      taskId: null,
      projectId,
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
      capabilityTier: 'standard',
      autonomy: 'standard',
    };
    assert.deepEqual(
      gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/notes/a.md' } }, projectRun),
      {},
      '项目内写应放行',
    );
    const outside = gate.evaluate({ toolName: 'write', input: { path: 'D:/outside/a.md' } }, projectRun);
    assert.equal(outside.block, true, '项目外写必须拦');
    assert.match(outside.reason ?? '', /项目根|工作目录|拒绝/);

    const noProjectRun: RunGateContext = {
      employeeId: 0,
      taskId: null,
      projectId: null,
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
      capabilityTier: 'sandbox',
      autonomy: 'standard',
    };
    assert.equal(
      gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/notes/a.md' } }, noProjectRun).block,
      true,
      '无项目写必须拦（sandbox 只读）',
    );
    assert.deepEqual(
      gate.evaluate({ toolName: 'read', input: { path: 'D:/repo/README.md' } }, noProjectRun),
      {},
      '无项目仍可读',
    );
  } finally {
    db.close();
  }
});

test('G1 "有牙": 注入"永远放行"的 gate → 项目外写不再被拦（证明上面的拦截断言有意义）', () => {
  const { db, run } = setup();
  try {
    const gate = new SessionToolGate({ db, gate: () => ({ decision: 'allow', reason: 'always' }) });
    assert.deepEqual(gate.evaluate({ toolName: 'write', input: { path: 'C:/outside/x' } }, run), {});
    // 对照：真闸门会拦
    const real = new SessionToolGate({ db });
    assert.equal(real.evaluate({ toolName: 'write', input: { path: 'C:/outside/x' } }, run).block, true);
  } finally {
    db.close();
  }
});

// ── B2-7：员工会话 git 写子命令在会话闸门层被拦（employeeId>0 → employeeSession 注入）──

test('B2-7: 会话闸门集成 —— 员工会话 git commit 被拦且带宿主收口提示；助手会话不受影响', () => {
  const { db, run } = setup();
  try {
    const gate = new SessionToolGate({ db });
    const deny = gate.evaluate({ toolName: 'bash', input: { command: 'git commit -m "fix"' } }, run);
    assert.equal(deny.block, true, '员工会话 git commit 必须 block');
    assert.ok(deny.reason?.includes('宿主'), `提示要说清提交归宿主，实际：${deny.reason}`);
    // 只读 git 照常（standard 放行）。
    const read = gate.evaluate({ toolName: 'bash', input: { command: 'git log --oneline -5' } }, run);
    assert.notEqual(read.block, true, '员工会话只读 git 不拦');
    // 频道助手（employeeId=0）不走 B2-7（W1 口径不变）。
    const assistantRun: RunGateContext = { employeeId: 0, taskId: null, projectId: 1, cwd: 'D:/repo', capabilityTier: 'standard', autonomy: 'standard' };
    const a = gate.evaluate({ toolName: 'bash', input: { command: 'git status' } }, assistantRun);
    assert.notEqual(a.block, true, '助手只读 git 不拦');
  } finally {
    db.close();
  }
});
