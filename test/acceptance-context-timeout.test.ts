/**
 * （ADV-1 G2）：验收命令 60 秒硬超时不可配 ＋ 命令不进员工上下文的回归测试。
 *
 * 旧实现：`acceptance-checks.ts` 两处 `options.timeoutMs ?? 60_000`，唯一生产调用不传 timeoutMs
 * ⇒ `pnpm test` 级（分钟级）验收必被 60s 掐断判 fail → 返工 → 再超时，硬门永远过不了；
 * `context.ts` 验收层只拼 text，员工不知道过关命令是什么，无法对准验收自查。
 *
 * 新口径：默认 10 分钟（`AICO_ACCEPTANCE_TIMEOUT_MS` 可配、显式参数优先）；验收层把
 * `check` 命令以「（机器检查：…）」带给员工。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { insertEmployee, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import {
  DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  acceptanceTimeoutMs,
  runAcceptanceChecks,
} from '../src/main/agent/acceptance-checks.js';

test('B0-2：默认超时放宽到 10 分钟；env 可配；显式参数优先', () => {
  assert.ok(DEFAULT_ACCEPTANCE_TIMEOUT_MS >= 10 * 60_000, '默认必须够跑 pnpm test 级验收（旧值 60s）');
  const saved = process.env.AICO_ACCEPTANCE_TIMEOUT_MS;
  try {
    delete process.env.AICO_ACCEPTANCE_TIMEOUT_MS;
    assert.equal(acceptanceTimeoutMs(), DEFAULT_ACCEPTANCE_TIMEOUT_MS);
    process.env.AICO_ACCEPTANCE_TIMEOUT_MS = '900000';
    assert.equal(acceptanceTimeoutMs(), 900_000, 'env 覆盖默认');
    process.env.AICO_ACCEPTANCE_TIMEOUT_MS = 'not-a-number';
    assert.equal(acceptanceTimeoutMs(), DEFAULT_ACCEPTANCE_TIMEOUT_MS, '非法 env 回落默认（不静默变 0）');
    assert.equal(acceptanceTimeoutMs(1234), 1234, '显式参数最优先（测试/特殊装配）');
  } finally {
    if (saved === undefined) delete process.env.AICO_ACCEPTANCE_TIMEOUT_MS;
    else process.env.AICO_ACCEPTANCE_TIMEOUT_MS = saved;
  }
});

test('B0-2：显式 timeoutMs 真的生效（超时判 fail，而不是无限等）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const dir = process.cwd();
  try {
    db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(1,'P',?,1)").run(dir);
    db.prepare(
      "INSERT INTO tasks(id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES(1,'T-1','T','g',?,'verifying',1,1,1)",
    ).run(JSON.stringify([{ text: '慢检查', check: 'node -e "setTimeout(()=>{},1500)"' }]));
    const res = runAcceptanceChecks(db, 1, { timeoutMs: 120 });
    assert.equal(res.items[0]?.status, 'fail');
    assert.match(res.items[0]?.reason ?? '', /执行失败|ETIMEDOUT|timeout/i, '超时必须如实判 fail 并给原因');
  } finally {
    db.close();
  }
});

test('B0-2：员工上下文验收层带「机器检查」命令（不再盲自查）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', persona: '', now: 1 });
    db.prepare("INSERT INTO projects(id, name, root_dir, created_at) VALUES(11,'P','D:/p',1)").run();
    db.prepare(
      "INSERT INTO tasks(id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES(1,'T-1','修渲染','让 tab 正确',?,'executing',11,1,1)",
    ).run(
      JSON.stringify([
        { text: '全链测试通过', check: 'pnpm test' },
        { text: '人工看空态' },
      ]),
    );
    const ctx = buildEmployeeContext(db, { employeeId: 3, taskId: 1, bossText: '收一下产物 tab' });
    assert.ok(ctx.systemPrompt.includes('全链测试通过（机器检查：pnpm test）'), '验收层必须带可执行命令');
    assert.ok(ctx.systemPrompt.includes('人工看空态'), '无 check 的验收项照旧显示');
    assert.ok(!ctx.systemPrompt.includes('机器检查：undefined'), '缺 check 不得写假命令');
  } finally {
    db.close();
  }
});
