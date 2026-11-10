/**
 * RET-1 P2（RET-/04）：检索召回/隔离/来源，及上下文查询文本扩展。
 * 判据：同项目命中、跨项目零命中、预筛 OR 不被常见词挤掉、memory_items 纳入（pinned 不重复）、
 * 工作简报里的词能触发历史检索。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  appendMemory,
  createTask,
  insertArtifact,
  insertEmployee,
  insertTaskEvent,
  insertWorkItem,
  openMemoryDatabase,
  replacePlanSteps,
  runMigrations,
  searchRelated,
  type SqliteDb,
} from '../src/main/db/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';

const AT = 1_800_000_000_000;

function setup(): { db: SqliteDb; projects: { A: number; B: number }; taskA: number; taskB: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: AT });
  const pid = (name: string) => Number(db.prepare('INSERT INTO projects(name,root_dir,created_at) VALUES(?,?,?)').run(name, `D:/${name}`, AT).lastInsertRowid);
  const A = pid('A');
  const B = pid('B');
  const taskA = createTask(db, new SqliteCounterStore(db), { projectId: A, title: '当前任务', goal: 'g', riskLevel: 0, ownerId: 7, now: AT }).id;
  const taskB = createTask(db, new SqliteCounterStore(db), { projectId: B, title: '当前任务B', goal: 'g', riskLevel: 0, ownerId: 7, now: AT }).id;
  return { db, projects: { A, B }, taskA, taskB };
}

function historyTask(db: SqliteDb, projectId: number, title: string): number {
  return createTask(db, new SqliteCounterStore(db), { projectId, title, goal: 'g', riskLevel: 0, ownerId: 7, now: AT }).id;
}

test('RET-F-03: 同项目记忆/事件/产物/事实命中；跨项目零命中', () => {
  const { db, projects, taskA } = setup();
  try {
    appendMemory(db, { employeeId: 7, projectId: projects.A, block: '- 对账规则：以万元为单位，月末核对。', marker: '对账规则', now: AT });
    appendMemory(db, { employeeId: 7, projectId: projects.B, block: '- B 项目专属：对账用美元。', marker: 'B 项目', now: AT });
    const hA = historyTask(db, projects.A, '历史对账任务');
    insertTaskEvent(db, { taskId: hA, workItemId: null, ts: AT, kind: 'submitted_summary', actor: 'employee', payload: { summary: '对账以万元为单位，已核对。' } });
    insertArtifact(db, { taskId: hA, workItemId: null, kind: 'file', path: 'reports/对账清单.md', sha256: 'a'.repeat(64), now: AT });
    db.prepare(
      "INSERT INTO memory_items(scope_type,scope_id,kind,key,value,source_type,confidence,status,pinned,created_at,updated_at) VALUES('project',?,'fact','billing.unit','对账以万元为单位','boss','confirmed','active',0,?,?)",
    ).run(projects.A, AT, AT);
    db.prepare(
      "INSERT INTO memory_items(scope_type,scope_id,kind,key,value,source_type,confidence,status,pinned,created_at,updated_at) VALUES('project',?,'fact','billing.unit.b','对账以美元为单位 B','boss','confirmed','active',0,?,?)",
    ).run(projects.B, AT, AT);

    const hits = searchRelated(db, { projectId: projects.A, taskId: taskA, text: '对账 万元', limit: 10 });
    const sources = new Set(hits.map((h) => h.source));
    assert.ok(sources.has('memory'), '记忆应命中');
    assert.ok(sources.has('artifact'), '产物应命中');
    assert.ok(sources.has('fact'), '项目事实应命中');
    assert.ok(hits.every((h) => !h.text.includes('美元')), '不得混入 B 项目内容');

    const none = searchRelated(db, { projectId: projects.B, taskId: 9999, text: '对账 万元', limit: 10 });
    assert.ok(none.every((h) => !h.text.includes('万元')), 'B 项目不得命中 A 的内容');
  } finally {
    db.close();
  }
});

test('RET-F-03: 预筛用前 3 词 OR——常见词堆满时仍能召回含其他词的历史', () => {
  const { db, projects, taskA } = setup();
  try {
    const decoy = historyTask(db, projects.A, '常见词任务');
    for (let i = 0; i < 25; i += 1) {
      insertTaskEvent(db, { taskId: decoy, workItemId: null, ts: AT + i, kind: 'submitted_summary', actor: 'employee', payload: { summary: 'alpha 常见词 ' + i } });
    }
    const target = historyTask(db, projects.A, '目标任务');
    insertTaskEvent(db, { taskId: target, workItemId: null, ts: AT - 10, kind: 'submitted_summary', actor: 'employee', payload: { summary: 'alpha beta 目标片段' } });
    const hits = searchRelated(db, { projectId: projects.A, taskId: taskA, text: 'alpha beta 目标片段', limit: 10 });
    assert.ok(hits.some((h) => h.text.includes('beta 目标片段')), '含第 2/3 词的历史不得被首词挤出');
  } finally {
    db.close();
  }
});

test('RET-F-03: memory_items 只取项目级 active 非 pinned；pinned/global 不进检索', () => {
  const { db, projects, taskA } = setup();
  try {
    const ins = (scope: 'project' | 'global', scopeId: number, key: string, value: string, pinned: number): unknown =>
      db.prepare(
        "INSERT INTO memory_items(scope_type,scope_id,kind,key,value,source_type,confidence,status,pinned,created_at,updated_at) VALUES(?,?,'fact',?,?,'boss','confirmed','active',?,?,?)",
      ).run(scope, scopeId, key, value, pinned, AT, AT);
    ins('project', projects.A, 'k1', '检索哨兵' + 'ZQ1', 0);
    ins('project', projects.A, 'k2', '检索哨兵' + 'ZQ2', 1);
    ins('global', 0, 'k3', '检索哨兵' + 'ZQ3', 0);
    const hits = searchRelated(db, { projectId: projects.A, taskId: taskA, text: '检索哨兵', limit: 10 }).filter((h) => h.source === 'fact');
    assert.ok(hits.some((h) => h.text.includes('ZQ1')), '非 pinned 项目事实应命中');
    assert.ok(hits.every((h) => !h.text.includes('ZQ2')), 'pinned 事实已进事实层，不在检索里重复');
    assert.ok(hits.every((h) => !h.text.includes('ZQ3')), '全局事实不跨项目检索');
  } finally {
    db.close();
  }
});

test('RET-F-03: 工作简报里的关键词能触发历史检索（上下文查询文本已扩展）', () => {
  const { db, projects, taskA } = setup();
  try {
    const wi = insertWorkItem(db, { taskId: taskA, employeeId: 7, title: 'work', brief: '按 BRIEFONLY-77 的口径核对', now: AT });
    replacePlanSteps(db, taskA, ['先查历史'], AT);
    const historical = historyTask(db, projects.A, '历史相关');
    insertTaskEvent(db, { taskId: historical, workItemId: null, ts: AT, kind: 'submitted_summary', actor: 'employee', payload: { summary: '历史结论 BRIEFONLY-77 已确认' } });
    const ctx = buildEmployeeContext(db, { employeeId: 7, taskId: taskA, workItemId: wi.id });
    assert.match(ctx.systemPrompt, /\[历史检索\]/, '简报里的关键词应触发检索段');
    assert.match(ctx.systemPrompt, /BRIEFONLY-77/);
  } finally {
    db.close();
  }
});
