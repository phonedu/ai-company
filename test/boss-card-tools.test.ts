/**
 * RW-51（2026-11-05 老板定性「必须做到」）：幕僚长待办卡工具——自然话驱动待办的地基。
 * 判据：boss_inbox 只读列卡（含选项与推荐）；boss_card_resolve 走既有审批真路径
 * （DAO 投影 reports resolved + needs_decision 推 decision_made 引擎事件 + 权限批准发 grant）；
 * 选项 key 不在卡面 → 明确报错并列出可选（不猜）；ack 只清卡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBossCardTools } from '../src/main/agent/boss-card-tools.js';
import type { EngineEvent } from '../src/main/engine/types.js';

interface Tools {
  inboxTool: { execute: (id: string, p: object) => Promise<{ content: Array<{ text: string }>; details?: unknown }> };
  resolveTool: { execute: (id: string, p: { action: 'ack' | 'select'; card: number; chosen?: string }) => Promise<{ content: Array<{ text: string }>; details?: unknown }> };
}

async function setup(): Promise<{ tools: Tools; db: DatabaseSync; dispatched: EngineEvent[]; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'aico-card-tools-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, alias TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, state TEXT);
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY, task_id INTEGER, kind TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', dedupe_key TEXT, created_at INTEGER NOT NULL,
      delivered_at INTEGER, acknowledged_at INTEGER, verdict TEXT, verifier_employee_id INTEGER
    );
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY, task_id INTEGER, report_id INTEGER, question TEXT,
      options TEXT NOT NULL DEFAULT '[]', default_action TEXT, timeout_at INTEGER,
      chosen TEXT, decided_by TEXT, decided_at INTEGER
    );
  `);
  db.prepare("INSERT INTO tasks (id, state) VALUES (77, 'needs_decision')").run();
  db.prepare("INSERT INTO approvals (id, task_id, report_id, chosen) VALUES (900, 77, 800, NULL)").run();
  db.prepare(
    "INSERT INTO reports (id, kind, state, task_id, payload, created_at) VALUES (800, 'ask', 'pending', 77, ?, 1000)"
  ).run(JSON.stringify({
    title: '等你决策：T-77',
    options: [{ key: 'proceed', recommended: true }, { key: 'cancel' }],
  }));
  const dispatched: EngineEvent[] = [];
  const tools = (await createBossCardTools({
    db: db as unknown as Parameters<typeof createBossCardTools>[0]['db'],
    engine: { dispatch: async (e: EngineEvent) => { dispatched.push(e); } },
    onInboxChanged: () => undefined,
  })) as unknown as Tools;
  return { tools, db, dispatched, dir };
}

test('RW-51 boss_inbox：只读列出待办卡（含选项与推荐标记），不动数据', async () => {
  const { tools, db, dir } = await setup();
  const r = await tools.inboxTool.execute('t', {});
  const text = r.content[0]!.text;
  assert.match(text, /待办 1 张/);
  assert.match(text, /卡#800/);
  assert.match(text, /proceed（推荐）/);
  const count = (db.prepare("SELECT COUNT(*) AS c FROM reports WHERE state='pending'").get() as { c: number }).c;
  assert.equal(count, 1, '只读不改变状态');
  rmSync(dir, { recursive: true, force: true });
});

test('RW-51 boss_card_resolve select：走审批真路径＋推 decision_made＋卡面 key 校验', async () => {
  const s1 = await setup();
  const bad = await s1.tools.resolveTool.execute('t', { action: 'select', card: 800, chosen: '瞎选的' });
  assert.match(bad.content[0]!.text, /不在卡面上/);
  assert.equal(s1.dispatched.length, 0, '坏选项不推引擎');
  const good = await s1.tools.resolveTool.execute('t', { action: 'select', card: 800, chosen: 'proceed' });
  assert.match(good.content[0]!.text, /按「proceed」作答/);
  // proceed 机器边无 payload（approvalAnswerEvent 只回 event）
  assert.deepEqual(s1.dispatched, [{ scope: 'task', id: 77, event: 'decision_proceed_latest', actor: 'boss', payload: undefined }]);
  const cardState = (s1.db.prepare('SELECT state FROM reports WHERE id=800').get() as { state: string }).state;
  assert.equal(cardState, 'resolved', '卡随审批联动 resolved');
  const approval = (s1.db.prepare('SELECT chosen FROM approvals WHERE id=900').get() as { chosen: string }).chosen;
  assert.equal(approval, 'proceed');
  rmSync(s1.dir, { recursive: true, force: true });
});

test('RW-51 boss_card_resolve ack：只清卡、不推引擎', async () => {
  const s2 = await setup();
  const r = await s2.tools.resolveTool.execute('t', { action: 'ack', card: 800 });
  assert.match(r.content[0]!.text, /已清除/);
  assert.equal(s2.dispatched.length, 0);
  const st = (s2.db.prepare('SELECT state FROM reports WHERE id=800').get() as { state: string }).state;
  assert.equal(st, 'acknowledged');
  rmSync(s2.dir, { recursive: true, force: true });
});
