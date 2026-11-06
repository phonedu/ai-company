/**
 * BRK16-a＋GAP11（挂载 3）· 产物读/打开/文件夹 ＋ 审计导出（`task:read-artifact` / `task:export`）——守据。
 *
 * 口径：
 *  - **D1 铁律**：renderer 只给 `artifactId`/`taskId`（**不接受任何路径**）；读/开/导出路径全部由主进程推导；
 *  - 读：项目根包含性（`..`/绝对/URL 伪装一律拒）、二进制显式拒、超上限截断**如实标注**、实读 sha256
 *    与记录不一致显式 `sha256Mismatch`（内容仍如实展示）；
 *  - 开：经注入 `openPath`/`revealPath`（handler 不直接碰 electron）；缺注入 ⇒ `*_unavailable`（不假装已开）；
 *  - 导出：单文件 JSON 档案（任务/事件/产物/成本），落在注入 `exportDir`；**打开失败不回滚导出**（`openError` 如实带）。
 *
 * 本测用**真库（内存）＋真临时目录**驱动真实 handler；只断事实（字节/次数/回执码/落盘内容）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertArtifact, openMemoryDatabase, runMigrations, insertReport } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { ARTIFACT_READ_CAP, handleExportTask, handleReadArtifact } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';

const sha256hex = (bytes: Buffer | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');

interface Fixture {
  dir: string;
  root: string;
  exportDir: string;
  db: ReturnType<typeof openMemoryDatabase>;
  calls: { open: string[]; reveal: string[] };
  deps: IpcDeps;
  /** 内容正确的产物 id（记录 sha256 与实读一致）。 */
  artifactId: number;
}

/** 单项目单任务夹具（真临时目录；测完递归删）。`openPath`/`revealPath` 为可观察假件。 */
function seed(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'aico-artio-'));
  const root = join(dir, 'proj');
  const exportDir = join(dir, 'exports');
  mkdirSync(join(root, 'docs'), { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(1, '甲项目', root, 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(11, 'T-1001', '甲任务', '目标', JSON.stringify([]), 'executing', 1, 1, 1);
  const content = '这是产物正文：\n一、结论\n二、依据\n';
  writeFileSync(join(root, 'docs', 'report.md'), content, 'utf8');
  const { id: artifactId } = insertArtifact(db, {
    taskId: 11,
    path: 'docs/report.md',
    kind: 'file',
    note: '甲的产物',
    sha256: sha256hex(content),
    now: 5,
  });
  insertReport(db, { kind: 'success', taskId: 11, payload: { summary: '汇报' }, state: 'pending', now: 9 });
  const calls = { open: [] as string[], reveal: [] as string[] };
  const deps: IpcDeps = {
    repo: createSqliteChatRepo(db),
    openPath: (p) => {
      calls.open.push(p);
      return '';
    },
    revealPath: (p) => {
      calls.reveal.push(p);
    },
    exportDir: () => exportDir,
  };
  return { dir, root, exportDir, db, calls, deps, artifactId };
}

function cleanup(f: Fixture): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

// ─────────────────────────── task:read-artifact ───────────────────────────

test('读：文本产物 → 真内容/真大小/真 sha256（与记录一致）；落盘路径=项目根内相对路径', async () => {
  const f = seed();
  try {
    const res = await handleReadArtifact(f.deps, { artifactId: f.artifactId });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(res.path, 'docs/report.md');
    assert.equal(res.name, 'report.md');
    assert.equal(res.text, readFileSync(join(f.root, 'docs', 'report.md'), 'utf8'));
    assert.equal(res.size, statSync(join(f.root, 'docs', 'report.md')).size);
    assert.equal(res.sha256, sha256hex(res.text));
    assert.equal(res.sha256Mismatch, false);
    assert.equal(res.truncated, false);
  } finally {
    cleanup(f);
  }
});

test('UG-05 读：图片/PDF → 受控短票 previewKind/previewUrl（不把路径交给 renderer）', async () => {
  const f = seed();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    writeFileSync(join(f.root, 'docs', 'shot.png'), png);
    const { id: imageId } = insertArtifact(f.db, {
      taskId: 11,
      path: 'docs/shot.png',
      kind: 'file',
      note: '',
      sha256: sha256hex(png),
      now: 13,
    });
    const image = await handleReadArtifact(f.deps, { artifactId: imageId });
    assert.equal(image.ok, true);
    if (!image.ok || image.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(image.previewKind, 'image');
    assert.match(image.previewUrl ?? '', /^aico-file:\/\/preview\/[0-9a-f-]{36}$/);
    assert.equal((image.previewUrl ?? '').includes(f.root), false, 'URL 不含真实路径');
    assert.equal(image.sha256, sha256hex(png));

    const pdf = Buffer.from('%PDF-1.4\n%fake\n');
    writeFileSync(join(f.root, 'docs', 'rule.pdf'), pdf);
    const { id: pdfId } = insertArtifact(f.db, {
      taskId: 11,
      path: 'docs/rule.pdf',
      kind: 'file',
      note: '',
      sha256: sha256hex(pdf),
      now: 14,
    });
    const pdfRes = await handleReadArtifact(f.deps, { artifactId: pdfId });
    assert.equal(pdfRes.ok, true);
    if (!pdfRes.ok || pdfRes.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(pdfRes.previewKind, 'pdf');
    assert.match(pdfRes.previewUrl ?? '', /^aico-file:\/\/preview\//);
  } finally {
    cleanup(f);
  }
});

test('读：超上限 → 截断且 `truncated:true`（text 恰为上限字节；不假装全文）', async () => {
  const f = seed();
  try {
    const big = 'x'.repeat(ARTIFACT_READ_CAP + 1024);
    writeFileSync(join(f.root, 'docs', 'big.txt'), big, 'utf8');
    const { id } = insertArtifact(f.db, { taskId: 11, path: 'docs/big.txt', kind: 'file', note: '', sha256: sha256hex(big), now: 6 });
    const res = await handleReadArtifact(f.deps, { artifactId: id });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(res.truncated, true);
    assert.equal(Buffer.byteLength(res.text, 'utf8'), ARTIFACT_READ_CAP);
    assert.equal(res.size, big.length);
    // 实读 sha256 覆盖**全文**（截断只影响预览，不影响指纹）
    assert.equal(res.sha256, sha256hex(big));
    assert.equal(res.sha256Mismatch, false);
  } finally {
    cleanup(f);
  }
});

test('读：二进制（含 NUL）→ 显式拒（binary_file）；同产物「打开」仍可（走系统默认应用）', async () => {
  const f = seed();
  try {
    const bin = Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
    writeFileSync(join(f.root, 'docs', 'blob.bin'), bin);
    const { id } = insertArtifact(f.db, { taskId: 11, path: 'docs/blob.bin', kind: 'file', note: '', sha256: sha256hex(bin), now: 7 });
    const read = await handleReadArtifact(f.deps, { artifactId: id, mode: 'read' });
    assert.equal(read.ok, false);
    if (read.ok) return assert.fail('二进制读应被拒');
    assert.equal(read.code, 'binary_file');
    const open = await handleReadArtifact(f.deps, { artifactId: id, mode: 'open' });
    assert.equal(open.ok, true);
    assert.deepEqual(f.calls.open, [join(f.root, 'docs', 'blob.bin')]);
  } finally {
    cleanup(f);
  }
});

test('读：sha256 记录与实读不一致 → 显式 `sha256Mismatch:true`（内容仍如实展示；记录不改）', async () => {
  const f = seed();
  try {
    // 注意：`insertArtifact` 对同一 (work_item_id=NULL, path) 幂等去重 → 用**另一路径**录错指纹。
    const content = '这是产物正文：\n一、结论\n二、依据\n';
    writeFileSync(join(f.root, 'docs', 'report2.md'), content, 'utf8');
    const { id } = insertArtifact(f.db, {
      taskId: 11,
      path: 'docs/report2.md',
      kind: 'file',
      note: '记录指纹写错',
      sha256: 'deadbeef'.repeat(8),
      now: 8,
    });
    const res = await handleReadArtifact(f.deps, { artifactId: id });
    assert.equal(res.ok, true);
    if (!res.ok || res.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(res.sha256Mismatch, true);
    assert.ok(res.text.includes('结论'), '不一致也如实展示内容（不臆造、不封锁）');
  } finally {
    cleanup(f);
  }
});

test('安全：路径越界（`..`）/ 绝对路径 / URL 伪装 → 拒（不落在项目根内一律不可达）', async () => {
  const f = seed();
  try {
    const outside = join(f.dir, 'outside.txt');
    writeFileSync(outside, '不该被读到', 'utf8');
    const { id: esc } = insertArtifact(f.db, { taskId: 11, path: '../outside.txt', kind: 'file', note: '', sha256: null, now: 9 });
    const r1 = await handleReadArtifact(f.deps, { artifactId: esc });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'path_escape');

    const { id: abs } = insertArtifact(f.db, { taskId: 11, path: outside, kind: 'file', note: '', sha256: null, now: 10 });
    const r2 = await handleReadArtifact(f.deps, { artifactId: abs });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'bad_request');

    const { id: url } = insertArtifact(f.db, { taskId: 11, path: 'https://example.com/a.md', kind: 'file', note: '', sha256: null, now: 11 });
    const r3 = await handleReadArtifact(f.deps, { artifactId: url });
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, 'bad_request');
  } finally {
    cleanup(f);
  }
});

test('读：文件不在盘上/产物不存在/入参非法 → 显式码（不臆造内容）', async () => {
  const f = seed();
  try {
    const { id: gone } = insertArtifact(f.db, { taskId: 11, path: 'docs/gone.md', kind: 'file', note: '', sha256: null, now: 12 });
    const r1 = await handleReadArtifact(f.deps, { artifactId: gone });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'missing_file');

    const r2 = await handleReadArtifact(f.deps, { artifactId: 99999 });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'not_found');

    const r3 = await handleReadArtifact(f.deps, { artifactId: 'abc' });
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, 'bad_request');
  } finally {
    cleanup(f);
  }
});

test('打开/文件夹：经注入注入件（真绝对路径）；缺注入 ⇒ *_unavailable（不假装已开）', async () => {
  const f = seed();
  try {
    const open = await handleReadArtifact(f.deps, { artifactId: f.artifactId, mode: 'open' });
    assert.equal(open.ok, true);
    assert.deepEqual(f.calls.open, [join(f.root, 'docs', 'report.md')]);
    const reveal = await handleReadArtifact(f.deps, { artifactId: f.artifactId, mode: 'reveal' });
    assert.equal(reveal.ok, true);
    assert.deepEqual(f.calls.reveal, [join(f.root, 'docs', 'report.md')]);

    const bare: IpcDeps = { repo: f.deps.repo };
    const noOpen = await handleReadArtifact(bare, { artifactId: f.artifactId, mode: 'open' });
    assert.equal(noOpen.ok, false);
    if (!noOpen.ok) assert.equal(noOpen.code, 'open_unavailable');
    const noReveal = await handleReadArtifact(bare, { artifactId: f.artifactId, mode: 'reveal' });
    assert.equal(noReveal.ok, false);
    if (!noReveal.ok) assert.equal(noReveal.code, 'reveal_unavailable');
  } finally {
    cleanup(f);
  }
});

test('打开：注入件报错 → `open_failed` 且错误文案如实转述（不静默）', async () => {
  const f = seed();
  try {
    const failing: IpcDeps = { ...f.deps, openPath: () => '没有关联应用' };
    const res = await handleReadArtifact(failing, { artifactId: f.artifactId, mode: 'open' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'open_failed');
      assert.match(res.message, /没有关联应用/);
    }
  } finally {
    cleanup(f);
  }
});

// ─────────────────────────── task:export（GAP11） ───────────────────────────

test('导出：单文件 JSON 档案（任务/事件/产物/报告/成本）落盘；同名覆盖（同任务恒一个档案文件）', async () => {
  const f = seed();
  try {
    const res = await handleExportTask(f.deps, { taskId: 11 }, 1_700_000_000_000);
    if (!res.ok) assert.fail(`导出失败：${res.code}｜${res.message}`);
    assert.equal(res.ok, true);
    assert.equal(res.path, join(f.exportDir, 'task-T-1001.json'));
    assert.equal(existsSync(res.path), true);
    const bundle = JSON.parse(readFileSync(res.path, 'utf8')) as Record<string, unknown>;
    assert.equal(bundle.schema, 'aico.task-export/v1');
    assert.equal(bundle.exportedAt, 1_700_000_000_000);
    assert.equal((bundle.task as { id: number }).id, 11);
    assert.equal(Array.isArray(bundle.events), true);
    assert.equal(Array.isArray(bundle.artifacts), true);
    assert.equal((bundle.artifacts as unknown[]).length, 1);
    assert.equal(Array.isArray(bundle.reports), true);
    assert.equal((bundle.reports as unknown[]).length, 1);
    assert.equal(typeof bundle.costs, 'object');
    assert.equal(Array.isArray(bundle.workItemIds), true);

    const again = await handleExportTask(f.deps, { taskId: 11 }, 1_700_000_000_001);
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.path, res.path, '同名覆盖：同一任务只留一个档案文件');
  } finally {
    cleanup(f);
  }
});

test('导出：`openAction` 开/显文件夹（注入件收真路径）；**打开失败不回滚导出**（ok:true + openError）', async () => {
  const f = seed();
  try {
    const opened = await handleExportTask(f.deps, { taskId: 11, openAction: 'open' }, 20);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.deepEqual(f.calls.open, [opened.path]);
    const revealed = await handleExportTask(f.deps, { taskId: 11, openAction: 'reveal' }, 21);
    assert.equal(revealed.ok, true);
    if (revealed.ok) assert.deepEqual(f.calls.reveal, [revealed.path]);

    const failing: IpcDeps = { ...f.deps, openPath: () => '打不开' };
    const res = await handleExportTask(failing, { taskId: 11, openAction: 'open' }, 22);
    assert.equal(res.ok, true, '导出已成功是事实，不因打开失败回滚');
    if (res.ok) {
      assert.equal(existsSync(res.path), true);
      assert.match(res.openError ?? '', /打不开/);
    }
  } finally {
    cleanup(f);
  }
});

test('导出：无 exportDir / 任务不存在 / 入参非法 → 显式码', async () => {
  const f = seed();
  try {
    const bare: IpcDeps = { repo: f.deps.repo };
    const r1 = await handleExportTask(bare, { taskId: 11 }, 30);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'export_unavailable');

    const r2 = await handleExportTask(f.deps, { taskId: 9999 }, 31);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'not_found');

    const r3 = await handleExportTask(f.deps, { taskId: 0 }, 32);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, 'bad_request');
  } finally {
    cleanup(f);
  }
});
