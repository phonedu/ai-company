/**
 * OPT-M9-1 · 权限闸门（`permissionGate`）与 `permission_policies` DAO 验收。
 * 每条都能被弄红（改 tier/autonomy/policy 即变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, getPermissionPolicy, resolvePermissionPolicy, setPermissionPolicy, getAction, listTaskEvents, createTask, SqliteCounterStore } from '../src/main/db/index.js';
import { registerPendingAction } from '../src/main/db/action_log.js';
import { executePendingActions } from '../src/main/engine/index.js';
import { permissionGate, toolCategory, downgradeAutonomy, type GateContext } from '../src/main/permission/index.js';

const base: GateContext = {
  capabilityTier: 'standard',
  autonomy: 'standard',
  riskLevel: 1,
  projectRoot: 'D:/repo',
  cwd: 'D:/repo',
};

test('OPT-M9-1: 工具分类 + 能力档（sandbox 只读；install 需 trusted）', () => {
  assert.equal(toolCategory('read'), 'read');
  assert.equal(toolCategory('bash'), 'command');
  assert.equal(toolCategory('git_push'), 'external');
  assert.equal(toolCategory('pnpm_add'), 'install');

  const sandbox: GateContext = { ...base, capabilityTier: 'sandbox' };
  assert.equal(permissionGate({ name: 'read', args: { path: 'D:/repo/a.ts' } }, sandbox).decision, 'allow');
  assert.equal(permissionGate({ name: 'write', args: { path: 'D:/repo/a.ts' } }, sandbox).decision, 'deny', 'sandbox 不得写');
  assert.equal(permissionGate({ name: 'bash', args: { cmd: 'ls' } }, sandbox).decision, 'deny');
  assert.equal(permissionGate({ name: 'install', args: {} }, { ...base, capabilityTier: 'standard' }).decision, 'deny', 'standard 无 install 能力');
  assert.equal(permissionGate({ name: 'install', args: {} }, { ...base, capabilityTier: 'trusted' }).decision, 'ask', 'install 永远要批');
});

test('OPT-M9-1: 对外动作/花钱 —— 任何放行档都不自动放行（一律 ask）', () => {
  for (const autonomy of ['strict', 'standard', 'loose'] as const) {
    assert.equal(permissionGate({ name: 'web', args: {} }, { ...base, autonomy }).decision, 'ask', `web under ${autonomy}`);
    assert.equal(permissionGate({ name: 'spend', args: {} }, { ...base, autonomy }).decision, 'ask');
  }
});

test('OPT-M9-1: 路径层 —— 项目外拒绝、敏感路径拒绝、`..` 穿越拒绝', () => {
  assert.equal(permissionGate({ name: 'read', args: { path: 'D:/repo/src/a.ts' } }, base).decision, 'allow');
  assert.equal(permissionGate({ name: 'read', args: { path: 'D:/other/a.ts' } }, base).decision, 'deny');
  assert.equal(permissionGate({ name: 'read', args: { path: 'D:/repo/../secret.txt' } }, base).decision, 'deny');
  assert.equal(permissionGate({ name: 'read', args: { path: 'C:/Users/x/.ssh/id_rsa' } }, base).decision, 'deny');
});

test('OPT-M9-1: 放行档 —— strict 写也需批；standard/loose 本地放行', () => {
  const write = { name: 'write', args: { path: 'D:/repo/a.ts' } };
  assert.equal(permissionGate(write, { ...base, autonomy: 'strict' }).decision, 'ask');
  assert.equal(permissionGate(write, { ...base, autonomy: 'standard' }).decision, 'allow');
  assert.equal(permissionGate(write, { ...base, autonomy: 'loose' }).decision, 'allow');
});

test('OPT-M9-1: L2 自动收紧一档（loose→standard→strict）', () => {
  assert.equal(downgradeAutonomy('loose', 2), 'standard');
  assert.equal(downgradeAutonomy('standard', 2), 'strict');
  assert.equal(downgradeAutonomy('loose', 1), 'loose');
  // MP1-F19：`echo hi` 属只读白名单（任何放行档都走快速通道），L2 收紧改用非只读命令作例子——
  // 收紧意图不变：对**可能写/执行**的命令，L2 仍把 standard 收到 strict（逐次批）。
  const cmd = { name: 'bash', args: { cmd: 'node -e "1"' } };
  assert.equal(permissionGate(cmd, { ...base, autonomy: 'standard', riskLevel: 2 }).decision, 'ask', 'L2 把 standard 收紧到 strict');
  assert.equal(permissionGate(cmd, { ...base, autonomy: 'standard', riskLevel: 1 }).decision, 'allow');
});

test('OPT-M9-1: 命令黑名单 deny；consentRules ask；grant 放行对外', () => {
  const ctx: GateContext = {
    ...base,
    policy: { commandDenylist: ['rm\\s+-rf'], consentRules: ['git\\s+push'], grants: [{ rule: 'external', scope: 'task' }] },
  };
  assert.equal(permissionGate({ name: 'bash', args: { cmd: 'rm -rf /' } }, ctx).decision, 'deny');
  assert.equal(permissionGate({ name: 'bash', args: { cmd: 'git push origin main' } }, ctx).decision, 'ask');
  assert.equal(permissionGate({ name: 'bash', args: { cmd: 'ls' } }, ctx).decision, 'allow');
  assert.equal(permissionGate({ name: 'web', args: {} }, ctx).decision, 'allow', 'grant external → 放行');
});

test('OPT-M9-1: permission_policies DAO —— 三级覆盖（global←project←task）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    assert.deepEqual(resolvePermissionPolicy(db), { tier: 'standard', policy: {} }, '默认 standard');
    setPermissionPolicy(db, { scopeType: 'global', scopeId: 0, tier: 'loose', policy: { pathAllow: ['D:/shared'] }, now: 1 });
    setPermissionPolicy(db, { scopeType: 'project', scopeId: 7, tier: 'strict', policy: { commandDenylist: ['x'] }, now: 2 });
    const effective = resolvePermissionPolicy(db, { projectId: 7 });
    assert.equal(effective.tier, 'strict', 'project 覆盖 global');
    assert.deepEqual(effective.policy.pathAllow, ['D:/shared'], 'global 的 policy 仍保留');
    assert.deepEqual(effective.policy.commandDenylist, ['x']);
    assert.equal(getPermissionPolicy(db, 'project', 7)?.tier, 'strict');
  } finally {
    db.close();
  }
});

test('OPT-M9-1: 引擎动作执行前过闸门（deny→failed+审计；ask→留 pending+审计）', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
    );
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 't', goal: 'g' }).id;
    const neverRun = { execute: () => { throw new Error('执行器不应被调用'); } };

    registerPendingAction(db, { actionKey: 'dispatch:work_item:1:0', kind: 'dispatch', taskId, now: 1 });
    const deny = await executePendingActions(db, neverRun, 2, () => ({ decision: 'deny', reason: 'nope', rule: 'test' }));
    assert.deepEqual(deny.failed.map((f) => f.actionKey), ['dispatch:work_item:1:0']);
    assert.equal(getAction(db, 'dispatch:work_item:1:0')?.state, 'failed');
    assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'permission_decision'));

    registerPendingAction(db, { actionKey: 'dispatch:work_item:2:0', kind: 'dispatch', taskId, now: 1 });
    await executePendingActions(db, neverRun, 3, () => ({ decision: 'ask', reason: 'need approval' }));
    assert.equal(getAction(db, 'dispatch:work_item:2:0')?.state, 'pending', 'ask 应留 pending 等批准');
    assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'permission_requested'));
    const appr = db.prepare('SELECT question FROM approvals').all() as { question: string }[];
    assert.equal(appr.length, 1, 'ask 应复用 approvals 生成一条权限审批');
    assert.ok(appr[0]!.question.startsWith('[权限] '), 'question 带权限前缀');

    // allow → 正常执行并 done
    registerPendingAction(db, { actionKey: 'dispatch:work_item:3:0', kind: 'dispatch', taskId, now: 1 });
    const ran: string[] = [];
    const allow = await executePendingActions(db, { execute: (a) => void ran.push(a.actionKey) }, 4, () => ({ decision: 'allow', reason: 'ok' }));
    assert.deepEqual([...allow.executed].sort(), ['dispatch:work_item:2:0', 'dispatch:work_item:3:0'], 'ask 留的 pending 在放行后被重放');
    assert.ok(ran.includes('dispatch:work_item:3:0'));
    assert.equal(getAction(db, 'dispatch:work_item:2:0')?.state, 'done', 'ask → 批准后执行并 done');
  } finally {
    db.close();
  }
});

test('MP1-F15 补丁：ask 挂起动作重复 drain 不重复写 permission_requested（每秒排水下防事件写放大）', async () => {
  const db = openMemoryDatabase();
  try {
    runMigrations(db);
    const projectId = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/r',?)").run(1).lastInsertRowid);
    db.prepare("INSERT INTO employees(id,name,role,is_assistant,active,created_at) VALUES(0,'幕僚长','assistant',1,1,?)").run(1);
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 0, now: 1 });
    registerPendingAction(db, {
      actionKey: `dispatch_planning:task:${task.id}:0`,
      kind: 'dispatch_planning',
      taskId: task.id,
      payload: '{}',
      now: 1,
    });
    const gate = (): { decision: 'ask'; reason: string; rule: string } => ({ decision: 'ask', reason: '需批准', rule: 'r1' });
    const noopExecutor = { execute: async (): Promise<void> => undefined };
    // MP1-F15 后 tick 每秒都会排水挂起动作——同一条 ask 连续三次 drain
    for (const now of [1000, 2000, 3000]) {
      await executePendingActions(db, noopExecutor, now, gate, undefined, undefined);
    }
    const events = db.prepare("SELECT COUNT(*) c FROM task_events WHERE kind = 'permission_requested'").get() as { c: number };
    assert.equal(events.c, 1, `三次 drain 只应留一条 permission_requested（实际 ${events.c}）`);
    const approvals = db.prepare('SELECT COUNT(*) c FROM approvals').get() as { c: number };
    assert.equal(approvals.c, 1, '审批行也只一条（BRK10 既有幂等）');
  } finally {
    db.close();
  }
});
