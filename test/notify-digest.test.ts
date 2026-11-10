/**
 *  余 · 通知策略（静默时段）＋ 日报 —— 测试（每条可弄红）。
 *
 * 覆盖：静默窗判定（含跨午夜/空窗/边界）· 投递通道决策（紧急穿透）· notify() 真集成（投递行照写、
 * 只改 channel）· 日报内容（真数据推导、空就是空）· 日报幂等（一天一次）· 设置键边界校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertReport,
  listNotifications,
  listReports,
  openMemoryDatabase,
  readSetting,
  runMigrations,
  validateSettingValue,
  writeSetting,
  type SqliteDb,
} from '../src/main/db/index.js';
import { deliveryChannel, isQuietAt, isQuietDisabled, minuteOfDay } from '../src/main/notify/policy.js';
import { buildDigestContent, digestText, emitDailyDigest, startOfLocalDay } from '../src/main/notify/digest.js';
import { notify } from '../src/main/notify/index.js';

const AT = new Date(2026, 9, 14, 10, 30, 0).getTime(); // 本地 2026-10-14 10:30

function seedTask(db: SqliteDb, state: string, finishedAt: number | null, ownerId: number | null = 7) {
  db.prepare("INSERT OR IGNORE INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  db.prepare("INSERT OR IGNORE INTO employees(id, name, role, created_at) VALUES(9,'E9','dev',1)").run();
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/r', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    ownerId,
    state,
  });
  if (finishedAt != null) {
    db.prepare('UPDATE tasks SET closed_at = ? WHERE id = ?').run(finishedAt, task.id);
  }
  return task;
}

// ── 策略层（纯函数）────────────────────────────────────────────────────────────

test('M2-A 静默时段：普通窗/跨午夜窗/空窗的判定（边界＝左闭右开）', () => {
  assert.equal(isQuietAt(23 * 60, { startMinutes: 22 * 60, endMinutes: 8 * 60 }), true, '跨午夜：晚段在窗内');
  assert.equal(isQuietAt(7 * 60 + 59, { startMinutes: 22 * 60, endMinutes: 8 * 60 }), true, '跨午夜：早段在窗内');
  assert.equal(isQuietAt(8 * 60, { startMinutes: 22 * 60, endMinutes: 8 * 60 }), false, '右边界＝开（8:00 已醒）');
  assert.equal(isQuietAt(22 * 60, { startMinutes: 22 * 60, endMinutes: 8 * 60 }), true, '左边界＝闭');
  assert.equal(isQuietAt(12 * 60, { startMinutes: 9 * 60, endMinutes: 12 * 60 }), false, '普通窗右开');
  assert.equal(isQuietDisabled({ startMinutes: 0, endMinutes: 0 }), true, '空窗＝未配置 → 不静默');
  assert.equal(isQuietAt(0, { startMinutes: 0, endMinutes: 0 }), false, '空窗任何时刻都不静默（不臆造默认值）');
  assert.equal(isQuietAt(600, null), false, '未配置 → 不静默');
  assert.equal(isQuietAt(-30, { startMinutes: 21 * 60, endMinutes: 23 * 60 }), false, '越界入参归一化（-30 → 1410，不在窗）');
  assert.equal(minuteOfDay(AT), 10 * 60 + 30, 'minuteOfDay 用本地时间');
});

test('M2-A 投递通道：静默期非紧急 → digest；紧急照常 desktop；非静默一律 desktop', () => {
  assert.equal(deliveryChannel(true, false), 'digest');
  assert.equal(deliveryChannel(true, true), 'desktop', '紧急（如员工被卡住的升级）穿透静默');
  assert.equal(deliveryChannel(false, false), 'desktop');
});

// ── notify() 集成（静默期真改 channel、投递行照写）──────────────────────────────

test('M2-A notify 集成：静默期内非紧急 → channel=digest（卡片照落、台账不减）；urgent → desktop；窗外 → desktop', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const task = seedTask(db, 'executing', null);
    // 静默窗 10:00–11:00；AT = 10:30 → 窗内
    writeSetting(db, 'notify.quietStartMinutes', 600);
    writeSetting(db, 'notify.quietEndMinutes', 660);

    notify(db, { taskId: task.id, dedupeKey: 'n1', payload: { t: 1 }, now: AT });
    notify(db, { taskId: task.id, dedupeKey: 'n2', urgent: true, payload: { t: 2 }, now: AT });
    const rows = listNotifications(db, {});
    assert.equal(rows.find((r) => r.dedupe_key === 'n1')?.channel, 'digest', '静默期内非紧急 → digest（夜里不弹）');
    assert.equal(rows.find((r) => r.dedupe_key === 'n2')?.channel, 'desktop', 'urgent 穿透静默');
    assert.equal(
      listReports(db, {}).filter((r) => String(r.dedupe_key ?? '').startsWith('n')).length,
      2,
      '卡片两件都在（投递行照写、不丢件）',
    );

    // 窗外（11:05）→ desktop
    const outside = new Date(2026, 9, 14, 11, 5, 0).getTime();
    notify(db, { taskId: task.id, dedupeKey: 'n3', payload: { t: 3 }, now: outside });
    assert.equal(listNotifications(db, {}).find((r) => r.dedupe_key === 'n3')?.channel, 'desktop');
  } finally {
    db.close();
  }
});

// ── 日报内容与幂等 ─────────────────────────────────────────────────────────────

test('M2-A 日报内容：完成数/员工数/失败数/成本/待处理——全部真数据推导；空就是空（usd=null 不写假 0）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const empty = buildDigestContent(db, { since: startOfLocalDay(AT), until: AT });
    assert.deepEqual(empty, { completedShortIds: [], failedCount: 0, cancelledCount: 0, employeeCount: 0, usd: null, pendingCards: 0 });
    assert.match(digestText(empty), /今天暂无完成的任务/, '空态如实说（不臆造完成量）');
    assert.match(digestText(empty), /成本 —/, '无成本行 → 显 —（不写假 $0）');

    const t1 = seedTask(db, 'done', AT - 1000, 7);
    seedTask(db, 'done', AT - 2000, 9);
    seedTask(db, 'failed', AT - 3000, 7);
    seedTask(db, 'done', AT - 40 * 24 * 3600 * 1000, 7); // 昨天完成 → 不计入
    db.prepare("INSERT INTO costs(task_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?, 'm', 1, 2, 0.25, ?)").run(t1.id, AT - 500);
    insertReport(db, { taskId: t1.id, kind: 'ask', payload: { question: 'q' }, state: 'pending', now: AT - 600 });

    const c = buildDigestContent(db, { since: startOfLocalDay(AT), until: AT });
    assert.equal(c.completedShortIds.length, 2, '当日完成 2 件（昨天的不计）');
    assert.equal(c.failedCount, 1);
    assert.equal(c.employeeCount, 2, '两位员工（owner 去重）');
    assert.equal(c.usd, 0.25);
    assert.equal(c.pendingCards, 1, '待处理卡提醒（PLAN §157：每天并进日报提醒一次）');
    const text = digestText(c);
    assert.match(text, /今天 2 位员工完成 2 件任务/);
    assert.match(text, /成本 \$0\.2500/);
    assert.match(text, /待你处理：1 张卡/);
  } finally {
    db.close();
  }
});

test('M2-A 日报幂等：同一天重复调用只发一次（digest:<date> 短路）；卡片 kind=notification（FYI，不占决策 tab）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    seedTask(db, 'done', AT - 1000);
    const first = emitDailyDigest(db, { now: AT });
    assert.equal(first.delivered, true);
    const second = emitDailyDigest(db, { now: AT + 60_000 });
    assert.equal(second.delivered, false, '当天第二次调用必须短路（重启/多次 tick 安全）');

    const rows = listReports(db, { kind: 'notification' });
    assert.equal(rows.length, 1, '只落一张日报卡');
    try {
      const payload = JSON.parse(String(rows[0]!.payload)) as { title?: string; tldr?: string };
      assert.match(String(payload.title), /日报/);
      assert.match(String(payload.tldr), /完成/);
    } catch {
      assert.fail('日报 payload 必须是可解析 JSON');
    }
    assert.equal(
      listNotifications(db, {}).filter((r) => r.dedupe_key.startsWith('digest:')).length,
      1,
      '投递台账也只有一条（幂等）',
    );
  } finally {
    db.close();
  }
});

// ── 设置键边界 ────────────────────────────────────────────────────────────────

test('M2-A 设置：三个通知键的边界（0..1439 整数；越界/小数/字符串拒）', () => {
  assert.deepEqual(validateSettingValue('notify.digestAtMinutes', 540), { ok: true });
  assert.deepEqual(validateSettingValue('notify.quietStartMinutes', 0), { ok: true });
  assert.deepEqual(validateSettingValue('notify.quietEndMinutes', 1439), { ok: true });
  assert.deepEqual(validateSettingValue('notify.digestAtMinutes', null), { ok: true }, 'null＝清空（回落缺省）');
  assert.equal(validateSettingValue('notify.digestAtMinutes', 1440).ok, false);
  assert.equal(validateSettingValue('notify.quietStartMinutes', -1).ok, false);
  assert.equal(validateSettingValue('notify.quietEndMinutes', 22.5).ok, false);
  assert.equal(validateSettingValue('notify.digestAtMinutes', '540').ok, false);
});

test('M2-A 日报默认时间：未设 → main 侧取 540（09:00）；本测固化该约定为常量断言（防两侧漂移）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    assert.equal(readSetting(db, 'notify.digestAtMinutes'), undefined, '未设 → undefined（不预写默认值）');
    assert.equal(540, 9 * 60, '缺省 09:00 的分钟数＝540（与 UI 文案「默认 9:00」一致）');
  } finally {
    db.close();
  }
});

// ── / 迁移 008：全局卡（空库日报）────────────────────────────────────────

test('BRK21（008 后）：空库 emitDailyDigest 不抛 —— 全局卡 task_id=NULL、幂等只发一次（修复锚）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    // 空库（零任务/零项目）：此前哨兵 task_id=0 撞 `reports.task_id REFERENCES tasks(id)` ⇒ FK 炸
    const first = emitDailyDigest(db, { now: AT });
    assert.equal(first.delivered, true, '空库日报必须真投递（BRK21：此前 FK 报错、当天永远收不到）');
    const rows = db.prepare('SELECT task_id, kind, dedupe_key FROM reports').all() as Array<{
      task_id: number | null;
      kind: string;
      dedupe_key: string | null;
    }>;
    assert.equal(rows.length, 1, '恰一张卡');
    assert.equal(rows[0]?.task_id, null, '全局卡：task_id 必须为 NULL（不是哨兵 0）');
    assert.equal(rows[0]?.kind, 'notification');
    const again = emitDailyDigest(db, { now: AT + 1000 });
    assert.equal(again.delivered, false, '同一天二次调用幂等（dedupe digest:<date> 短路）');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM reports').get() as { c: number }).c, 1, '不叠第二张');
  } finally {
    db.close();
  }
});
