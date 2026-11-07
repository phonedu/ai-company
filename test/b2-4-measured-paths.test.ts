/**
 * B2-4（58 §1.6 P2；D-30）：路径所有权改执行期实测——预言退役为提示。
 *
 * 背景：并行正确性此前建立在「路径预言」上（touched_paths 塞 brief）；B0-7 因无测量
 * 用 `'.'` 整树认领兜底 ⇒ inplace 恒串行。启用多件并行（B2-3）前必须换实测：
 *  - **实测**：员工会话内 read/edit/write 实际触碰的路径（工具调用**执行前**登记），
 *    非**只读** bash/mcp 保守认领整树（`'.'`）——宁可串行、不可互踩；
 *  - **判定**：派发时候选实测路径 ∩ 在跑实测路径 → hold(path_conflict)；
 *  - **预言退役为提示**：brief 不再写 `'.'` 认领，只留「预计改哪些文件」文本提示；
 *  - **血缘**：返工件（retry_of）派发时继承源件实测认领（重启/重试不丢已测事实）；
 *  - staging 独占 worktree，不受影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations, createTask, insertEmployee, type SqliteDb } from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { insertWorkItem, getWorkItem, listRunningPathClaims } from '../src/main/db/work_items.js';
import { extractTouchedPathsFromTool } from '../src/main/agent/touched-path-recorder.js';
import { Engine } from '../src/main/engine/index.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedInplace(db: SqliteDb, risk = 1): { taskId: number; rootDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'b2-4-inplace-'));
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
  insertEmployee(db, { id: 8, name: 'E8', role: 'dev', now: 1 });
  const projectId = Number(
    (db.prepare("INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES('P',?, 'inplace',1)").run(dir) as { lastInsertRowid: number }).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    riskLevel: risk,
    ownerId: 7,
  });
  return { taskId: task.id, rootDir: dir };
}

// ── ① 提取器：纯函数（工具调用执行前登记） ────────────────────────────────

test('B2-4: extractTouchedPathsFromTool —— 读写编辑提路径；只读 bash 不认领；非只读 bash/mcp 保守整树', () => {
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'read', input: { path: 'src/a.ts' } }), ['src/a.ts']);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'write', input: { filePath: 'docs/x.md' } }), ['docs/x.md']);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'edit', input: { file: 'src/b.ts' } }), ['src/b.ts']);
  const roots = { projectRoot: 'D:/repo', cwd: 'D:/repo' };
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'bash', input: { command: 'ls -la' } }, roots), [], '只读白名单内不认领');
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'bash', input: { command: 'git status' } }, roots), ['.'], 'git 不在只读白名单（B2-7 未入）→ 保守整树');
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'bash', input: { command: 'pnpm test' } }, roots), ['.'], '非只读 bash 保守整树');
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'bash', input: { command: 'node -e "fs.writeFileSync(1)"' } }, roots), ['.']);
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'mcp_call', input: {} }), ['.'], 'mcp 调用不可测 → 保守整树');
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'task_status', input: {} }), [], '流程工具不认领');
  assert.deepEqual(extractTouchedPathsFromTool({ toolName: 'bash', input: {} }), [], '无命令不认领');
});

// ── ② 预言退役：inplace brief 不再带 '.' 认领，只留提示 ──────────────────

test('B2-4: spawnPlanWorkItems inplace —— brief 无 touchedPaths 认领（预言退役），提示在场', async () => {
  const db = fresh();
  const { taskId, rootDir } = seedInplace(db, 0); // L0：plan_drafted 即直通 spawn
  try {
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 1 });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'triage', actor: 'boss' });
    await engine.dispatch({ scope: 'task', id: taskId, event: 'plan_drafted', actor: 'employee:7', payload: { steps: ['改 A 文件', '改 B 文件'], plannerEmployeeId: 7 } });
    const wis = db.prepare('SELECT * FROM work_items WHERE task_id=?').all(taskId) as Array<{ brief: string }>;
    assert.equal(wis.length, 1);
    const brief = wis[0]!.brief;
    // 预言退役：纯文本 brief（无 JSON 认领包裹）；提示在场
    assert.ok(!brief.trimStart().startsWith('{'), 'brief 不再是 JSON 认领载体（B0-7 的 \'.\' 整树认领退役）');
    assert.match(brief, /预计改哪些文件|实测/, 'brief 保留「路径按实测」提示');
    // 派发前认领为空 → 不凭空拦
    assert.deepEqual(listRunningPathClaims(db).filter((c) => c.workItemId !== -1).map((c) => c.paths), []);
    void rootDir;
  } finally {
    db.close();
    void rootDir;
  }
});
void seedInplace;

// ── ③ 实测登记 → 认领生效 → 后到件 hold(path_conflict) ──────────────────

test('B2-4: 实测路径登记后，同 root 的后到件按实测 hold(path_conflict)；staging 不受影响', async () => {
  const db = fresh();
  const { taskId, rootDir } = seedInplace(db);
  try {
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(taskId);
    const a = insertWorkItem(db, { taskId, employeeId: 7, title: 'A', brief: 'A 改 src/a.ts', now: 1 });
    const b = insertWorkItem(db, { taskId, employeeId: 8, title: 'B', brief: 'B 改 src/b.ts', now: 2 });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(a.id);
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 2 });
    // 员工 A 实际开始改 src/a.ts（工具调用执行前登记——闸门同点位）
    engine.recordWorkItemTouchedPaths(a.id, ['src/a.ts']);
    const claims = listRunningPathClaims(db);
    const claimA = claims.find((c) => c.workItemId === a.id);
    assert.ok(claimA && claimA.paths.includes('src/a.ts'), '实测认领落库并可在 running 集合读到');
    // 实测语义（D-30）：冲突判定用**候选件已有的实测/血缘**——未测的全新件乐观放行
    // （否则回到 '.' 恒串行）；运行中重叠窗口由「登记即见」+ git 白名单兜底，余量风险留痕。
    assert.deepEqual(engine.pathConflictsFor(b.id), [], '未测的全新件乐观放行（实测语义）');
    // B 曾实测过（重试/中断再派）：实测路径与 A 相交 → hold
    engine.recordWorkItemTouchedPaths(b.id, ['src/a.ts']);
    assert.deepEqual(engine.pathConflictsFor(b.id), [a.id], '后到实测件与在跑件相交 → 冲突');
    // B 实测的是不相交路径 → 放行（并行成立）
    const c = insertWorkItem(db, { taskId, employeeId: 8, title: 'C', brief: 'C 改 docs/c.md', now: 3 });
    engine.recordWorkItemTouchedPaths(c.id, ['docs/c.md']);
    assert.deepEqual(engine.pathConflictsFor(c.id), [], '实测不相交 → 可并行');
    // A 结束（done）后 B 不再被拦
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(a.id);
    assert.deepEqual(engine.pathConflictsFor(b.id), [], 'A 终态后 B 放行');
    void rootDir;
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── ④ 返工件血缘：派发时继承源件实测认领 ─────────────────────────────────

test('B2-4: 返工件（retry_of）派发时继承源件实测认领（重启/重试不丢已测事实）', async () => {
  const db = fresh();
  const { taskId, rootDir } = seedInplace(db);
  try {
    const src = insertWorkItem(db, { taskId, employeeId: 7, title: '原件', brief: '改 src/a.ts', now: 1 });
    // 源件运行中实测到 src/a.ts（落 brief JSON）
    const engine = new Engine(db, { async execute() {} }, { autoSchedule: false, now: () => 2 });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(src.id);
    engine.recordWorkItemTouchedPaths(src.id, ['src/a.ts']);
    // 返工件：同员工、血缘指向源件；brief 无认领
    const rework = insertWorkItem(db, { taskId, employeeId: 7, title: '返工', brief: '按批注返工', retryOf: src.id, now: 3 });
    assert.equal(getWorkItem(db, rework.id)?.retry_of, src.id);
    // 引擎为返工件构造派发认领时应并上源件实测
    const seeded = engine.seedClaimPaths(rework.id);
    assert.ok(seeded.includes('src/a.ts'), `返工认领应继承源件实测（实际 ${JSON.stringify(seeded)}）`);
    void rootDir;
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
