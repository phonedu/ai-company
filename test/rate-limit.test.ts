/**
 * N2 · 速率闸门（P21）—— 「花钱如流水」看的是**速率**，不是总额。
 *
 * 判据（本文件头注即真源）：
 *  - **动作阶梯**：`ok → economy（降档，装配期生效）→ hold（新派发排队）`；**降档优先于暂停**（在跑任务不打断）；
 *  - **降档真效应**：超降档线后**新装配**的会话用 `AICO_ECONOMY_MODEL`（缺省＝普通档 ⇒ 未配置时不假装省了）；
 *  - **留痕**：档位**切换**时写 `task_events(kind='rate_limited')`（不刷屏）＋ `console.error`（静默风险显式）；
 *  - **不粘滞**：速率回落 ⇒ 档位复位；
 *  - **有牙**：把闸门阈值调到无穷 → 不再 hold（证明判定承重）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getWorkItem,
  insertWorkItem,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import { rateAction } from '../src/main/engine/rate-gate.js';
import { isEconomyMode, resolveAssembleModel, setDefaultModel, setEconomyMode } from '../src/main/agent/model-policy.js';
import { createLazyEmployeeRuntime } from '../src/main/agent/employee-factory.js';

const AT = 1_700_000_000_000;
const LIMITS = { softUsdPerHour: 3, hardUsdPerHour: 4.5 };

function setup(): { db: SqliteDb; projectId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES('E1','standard',1)").run();
  return { db, projectId };
}
const taskEvent = (taskId: number, event: string) => ({ scope: 'task' as const, id: taskId, event, actor: 'boss' });
async function driveToExecuting(engine: Engine, taskId: number): Promise<void> {
  await engine.dispatch(taskEvent(taskId, 'triage'));
  await engine.dispatch(taskEvent(taskId, 'plan_drafted'));
  await engine.dispatch(taskEvent(taskId, 'plan_reviewed'));
  await engine.dispatch(taskEvent(taskId, 'plan_approved'));
}
function seedCost(db: SqliteDb, taskId: number, usd: number, at: number, employeeId = 1): void {
  db.prepare(
    'INSERT INTO costs(task_id, work_item_id, employee_id, model, tokens_in, tokens_out, usd, created_at) VALUES(?, NULL, ?, ?, 0, 0, ?, ?)',
  ).run(taskId, employeeId, 'm', usd, at);
}

test('N2 纯判定：ok / economy / hold 三档（边界含等号）', () => {
  assert.equal(rateAction(0, LIMITS), 'ok');
  assert.equal(rateAction(2.99, LIMITS), 'ok');
  assert.equal(rateAction(3, LIMITS), 'economy', '恰好等于降档线 ⇒ economy（边界含等号）');
  assert.equal(rateAction(4.49, LIMITS), 'economy');
  assert.equal(rateAction(4.5, LIMITS), 'hold', '恰好等于排队线 ⇒ hold');
  // 有牙：naive `>` 会把边界判成 ok —— 断言真值即证明边界承重
  assert.notEqual(rateAction(3, LIMITS), 'ok');
});

test('N2 硬线：超排队线 → 新派发 hold（reason=rate_limit）＋ 留痕；在跑任务不被暂停', async () => {
  const { db, projectId } = setup();
  try {
    setEconomyMode(false);
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    const wi = insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
    seedCost(db, taskId, 100, AT - 60_000); // $100/h ≫ 排队线 4.5
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, rateLimit: LIMITS });

    await driveToExecuting(engine, taskId);

    assert.equal(getWorkItem(db, wi.id)?.state, 'queued', '超排队线 ⇒ 新派发保持 queued（不硬上）');
    const hold = engine.dispatchHold(wi.id);
    assert.equal(hold?.reason, 'rate_limit', '等待原因＝rate_limit（UI 可见）');
    assert.deepEqual(hold?.conflictsWith, []);
    assert.ok(hold?.detail && hold.detail.length > 0, 'R3-2：`detail` 必须带数字/阈值（决策点直给，不空）');
    assert.ok(engine.listDispatchHolds().some((h) => h.workItemId === wi.id && h.reason === 'rate_limit'));
    const ev = db.prepare("SELECT payload FROM task_events WHERE kind = 'rate_limited' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined;
    assert.ok(ev, '档位切换必须留痕（rate_limited）');
    assert.equal((JSON.parse(ev!.payload) as { tier: string }).tier, 'hold');
  } finally {
    setEconomyMode(false);
    db.close();
  }
});

test('N2 软线：达降档线 → economy（装配期档位真变化）；有牙：阈值调到无穷 → 不降档', async () => {
  {
    const { db, projectId } = setup();
    try {
      setEconomyMode(false);
      const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
      insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
      seedCost(db, taskId, 3.5, AT - 60_000); // 3 ≤ 3.5 < 4.5 ⇒ economy
      const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, rateLimit: LIMITS });
      await driveToExecuting(engine, taskId);
      assert.equal(isEconomyMode(), true, '达降档线 ⇒ 档位切 economy');
      assert.deepEqual(engine.dispatchHold(1), undefined, '软线不排队（降档优先于暂停/排队）');
    } finally {
      setEconomyMode(false);
      db.close();
    }
  }
  {
    const { db, projectId } = setup();
    try {
      setEconomyMode(false);
      const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
      insertWorkItem(db, { taskId, employeeId: 1, title: 'w', brief: 'b', now: 1 });
      seedCost(db, taskId, 3.5, AT - 60_000);
      // 有牙：把阈值调到无穷大 → 同样数据**不**降档（证明阈值判定承重）
      const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, rateLimit: { softUsdPerHour: Infinity, hardUsdPerHour: Infinity } });
      await driveToExecuting(engine, taskId);
      assert.equal(isEconomyMode(), false, '阈值失效 ⇒ 不降档');
    } finally {
      setEconomyMode(false);
      db.close();
    }
  }
});

test('N2 降档真效应：装配期用省钱档（AICO_ECONOMY_MODEL）；缺省未配 ⇒ 与普通档相同（不假装省）', async () => {
  const oldEco = process.env.AICO_ECONOMY_MODEL;
  const oldNormal = process.env.AICO_MODEL;
  try {
    process.env.AICO_MODEL = 'deepseek-v4-pro';
    process.env.AICO_ECONOMY_MODEL = 'deepseek-flash';

    setEconomyMode(false);
    assert.equal(resolveAssembleModel().model, 'deepseek-v4-pro', '普通档＝AICO_MODEL');
    setEconomyMode(true);
    assert.equal(resolveAssembleModel().model, 'deepseek-flash', '省钱档＝AICO_ECONOMY_MODEL');

    // 真链路：懒装配把档位**传给 assemble**（fake assemble 记录收到的 options）
    const seen: Array<string | undefined> = [];
    const lazy = createLazyEmployeeRuntime({
      db: openMemoryDatabase(),
      cwd: 'D:/repo',
      sessionDir: 'D:/tmp/aico-sessions',
      timeoutMs: 1000,
      assemble: async (o) => {
        seen.push(o.model);
        return {
          runtime: {} as never,
          modelRef: String(o.model),
          credentialSource: 'env' as never,
          createExecutor: () => ({ execute: async () => undefined }) as never,
          dispose: () => undefined,
        };
      },
    });
    await lazy.warmUp();
    assert.equal(seen[0], 'deepseek-flash', 'economy 下装配收到省钱档');

    delete process.env.AICO_ECONOMY_MODEL;
    setEconomyMode(false);
    assert.equal(resolveAssembleModel().model, 'deepseek-v4-pro', '未配省钱档 ⇒ 普通档（不假装省了）');
  } finally {
    if (oldEco === undefined) delete process.env.AICO_ECONOMY_MODEL; else process.env.AICO_ECONOMY_MODEL = oldEco;
    if (oldNormal === undefined) delete process.env.AICO_MODEL; else process.env.AICO_MODEL = oldNormal;
    setEconomyMode(false);
  }
});

test('装配期 provider：models.default 的 `provider/model` 被解析（MiMo/xiaomi 可装配）', () => {
  const oldProvider = process.env.AICO_PROVIDER;
  try {
    delete process.env.AICO_PROVIDER;
    setDefaultModel('xiaomi/mimo-v2.6-flash');
    setEconomyMode(false);
    assert.deepEqual(resolveAssembleModel(), { provider: 'xiaomi', model: 'mimo-v2.6-flash' });
    process.env.AICO_PROVIDER = 'xiaomi';
    assert.deepEqual(resolveAssembleModel(), { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, 'env provider 仍最优先');
  } finally {
    setDefaultModel(null);
    if (oldProvider === undefined) delete process.env.AICO_PROVIDER; else process.env.AICO_PROVIDER = oldProvider;
    setEconomyMode(false);
  }
});

test('N2 不粘滞：速率回落到线下 ⇒ 档位复位（并留痕 ok）', async () => {
  const { db, projectId } = setup();
  try {
    setEconomyMode(false);
    const taskId = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g' }).id;
    insertWorkItem(db, { taskId, employeeId: 1, title: 'w1', brief: 'b', now: 1 });
    const engine = new Engine(db, makeRecordingExecutor(), { now: () => AT, rateLimit: LIMITS });
    seedCost(db, taskId, 3.5, AT - 60_000);
    await driveToExecuting(engine, taskId);
    assert.equal(isEconomyMode(), true);

    // 费率行移出窗口（用 2 小时前的行 + 只留小额）：下一轮派发时判定即回落
    db.prepare('UPDATE costs SET created_at = ?').run(AT - 2 * 3_600_000);
    insertWorkItem(db, { taskId, employeeId: 1, title: 'w2', brief: 'b', now: 2 });
    await engine.dispatch(taskEvent(taskId, 'pause')); // 合法事件 → 触发一轮规划（此时评估速率）
    assert.equal(isEconomyMode(), false, '低于降档线 ⇒ 复位（不粘滞）');
  } finally {
    setEconomyMode(false);
    db.close();
  }
});
