import test from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

import { createProject, getProjectById, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { probeProject, type ProbeIo } from '../src/main/ipc/project-probe.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectAttach } from '../src/main/ipc/ipc.js';

// ── R2-4 · 项目接入（`` 第 2 屏）：探测＝**只报真事实**；`project:attach`＝dialog 选目录、只记录路径 ──

const AT = 1_800_000_000_000;

function setup(): { db: ReturnType<typeof openMemoryDatabase>; repo: ReturnType<typeof createSqliteChatRepo> } {
  const db = openMemoryDatabase();
  runMigrations(db);
  return { db, repo: createSqliteChatRepo(db) };
}

/** 假 io：按 **basename** 命中（路径分隔符/盘符无关）。 */
function fakeIo(map: Record<string, string>): ProbeIo {
  const base = (p: string): string => p.split(/[\\/]/).pop() as string;
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(map, base(p)),
    read: (p) => map[base(p)] ?? '',
  };
}

test('R2-4 探测：Node 项目（pnpm test）/ Python（pytest -q）/ git 决定接入模式 / 坏 JSON 不猜', () => {
  const node = probeProject('D:/repo', fakeIo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'pnpm-lock.yaml': '' }));
  assert.equal(node.hasPackageJson, true);
  assert.equal(node.suggestedCheck, 'pnpm test', '有 pnpm 锁文件 ⇒ pnpm test');
  assert.equal(node.suggestedAccessMode, 'staging', '无 .git ⇒ 建议沙盒模式（02 §15.3）');

  const withGit = probeProject('D:/repo', fakeIo({ '.git': '', 'package.json': JSON.stringify({ scripts: { test: 'x' } }) }));
  assert.equal(withGit.suggestedAccessMode, 'inplace', '有 .git ⇒ 建议原地模式');
  assert.equal(withGit.suggestedCheck, 'npm test', '无锁文件 ⇒ npm test');

  const py = probeProject('D:/repo', fakeIo({ 'pyproject.toml': '' }));
  assert.equal(py.hasPyproject, true);
  assert.equal(py.suggestedCheck, 'pytest -q');

  const none = probeProject('D:/repo', fakeIo({}));
  assert.equal(none.suggestedCheck, null, '都没找到 ⇒ null（不臆造命令）');
  assert.equal(none.suggestedAccessMode, 'staging');

  const broken = probeProject('D:/repo', fakeIo({ 'package.json': '{bad' }));
  assert.equal(broken.suggestedCheck, null, '坏 JSON ⇒ 不猜（不误报命令）');

  const noTestScript = probeProject('D:/repo', fakeIo({ 'package.json': JSON.stringify({ scripts: {} }) }));
  assert.equal(noTestScript.suggestedCheck, null, '没有 scripts.test ⇒ null');
});

test('R2-4 DAO：createProject 只记录路径（不搬动目录）并可读回', () => {
  const { db } = setup();
  const row = createProject(db, { name: 'billing', rootDir: 'D:/projects/billing', accessMode: 'inplace', now: AT });
  assert.equal(row.name, 'billing');
  assert.equal(row.root_dir, 'D:/projects/billing');
  assert.equal(row.access_mode, 'inplace');
  assert.equal(row.created_at, AT);
  assert.equal(getProjectById(db, row.id)?.root_dir, 'D:/projects/billing', '读回一致');
  db.close();
});

test('R2-4 attach：选到目录 → 建行＋返回探测；取消 → cancelled 且**不建行**；无 dialog → 明确错误', async () => {
  const { db, repo } = setup();
  const deps = {
    repo,
    pickDirectory: async () => 'D:/projects/billing' as string | null,
  };
  const res = await handleProjectAttach(deps, AT);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.project.name, 'billing', '项目名＝目录名');
    assert.equal(res.project.rootDir, 'D:/projects/billing');
    assert.equal(res.probe.suggestedAccessMode, 'staging', '真实 fs 下目录不存在 ⇒ 无 .git ⇒ 推荐沙盒（如实）');
  }
  assert.equal(handleProjectAttach === undefined, false);

  const cancelled = await handleProjectAttach({ repo, pickDirectory: async () => null }, AT);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.code, 'cancelled');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  assert.equal(count, 1, '取消 ⇒ 不建行（只建了成功那一条）');

  const noDialog = await handleProjectAttach({ repo }, AT);
  assert.equal(noDialog.ok, false);
  if (!noDialog.ok) assert.equal(noDialog.code, 'dialog_unavailable');
  db.close();
});

// ── （真机带回，2026-10-27）：接入后默认指针跟着走；回退默认项目根必须真实存在 ──

test('RW-1①: attach 成功后把接入项目设为默认（教学接入的项目＝建任务默认落点）', async () => {
  const { db, repo } = setup();
  const deps = {
    repo,
    db,
    pickDirectory: async () => 'D:/projects/billing' as string | null,
  };
  const res = await handleProjectAttach(deps, AT);
  assert.equal(res.ok, true);
  const def = db.prepare("SELECT value FROM settings WHERE key = 'projects.default_id'").get() as { value: unknown } | undefined;
  assert.ok(def, 'attach 后应写入 projects.default_id');
  if (res.ok) assert.equal(String(def?.value), String(res.project.id), '默认指针应指向刚接入的项目');
  db.close();
});

test('RW-1②: attach 失败/取消不动默认指针', async () => {
  const { db, repo } = setup();
  const cancelled = await handleProjectAttach({ repo, db, pickDirectory: async () => null }, AT);
  assert.equal(cancelled.ok, false);
  const def = db.prepare("SELECT value FROM settings WHERE key = 'projects.default_id'").get();
  assert.equal(def, undefined, '取消不设默认');
  db.close();
});

test('RW-1③: 回退默认项目的根目录真实存在（不再指向模板路径 D:/...）', () => {
  const { db, repo } = setup();
  // 未设默认 → createTask 走 ensureDefaultProject 回退
  const t = repo.createTask({ title: 'T', goal: 'g', riskLevel: 0 });
  const row = db.prepare('SELECT root_dir FROM projects WHERE id = ?').get(t.projectId) as { root_dir: string };
  assert.ok(!/^[A-Z]:\/ai-company-projects/.test(row.root_dir), `回退根不得是模板路径（实际 ${row.root_dir}）`);
  assert.ok(existsSync(row.root_dir), `回退默认项目根必须真实存在：${row.root_dir}`);
  db.close();
});
