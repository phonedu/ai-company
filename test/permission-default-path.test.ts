/**
 * OPT-M9-1 接线修复（独立验证发现的"假完成"）：**默认引擎路径必须也过权限闸门**。
 *
 * 口径：`Engine` 默认（不显式注入 gate）执行 pending 动作时也过 `permissionGate`：
 *  - `deny` → 动作 `failed` + `permission_decision`；
 *  - `ask`  → 动作留 `pending` + `permission_requested` + `approvals` 行（`[权限]` 前缀、无默认动作）；
 *  - 有效权限 = 员工能力档 ∩ DB 三级放行档；L2 收紧一档；对外永不自动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getAction,
  listTaskEvents,
  openMemoryDatabase,
  runMigrations,
  setPermissionPolicy,
  type SqliteDb,
} from '../src/main/db/index.js';
import { registerPendingAction } from '../src/main/db/action_log.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

function setup(): { db: SqliteDb; taskId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P', 'D:/repo', 1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','standard',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  return { db, taskId: task.id };
}

const approvalCount = (db: SqliteDb) => (db.prepare('SELECT COUNT(*) n FROM approvals').get() as { n: number }).n;
const kindCount = (db: SqliteDb, taskId: number, kind: string) =>
  listTaskEvents(db, taskId).filter((e) => e.kind === kind).length;

test('OPT-M9-1 接线：默认 Engine（不注入 gate）执行 pending 动作也过闸（对外=ask / 路径外=deny）', async () => {
  const { db, taskId } = setup();
  try {
    registerPendingAction(db, { actionKey: 'publish:task:1:0', kind: 'publish', taskId, now: 1 }); // 对外 → ask
    registerPendingAction(db, {
      actionKey: 'write:task:1:1',
      kind: 'write',
      taskId,
      payload: { path: 'C:/outside/evil.txt' },
      now: 1,
    }); // 项目外 → deny

    const executor = makeRecordingExecutor();
    const engine = new Engine(db, executor, { now: () => 100 }); // 默认配置 → gate 开启
    await engine.recover(); // 内部走 executePendingActions(..., this.gate)

    // 对外动作：留 pending + approvals 行（[权限] 前缀、无默认动作）+ permission_requested
    assert.equal(getAction(db, 'publish:task:1:0')?.state, 'pending', '对外动作不得自动执行');
    assert.equal(approvalCount(db), 1, 'ask 必须落 approvals 行');
    const a = db.prepare('SELECT question, default_action FROM approvals LIMIT 1').get() as {
      question: string;
      default_action: string | null;
    };
    assert.match(a.question, /^\[权限\]/, 'approvals 行须带 [权限] 前缀');
    assert.equal(a.default_action, null, '对外动作不得有默认动作');
    assert.equal(kindCount(db, taskId, 'permission_requested'), 1);

    // 路径外写：failed + permission_decision(deny)
    assert.equal(getAction(db, 'write:task:1:1')?.state, 'failed');
    const dec = listTaskEvents(db, taskId).find((e) => e.kind === 'permission_decision');
    assert.ok(dec, 'deny 必须落 permission_decision');
    assert.equal((JSON.parse(dec!.payload) as { decision: string }).decision, 'deny');

    // 执行器从未被调用（两个动作都没执行）
    assert.deepEqual(executor.state.calls, [], '被拦的动作不得触达执行器');
  } finally {
    db.close();
  }
});

test('OPT-M9-1 接线"有牙"：config.permission=false 关闸 → 同样动作不再被拦（证明上面断言确由默认闸门产生）', async () => {
  const { db, taskId } = setup();
  try {
    registerPendingAction(db, { actionKey: 'publish:task:1:0', kind: 'publish', taskId, now: 1 });
    const executor = makeRecordingExecutor();
    const engine = new Engine(db, executor, { now: () => 100, permission: false }); // 关闸
    await engine.recover();
    assert.equal(approvalCount(db), 0, '关闸后无 approvals 行');
    assert.equal(kindCount(db, taskId, 'permission_requested'), 0);
    assert.deepEqual(executor.state.calls, ['publish:task:1:0'], '关闸后动作被直接执行');
  } finally {
    db.close();
  }
});

test('OPT-M9-1 接线：默认路径生效 DB 三级放行档（global loose ← project strict，项目覆盖）', async () => {
  const { db, taskId } = setup();
  try {
    const projectId = (db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: number }).project_id;
    setPermissionPolicy(db, { scopeType: 'global', scopeId: 0, tier: 'loose', now: 1 });
    setPermissionPolicy(db, { scopeType: 'project', scopeId: projectId, tier: 'strict', now: 1 });
    registerPendingAction(db, {
      actionKey: 'write:task:1:9',
      kind: 'write',
      taskId,
      payload: { path: 'D:/repo/sub/x.txt' }, // 项目内
      now: 1,
    });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => 100 });
    await engine.recover();
    // strict（项目覆盖 global loose）→ 项目内写也需逐次批准 → pending + approvals
    assert.equal(getAction(db, 'write:task:1:9')?.state, 'pending', '项目级 strict 必须收紧到 ask');
    assert.equal(approvalCount(db), 1);
  } finally {
    db.close();
  }
});
