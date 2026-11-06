/**
 * S13-E P2 尾项（2026-10-29，老板「这个可以做了」）：
 *  D-N07 合并冲突派回原员工（建续办任务，指派原执行者，冲突文件进目标）；
 *  D-N09 diff 行内批注（按任务/变更集/文件存储，打回时汇总进 notes）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SqliteCounterStore,
  createTask,
  insertChangeset,
  insertTaskEvent,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
} from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  diffNotesStorageKey,
  diffNotesTaskPrefix,
  parseDiffNoteMap,
  pathFromDiffNotesKey,
  summarizeDiffNotes,
} from '../src/renderer/components/diffNotes.js';

const AT = 1_800_000_000_000;

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,created_at) VALUES(0,'幕僚长','assistant',1,1)").run();
  db.prepare("INSERT INTO employees(id,name,role,is_assistant,created_at) VALUES(7,'林川','dev',0,1)").run();
  const pid = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid);
  const task = createTask(db, new SqliteCounterStore(db), { projectId: pid, title: '冲突任务', goal: 'g', riskLevel: 1, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: AT });
  const cs = insertChangeset(db, {
    taskId: task.id,
    workItemId: wi.id,
    branch: 'aico/T-1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    state: 'open',
    now: AT,
  });
  insertTaskEvent(db, {
    taskId: task.id,
    ts: AT,
    kind: 'action_failed',
    actor: 'boss',
    payload: { action: 'task_merge', changesetId: cs.row.id, reason: 'merge_conflict', conflicts: ['a.txt', 'docs/b.md'] },
  });
  return { db, repo: createSqliteChatRepo(db), pid, taskId: task.id, changesetId: cs.row.id };
}

test('D-N07① 派回原员工：建续办任务、指派原执行者、冲突文件进目标', () => {
  const { db, repo, taskId, changesetId } = setup();
  try {
    const res = repo.reworkMergeConflict(taskId, changesetId, AT + 1);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.employeeId, 7);
    assert.equal(res.conflicts.length, 2);
    const row = db.prepare('SELECT title, goal, owner_id, parent_task_id, renewed_from, origin FROM tasks WHERE id = ?').get(res.taskId) as {
      title: string;
      goal: string;
      owner_id: number;
      parent_task_id: number;
      renewed_from: number;
      origin: string;
    };
    assert.match(row.title, /修复合并冲突/);
    assert.match(row.goal, /a\.txt/);
    assert.match(row.goal, /重试合并/);
    assert.equal(row.owner_id, 7);
    assert.equal(row.parent_task_id, taskId);
    assert.equal(row.renewed_from, taskId);
    assert.equal(row.origin, 'renew');
    assert.ok(listTaskEvents(db, taskId).some((event) => event.kind === 'merge_conflict_rework'));
  } finally {
    db.close();
  }
});

test('D-N07② 变更集不属于该任务 → not_found（不建任务）', () => {
  const { db, repo, taskId } = setup();
  try {
    const res = repo.reworkMergeConflict(taskId, 9999, AT);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'not_found');
  } finally {
    db.close();
  }
});

test('D-N09 diff 批注：键/解析/汇总可往返，坏 JSON 不炸', () => {
  const key = diffNotesStorageKey(5, 12, 'docs/a.md');
  assert.equal(key, 'aico:diff-notes:5:12:docs/a.md');
  assert.equal(diffNotesTaskPrefix(5), 'aico:diff-notes:5:');
  assert.equal(pathFromDiffNotesKey(key), 'docs/a.md');
  assert.equal(pathFromDiffNotesKey('bad'), null);
  const map = parseDiffNoteMap(JSON.stringify({ '12': '这里少了错误处理', '13': '  ' }));
  assert.deepEqual(map, { '12': '这里少了错误处理' });
  assert.deepEqual(parseDiffNoteMap('{bad'), {});
  assert.equal(
    summarizeDiffNotes([
      { path: 'docs/a.md', line: '12', note: '这里少了错误处理' },
      { path: 'docs/b.md', line: '3', note: '改个名字' },
    ]),
    'diff 批注：\n- docs/a.md:12 这里少了错误处理\n- docs/b.md:3 改个名字',
  );
});

test('D-N09 接线：冲突面板有派回按钮；diff 行有批注入口；打回会收集批注', () => {
  const detail = readFileSync('src/renderer/components/TaskDetail.tsx', 'utf8');
  assert.match(detail, /data-testid="merge-conflict-rework"/);
  assert.match(detail, /data-testid="diff-note-toggle"/);
  assert.match(detail, /data-testid="diff-note-input"/);
  assert.match(detail, /collectDiffNotes\(\)/);
  assert.match(detail, /setRejectNotes\(summary\)/);
  // 真机回归：预填后不得再把 notes 清空（旧代码在 prefill 后紧跟 setRejectNotes('')）。
  const prefill = detail.slice(detail.indexOf('setRejectNotes(summary)'), detail.indexOf('setRejectNotes(summary)') + 300);
  assert.doesNotMatch(prefill, /setRejectNotes\(''\)/, '预填后不得清空批注');
  const view = readFileSync('src/renderer/components/TaskDetailView.tsx', 'utf8');
  assert.match(view, /reworkMergeConflict/);
});
