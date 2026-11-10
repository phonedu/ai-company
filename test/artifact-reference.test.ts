/**
 * G-A/B/C（§7 序 3）· 产物引用（`task:reference-artifact`）——守据。
 *
 * 口径（`work/plan-doc-and-cost-product.md` §4.1）：
 *  - **先 `copy`＋sha256**（link 后议不实现）；
 *  - 硬规则①：**AI 不得自主跨项目读**——本通道只由老板动作调用（AI 侧无工具），源路径必须落在**源项目根内**
 *    （绝对路径/`..` 越界/URL 伪装一律拒）；
 *  - 硬规则②：引用带**来源标记**（`origin_artifact_id`/`origin_project_id`，007 列）＋ sha256 按**实读字节**重算
 *    （与源记录不一致照实入库并在 note 标注，**不臆造**）；动作记 `task_events.artifact_referenced`。
 *
 * 本测用**真库（内存）＋真临时目录**驱动真实 handler；只断事实（字节一致/列值/事件/拒绝码）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertArtifact, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleArtifactReference, handleReadArtifact } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';

const sha256hex = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

interface Fixture {
  dir: string;
  rootA: string;
  rootB: string;
  db: ReturnType<typeof openMemoryDatabase>;
  deps: IpcDeps;
  taskA: number;
  taskB: number;
  projA: number;
  projB: number;
  artifactId: number;
}

/** 两项目/两任务的隔离夹具（真临时目录；测完递归删）。 */
function seed(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'aico-artref-'));
  const rootA = join(dir, 'proj-a');
  const rootB = join(dir, 'proj-b');
  mkdirSync(join(rootA, 'docs'), { recursive: true });
  mkdirSync(rootB, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(1, '甲项目', rootA, 1);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(2, '乙项目', rootB, 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(11, 'T-1001', '甲任务', 'g', JSON.stringify([]), 'executing', 1, 1, 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(12, 'T-1002', '乙任务', 'g', JSON.stringify([]), 'executing', 2, 1, 1);
  const content = '这是甲的产物：\n一、结论\n二、依据\n';
  writeFileSync(join(rootA, 'docs', 'report.md'), content, 'utf8');
  const { id: artifactId } = insertArtifact(db, {
    taskId: 11,
    path: 'docs/report.md',
    kind: 'file',
    note: '甲的产物',
    sha256: sha256hex(content),
    now: 5,
  });
  const repo = createSqliteChatRepo(db);
  return { dir, rootA, rootB, db, deps: { repo }, taskA: 11, taskB: 12, projA: 1, projB: 2, artifactId };
}

function cleanup(f: Fixture): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test('G-A 引用: copy 落目标项目 refs/，字节一致；来源两列＋sha256＋审计事件齐', () => {
  const f = seed();
  try {
    const res = handleArtifactReference(f.deps, { artifactId: f.artifactId, targetTaskId: f.taskB }, 1000);
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.duplicated, false);

    // ① 文件真落盘且字节一致（不是"看起来复制了"）
    const targetAbs = join(f.rootB, ...res.path.split('/'));
    assert.ok(existsSync(targetAbs), `目标副本必须在盘上：${res.path}`);
    assert.equal(readFileSync(targetAbs, 'utf8'), readFileSync(join(f.rootA, 'docs', 'report.md'), 'utf8'), '字节必须一致');
    assert.match(res.path, /^refs\/T-1001-a\d+-report\.md$/, '目标路径带来源短号与源产物 id（幂等键可辨）');

    // ② 库：新行属目标任务 ＋ 来源两列 ＋ 实读 sha
    const row = f.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(res.artifactId) as Record<string, unknown>;
    assert.equal(Number(row.task_id), f.taskB, '新产物行必须挂目标任务');
    assert.equal(Number(row.origin_artifact_id), f.artifactId, 'origin_artifact_id＝源产物');
    assert.equal(Number(row.origin_project_id), f.projA, 'origin_project_id＝源项目');
    assert.equal(String(row.sha256), sha256hex(readFileSync(join(f.rootA, 'docs', 'report.md'), 'utf8')), 'sha256＝实读字节');
    assert.match(String(row.note), /引用自 T-1001（项目 甲项目）/, 'note 带人话来源（面板可读）');

    // ③ 审计：老板显式发起（actor=boss；mode=copy；payload 带双向 id）
    const ev = f.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? AND kind = 'artifact_referenced'")
      .all(f.taskB) as Array<{ actor: string; payload: string }>;
    assert.equal(ev.length, 1, '必须恰有一条引用审计事件');
    assert.equal(ev[0]!.actor, 'boss', '发起者＝老板（G-B 硬规则①）');
    const payload = JSON.parse(ev[0]!.payload) as Record<string, unknown>;
    assert.equal(payload.mode, 'copy');
    assert.equal(Number(payload.originTaskId), f.taskA);
    assert.equal(Number(payload.originProjectId), f.projA);

    // ④ 幂等：重复引用同源 → 同 id、duplicated=true、不产生第二行
    const again = handleArtifactReference(f.deps, { artifactId: f.artifactId, targetTaskId: f.taskB }, 1100);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.duplicated, true, '重复引用必须如实标 duplicated');
    assert.equal(again.artifactId, res.artifactId);
    assert.equal(
      (f.db.prepare('SELECT count(*) c FROM artifacts WHERE task_id = ?').get(f.taskB) as { c: number }).c,
      1,
      '重复引用不得产生第二行',
    );

    // ⑤ 来源面板（G-A 余项，2026-10-16）：引用副本经详情 DTO **结构化**带来源（项目名 join；a<源 id>）
    const targetDetail = f.deps.repo.getTaskDetail(f.taskB);
    const refRow = targetDetail?.artifacts.find((a) => a.id === res.artifactId);
    assert.ok(refRow, '引用副本在目标详情产物列表里');
    assert.equal(refRow?.originProjectId, f.projA, '来源项目 id（结构化）');
    assert.equal(refRow?.originProjectName, '甲项目', '来源项目名（join）');
    assert.equal(refRow?.originArtifactId, f.artifactId, '源产物 id（溯源到 a<id>）');
    const selfDetail = f.deps.repo.getTaskDetail(f.taskA);
    const ownRow = selfDetail?.artifacts.find((a) => a.id === f.artifactId);
    assert.equal(ownRow?.originProjectId, null, '自产产物无来源字段（null，不臆造）');
  } finally {
    cleanup(f);
  }
});

test('G-A 引用·link（M2 尾）: 不复制、读时按源项目根解析；源变了读到的也变（指纹如实标 mismatch）', async () => {
  const f = seed();
  try {
    const res = handleArtifactReference(f.deps, { artifactId: f.artifactId, targetTaskId: f.taskB, mode: 'link' }, 1000);
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.path, 'docs/report.md', 'link 保留源相对路径（不落 refs 副本）');
    assert.equal(existsSync(join(f.rootB, 'refs')), false, 'link 不写任何副本');

    const row = f.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(res.artifactId) as Record<string, unknown>;
    assert.equal(String(row.source), `link:${f.projA}`, 'source 标明链接来源项目');
    assert.equal(Number(row.origin_artifact_id), f.artifactId);
    assert.equal(Number(row.origin_project_id), f.projA);
    const ev = f.db
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'artifact_referenced'")
      .get(f.taskB) as { payload: string };
    assert.equal((JSON.parse(ev.payload) as { mode: string }).mode, 'link', '审计如实记 link');

    const first = await handleReadArtifact(f.deps, { artifactId: res.artifactId });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.match(String((first as { text?: string }).text), /这是甲的产物/);

    // 源随动：源文件改了，link 读到的就是新内容（sha 快照不一致如实标注）。
    writeFileSync(join(f.rootA, 'docs', 'report.md'), '甲的新版内容\n', 'utf8');
    const second = await handleReadArtifact(f.deps, { artifactId: res.artifactId });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.match(String((second as { text?: string }).text), /甲的新版内容/);
    assert.equal((second as { sha256Mismatch?: boolean }).sha256Mismatch, true, '源变了 → 与链接时 sha 快照不一致');
  } finally {
    cleanup(f);
  }
});

test('G-A 引用·有牙: 源记录指纹与实读不一致 → 照实入库并在 note 标注（不臆造）', () => {
  const f = seed();
  try {
    // 伪造一条"记录指纹是错的"源产物（模拟产物被改动过）——刻意用**不同文件**，避免与既有源产物幂等键相撞
    const realContent = '报告 v2：内容与记录不符的场景\n';
    writeFileSync(join(f.rootA, 'docs', 'report2.md'), realContent, 'utf8');
    const wrongSha = sha256hex('完全不同的内容');
    const { id: badId } = insertArtifact(f.db, {
      taskId: f.taskA,
      path: 'docs/report2.md',
      kind: 'file',
      note: '指纹被改',
      sha256: wrongSha,
      now: 6,
    });
    assert.notEqual(badId, f.artifactId, '必须是一条独立源产物（幂等键按任务分区，不与既有行相撞）');
    const res = handleArtifactReference(f.deps, { artifactId: badId, targetTaskId: f.taskB }, 1000);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const row = f.db.prepare('SELECT sha256, note FROM artifacts WHERE id = ?').get(res.artifactId) as {
      sha256: string;
      note: string;
    };
    assert.notEqual(row.sha256, wrongSha, '入库 sha 必须是实读值（不得沿用错记录）');
    assert.equal(row.sha256, sha256hex(realContent));
    assert.match(row.note, /指纹不一致/, '不一致必须显式标注（可见，不静默）');
  } finally {
    cleanup(f);
  }
});

test('G-B 隔离: 源路径越界/绝对路径/缺文件 一律拒（AI 不得越项目根读）', () => {
  const f = seed();
  try {
    writeFileSync(join(f.dir, 'outside.txt'), '项目外的内容', 'utf8'); // 在**两项目根之外**

    const { id: escapeId } = insertArtifact(f.db, { taskId: f.taskA, path: '../outside.txt', kind: 'file', now: 7 });
    const esc = handleArtifactReference(f.deps, { artifactId: escapeId, targetTaskId: f.taskB }, 1000);
    assert.equal(esc.ok, false);
    if (esc.ok) return;
    assert.equal(esc.code, 'path_escape', `越界必须拒（实际 ${esc.code}）`);

    const { id: absId } = insertArtifact(f.db, { taskId: f.taskA, path: 'C:\\Windows\\win.ini', kind: 'file', now: 8 });
    const abs = handleArtifactReference(f.deps, { artifactId: absId, targetTaskId: f.taskB }, 1000);
    assert.equal(abs.ok, false);
    if (abs.ok) return;
    assert.equal(abs.code, 'bad_request', '绝对路径必须拒');

    const { id: urlFakeId } = insertArtifact(f.db, { taskId: f.taskA, path: 'https://evil/x', kind: 'file', now: 9 });
    const urlFake = handleArtifactReference(f.deps, { artifactId: urlFakeId, targetTaskId: f.taskB }, 1000);
    assert.equal(urlFake.ok, false, 'file 类型里伪装 URL 必须拒');

    const { id: missingId } = insertArtifact(f.db, { taskId: f.taskA, path: 'docs/nope.md', kind: 'file', now: 10 });
    const missing = handleArtifactReference(f.deps, { artifactId: missingId, targetTaskId: f.taskB }, 1000);
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, 'missing_file', '快照不在盘上不得臆造内容');

    // 全程没有往目标项目写任何 refs/（越界被拒不是"拒了但已写"）
    assert.ok(!existsSync(join(f.rootB, 'refs')), '被拒的引用不得留下副本');
  } finally {
    cleanup(f);
  }
});

test('G-A 引用: URL 类产物→访 url 行（不抓取网络）；入参/源/目标不存在各给明确码', () => {
  const f = seed();
  try {
    const { id: urlId } = insertArtifact(f.db, {
      taskId: f.taskA,
      path: 'https://example.com/doc',
      kind: 'url',
      sha256: null,
      now: 11,
    });
    const res = handleArtifactReference(f.deps, { artifactId: urlId, targetTaskId: f.taskB }, 1000);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const row = f.db.prepare('SELECT kind, path, note FROM artifacts WHERE id = ?').get(res.artifactId) as {
      kind: string;
      path: string;
      note: string;
    };
    assert.equal(row.kind, 'url');
    assert.equal(row.path, 'https://example.com/doc', 'URL 原样登记（未抓取内容）');
    assert.match(row.note, /未抓取内容/);
    assert.ok(!existsSync(join(f.rootB, 'refs')), 'URL 引用不得落文件');

    assert.equal((handleArtifactReference(f.deps, { artifactId: 9999, targetTaskId: f.taskB }, 1) as { code: string }).code, 'not_found');
    assert.equal((handleArtifactReference(f.deps, { artifactId: f.artifactId, targetTaskId: 8888 }, 1) as { code: string }).code, 'not_found');
    assert.equal((handleArtifactReference(f.deps, { artifactId: 0, targetTaskId: f.taskB }, 1) as { code: string }).code, 'bad_request');
  } finally {
    cleanup(f);
  }
});
