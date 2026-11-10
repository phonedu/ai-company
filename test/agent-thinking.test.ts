/**
 * G5· `agent_thinking` 采集：思考文本**脱敏 + 截断**后落 `task_events`（只本地、不进人类频道）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime, AGENT_THINKING_MAX, sanitizeThinking } from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'E7','dev','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number) =>
  toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{"attempt":0}');

test('G5: 有思考事件 → 落 `agent_thinking`（且已脱敏：密钥/绝对路径不入库）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: 'done',
        thinking: 'let me check apiKey sk-abcdef123456 and read C:\\Users\\Tup\\secret\\x.txt first',
        toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId));
    const rows = listTaskEvents(db, taskId).filter((e) => e.kind === 'agent_thinking');
    assert.equal(rows.length, 1, '应落一条 agent_thinking');
    const payload = JSON.parse(rows[0]!.payload) as { employeeId: number; text: string };
    assert.equal(payload.employeeId, 7);
    assert.ok(!payload.text.includes('sk-abcdef123456'), '密钥不得入库');
    assert.ok(!payload.text.includes('C:\\Users\\Tup'), '绝对用户路径不得入库');
    assert.ok(payload.text.includes('«redacted»') || payload.text.includes('<abs>'), '应留下脱敏痕迹');
    // 只本地：不进人类频道
    assert.equal((db.prepare('SELECT COUNT(*) n FROM human_messages').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('G5: 无思考事件 → 不落 `agent_thinking`（不臆造）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      { text: 'x', toolCalls: [{ id: 't1', name: 'submit_work_item', input: {}, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId));
    assert.equal(listTaskEvents(db, taskId).filter((e) => e.kind === 'agent_thinking').length, 0);
  } finally {
    db.close();
  }
});

test('G5: 思考文本截断 ≤ 上限（不把整段思考无限写库）', () => {
  const long = 'x'.repeat(AGENT_THINKING_MAX + 500);
  const out = sanitizeThinking(long);
  assert.ok(out.length <= AGENT_THINKING_MAX + 1, `应截断到 ≤${AGENT_THINKING_MAX}，实际 ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('G5 "有牙": 未脱敏的原文含密钥/绝对路径（对照证明上面的脱敏断言有意义）', () => {
  const raw = 'key=sk-abcdef123456 path=C:\\Users\\Tup\\a.txt';
  assert.ok(raw.includes('sk-abcdef123456') && raw.includes('C:\\Users\\Tup'), '原文确实含敏感串');
  const safe = sanitizeThinking(raw);
  assert.ok(!safe.includes('sk-abcdef123456'));
  assert.ok(!safe.includes('C:\\Users\\Tup'));
});
