/**
 * 卡片可读性批（2026-10-28 圈定「都按你说的改」；其中 3/4 经核实为误报已更正）：
 * ① 选项按钮的英文 key 前缀（approve/revise/…）是给微信回序号用的，桌面端隐藏——
 *    Card/InboxView 不得再渲染 card__key/inbox-row__key 前缀（IM 侧格式化不受影响，独立生成）。
 * ② 权限卡正文是技术原串（[权限] 频道写操作 bash（autonomy:strict）[project:1|session:…]）——
 *    老板看不出「谁、想干什么、在哪个项目」。gate 组卡时附结构化 permissionDetail
 *    （who/action/project/session），渲染层优先三行字段＋折叠技术细节；老卡（无 detail）回落原串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { permissionDetailLines } from '../src/renderer/components/cardAnswer.js';
import { persistChannelGateDecision, persistSessionGateDecision } from '../src/main/agent/session-tool-gate.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import type { SqliteDb } from '../src/main/db/index.js';

// ── ① key 前缀隐藏（源码守卫） ─────────────────────────────────────────────

test('可读① 选项按钮不再渲染英文 key 前缀（桌面端）', () => {
  const card = readFileSync('src/renderer/components/Card.tsx', 'utf8');
  assert.doesNotMatch(card, /className="card__key"/, 'Card 不得渲染 card__key 前缀 span');
  const inbox = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  assert.doesNotMatch(inbox, /inbox-row__key/, 'InboxView 不得渲染 key 前缀 span');
});

// ── ② 权限卡结构化（纯函数） ────────────────────────────────────────────────

test('可读② permissionDetailLines：有结构化字段 → 三行人话；无 → null（老卡回落原串）', () => {
  const lines = permissionDetailLines({
    permissionDetail: { who: '幕僚长', action: '频道写操作 bash（规则 autonomy:strict）', project: 'review-site', session: 'boss-channel:demo' },
  });
  assert.equal(lines?.who, '幕僚长');
  assert.equal(lines?.action, '频道写操作 bash（规则 autonomy:strict）');
  assert.equal(lines?.project, 'review-site');
  assert.equal(lines?.session, 'boss-channel:demo');
  assert.equal(permissionDetailLines({}), null, '老卡（无 detail）→ null 回落 question 原串');
  assert.equal(permissionDetailLines({ permissionDetail: { who: '', action: 'x', project: 'y' } }), null, '缺 who 的坏数据不猜 → null');
});

// ── ② gate 组卡附带 permissionDetail（真库断言） ─────────────────────────────

function seed(db: SqliteDb): { projectId: number; taskId: number } {
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('review-site','D:/rs',1)").run().lastInsertRowid,
  );
  const taskId = Number(
    db.prepare("INSERT INTO tasks(short_id, project_id, title, goal, acceptance, state, origin, created_at, updated_at) VALUES('T-2001', ?, 't', 'g', '[]', 'executing', 'boss', 1, 1)").run(projectId).lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, is_assistant, active, created_at) VALUES(0, '幕僚长', 'assistant', 1, 1, 1)").run();
  db.prepare("INSERT INTO employees(id, name, role, is_assistant, active, created_at) VALUES(1, '林川', 'dev', 0, 1, 1)").run();
  return { projectId, taskId };
}

function lastCardPayload(db: SqliteDb): Record<string, unknown> {
  const row = db.prepare('SELECT payload FROM reports ORDER BY id DESC LIMIT 1').get() as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

test('可读③ 频道 gate ask → 卡 payload 带 permissionDetail（who=幕僚长，project=项目名）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { projectId } = seed(db);
    persistChannelGateDecision(
      db,
      {
        decision: 'ask',
        toolName: 'bash',
        rule: 'autonomy:strict',
        reason: '频道写操作',
        run: { employeeId: 0, taskId: null, workItemId: null, projectId, sessionKey: 'boss-channel:demo', writeMode: 'confirm' },
      } as never,
      100,
    );
    const card = lastCardPayload(db);
    const detail = card.permissionDetail as { who: string; action: string; project: string; session: string };
    assert.equal(detail.who, '幕僚长', 'assistant 会话的 who＝幕僚长');
    assert.match(detail.action, /bash/);
    assert.equal(detail.project, 'review-site', 'project 用项目名不是 id');
    assert.equal(detail.session, 'boss-channel:demo', 'session 收进 detail（卡面折叠）');
  } finally {
    db.close();
  }
});

test('可读④ 员工会话 gate ask → permissionDetail.who＝员工名', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const { taskId } = seed(db);
    persistSessionGateDecision(
      db,
      {
        decision: 'ask',
        toolName: 'bash',
        rule: 'env_file',
        reason: '触碰环境文件',
        run: { employeeId: 1, taskId, workItemId: null, sessionKey: 'task:1:dev' },
      } as never,
      100,
    );
    const card = lastCardPayload(db);
    const detail = card.permissionDetail as { who: string; project: string };
    assert.equal(detail.who, '林川', '员工会话的 who＝员工名');
    assert.equal(detail.project, 'review-site', '经 taskId 反查项目名');
  } finally {
    db.close();
  }
});
