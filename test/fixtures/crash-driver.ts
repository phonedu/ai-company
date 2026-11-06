/**
 * T0.3② 真·崩溃恢复驱动（非测试文件；由 `test/engine-crash.test.ts` spawn）。
 *
 * 用法：node crash-driver.js <dbFile> <effectsFile> <crash|recover>
 *  - crash  ：建任务 → 驱动到 executing（派发 work item，副作用写 effectsFile）→ 打印 READY → 挂起（等被 taskkill）
 *  - recover：engine.recover()（②running→interrupted ③重放 pending ④重建 timers）→ 打印 REPORT <json> → 退出
 *
 * 副作用执行器：把 actionKey 追加到 effectsFile（按 key 幂等去重），以便跨进程观察「无重复副作用」。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import {
  SqliteCounterStore,
  createTask,
  insertWorkItem,
  listActions,
  openDatabase,
  runMigrations,
} from '../../src/main/db/index.js';
import { Engine, type EffectExecutor, type EngineEvent } from '../../src/main/engine/index.js';

const [, , dbFile, effectsFile, mode] = process.argv;

function fileExecutor(file: string): EffectExecutor {
  return {
    execute(action) {
      const existing = existsSync(file)
        ? readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
        : [];
      if (existing.includes(action.actionKey)) return; // 下游幂等键
      appendFileSync(file, `${action.actionKey}\n`);
    },
  };
}

const db = openDatabase(dbFile as string);
runMigrations(db);
const executor = fileExecutor(effectsFile as string);
const engine = new Engine(db, executor, { now: () => 10_000 });

if (mode === 'crash') {
  const projectId = Number(
    db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?)').run('演示', 'D:/tmp/演示', 1)
      .lastInsertRowid,
  );
  const employeeId = Number(
    db.prepare("INSERT INTO employees(name, role, created_at) VALUES('员工A', 'standard', 1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: '崩溃恢复用例',
    goal: '驱动到执行中',
    riskLevel: 1,
  });
  insertWorkItem(db, { taskId: task.id, employeeId, title: '打工', brief: 'B', now: 10_000 });

  const e = (event: string, payload?: Record<string, unknown>): EngineEvent => ({
    scope: 'task',
    id: task.id,
    event,
    actor: 'boss',
    payload,
  });
  await engine.dispatch(e('triage'));
  await engine.dispatch(e('plan_drafted'));
  await engine.dispatch(e('plan_reviewed'));
  await engine.dispatch(e('plan_approved')); // fixpoint：ready→executing→dispatch work item

  process.stdout.write('READY\n');
  // 挂起，等父进程 taskkill（模拟真实进程被强杀）
  setInterval(() => {}, 1000);
} else {
  const report = await engine.recover();
  const task = db.prepare('SELECT id, state FROM tasks ORDER BY id LIMIT 1').get() as { id: number; state: string };
  const wi = db.prepare('SELECT id, state FROM work_items ORDER BY id LIMIT 1').get() as { id: number; state: string };
  const effects = existsSync(effectsFile as string)
    ? readFileSync(effectsFile as string, 'utf8').split('\n').filter((l) => l.length > 0)
    : [];
  const out = {
    taskState: task?.state ?? null,
    wiState: wi?.state ?? null,
    effects,
    actions: listActions(db).map((a) => ({ key: a.action_key, state: a.state })),
    replayed: report.replayed,
    interrupted: report.interrupted,
    redispatched: report.redispatched,
    timersRebuilt: report.timersRebuilt,
    tasks: db.prepare('SELECT id, state FROM tasks').all(),
    workItems: db.prepare('SELECT id, state FROM work_items').all(),
  };
  process.stdout.write(`REPORT ${JSON.stringify(out)}\n`);
  process.exit(0);
}
