/**
 *  · `rawConversation` 派生投影 + `agent_message` 写入（契约守卫，可弄红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  insertHumanMessage,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { insertTaskEvent } from '../src/main/db/task_events.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import {
  EmployeeSessionRuntime,
  createEmployeeExecutor,
  makeFakeAgentRuntime,
  projectRawConversation,
  redactArgsDigest,
  ARGS_DIGEST_MAX,
} from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'林悦','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

test('OPT-AI-1 rawConversation: 空数据 → []（显式空态，不臆造）', () => {
  const { db, taskId } = setup();
  try {
    assert.deepEqual(projectRawConversation(db, taskId), []);
  } finally {
    db.close();
  }
});

test('OPT-AI-1 rawConversation: 老板原话 + agent_message + tool_call 三类派生，按 at 升序', () => {
  const { db, taskId } = setup();
  try {
    insertHumanMessage(db, { direction: 'in', taskId, content: '把契约写清', now: 10 });
    insertTaskEvent(db, { taskId, kind: 'agent_message', actor: 'employee:7', ts: 20, payload: { employeeId: 7, text: '好的' } });
    insertTaskEvent(db, { taskId, kind: 'tool_call', actor: 'employee:7', ts: 30, payload: { toolName: 'read', toolCallId: 'c1', phase: 'start', input: { path: 'src/a.ts' } } });
    insertTaskEvent(db, { taskId, kind: 'tool_call', actor: 'employee:7', ts: 35, payload: { toolName: 'read', toolCallId: 'c1', phase: 'end', isError: false } });

    const items = projectRawConversation(db, taskId);
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.at), [10, 20, 30]);
    assert.equal(items[0]!.role, 'boss');
    assert.equal(items[0]!.text, '把契约写清');
    assert.equal(items[1]!.role, 'employee');
    assert.equal(items[1]!.employeeId, 7);
    assert.equal(items[1]!.name, '林悦');
    assert.equal(items[1]!.text, '好的');
    assert.equal(items[2]!.toolCall?.name, 'read');
    assert.equal(items[2]!.toolCall?.ok, true);
    assert.match(items[2]!.toolCall?.argsDigest ?? '', /src\/a\.ts/);
  } finally {
    db.close();
  }
});

test('OPT-AI-1 rawConversation: 执行器落 agent_message（提交与未提交都记；text 为空不写）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      { text: '我做了 X', toolCalls: [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }] },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{"attempt":0}'));
    const items = projectRawConversation(db, taskId);
    assert.equal(items.filter((i) => i.text === '我做了 X').length, 1);
  } finally {
    db.close();
  }
});

test('OPT-AI-1 rawConversation: argsDigest 脱敏（密钥/令牌不出现）+ 截断 ≤120', () => {
  const d1 = redactArgsDigest({ apiKey: 'sk-abcdef123456', path: 'a.ts' });
  assert.ok(!d1.includes('sk-abcdef123456'), '不得含明文密钥');
  assert.match(d1, /«redacted»/);
  const d2 = redactArgsDigest({ authorization: 'Bearer abcdef123456' });
  assert.ok(!d2.includes('abcdef123456'));
  const long = redactArgsDigest({ q: 'x'.repeat(500) });
  assert.ok(long.length <= ARGS_DIGEST_MAX + 1, `应截断到 ≤${ARGS_DIGEST_MAX}，实际 ${long.length}`);
  assert.ok(long.endsWith('…'));
});

test('OPT-AI-1 rawConversation: redactArgsDigest 输出仍是合法 JSON（"key":"«redacted»"，不重复替换，非敏感键不吞）', () => {
  const d = redactArgsDigest({ command: 'pytest -q', apiKey: 'sk-abcdef123456' });
  const parsed = JSON.parse(d) as { command: string; apiKey: string };
  assert.equal(parsed.command, 'pytest -q');
  assert.equal(parsed.apiKey, '«redacted»');
  assert.equal((d.match(/«redacted»/g) ?? []).length, 1, '不应重复替换');
  const d2 = redactArgsDigest({ password: 'p@ss', token: 'tok-123', ok: true });
  const p2 = JSON.parse(d2) as { password: string; token: string; ok: boolean };
  assert.equal(p2.password, '«redacted»');
  assert.equal(p2.token, '«redacted»');
  assert.equal(p2.ok, true, '非敏感键不得被吞');
});

test('OPT-AI-1 rawConversation "有牙": 去掉敏感键分支 → 假密钥会出现在 digest 里（证明脱敏断言有意义）', () => {
  // 模拟“脱敏分支被删”：直接 JSON.stringify 的原文应含密钥，而 redactArgsDigest 不应含
  const raw = JSON.stringify({ apiKey: 'sk-abcdef123456' });
  assert.ok(raw.includes('sk-abcdef123456'));
  assert.ok(!redactArgsDigest({ apiKey: 'sk-abcdef123456' }).includes('sk-abcdef123456'));
});

test('OPT-AI-1 rawConversation "有牙": 去掉 agent_message 写入 → 投影无员工发言条（证明断言有意义）', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([{ text: '有正文', toolCalls: [] }]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));
    // 删除刚写入的 agent_message → 投影应回到空（等价于"写入守卫被去掉"）
    db.prepare("DELETE FROM task_events WHERE task_id = ? AND kind='agent_message'").run(taskId);
    assert.deepEqual(projectRawConversation(db, taskId).filter((i) => i.role === 'employee'), []);
  } finally {
    db.close();
  }
});
