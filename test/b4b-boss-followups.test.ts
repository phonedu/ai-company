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
  // 官方按输出像素面积分档（>2,250,000 才 2K）：1792×1024=1,835,008 ⇒ 1k（独立验收 P2-2 更正）
  assert.equal(imageTierOf({ width: 1792, height: 1024 }), '1k');
  assert.equal(imageTierOf({ width: 2048, height: 1024 }), '1k', '2,097,152 仍未过 2.25M');
  // 同向复核 P2-3：DALL-E 按尺寸档（长边 >1024 即 $0.08 档），不能套千问的面积口径。
  assert.equal(imageTierOf({ width: 1792, height: 1024 }, 'dall-e-3'), '2k');
  assert.equal(imageTierOf({ width: 1024, height: 1024 }, 'dall-e-3'), '1k');
  assert.deepEqual(imagePriceCny('dall-e-3', { width: 1792, height: 1024 }), { cny: 0.58, tier: '2k', priced: true });
  assert.equal(imageTierOf({ width: 2048, height: 2048 }), '2k');
  assert.equal(imageTierOf(null), '2k', '判不出尺寸按 2k 保守记');
  assert.deepEqual(imagePriceCny('qwen-image-3.0-pro', { width: 2048, height: 2048 }), { cny: 0.5, tier: '2k', priced: true });
  assert.deepEqual(imagePriceCny('qwen-image-3.0-pro', { width: 1792, height: 1024 }), { cny: 0.25, tier: '1k', priced: true }, '横版封面按 1k 记（不再多记一倍）');
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
    // tinyPng(2048,2048)=4.19M 像素 ⇒ 2k 档 0.5 元
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
    assert.equal(res.reason, 'refired');
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
    assert.equal(res.reason, 'refired');
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
  // S13（独立验收）：随包必须是**全文** GPL-3.0，不只给 URL。
  assert.match(readFileSync(join(dir, 'UPSTREAM-LICENSE.txt'), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/, 'GPL-3.0 全文随包');
  assert.match(readFileSync(join(dir, 'LICENSE.txt'), 'utf8'), /GPL-3\.0|General Public License/);
});

// ── 独立验收补的用例（2026-11-09）──────────────────────────────────────

test('裁决 8（S4）：undo 守卫拒绝（超 7 天窗）→ 不留孤儿返工件、任务仍 done', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='done', closed_at=0, state_before_close='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 8 * 24 * 3600 * 1000 });
    const res = await engine.refireAfterApproval(taskId);
    assert.equal(res.ok, false);
    assert.match(res.reason, /task_reopen_refused/);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE task_id=?').get(taskId) as { n: number }).n;
    assert.equal(n, 1, '不留孤儿件（先重开再建件的顺序）');
    assert.equal((getTaskById(db, taskId) as { state: string }).state, 'done', '任务仍在 done');
  } finally {
    db.close();
  }
});

test('裁决 8（S7）：正常完成路径 state_before_close=verifying → 也能回到可执行并补跑', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='done', closed_at=5, state_before_close='verifying' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{\"toolName\":\"image_generate\",\"rule\":\"consent:spend\"}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    const res = await engine.refireAfterApproval(taskId);
    assert.equal(res.ok, true, JSON.stringify(res));
    const task = getTaskById(db, taskId) as { state: string };
    assert.notEqual(task.state, 'done');
    assert.notEqual(task.state, 'verifying', '不再卡在 verifying');
  } finally {
    db.close();
  }
});

test('裁决 8（S8 返工后）：补跑只为**本次批准的规则**、只给**新返工件会话**发 grant（不扩面）', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='done', closed_at=5, state_before_close='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wiId);
    // 任务里另有一条更晚、且老板**没批过**的 spend 卡——补跑绝不能顺手放行它。
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{\"toolName\":\"bash\",\"rule\":\"consent:egress\"}')").run(taskId, wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,2,'permission_requested','employee:7','{\"toolName\":\"image_generate\",\"rule\":\"consent:spend\"}')").run(taskId, wiId);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    await engine.refireAfterApproval(taskId, wiId, { rule: 'consent:egress', toolName: 'bash' });
    const row = db.prepare("SELECT policy FROM permission_policies WHERE scope_type='task' AND scope_id=?").get(taskId) as { policy: string } | undefined;
    const grants = (JSON.parse(row?.policy ?? '{}').grants ?? []) as Array<{ rule: string; toolName: string; sessionKey?: string }>;
    const ok = grants.find((x) => x.rule === 'consent:egress' && x.toolName === 'bash');
    assert.ok(ok, '只给本次批准的规则发 grant');
    const rework = db.prepare('SELECT id FROM work_items WHERE task_id=? AND retry_of=?').get(taskId, wiId) as { id: number };
    assert.equal(ok.sessionKey, `employee:7:task:${taskId}:wi:${rework.id}`, '绑到新返工件的会话键（不外溢到同任务其它件）');
    assert.equal(grants.some((x) => x.rule === 'consent:spend'), false, '没批过的 spend 规则不得被补跑放行');
  } finally {
    db.close();
  }
});

test('裁决 8（S5）：公司日预算超线 → 补跑拒绝（批准权限≠豁免预算）', async () => {
  const { db, taskId, wiId } = setupRefire();
  try {
    db.prepare("UPDATE tasks SET state='done', closed_at=5, state_before_close='executing' WHERE id=?").run(taskId);
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(wiId);
    db.prepare("INSERT INTO task_events(task_id, work_item_id, ts, kind, actor, payload) VALUES(?,?,1,'permission_requested','employee:7','{}')").run(taskId, wiId);
    // 日预算设 0.01 美元并先记 1 美元花销。
    db.prepare("INSERT INTO settings(key, value) VALUES('budget.companyDailyUsd','0.01') ON CONFLICT(key) DO UPDATE SET value='0.01'").run();
    db.prepare("INSERT INTO costs(task_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?,?,0,0,1,?)").run(taskId, 'x', 10);
    const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => 10 });
    const res = await engine.refireAfterApproval(taskId);
    assert.equal(res.ok, false);
    assert.match(res.reason, /budget_hold/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE task_id=?').get(taskId) as { n: number }).n, 1, '被预算拦下时不建件');
  } finally {
    db.close();
  }
});
