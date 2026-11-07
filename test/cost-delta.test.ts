/**
 * B0-8（ADV-1 I1）：成本记账重复入账的回归测试。
 *
 * 根因：Pi `getSessionStats()` 返回**全会话累计**，而 `persistUsage` 每次 run 都全额再记一笔；
 * 会话键不带轮次 ⇒ 重规划/返工/nudge 补跑把此前成本重复计入，任务读数与预算闸虚高。
 *
 * 新口径：runtime 标记 `cumulativeSessionStats` 的用量按**差值**入账，游标持久化到 settings
 * （重启后同会话续跑不重记）；非累计（fake/单轮）用量照旧全额记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SqliteCounterStore,
  createTask,
  getTaskById,
  insertWorkItem,
  listCosts,
  openMemoryDatabase,
  runMigrations,
  type SqliteDb,
} from '../src/main/db/index.js';
import { toPersistedAction } from '../src/main/engine/index.js';
import { EmployeeSessionRuntime, createEmployeeExecutor, makeFakeAgentRuntime } from '../src/main/agent/index.js';

function setup(): { db: SqliteDb; taskId: number; wiId: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employees(id, name, role, created_at) VALUES(7,'E7','dev',1)").run();
  const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 0, ownerId: 7 });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'do it', now: 1 });
  return { db, taskId: task.id, wiId: wi.id };
}

const dispatchAction = (taskId: number, wiId: number, attempt = 0) =>
  toPersistedAction(`dispatch:work_item:${wiId}:${attempt}`, 'dispatch', taskId, JSON.stringify({ attempt }));

/** 一次 run：只回文本（触发宿主补提交回合）→ 第二次真提交。累计统计递增。 */
const cumulativeRun = (input: { i: number; o: number; usd: number }) => ({
  text: input.i === 100 ? '我先说明一下…' : '',
  toolCalls:
    input.i === 100
      ? []
      : [{ id: 's1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
  usage: {
    model: 'deepseek-flash',
    inputTokens: input.i,
    outputTokens: input.o,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: input.usd,
    cumulativeSessionStats: true,
  },
});

test('B0-8：同一会话两轮（nudge 补跑）只记差值——任务成本不被重复计入', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      cumulativeRun({ i: 100, o: 10, usd: 0.01 }),
      cumulativeRun({ i: 160, o: 18, usd: 0.016 }),
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId));
    const costs = listCosts(db, taskId);
    assert.equal(costs.length, 2, '两次 run 各落一行（第二行是差值，不是 0）');
    const tokens = costs.reduce((n, c) => n + c.tokens_in + c.tokens_out, 0);
    assert.equal(tokens, 160 + 18, `总 token 必须等于会话累计（实际 ${tokens}；旧实现会是 260+28）`);
    const usd = costs.reduce((n, c) => n + c.usd, 0);
    assert.ok(Math.abs(usd - 0.016) < 1e-9, `总花费必须等于会话累计 0.016（实际 ${usd}）`);
    const task = getTaskById(db, taskId) as { cost_tokens?: number };
    assert.equal(Number(task.cost_tokens ?? 0), 178, '任务 cost_tokens 与分账同源');
  } finally {
    db.close();
  }
});

test('B0-8：游标持久化——重启后同会话续跑仍只记差值', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const first = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(makeFakeAgentRuntime([cumulativeRun({ i: 100, o: 10, usd: 0.01 })])),
      dispatch: () => undefined,
    });
    await first.execute(dispatchAction(taskId, wiId));
    // 模拟重启：新执行器实例 + 同一会话的累计统计已到 200/20/$0.02。
    const second = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(makeFakeAgentRuntime([cumulativeRun({ i: 200, o: 20, usd: 0.02 })])),
      dispatch: () => undefined,
    });
    await second.execute(dispatchAction(taskId, wiId, 1));
    const costs = listCosts(db, taskId);
    const tokens = costs.reduce((n, c) => n + c.tokens_in + c.tokens_out, 0);
    assert.equal(tokens, 220, `重启后总 token 仍等于会话累计（实际 ${tokens}；旧实现会重复记 110）`);
  } finally {
    db.close();
  }
});

test('B0-8：统计回退（会话被重建）不记负数——按 0 处理', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const exec = createEmployeeExecutor({
      db,
      runtime: new EmployeeSessionRuntime(
        makeFakeAgentRuntime([
          cumulativeRun({ i: 100, o: 10, usd: 0.01 }),
          cumulativeRun({ i: 20, o: 2, usd: 0.002 }),
        ]),
      ),
      dispatch: () => undefined,
    });
    await exec.execute(dispatchAction(taskId, wiId));
    const costs = listCosts(db, taskId);
    assert.ok(costs.every((c) => c.tokens_in >= 0 && c.tokens_out >= 0 && c.usd >= 0), '差值不得为负');
    assert.equal(costs.length, 1, '统计回退的那一轮不落假行（差值全 0）');
  } finally {
    db.close();
  }
});

test('B0-8：非累计用量（fake/单轮）保持全额记账', async () => {
  const { db, taskId, wiId } = setup();
  try {
    const fake = makeFakeAgentRuntime([
      {
        text: '',
        toolCalls: [{ id: 's1', name: 'submit_work_item', input: { summary: 'ok' }, isError: false }],
        usage: { model: 'deepseek-flash', inputTokens: 30, outputTokens: 5, costUsd: 0.003 },
      },
    ]);
    const exec = createEmployeeExecutor({ db, runtime: new EmployeeSessionRuntime(fake), dispatch: () => undefined });
    await exec.execute(dispatchAction(taskId, wiId));
    const costs = listCosts(db, taskId);
    assert.equal(costs.length, 1);
    assert.equal(costs[0]!.tokens_in + costs[0]!.tokens_out, 35, '无累计标记的用量不得做差值');
  } finally {
    db.close();
  }
});
