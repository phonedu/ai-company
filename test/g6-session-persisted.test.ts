/**
 * G6（M2-C）· 会话落盘显式化：`isPersisted()` 不可用不臆造；未落盘 → 有界复查 + 响亮报错 + 回写标记可见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, insertWorkItem, openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import type { EngineEvent } from '../src/main/engine/types.js';
import { EmployeeSessionRuntime, createEmployeeExecutor } from '../src/main/agent/index.js';
import { checkPersisted } from '../src/main/agent/pi-runtime.js';

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

/** 最小假 runtime：返回指定 `persisted` 的可控结果。 */
function runtimeWith(persisted: boolean | undefined, toolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; isError: boolean }> = []) {
  return {
    runs: [] as unknown[],
    async run(_input: unknown) {
      return { text: 'x', toolCalls, persisted };
    },
    steer: () => false,
    dispose: () => undefined,
  } as never;
}

test('G6: `isPersisted` 不可用 → 返回 undefined（不臆造）', async () => {
  const out = await checkPersisted({});
  assert.equal(out, undefined);
});

test('G6: 首次未落盘 → 复查（覆盖异步 flush）；复查成功 → true', async () => {
  let calls = 0;
  const session = { sessionManager: { isPersisted: () => (++calls >= 2 ? true : false) } };
  const out = await checkPersisted(session, { sleep: async () => undefined });
  assert.equal(out, true, '复查一次后应视为已落盘');
  assert.equal(calls, 2, '应恰好复查一次');
});

test('G6: 两次都未落盘 → 返回 false 且**响亮报错**（不静默）', async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => void errors.push(String(msg));
  try {
    const session = { sessionManager: { isPersisted: () => false } };
    const out = await checkPersisted(session, { sessionKey: 'k1', sleep: async () => undefined });
    assert.equal(out, false);
    assert.equal(errors.length, 1, '必须报错');
    assert.match(errors[0]!, /未能落盘/);
    assert.match(errors[0]!, /k1/);
  } finally {
    console.error = orig;
  }
});

test('G6: `persisted:true` → 正常路径**零噪音**（不 console.error、不带标记）', async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => void errors.push(String(m));
  try {
    const session = { sessionManager: { isPersisted: () => true } };
    const out = await checkPersisted(session, { sessionKey: 'k-ok' });
    assert.equal(out, true);
    assert.equal(errors.length, 0, '正常路径不得报错（否则真问题会被噪音淹没）');
  } finally {
    console.error = orig;
  }
});

test('G6 "有牙": `persisted:false` → 回写事件 payload 真带 `sessionPersisted:false`；true/undefined → 不带（不臆造）', async () => {
  // false 分支：提交写回
  {
    const { db, taskId, wiId } = setup();
    try {
      const events: EngineEvent[] = [];
      const exec = createEmployeeExecutor({
        db,
        runtime: new EmployeeSessionRuntime(runtimeWith(false, [{ id: 't1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }])),
        dispatch: (e) => void events.push(e),
      });
      const orig = console.error;
      console.error = () => undefined;
      try {
        await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));
      } finally {
        console.error = orig;
      }
      assert.equal((events[0]!.payload as { sessionPersisted?: boolean }).sessionPersisted, false, '可见标记必须落 read-back');
    } finally {
      db.close();
    }
  }
  // true / undefined 分支：不带该字段
  for (const val of [true, undefined]) {
    const { db, taskId, wiId } = setup();
    try {
      const events: EngineEvent[] = [];
      const exec = createEmployeeExecutor({
        db,
        runtime: new EmployeeSessionRuntime(runtimeWith(val, [{ id: 't1', name: 'submit_work_item', input: {}, isError: false }])),
        dispatch: (e) => void events.push(e),
      });
      await exec.execute(toPersistedAction(`dispatch:work_item:${wiId}:0`, 'dispatch', taskId, '{}'));
      assert.equal('sessionPersisted' in (events[0]!.payload as object), false, `persisted=${String(val)} 不应带标记`);
    } finally {
      db.close();
    }
  }
});
