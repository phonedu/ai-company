/**
 * RM-5：卡片落库后停掉**同任务**幕僚长会话；别的任务/未在跑不误伤。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { AssistantRuntime } from '../src/main/agent/assistant.js';

test('RM-5：abortForTask 只中止当前任务的幕僚长会话', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', now: 1 });
    const aborted: string[] = [];
    let release: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = {
      run: async () => {
        release?.();
        return new Promise((resolve) => {
          // 等待 abortForTask 触发后由 abortSession resolve
          (globalThis as { __rm5Resolve?: () => void }).__rm5Resolve = () =>
            resolve({ text: '', toolCalls: [], usage: { model: 'm' } });
        });
      },
      abortSession: (key: string) => {
        aborted.push(key);
        (globalThis as { __rm5Resolve?: () => void }).__rm5Resolve?.();
        return true;
      },
      steer: () => false,
      dispose: () => undefined,
    };
    const runtime = new AssistantRuntime({ db, runtime: fake as never, systemPrompt: 's' });
    const turn = runtime.runTurn({ text: 'x', taskId: task.id });
    await started;
    assert.equal(runtime.abortForTask(task.id + 1), false, '别的任务不中止');
    assert.equal(runtime.abortForTask(task.id), true, '当前任务中止');
    await turn;
    assert.deepEqual(aborted, ['boss-channel:assistant']);
    assert.equal(runtime.abortForTask(task.id), false, '结束后不再命中');
  } finally {
    db.close();
  }
});
