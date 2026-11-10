/**
 *  P1 · 频道助手写权限（项目级 read-only/confirm/auto）+ 确认卡/grant/审计。
 *
 * 覆盖：
 *  - 模式解析（无项目只读、缺省 confirm、项目覆盖全局）；
 *  - 闸门三态（confirm=ask、auto=allow、read-only=deny；项目内 vs 越界）；
 *  - 会话级「本次允许」/项目级「本项目允许」grant 的作用域；
 *  - 无任务频道审批（approvals.task_id=null + 全局卡 + action_log 审计）；
 *  - 实际放行的写/命令落审计（读不落）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, getPermissionPolicy, setPermissionPolicy, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectAssistantWriteModeSet } from '../src/main/ipc/ipc.js';
import { answerApproval, insertApproval } from '../src/main/db/approvals.js';
import {
  applyApprovalAsGrant,
  formatChannelPermissionQuestion,
  issueChannelGrant,
  parseChannelPermissionQuestion,
} from '../src/main/permission/grants.js';
import { assistantGatePolicy, resolveAssistantWriteMode, setAssistantWriteMode } from '../src/main/permission/assistant-write.js';
import type { AssistantWriteMode } from '../src/main/permission/gate.js';
import { SessionToolGate, persistChannelGateDecision, recordChannelAllowAudit, type GateDecisionInfo, type RunGateContext } from '../src/main/agent/session-tool-gate.js';

function setup(): { db: SqliteDb; repo: ReturnType<typeof createSqliteChatRepo>; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: 'P', rootDir: 'D:/repo', accessMode: 'inplace', now: 1 });
  return { db, repo, projectId: project.id };
}

function runCtx(projectId: number, mode: AssistantWriteMode, sessionKey = 's1'): RunGateContext {
  return {
    employeeId: 0,
    taskId: null,
    projectId,
    cwd: 'D:/repo',
    projectRoot: 'D:/repo',
    ...assistantGatePolicy(mode),
    writeMode: mode,
    sessionKey,
  };
}

test('D-19 P1: 写模式解析 —— 无项目只读 / 缺省 confirm / 项目覆盖全局', () => {
  const { db, repo, projectId } = setup();
  try {
    assert.equal(resolveAssistantWriteMode(db, null), 'read-only', '无项目必须只读');
    assert.equal(resolveAssistantWriteMode(db, projectId), 'confirm', '未设项目/全局 → confirm');

    // 全局 auto 只影响未显式设置的项目。
    setPermissionPolicy(db, { scopeType: 'global', scopeId: 0, tier: 'standard', policy: { assistantWriteMode: 'auto' }, now: 10 });
    const other = repo.createProject({ name: 'P2', rootDir: 'D:/repo2', accessMode: 'inplace', now: 11 });
    assert.equal(resolveAssistantWriteMode(db, other.id), 'auto', '全局策略兜底');

    setAssistantWriteMode(db, projectId, 'confirm', 12);
    assert.equal(resolveAssistantWriteMode(db, projectId), 'confirm', '项目显式值覆盖全局');
    setAssistantWriteMode(db, projectId, 'auto', 13);
    assert.equal(resolveAssistantWriteMode(db, projectId), 'auto');
    setAssistantWriteMode(db, projectId, 'read-only', 14);
    assert.equal(resolveAssistantWriteMode(db, projectId), 'read-only');

    // 只写 assistantWriteMode，不把员工任务会话 tier 一并改掉。
    const row = getPermissionPolicy(db, 'project', projectId);
    assert.ok(row);
    assert.equal(row?.tier, 'standard');
    assert.match(row?.policy ?? '', /assistantWriteMode/);
  } finally {
    db.close();
  }
});

test('D-19 P1: 闸门三态 —— confirm=ask、auto=allow、read-only=deny；越界恒拒', () => {
  const { db, projectId } = setup();
  try {
    const gate = new SessionToolGate({ db });

    const confirm = gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'confirm'));
    assert.equal(confirm.block, true, 'confirm 模式项目内写应询问');
    assert.match(confirm.reason ?? '', /strict|批准/);

    const mkdir = gate.evaluate({ toolName: 'mkdir', input: { path: 'D:/repo/new-dir' } }, runCtx(projectId, 'confirm'));
    assert.equal(mkdir.block, true, '建目录必须与写文件同闸门');

    const auto = gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'auto'));
    assert.deepEqual(auto, {}, 'auto 模式项目内写应放行');
    assert.deepEqual(
      gate.evaluate({ toolName: 'mkdir', input: { path: 'D:/repo/new-dir' } }, runCtx(projectId, 'auto')),
      {},
      'auto 模式项目内建目录应放行',
    );

    const ro = gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'read-only'));
    assert.equal(ro.block, true, 'read-only 模式写应拒');
    assert.match(ro.reason ?? '', /能力档|capability/);
    assert.deepEqual(
      gate.evaluate({ toolName: 'read', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'read-only')),
      {},
      'read-only 仍可读',
    );

    const outside = gate.evaluate({ toolName: 'write', input: { path: 'D:/outside/a.md' } }, runCtx(projectId, 'auto'));
    assert.equal(outside.block, true, 'auto 也不能越界');
    assert.match(outside.reason ?? '', /项目根|工作目录|拒绝/);
  } finally {
    db.close();
  }
});

test('D-19 P1: grant 作用域 —— 会话级只放行本会话，项目级放行同项目所有会话', () => {
  const { db, projectId } = setup();
  try {
    const gate = new SessionToolGate({ db });
    issueChannelGrant(db, {
      projectId,
      rule: 'autonomy:strict',
      toolName: 'write',
      grantedBy: 'boss',
      now: 20,
      sessionKey: 's1',
    });
    assert.deepEqual(
      gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'confirm', 's1')),
      {},
      '本会话 grant 应放行',
    );
    assert.equal(
      gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'confirm', 's2')).block,
      true,
      '别的会话不得共享「本次允许」',
    );

    issueChannelGrant(db, {
      projectId,
      rule: 'autonomy:strict',
      toolName: 'write',
      grantedBy: 'boss',
      now: 21,
    });
    assert.deepEqual(
      gate.evaluate({ toolName: 'write', input: { path: 'D:/repo/a.md' } }, runCtx(projectId, 'confirm', 's2')),
      {},
      '项目级 grant 应放行同项目其它会话',
    );
    assert.equal(
      gate.evaluate(
        { toolName: 'write', input: { path: 'D:/repo/a.md' } },
        { ...runCtx(projectId, 'confirm', 's2'), employeeId: 7 },
      ).block,
      true,
      '频道项目级 grant 不得扩散到员工任务会话',
    );
  } finally {
    db.close();
  }
});

test('D-19 P1: 频道审批落库 —— task_id=null + 全局卡 + 审计；approve_once/approve_project 写对 grant', () => {
  const { db, repo, projectId } = setup();
  try {
    const decisions: GateDecisionInfo[] = [];
    const gate = new SessionToolGate({ db, onDecision: (d) => decisions.push(d) });
    const blocked = gate.evaluate(
      { toolName: 'write', input: { path: 'D:/repo/a.md' } },
      runCtx(projectId, 'confirm', 's1'),
    );
    assert.equal(blocked.block, true);
    assert.equal(decisions.length, 1);

    persistChannelGateDecision(db, decisions[0]!, 30);
    const approval = db
      .prepare('SELECT * FROM approvals WHERE task_id IS NULL ORDER BY id DESC LIMIT 1')
      .get() as { id: number; question: string; task_id: number | null } | undefined;
    assert.ok(approval, '频道 ask 必须有 approvals 行');
    assert.equal(approval?.task_id, null);
    assert.match(approval?.question ?? '', /^\[权限\] 频道写操作 /);
    const parsed = parseChannelPermissionQuestion(approval?.question ?? '');
    assert.deepEqual(parsed && { toolName: parsed.toolName, rule: parsed.rule, projectId: parsed.projectId, sessionKey: parsed.sessionKey }, {
      toolName: 'write',
      rule: 'autonomy:strict',
      projectId,
      sessionKey: 's1',
    });

    const report = db
      .prepare("SELECT * FROM reports WHERE task_id IS NULL AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    assert.ok(report, '频道 ask 必须出全局卡（无 task_id 也不能静默）');
    const auditCount = db
      .prepare("SELECT count(*) AS c FROM action_log WHERE kind = 'assistant_gate' AND state = 'done'")
      .get() as { c: number };
    assert.equal(auditCount.c, 1, 'ask 必须落审计且立即 done');

    // approve_once → 会话级 grant。
    answerApproval(db, { approvalId: approval!.id, chosen: 'approve_once', decidedBy: 'boss', now: 31 });
    const once = applyApprovalAsGrant(db, approval!.id, { now: 31, approvedBy: 'boss' });
    assert.equal(once.applied, true);
    assert.equal(once.grant?.sessionKey, 's1');
    assert.equal(once.grant?.projectId, projectId);

    // 真实 UI/卡片入口走 repo.answerApproval —— 同样必须发 grant（不只直接调 grants 函数）。
    const viaRepo = insertApproval(db, {
      taskId: null,
      question: formatChannelPermissionQuestion('write', 'autonomy:strict', projectId, 's-ui'),
      options: [{ key: 'approve_once' }, { key: 'approve_project' }, { key: 'deny' }],
      defaultAction: null,
      timeoutAt: null,
    });
    repo.answerApproval({ approvalId: viaRepo.id, chosen: 'approve_once', decidedBy: 'boss', now: 34 });
    const repoPolicy = getPermissionPolicy(db, 'project', projectId);
    const repoGrants = (JSON.parse(repoPolicy?.policy ?? '{}') as { grants?: Array<{ sessionKey?: string }> }).grants ?? [];
    assert.ok(repoGrants.some((g) => g.sessionKey === 's-ui'), 'repo.answerApproval 必须落会话级 grant');

    // approve_project → 项目级 grant（无 sessionKey）。
    const projectApproval = insertApproval(db, {
      taskId: null,
      question: formatChannelPermissionQuestion('edit', 'autonomy:strict', projectId, 's1'),
      options: [{ key: 'approve_once' }, { key: 'approve_project' }, { key: 'deny' }],
      defaultAction: null,
      timeoutAt: null,
    });
    answerApproval(db, { approvalId: projectApproval.id, chosen: 'approve_project', decidedBy: 'boss', now: 32 });
    const projectGrant = applyApprovalAsGrant(db, projectApproval.id, { now: 32, approvedBy: 'boss' });
    assert.equal(projectGrant.applied, true);
    assert.equal(projectGrant.grant?.sessionKey, undefined);
    assert.equal(projectGrant.grant?.projectId, projectId);

    // deny 不写 grant。
    const denied = insertApproval(db, {
      taskId: null,
      question: formatChannelPermissionQuestion('bash', 'autonomy:strict', projectId, 's1'),
      options: [{ key: 'approve_once' }, { key: 'approve_project' }, { key: 'deny' }],
      defaultAction: null,
      timeoutAt: null,
    });
    answerApproval(db, { approvalId: denied.id, chosen: 'deny', decidedBy: 'boss', now: 33 });
    assert.equal(applyApprovalAsGrant(db, denied.id, { now: 33 }).applied, false);
  } finally {
    db.close();
  }
});

test('D-19 P1: 放行审计 —— 写/命令落 action_log，读不落', () => {
  const { db, projectId } = setup();
  try {
    const before = (db.prepare('SELECT count(*) AS c FROM action_log').get() as { c: number }).c;
    const run = runCtx(projectId, 'auto', 's1');
    recordChannelAllowAudit(
      db,
      { decision: 'allow', reason: 'ok', rule: 'autonomy:standard', toolName: 'write', run, sessionId: 'x' },
      40,
    );
    recordChannelAllowAudit(
      db,
      { decision: 'allow', reason: 'ok', rule: 'readonly', toolName: 'read', run, sessionId: 'x' },
      41,
    );
    const after = (db.prepare('SELECT count(*) AS c FROM action_log').get() as { c: number }).c;
    assert.equal(after, before + 1, '只审计写类放行');
    const row = db.prepare("SELECT state, payload FROM action_log WHERE kind = 'assistant_gate' ORDER BY id DESC LIMIT 1").get() as {
      state: string;
      payload: string;
    };
    assert.equal(row.state, 'done');
    assert.match(row.payload, /"decision":"allow"/);
    assert.match(row.payload, /"writeMode":"auto"/);
  } finally {
    db.close();
  }
});

test('D-19 P1: project:assistant-write-mode-set —— 合法写入/非法拒绝/项目不存在', () => {
  const { db, repo, projectId } = setup();
  try {
    const ok = handleProjectAssistantWriteModeSet({ repo }, { projectId, mode: 'auto' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.project.assistantWriteMode, 'auto');
    assert.equal(resolveAssistantWriteMode(db, projectId), 'auto');

    const bad = handleProjectAssistantWriteModeSet({ repo }, { projectId, mode: 'full' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, 'bad_request');

    const missing = handleProjectAssistantWriteModeSet({ repo }, { projectId: 9999, mode: 'auto' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'not_found');
  } finally {
    db.close();
  }
});
