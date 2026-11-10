/**
 * G1 余项：`approvals → grants` 转换回路（批准一次 ask → 下次同规则放行；幂等；最小范围）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  answerApproval,
  getApproval,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SessionToolGate, persistSessionGateDecision, type GateDecisionInfo, type RunGateContext } from '../src/main/agent/session-tool-gate.js';
import { insertApproval } from '../src/main/db/approvals.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { applyApprovalAsGrant, issueGrant, parsePermissionQuestion } from '../src/main/permission/grants.js';

function setup(tier = 'standard'): { db: SqliteDb; taskId: number; wiId: number; run: RunGateContext } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev',?,1)").run(tier);
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id, run: { employeeId: 7, taskId: task.id, workItemId: wi.id, cwd: 'D:/repo' } };
}

function gateWith(db: SqliteDb): { gate: SessionToolGate; decisions: GateDecisionInfo[] } {
  const decisions: GateDecisionInfo[] = [];
  const gate = new SessionToolGate({
    db,
    onDecision: (d) => {
      decisions.push(d);
      // 复刻工厂缺省写入者：ask → approvals 行（问题里含规则）；deny → permission_decision。
      persistSessionGateDecision(db, d);
    },
  });
  return { gate, decisions };
}

test('G1 余项: ask → approvals 行（问题可解析：工具 + 规则）；未批 → 再 ask', () => {
  const { db, taskId, run } = setup();
  try {
    const { gate } = gateWith(db);
    const first = gate.evaluate({ toolName: 'publish', input: {} }, run);
    assert.equal(first.block, true, '未批 → 拦');
    const row = getApproval(db, 1);
    assert.ok(row, '必须落 approvals 行');
    assert.equal(row!.chosen, null, '未批时 chosen 为空（无默认动作）');
    const parsed = parsePermissionQuestion(row!.question);
    assert.deepEqual(parsed, { toolName: 'publish', rule: 'consent:external' });
    // 未批 → 再次调用仍 ask
    assert.equal(gate.evaluate({ toolName: 'publish', input: {} }, run).block, true);
    void taskId;
  } finally {
    db.close();
  }
});

test('G1 余项: 批准 → 发 grant → 同规则下次放行；重复批幂等', () => {
  const { db, run } = setup();
  try {
    const { gate } = gateWith(db);
    gate.evaluate({ toolName: 'publish', input: {} }, run); // 落 approvals 行
    answerApproval(db, { approvalId: 1, chosen: 'approve', decidedBy: 'boss', now: 100 });

    const applied = applyApprovalAsGrant(db, 1, { now: 101, approvedBy: 'boss' });
    assert.equal(applied.applied, true);
    assert.match(applied.reason, /^granted/); // 无会话 → granted(task_fallback)
    assert.deepEqual(applied.grant, { rule: 'consent:external', toolName: 'publish', taskId: run.taskId });

    // 给了 grant → 放行
    assert.deepEqual(gate.evaluate({ toolName: 'publish', input: {} }, run), {});
    // 幂等：重复批不重复发
    const again = applyApprovalAsGrant(db, 1, { now: 102 });
    assert.equal(again.reason, 'already_present');
    const policy = JSON.parse((db.prepare("SELECT policy FROM permission_policies WHERE scope_type='task' AND scope_id=?").get(run.taskId) as { policy: string }).policy) as { grants: unknown[] };
    assert.equal(policy.grants.length, 1, '同 (rule,toolName,scope) 只留一条');
    // 变更只影响该规则：另一规则仍 ask
    assert.equal(gate.evaluate({ toolName: 'install', input: {} }, run).block, true);
  } finally {
    db.close();
  }
});

test('G1 余项: deny / 非权限审批 / 无任务上下文 → 不发 grant（如实给原因）', () => {
  const { db, run } = setup('trusted'); // install 需 trusted（否则是能力档 deny，不产生 ask/approvals 行）
  try {
    const { gate } = gateWith(db);
    gate.evaluate({ toolName: 'install', input: {} }, run);
    answerApproval(db, { approvalId: 1, chosen: 'deny', decidedBy: 'boss', now: 100 });
    const denied = applyApprovalAsGrant(db, 1, { now: 101 });
    assert.equal(denied.applied, false);
    assert.match(denied.reason, /chosen=deny/);
    // 仍 ask
    assert.equal(gate.evaluate({ toolName: 'install', input: {} }, run).block, true);
    // 非权限审批（用 DAO 拿真实 id，不硬编码）
    const plain = insertApproval(db, { taskId: run.taskId, question: '普通问题', options: [] });
    assert.equal(applyApprovalAsGrant(db, plain.id, { now: 1 }).reason, 'not_permission_approval');
    // 不存在
    assert.equal(applyApprovalAsGrant(db, 999, { now: 1 }).reason, 'not_found');
  } finally {
    db.close();
  }
});

test('G1 余项: 覆盖 spend / install / consent:command 三类 ask 的 grant 放行', () => {
  const { db, taskId, run } = setup('trusted'); // install 需 trusted 能力档（否则是能力档层 deny，不是 ask）
  try {
    // 命令 consent 规则
    db.prepare("INSERT INTO permission_policies(scope_type,scope_id,tier,policy,updated_at) VALUES('task',?, 'standard', ?, 1)")
      // 用**非外发**命令测 consent:command 族（外发族由单独归到 consent:egress）。
      .run(taskId, JSON.stringify({ consentRules: ['npm run build'] }));
    const { gate } = gateWith(db);
    const cases: Array<[string, { toolName: string; input?: Record<string, unknown> }, string]> = [
      ['spend', { toolName: 'purchase', input: {} }, 'consent:spend'],
      ['install', { toolName: 'install', input: {} }, 'consent:install'],
      ['command', { toolName: 'bash', input: { command: 'npm run build' } }, 'consent:command'],
    ];
    for (const [label, event, rule] of cases) {
      assert.equal(gate.evaluate(event, run).block, true, `${label}: 未批应拦`);
      issueGrant(db, { taskId, rule, toolName: event.toolName, grantedBy: 'boss', now: 200 });
      assert.deepEqual(gate.evaluate(event, run), {}, `${label}: 批后应放行`);
    }
    // 留痕：ask 的事件已落库（permission_requested）
    assert.ok(listTaskEvents(db, taskId).some((e) => e.kind === 'permission_requested'));
  } finally {
    db.close();
  }
});

test('G1 余项 "有牙": 去掉 grant → 必须再 ask；恢复 grant → 必须放行', () => {
  const { db, taskId, run } = setup();
  try {
    const { gate } = gateWith(db);
    issueGrant(db, { taskId, rule: 'consent:external', toolName: 'publish', grantedBy: 'boss', now: 1 });
    assert.deepEqual(gate.evaluate({ toolName: 'publish', input: {} }, run), {}, '有 grant → 放行');
    // 模拟“grant 被删/未发” → 必须回到 ask
    db.prepare("UPDATE permission_policies SET policy='{}' WHERE scope_type='task' AND scope_id=?").run(taskId);
    assert.equal(gate.evaluate({ toolName: 'publish', input: {} }, run).block, true, '无 grant → 必须再 ask');
  } finally {
    db.close();
  }
});

test('G1 余项(sessionKey): 会话级 grant 不溢出到同任务的其他会话；无 sessionKey 时回落任务级（并标记）', () => {
  const { db, taskId, run } = setup();
  try {
    const { gate } = gateWith(db);
    const runA: RunGateContext = { ...run, sessionKey: 'employee_7_task_1_wi_1' };
    const runB: RunGateContext = { ...run, sessionKey: 'employee_7_task_1_wi_2' };
    // 会话 A 的 ask → 批准 → 会话级 grant
    gate.evaluate({ toolName: 'publish', input: {} }, runA);
    answerApproval(db, { approvalId: 1, chosen: 'approve', decidedBy: 'boss', now: 100 });
    const applied = applyApprovalAsGrant(db, 1, { now: 101, approvedBy: 'boss' });
    assert.equal(applied.reason, 'granted');
    assert.equal(applied.grant?.sessionKey, 'employee_7_task_1_wi_1');
    // A：放行；B（同任务、不同会话）：仍 ask（不溢出）
    assert.deepEqual(gate.evaluate({ toolName: 'publish', input: {} }, runA), {});
    assert.equal(gate.evaluate({ toolName: 'publish', input: {} }, runB).block, true, '会话级 grant 不得溢出到其他会话');
    // 任务级回落：问题里无 sessionKey（`[-]`）→ 任务级 grant，适用于任意会话，且 reason 标明回落
    const stray = insertApproval(db, { taskId, question: '[权限] 会话工具 publish（consent:external）[-]', options: [{ key: 'approve' }, { key: 'deny' }] });
    answerApproval(db, { approvalId: stray.id, chosen: 'approve', decidedBy: 'boss', now: 200 });
    const fb = applyApprovalAsGrant(db, stray.id, { now: 201 });
    assert.equal(fb.reason, 'granted(task_fallback)', '无会话时回落任务级并标明');
    assert.equal(fb.grant?.sessionKey, undefined);
    assert.deepEqual(gate.evaluate({ toolName: 'publish', input: {} }, runB), {}, '任务级 grant 对所有会话生效');
  } finally {
    db.close();
  }
});

test('G1 余项(sessionKey): persistSessionGateDecision 把会话写进 question（供回落/隔离解析）', () => {
  const { db, run } = setup();
  try {
    persistSessionGateDecision(db, {
      decision: 'ask',
      reason: 'x',
      rule: 'consent:external',
      toolName: 'publish',
      run: { ...run, sessionKey: 'employee_7_task_1_wi_1' },
      sessionId: 'employee_7_task_1_wi_1',
    });
    const row = getApproval(db, 1);
    assert.deepEqual(parsePermissionQuestion(row!.question), {
      toolName: 'publish',
      rule: 'consent:external',
      sessionKey: 'employee_7_task_1_wi_1',
    });
  } finally {
    db.close();
  }
});

test('G1 余项接线(C1 修复): 共用入口 repo.answerApproval(approve) 发 grant → 会话门下次放行（覆盖 task:approve / inbox:answer）', () => {
  const { db, taskId, run } = setup();
  try {
    const repo = createSqliteChatRepo(db);
    const { gate } = gateWith(db);
    // 先制造一次 ask（落 approvals 行）
    assert.equal(gate.evaluate({ toolName: 'publish', input: {} }, run).block, true);
    const appr = getApproval(db, 1);
    // 共用入口批准（task:approve / inbox:answer 都走它）
    repo.answerApproval({ approvalId: appr!.id, chosen: 'approve', decidedBy: 'boss', now: 100 });
    assert.deepEqual(gate.evaluate({ toolName: 'publish', input: {} }, run), {}, '共用入口批准后应放行');
    // 幂等：重复批仍只一条 grant
    repo.answerApproval({ approvalId: appr!.id, chosen: 'approve', decidedBy: 'boss', now: 101 });
    const policy = JSON.parse(
      (db.prepare("SELECT policy FROM permission_policies WHERE scope_type='task' AND scope_id=?").get(taskId) as { policy: string }).policy,
    ) as { grants: unknown[] };
    assert.equal(policy.grants.length, 1, '重复批准幂等');
    // 反例：不批准（deny）→ 仍 ask
    assert.equal(gate.evaluate({ toolName: 'install', input: {} }, { ...run, employeeId: 7 }).block, true, '未批准的另一规则仍 ask');
  } finally {
    db.close();
  }
});

test('G1 余项接线(C1): deny 不经共用入口发 grant（仍 ask）', () => {
  const { db, taskId, run } = setup('trusted');
  try {
    const repo = createSqliteChatRepo(db);
    const { gate } = gateWith(db);
    assert.equal(gate.evaluate({ toolName: 'install', input: {} }, run).block, true);
    const appr = getApproval(db, 1);
    repo.answerApproval({ approvalId: appr!.id, chosen: 'deny', decidedBy: 'boss', now: 100 });
    assert.equal(gate.evaluate({ toolName: 'install', input: {} }, run).block, true, 'deny 不得发 grant');
    const rows = db.prepare("SELECT COUNT(*) n FROM permission_policies WHERE scope_type='task' AND scope_id=?").get(taskId) as { n: number };
    assert.equal(rows.n, 0, 'deny 不得写任何策略');
  } finally {
    db.close();
  }
});

test('G1 余项: persistSessionGateDecision 会把规则写进 question（供转换回路解析）', () => {
  const { db, run } = setup();
  try {
    persistSessionGateDecision(db, {
      decision: 'ask',
      reason: 'x',
      rule: 'consent:install',
      toolName: 'install',
      run,
      sessionId: 's',
    });
    const row = getApproval(db, 1);
    assert.deepEqual(parsePermissionQuestion(row!.question), { toolName: 'install', rule: 'consent:install' });
  } finally {
    db.close();
  }
});
