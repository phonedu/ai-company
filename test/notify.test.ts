/**
 * OPT-EXT-1 · 通知执行器（可见 / 去重 / 脱敏 / 空态）。
 * 每条断言**都能被弄红**（含两条"有牙"）；**空态不伪装**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { insertReport, listReports } from '../src/main/db/reports.js';
import { getNotificationByDedupeKey, listNotifications, insertNotification } from '../src/main/db/notifications.js';
import { notify, NOTIFICATION_KIND, setNotifyDeliveryHook } from '../src/main/notify/index.js';
import { handleInboxList, handleNotifyTest } from '../src/main/ipc/ipc.js';

function setup(): { db: ReturnType<typeof openMemoryDatabase>; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const counters = new SqliteCounterStore(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, counters, { projectId, title: 'T', goal: 'g', riskLevel: 0 });
  return { db, taskId: task.id };
}

/** 走 `inbox:list()` 的真实处理函数（只依赖 `deps.repo.listReports`）。 */
function inbox(db: ReturnType<typeof openMemoryDatabase>): Array<Record<string, unknown>> {
  const deps = { repo: { listReports: (opts: unknown) => listReports(db, opts as never) } };
  return handleInboxList(deps as never, { limit: 50 }) as unknown as Array<Record<string, unknown>>;
}

test('OPT-EXT-1 可见：notify() → inbox:list() 含该条，且 kind 标明来源', () => {
  const { db, taskId } = setup();
  try {
    const r = notify(db, { taskId, dedupeKey: 'n:1', payload: { title: '任务完成' } });
    assert.equal(r.delivered, true);
    const rows = inbox(db);
    assert.equal(rows.length, 1, '行数 == 通知数');
    assert.equal(rows[0].kind, NOTIFICATION_KIND, '来源 kind 可区分（notification vs report）');
    const payload = JSON.parse(String(rows[0].payload)) as { title: string };
    assert.equal(payload.title, '任务完成');
  } finally {
    db.close();
  }
});

test('OPT-EXT-1b 投递旁路：真投递触发一次（带 channel/payload）；重复不再触发；钩子异常不打断落库', () => {
  const { db, taskId } = setup();
  const seen: Array<{ channel: string; dedupeKey: string; taskId: number | null }> = [];
  setNotifyDeliveryHook((d) => {
    seen.push({ channel: d.channel, dedupeKey: d.dedupeKey, taskId: d.taskId });
  });
  try {
    notify(db, { taskId, dedupeKey: 'hook:1', payload: { title: '完成' } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.taskId, taskId, '投递旁路必须带 taskId（OS 通知点击回任务）');
    assert.equal(seen[0]!.channel, 'desktop');
    notify(db, { taskId, dedupeKey: 'hook:1', payload: { title: '重复' } });
    assert.equal(seen.length, 1, '幂等短路不重复触发旁路');

    setNotifyDeliveryHook(() => {
      throw new Error('hook boom');
    });
    assert.equal(notify(db, { taskId, dedupeKey: 'hook:2', payload: { title: '仍落库' } }).delivered, true, '旁路异常不影响投递');
    assert.equal(listReports(db, {}).length, 2, '通知仍落库（可见）');
  } finally {
    setNotifyDeliveryHook(null);
    db.close();
  }
});

test('OPT-EXT-1 去重：同 dedupe_key 投递两次 → 只 1 行（report + 台账都只 1）', () => {
  const { db, taskId } = setup();
  try {
    assert.equal(notify(db, { taskId, dedupeKey: 'dup', payload: { n: 1 } }).delivered, true);
    assert.equal(notify(db, { taskId, dedupeKey: 'dup', payload: { n: 2 } }).delivered, false, '第二次短路');
    assert.equal(listReports(db, {}).length, 1, 'report 只 1 条');
    assert.equal(listNotifications(db, {}).length, 1, '台账只 1 条');
  } finally {
    db.close();
  }
});

test('OPT-EXT-1 去重（有牙）：去掉"先查后写"这条守卫 → 直写 DAO 必叠加（证明短路真的在承重）', () => {
  const { db, taskId } = setup();
  try {
    // 绕过 notify 的 pre-check，直接落两次 report（模拟"短路被去掉"）：
    insertReport(db, { taskId, kind: 'notification', payload: {}, dedupeKey: 'x', now: 1 });
    insertReport(db, { taskId, kind: 'notification', payload: {}, dedupeKey: 'x', now: 2 });
    assert.equal(listReports(db, {}).length, 2, '无守卫时叠加 → 证明上一条断言的 1 行来自短路');
    // 台账侧仍有 DB 层 UNIQUE 兜底：同键第二写被丢弃。
    assert.equal(insertNotification(db, { channel: 'desktop', dedupeKey: 'x', sentAt: 1 }), true);
    assert.equal(insertNotification(db, { channel: 'desktop', dedupeKey: 'x', sentAt: 2 }), false, 'UNIQUE(dedupe_key) 兜底');
  } finally {
    db.close();
  }
});

test('OPT-EXT-1 脱敏：真写入 → 读回，密钥/绝对用户路径不得出现（保留 basename）', () => {
  const { db, taskId } = setup();
  try {
    notify(db, {
      taskId,
      dedupeKey: 'sec',
      payload: { note: '写到 C:\\Users\\Tup\\secret\\out.txt', apiKey: 'sk-abcdef123456' },
    });
    const raw = JSON.stringify(listReports(db, {}));
    assert.equal(raw.includes('sk-abcdef123456'), false, '密钥不得出现');
    assert.equal(raw.includes('Tup'), false, '绝对用户路径不得出现');
    assert.ok(raw.includes('<abs>/out.txt'), '保留 basename 便于排查');
    const parsed = JSON.parse(String(inbox(db)[0].payload)) as { apiKey: string };
    assert.equal(parsed.apiKey, '«redacted»', '敏感键整值替换');
  } finally {
    db.close();
  }
});

test('OPT-EXT-1 空态：无通知 → inbox:list() 为空，且不造占位条', () => {
  const { db } = setup();
  try {
    assert.deepEqual(inbox(db), [], '空态就是空，不伪装');
    assert.equal(getNotificationByDedupeKey(db, 'nope'), undefined);
  } finally {
    db.close();
  }
});

test('OPT-EXT-1 计数同源：inbox 行数 = report 数 = 通知数（两类之和可指到行）', () => {
  const { db, taskId } = setup();
  try {
    notify(db, { taskId, dedupeKey: 'a', payload: { t: 'A' } });
    notify(db, { taskId, dedupeKey: 'b', payload: { t: 'B' } });
    const rows = inbox(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.length, listReports(db, {}).length);
    for (const r of rows) assert.ok(typeof r.id === 'number', '每行可指到具体 id');
  } finally {
    db.close();
  }
});

test('2026-10-17：notify:test 直通（缺接线明确拒；接线则触发一次真实 notify）', () => {
  let called = 0;
  assert.deepEqual(handleNotifyTest({ repo: {} as never }), {
    ok: false,
    code: 'notify_unavailable',
    message: '通知通道不可用（非桌面环境）',
  });
  assert.deepEqual(handleNotifyTest({ repo: {} as never, notifyTest: () => { called += 1; } }), { ok: true });
  assert.equal(called, 1);
  const boom = handleNotifyTest({ repo: {} as never, notifyTest: () => { throw new Error('toast failed'); } });
  assert.equal(boom.ok, false);
  if (!boom.ok) assert.match(boom.message, /toast failed/);
});
