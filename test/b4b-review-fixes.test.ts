/**
 * B4b 审查修复批（2026-11-09；四方向独立审查后）：
 *  - 安全 F1：审批卡带入参摘要（脱敏）——花钱/对外不再盲批；
 *  - 安全 F2：spend grant 用后即焚——「批准一次」＝真一次（external grant 仍会话内有效）；
 *  - 安全 F4/F5：export_format 经 junction 越根/敏感目标拒；派生输出已存在拒覆盖；
 *  - 安全 F11：`![alt](url)` 出 <img>（不安全协议降级为 alt 文本）；
 *  - 接线 F1：write_note 项目根取会话 cwd（不再取「全局最近 task_started」）；
 *  - 接线 F2：touched-path 采集认领内容工具产出；
 *  - 现状锁：缺 toolName 的旧 grant 仍兼容（收窄待 D-xx 裁决，不在本批改）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations, getApproval, type SqliteDb } from '../src/main/db/index.js';
import { SessionToolGate, persistSessionGateDecision, toolInputSummary, type RunGateContext } from '../src/main/agent/session-tool-gate.js';
import { consumeSpendGrant, issueGrant } from '../src/main/permission/grants.js';
import { getPermissionPolicy } from '../src/main/db/permission.js';
import { permissionGate } from '../src/main/permission/gate.js';
import { createExportFormatTool } from '../src/main/agent/tools/content-tools.js';
import { convertFormat, exportToFile } from '../src/main/agent/tools/export-format-tool.js';
import { createWriteNoteTool } from '../src/main/agent/write-note-tool.js';
import { extractTouchedPathsFromTool } from '../src/main/agent/touched-path-recorder.js';

type Out = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Exec<P> = { execute(id: string, params: P, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<Out> };

function setup(): { db: SqliteDb; taskId: number; run: RunGateContext } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','自媒体运营','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, run: { employeeId: 7, taskId: task.id, workItemId: wi.id, cwd: 'D:/repo', sessionKey: 'sk-e7' } };
}

test('安全 F2：spend grant 用后即焚——批准后放行一次，同会话第二次重新弹卡', () => {
  const { db, taskId, run } = setup();
  try {
    const gate = new SessionToolGate({ db, onDecision: (d) => persistSessionGateDecision(db, d) });
    const call = { toolName: 'image_generate', input: { prompt: 'cover' } };
    assert.equal(gate.evaluate(call, run).block, true, '未批 → 拦');
    issueGrant(db, { taskId, rule: 'consent:spend', toolName: 'image_generate', grantedBy: 'boss', now: 2, sessionKey: 'sk-e7' });
    assert.deepEqual(gate.evaluate(call, run), {}, '批准后第一次放行');
    const grants = JSON.parse(getPermissionPolicy(db, 'task', taskId)!.policy).grants ?? [];
    assert.equal(grants.filter((g: { rule: string }) => g.rule === 'consent:spend').length, 0, '放行即消费');
    assert.equal(gate.evaluate(call, run).block, true, '第二次重新弹卡（批准一次＝真一次）');
  } finally {
    db.close();
  }
});

test('复验 N1：前次审批已作答后，第二次 ask 出**新卡**；待批期间仍只一张', () => {
  const { db, taskId, run } = setup();
  try {
    const gate = new SessionToolGate({ db, onDecision: (d) => persistSessionGateDecision(db, d) });
    const call = { toolName: 'image_generate', input: { prompt: 'cover' } };
    gate.evaluate(call, run); // ask #1 → 卡 1
    const askCards = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM reports WHERE kind='ask' AND payload LIKE '%权限请求：image_generate%'").get() as { n: number }).n;
    assert.equal(askCards(), 1);
    // 老板拒绝（卡 1 resolved）
    db.prepare("UPDATE approvals SET chosen='deny', decided_by='boss', decided_at=10 WHERE id=1").run();
    gate.evaluate(call, run); // ask #2
    assert.equal(askCards(), 2, '旧卡 resolved 后新询问必须出新卡（去重键不得吞）');
    // 待批期间再次询问：仍只 2 张（固定键去重生效）
    gate.evaluate(call, run);
    assert.equal(askCards(), 2, '同问待批期间不重复出卡');
    // 两张卡都能各自回挂审批行
    const linked = (db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE report_id IS NOT NULL').get() as { n: number }).n;
    assert.equal(linked >= 2, true);
  } finally {
    db.close();
  }
});

test('安全 F2：任务级（无 sessionKey）spend grant 同样被消费；external grant 不消费', () => {
  const { db, taskId, run } = setup();
  try {
    issueGrant(db, { taskId, rule: 'consent:spend', toolName: 'image_generate', grantedBy: 'boss', now: 2 });
    issueGrant(db, { taskId, rule: 'consent:external', toolName: 'web_fetch', grantedBy: 'boss', now: 2 });
    const gate = new SessionToolGate({ db, onDecision: (d) => persistSessionGateDecision(db, d) });
    assert.deepEqual(gate.evaluate({ toolName: 'image_generate', input: {} }, run), {});
    assert.equal(gate.evaluate({ toolName: 'image_generate', input: {} }, run).block, true, '任务级 spend grant 也只用一次');
    assert.deepEqual(gate.evaluate({ toolName: 'web_fetch', input: { url: 'https://a.com' } }, run), {});
    assert.deepEqual(gate.evaluate({ toolName: 'web_fetch', input: { url: 'https://b.com' } }, run), {}, 'external 仍会话内有效');
    assert.equal(consumeSpendGrant(db, taskId, 'image_generate', 'sk-e7'), false, '无匹配时幂等 false');
  } finally {
    db.close();
  }
});

test('安全 F1：审批卡与事件带入参摘要（prompt 可见、Key 脱敏）', () => {
  const { db, run } = setup();
  try {
    const gate = new SessionToolGate({ db, onDecision: (d) => persistSessionGateDecision(db, d) });
    gate.evaluate({ toolName: 'image_generate', input: { prompt: '温暖插画风封面 sk-proj-abcdef123456', size: '1792x1024' } }, run);
    const report = db.prepare("SELECT payload FROM reports WHERE kind='ask' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    const detail = JSON.parse(report.payload).permissionDetail as { params: string };
    assert.match(detail.params, /prompt=温暖插画风封面/, '卡面看得到要发出去的 prompt');
    assert.match(detail.params, /size=1792x1024/);
    assert.ok(!/abcdef123456/.test(detail.params), 'Key 片段已脱敏');
    const ev = db.prepare("SELECT payload FROM task_events WHERE kind='permission_requested' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    assert.match(JSON.parse(ev.payload).params, /prompt=温暖插画风封面/, '审计事件同带摘要');
    assert.ok(getApproval(db, 1), '审批行照常落（问题格式未动）');
  } finally {
    db.close();
  }
});

test('安全 F1：toolInputSummary——只平铺文本参数、超长截断、空参数明说', () => {
  assert.equal(toolInputSummary({ url: 'https://a.com', n: 2, deep: { x: 1 } }), 'url=https://a.com；n=2');
  assert.equal(toolInputSummary(undefined), '（无文本参数）');
  const long = toolInputSummary({ prompt: 'x'.repeat(500) }, 300);
  assert.ok(long.length < 320 && long.endsWith('…（截断）'));
});

test('现状锁：缺 toolName 的旧 grant 仍兼容放行（收窄须 D-xx 裁决，本批不改）', () => {
  const ctx = { capabilityTier: 'standard' as const, autonomy: 'standard' as const, riskLevel: 0, projectRoot: 'D:/repo',
    policy: { grants: [{ rule: 'consent:external', scope: 'task' as const }] } };
  assert.equal(permissionGate({ name: 'web_fetch' }, ctx).decision, 'allow');
});

test('安全 F4：export_format 经 junction 越根被拒，项目外不落导出件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b4b-junc-'));
  const proj = join(root, 'proj');
  const outside = join(root, 'outside');
  mkdirSync(join(proj, 'docs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'), '# 项目外机密\n', 'utf8');
  try {
    symlinkSync(outside, join(proj, 'docs', 'linkdir'), 'junction');
    const tool = (await createExportFormatTool(proj)) as unknown as Exec<{ path: string; format: string }>;
    const out = await tool.execute('tc', { path: 'docs/linkdir/secret.md', format: 'markdown' }, undefined, undefined, { cwd: proj });
    assert.equal(out.details?.['outcome'], 'error');
    assert.match(out.content[0]!.text, /越出项目目录/);
    assert.deepEqual(readdirSync(outside), ['secret.md'], '项目外目录未被写入导出件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('安全 F4：项目内敏感真身（.env 类）拒导出', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'b4b-sens-'));
  try {
    mkdirSync(join(proj, '.envdocs'), { recursive: true });
    writeFileSync(join(proj, '.envdocs', 'a.md'), 'K=V', 'utf8');
    const tool = (await createExportFormatTool(proj)) as unknown as Exec<{ path: string; format: string }>;
    const out = await tool.execute('tc', { path: '.envdocs/a.md', format: 'plain_text' }, undefined, undefined, { cwd: proj });
    assert.equal(out.details?.['outcome'], 'error');
    assert.match(out.content[0]!.text, /敏感文件/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('安全 F5：派生输出已存在 → 拒绝覆盖，原文件不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b4b-ow-'));
  try {
    writeFileSync(join(dir, 'post.md'), '# 新稿\n', 'utf8');
    writeFileSync(join(dir, 'post.wechat.html'), 'LEGACY', 'utf8');
    const r = exportToFile(join(dir, 'post.md'), 'wechat_html');
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(dir, 'post.wechat.html'), 'utf8'), 'LEGACY', '旧文件未被覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安全 F11：图片语法出 <img>；不安全协议降级为 alt 文本', () => {
  const html = convertFormat('![封面](https://a.com/c.png)\n\n![坏](javascript:alert(1))', 'wechat_html');
  assert.match(html, /<img src="https:\/\/a\.com\/c\.png" alt="封面"/);
  assert.ok(!/src="javascript:/i.test(html), 'javascript: 不进 src');
  assert.ok(!/<a href="https:\/\/a\.com\/c\.png"/.test(html), '图片不再被当成链接');
});

test('接线 F1：write_note 写进会话 cwd 的项目，不写「全局最近 task_started」的项目', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b4b-note-'));
  const a = join(root, 'A');
  const b = join(root, 'B');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const pA = Number(db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?,?,1)').run('A', a).lastInsertRowid);
    db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
    const tA = createTask(db, new SqliteCounterStore(db), { projectId: pA, title: 'TA', goal: 'g', riskLevel: 0, ownerId: 7 });
    db.prepare("INSERT INTO task_events(task_id, ts, kind, actor, payload) VALUES(?, 5, 'task_started', 'system', '{}')").run(tA.id);
    const tool = (await createWriteNoteTool(db)) as unknown as Exec<{ name: string; content: string }>;
    const out = await tool.execute('tc', { name: 'runbook', content: '# 步骤' }, undefined, undefined, { cwd: b });
    assert.equal(out.details?.['ok'], true, out.content[0]!.text);
    assert.ok(existsSync(join(b, '.aico', 'notes')), '笔记落在会话 cwd（B）');
    assert.ok(!existsSync(join(a, '.aico', 'notes')), '全局最近任务的项目（A）未被写');
    // 无上下文：回落旧查询（兼容）
    const legacy = await tool.execute('tc', { name: 'legacy', content: 'x' });
    assert.equal(legacy.details?.['ok'], true);
    assert.ok(existsSync(join(a, '.aico', 'notes')), '无 ctx 时旧行为不变');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('接线 F2：touched-path 认领内容工具产出（目录/派生文件）', () => {
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'image_generate', input: { prompt: 'x' } }), ['assets/images']);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'screenshot', input: {} }), ['.aico/screenshots']);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'write_note', input: { name: 'n', content: 'c' } }), ['.aico/notes']);
  const exp = extractTouchedPathsFromTool({ toolName: 'export_format', input: { path: 'drafts/a.md', format: 'wechat_html' } });
  assert.equal(exp[0], 'drafts/a.md');
  assert.match(exp[1]!.replace(/\\/g, '/'), /drafts\/a\.wechat\.html$/);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'repo_map', input: {} }), [], '只读工具不认领');
});
