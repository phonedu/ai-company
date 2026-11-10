/**
 * （57 P0-3 协作面；）：员工唤醒＋协作原语结构化。
 *
 * 口径：
 *  - `spawnReplyWorkItem`：ask 送达后，**目标员工空闲**（无 running 件）→ 在提问方任务里
 *    派**轻量 reply 工作项**（brief=问题＋answer_colleague 指引＋dedupeKey；参与任务聚合与
 *    成本归属）；目标忙 → 'busy'（问题留在 mailbox，下次会话可见——现状）；同 askKey 已有
 *    未结 reply 件 → 'exists'（幂等，重放不重复派）。
 *  - 结构化答复：answer_colleague 增可选多字段（conclusion/evidence/artifacts/followup），
 *    `formatStructuredAnswer` 组装人话文本投递；旧单句 answer 完全兼容（原样投递）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openMemoryDatabase,
  runMigrations,
  createTask,
  insertEmployee,
  insertWorkItem,
  listWorkItemsByTask,
  type SqliteDb,
} from '../src/main/db/index.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { requestAsk } from '../src/main/engine/mailbox.js';
import { spawnReplyWorkItem } from '../src/main/engine/mailbox.js';
import { formatStructuredAnswer } from '../src/main/agent/answer-colleague-tool.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seed(db: SqliteDb): { taskId: number } {
  insertEmployee(db, { id: 7, name: '提问者', role: 'dev', now: 1 });
  insertEmployee(db, { id: 8, name: '被问者', role: 'dev', now: 1 });
  const projectId = Number(
    (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run() as { lastInsertRowid: number }).lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1, ownerId: 7 });
  return { taskId: task.id };
}

test('B2-5: 目标空闲 → spawnReplyWorkItem 派轻量 reply 件（问题＋dedupeKey＋作答指引，事件在案）', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db);
    const rec = requestAsk(db, { taskId, workItemId: null, from: 7, to: 8, question: '数据源用哪个接口？', seq: 'r0-0', now: 1 });
    assert.equal(rec.delivered, true);
    const outcome = spawnReplyWorkItem(db, {
      taskId,
      askDedupeKey: rec.dedupeKey,
      from: 7,
      to: 8,
      question: '数据源用哪个接口？',
      now: 2,
    });
    assert.equal(outcome, 'spawned');
    const items = listWorkItemsByTask(db, taskId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.employee_id, 8, 'reply 件派给被问员工');
    assert.match(items[0]!.title, /回复.*7/);
    assert.match(items[0]!.brief, /数据源用哪个接口/);
    assert.ok(items[0]!.brief.includes(String(rec.dedupeKey)), 'brief 必须带 askDedupeKey（作答寻址）');
    assert.match(items[0]!.brief, /answer_colleague/);
    const evt = db.prepare("SELECT payload FROM task_events WHERE kind='work_item_created' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    assert.ok(evt.payload.includes(String(rec.dedupeKey)), '事件 payload 带 askKey（审计/去重）');
  } finally {
    db.close();
  }
});

test('B2-5: 目标忙 → busy 不派（问题留 mailbox）；同 askKey 重复 → exists 幂等', () => {
  const db = fresh();
  try {
    const { taskId } = seed(db);
    // 忙：员工 8 有 running 件
    const busy = insertWorkItem(db, { taskId, employeeId: 8, title: '在跑', brief: 'b', now: 1 });
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(busy.id);
    const rec = requestAsk(db, { taskId, workItemId: null, from: 7, to: 8, question: 'q', seq: 'r0-0', now: 1 });
    assert.equal(spawnReplyWorkItem(db, { taskId, askDedupeKey: rec.dedupeKey, from: 7, to: 8, question: 'q', now: 2 }), 'busy');
    assert.equal(listWorkItemsByTask(db, taskId).length, 1, '忙时不新增件');
    // 空闲后派件；重复调用 → exists
    db.prepare("UPDATE work_items SET state='done' WHERE id=?").run(busy.id);
    const rec2 = requestAsk(db, { taskId, workItemId: null, from: 7, to: 8, question: 'q2', seq: 'r0-1', now: 2 });
    assert.equal(spawnReplyWorkItem(db, { taskId, askDedupeKey: rec2.dedupeKey, from: 7, to: 8, question: 'q2', now: 3 }), 'spawned');
    assert.equal(spawnReplyWorkItem(db, { taskId, askDedupeKey: rec2.dedupeKey, from: 7, to: 8, question: 'q2', now: 4 }), 'exists', '同 askKey 幂等');
    assert.equal(listWorkItemsByTask(db, taskId).length, 2, '不重复派件');
  } finally {
    db.close();
  }
});

test('B2-5: formatStructuredAnswer——结构化多字段组装；旧单句原样兼容', () => {
  // 结构化：结论＋依据＋产物引用＋追问
  const full = formatStructuredAnswer({
    answer: '用 v2 接口',
    conclusion: '数据源统一走 v2 分页接口',
    evidence: ['实测 v2 返回 200 且含分页头', 'v1 已标记 deprecated'],
    artifacts: ['docs/api-notes.md'],
    followup: '要不要我把 v1 调用点一起迁移？',
  });
  assert.match(full, /结论/);
  assert.match(full, /v2 分页接口/);
  assert.match(full, /依据/);
  assert.match(full, /v1 已标记 deprecated/);
  assert.match(full, /产物引用/);
  assert.match(full, /docs\/api-notes\.md/);
  assert.match(full, /追问/);
  assert.match(full, /要不要我/);
  // 旧单句：无结构化字段 → 原样（不注入空段）
  assert.equal(formatStructuredAnswer({ answer: '直接用 v2' }), '直接用 v2');
  // 混合：answer＋部分字段
  const partial = formatStructuredAnswer({ answer: 'ok', conclusion: '结论 X' });
  assert.match(partial, /结论 X/);
  assert.match(partial, /ok/);
});
