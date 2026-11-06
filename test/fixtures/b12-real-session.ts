/**
 * B12 真实会话验证（**非测试文件**；真 LLM，1 次调用）：
 * 员工会话**不调 `submit_work_item`** → 引擎按**真实提交事实**判 `submitted=false` → 工作项 `failed`
 * （即使执行器/调用方在 payload 里塞 `submitted:true` 也不认）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  listTaskEvents,
  openDatabase,
  runMigrations,
} from '../../src/main/db/index.js';
import { Engine } from '../../src/main/engine/index.js';
import { createEmployeeRuntime, defaultSessionDir } from '../../src/main/agent/employee-factory.js';
import { toPersistedAction } from '../../src/main/engine/index.js';

const dir = mkdtempSync(join(tmpdir(), 'aico-b12-'));
const db = openDatabase(join(dir, 'aico.db'));
runMigrations(db);

const projectId = Number(
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('B12', '" + dir.replace(/\\/g, '/') + "', 1)").run()
    .lastInsertRowid,
);
db.prepare("INSERT INTO employees(id, name, role, persona, created_at) VALUES(7,'小工','dev','务实。',1)").run();
const task = createTask(db, new SqliteCounterStore(db), {
  projectId,
  title: 'B12 真实会话（不提交）',
  goal: '随便回一句话即可，不要调用任何工具',
  riskLevel: 1,
  ownerId: 7,
});
const wi = insertWorkItem(db, {
  taskId: task.id,
  employeeId: 7,
  title: '不提交',
  brief: '请只回复一句话，明确表示你这次不提交任何成果（不要调用 submit_work_item）。',
  now: 1,
});
// 让工作项处于 running（模拟已派发）
db.prepare("UPDATE work_items SET state='running', started_at=1 WHERE id=?").run(wi.id);

try {
  const emp = await createEmployeeRuntime({ db, cwd: dir, sessionDir: defaultSessionDir(join(dir, 'ud')) });
  const engine = new Engine(db, emp.createExecutor((e) => void engine.dispatch(e)), { now: () => Date.now() });
  // 执行器跑一轮真会话；它会发 agent_settled（因为没提交）
  await emp.createExecutor((e) => void engine.dispatch(e)).execute(
    toPersistedAction(`dispatch:work_item:${wi.id}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })),
  );
  void engine;
  const wiState = getWorkItem(db, wi.id)?.state;
  const evs = listTaskEvents(db, task.id).map((e) => e.kind);
  console.log(
    JSON.stringify(
      { modelRef: emp.modelRef, wiState, eventKinds: evs, structured: { submittedFactBased: wiState === 'failed' } },
      null,
      2,
    ),
  );
  emp.dispose();
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
