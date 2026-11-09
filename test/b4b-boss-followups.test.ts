/**
 * 老板 2026-11-09「其他的那就补上吧」——裁决 6/7/8 的代码侧单测：
 *  1. 图片费用入账（image-cost：PNG 尺寸 → 1k/2k 档 → 元→USD；出图成功才回调）；
 *  2. 批准后补跑（refireAfterApproval：件在跑→no-op；任务 done→重开＋返工件；件 failed→retry）；
 *  3. 内置 ffmpeg 随包完整（PE 头＋GPL 声明）。
 *
 * 外发词表补齐（存量安全债）另在 `test/b4b-egress-words.test.ts`（样本放在数据文件里）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cnyToUsd, DEFAULT_CNY_PER_USD, imagePriceCny, imageTierOf, pngSize } from '../src/main/agent/tools/image-cost.js';
import { createImageGenerateTool } from '../src/main/agent/tools/content-tools.js';
import { Engine } from '../src/main/engine/index.js';
import { SqliteCounterStore, createTask, getTaskById, insertWorkItem, listTaskEvents, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';

// ── 1. 图片费用口径 ─────────────────────────────────────────────────────

/** 最小 PNG（只含签名 + IHDR，够 pngSize 解析）。 */
function tinyPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('裁决 7：PNG 尺寸解析 → 1k/2k 档 → 按模型定价', () => {
  assert.deepEqual(pngSize(tinyPng(2048, 2048)), { width: 2048, height: 2048 });
  assert.equal(pngSize(Buffer.from('not-a-png')), null);
  assert.equal(imageTierOf({ width: 1024, height: 1024 }), '1k');
  assert.equal(imageTierOf({ width: 1792, height: 1024 }), '2k');
  assert.equal(imageTierOf(null), '2k', '判不出尺寸按 2k 保守记');
  assert.deepEqual(imagePriceCny('qwen-image-3.0-pro', { width: 2048, height: 2048 }), { cny: 0.5, tier: '2k', priced: true });
  assert.deepEqual(imagePriceCny('qwen-image-3.0-pro', { width: 1024, height: 1024 }), { cny: 0.25, tier: '1k', priced: true });
  const unknown = imagePriceCny('some-future-model', null);
  assert.equal(unknown.priced, false, '无价目要标出来（不静默当已知价）');
  assert.equal(cnyToUsd(DEFAULT_CNY_PER_USD * 2, DEFAULT_CNY_PER_USD), 2);
  assert.equal(cnyToUsd(7.2, 0), 1, '非法汇率回落缺省');
});

test('裁决 7：出图成功 → 工具回调带价（按实际 PNG 尺寸），失败不回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-cost-'));
  try {
    const calls: Array<{ model: string; cny: number; tier: string }> = [];
    const tool = (await createImageGenerateTool(dir, {
      channel: 'qwen',
      recordImageCost: (info) => calls.push({ model: info.model, cny: info.cny, tier: info.tier }),
      generateQwen: async (opts) => {
        mkdirSync(opts.outputDir, { recursive: true });
        const p = join(opts.outputDir, 'i.png');
        writeFileSync(p, tinyPng(2048, 2048));
        return { ok: true, path: p };
      },
    })) as unknown as { execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<{ details?: Record<string, unknown> }> };
    await tool.execute('tc', { prompt: 'x' }, undefined, undefined, { cwd: dir });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { model: 'qwen-image-3.0-pro', cny: 0.5, tier: '2k' });

    const failTool = (await createImageGenerateTool(dir, {
      channel: 'qwen',
      recordImageCost: (info) => calls.push({ model: info.model, cny: info.cny, tier: info.tier }),
      generateQwen: async () => ({ ok: false, error: 'boom' }),
    })) as unknown as { execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<unknown> };
    await failTool.execute('tc', { prompt: 'x' }, undefined, undefined, { cwd: dir });
    assert.equal(calls.length, 1, '失败不入账');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. 批准后补跑 ───────────────────────────────────────────────────────

function setupRefire(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','开发','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const noopExecutor = { async execute() {} };

test('裁决 8：件还在跑 → 补跑 no-op（already_active）', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    const res = await engine.refireAfterApproval(taskId);
    assert.deepEqual(res, { ok: true, reason: 'already_active', workItemId: wiId });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE task_id=?').get(taskId) as { n: number }).n;
    assert.equal(count, 1, '不新增件');;
  } finally {
    db.close();
  }
});

test('裁决 8：任务已 done＋件已 done → 重开任务并新增返工件（retry_of 血缘）', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='done', closed_at=5, state_before_close='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    const res = await engine.refireAfterApproval(taskId);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.reason, 'rework_spawned');
    const task = getTaskById(db, taskId)!;
    assert.notEqual(task.state, 'done', '任务被重开');
    const rework = db.prepare('SELECT id, retry_of, state FROM work_items WHERE task_id=? AND retry_of=?').get(taskId, wiId) as { id: number; state: string } | undefined;
    assert.ok(rework, '新增返工件（retry_of 指向源件）');
    assert.equal(rework!.state, 'queued');
  } finally {
    db.close();
  }
});

test('裁决 8：件 failed → retry（attempt 递增）；任务不存在 → task_not_found', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='failed', attempt=1 WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    const res = await engine.refireAfterApproval(taskId);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.reason, 'retried');
    const wi = db.prepare('SELECT state, attempt FROM work_items WHERE id=?').get(wiId) as { state: string; attempt: number };
    assert.equal(wi.state, 'running', 'retry 直接回 running 并派发');
    assert.equal(wi.attempt, 2, 'attempt 递增（幂等键变化）');
    assert.equal((await engine.refireAfterApproval(9999)).reason, 'task_not_found');
  } finally {
    db.close();
  }
});

// ── 3. ffmpeg 随包 ─────────────────────────────────────────────────────

test('裁决 6：内置 ffmpeg 随包完整（PE 头＋GPL 声明；产物缺失则跳过不红）', () => {
  const dir = join(process.cwd(), 'vendor', 'ffmpeg');
  const exe = join(dir, 'ffmpeg.exe');
  if (!existsSync(exe)) {
    console.log('[skip] vendor/ffmpeg/ffmpeg.exe 未取（node scripts/fetch-ffmpeg.mjs）');
    return;
  }
  // 只读文件头判 PE（不执行二进制；可执行性由 fetch 脚本的 MZ 校验＋真机出口覆盖）。
  const fd = openSync(exe, 'r');
  try {
    const head = Buffer.alloc(2);
    readSync(fd, head, 0, 2, 0);
    assert.equal(head.toString('latin1'), 'MZ', '有效 Windows 可执行文件');
  } finally {
    closeSync(fd);
  }
  assert.ok(existsSync(join(dir, 'LICENSE.txt')), 'GPL 许可声明随包');
  assert.match(readFileSync(join(dir, 'LICENSE.txt'), 'utf8'), /GPL-3\.0|General Public License/);
});
