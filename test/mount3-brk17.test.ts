/**
 * BRK17 组（挂载 3 余件）：`undo_finish` 转正 ＋ `archive` 接线——引擎级真链路守据。
 *
 * 口径（05 §3.1.1）：
 *  - `done --undo_finish--> state_before_close`：守卫＝`now - closed_at ≤ 7d` 且 `archived = 0`；
 *    超窗/已归档**不是静默 no-op**：经 `task:transition` 得 `{ok:false, code:'transition_failed'}` ＋ 人话原因；
 *  - `done/failed/cancelled --archive--> KEEP（archived=1）`：归档≠state；**入口在左栏终态任务行**（非详情表）；
 *  - 非终态发 `archive` → 未知迁移，同样人话回执（不抛裸异常到 renderer）。
 *
 * 真库（内存）＋真引擎（`handleTaskTransition` 走真 dispatch→drain→applyTaskEventInTx）；只断事实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { Engine } from '../src/main/engine/index.js';
import { handleTaskCreate, handleTaskTransition } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const noopExecutor = { execute: async (): Promise<void> => undefined };

type Deps = {
  repo: ReturnType<typeof createSqliteChatRepo>;
  engine: Engine;
  db: ReturnType<typeof openMemoryDatabase>;
};

async function fixture(): Promise<Deps & { taskId: number; shortId: string }> {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const engine = new Engine(db, noopExecutor, { autoSchedule: false, now: () => AT });
  const created = await handleTaskCreate({ repo, engine }, { goal: 'BRK17 的目标' });
  return { repo, engine, db, taskId: created.id, shortId: created.shortId ?? `#${created.id}` };
}

/** 手术：把任务摆成「已结束」终态（closed_at=某刻、state_before_close=ready）。 */
function makeDone(db: ReturnType<typeof openMemoryDatabase>, taskId: number, closedAt: number, archived = 0): void {
  db.prepare("UPDATE tasks SET state='done', closed_at=?, state_before_close='ready', archived=? WHERE id=?").run(
    closedAt,
    archived,
    taskId,
  );
}

function taskRow(db: ReturnType<typeof openMemoryDatabase>, taskId: number): {
  state: string;
  archived: number;
  archived_at: number | null;
  ready_since: number | null;
} {
  return db
    .prepare('SELECT state, archived, archived_at, ready_since FROM tasks WHERE id=?')
    .get(taskId) as { state: string; archived: number; archived_at: number | null; ready_since: number | null };
}

function eventCount(db: ReturnType<typeof openMemoryDatabase>, taskId: number, kind: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind=?').get(taskId, kind) as {
    n: number;
  };
  return row.n;
}

test('undo_finish：窗口内 → `state_before_close`（原 ready）复活；`task_reopened` 事件落账', async () => {
  const f = await fixture();
  try {
    makeDone(f.db, f.taskId, AT - 1 * DAY);
    const res = await handleTaskTransition(f, { taskId: f.taskId, event: 'undo_finish' });
    assert.deepEqual(res, { ok: true }, '窗口内必须放行（此前 UI disabled＋0 生产者——BRK17）');
    const row = taskRow(f.db, f.taskId);
    assert.equal(row.state, 'ready', '回到 state_before_close（原 ready；executing 会回 ready）');
    assert.equal(row.ready_since, AT, '回边后 ready_since 置当前时刻（重新触发调度）');
    assert.equal(eventCount(f.db, f.taskId, 'task_reopened'), 1, '审计事件必须落账');
  } finally {
    f.db.close();
  }
});

test('undo_finish：超 7 天窗口 → **人话回执**（transition_failed），任务状态不动', async () => {
  const f = await fixture();
  try {
    makeDone(f.db, f.taskId, AT - 8 * DAY);
    const res = await handleTaskTransition(f, { taskId: f.taskId, event: 'undo_finish' });
    assert.equal(res.ok, false, '超窗必须被拒');
    if (res.ok) return;
    assert.equal(res.code, 'transition_failed');
    assert.match(res.message, /7 天窗口/, '原因人话化（不是裸 UnknownTransitionError）');
    assert.equal(taskRow(f.db, f.taskId).state, 'done', '拒绝后状态不动');
  } finally {
    f.db.close();
  }
});

test('undo_finish：已归档 → 拒（原因点名「已归档」；归档后只能续办）', async () => {
  const f = await fixture();
  try {
    makeDone(f.db, f.taskId, AT - 1 * DAY, 1);
    const res = await handleTaskTransition(f, { taskId: f.taskId, event: 'undo_finish' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, 'transition_failed');
    assert.match(res.message, /已归档/);
  } finally {
    f.db.close();
  }
});

test('archive：done → `archived=1`（state 不变）＋ `task_archived` 事件；二次归档幂等（KEEP 行可重入）', async () => {
  const f = await fixture();
  try {
    makeDone(f.db, f.taskId, AT - 1 * DAY);
    const res = await handleTaskTransition(f, { taskId: f.taskId, event: 'archive' });
    assert.deepEqual(res, { ok: true }, '终态任务必须可归档（此前 0 生产者——BRK17）');
    const row = taskRow(f.db, f.taskId);
    assert.equal(row.archived, 1);
    assert.equal(row.archived_at, AT, 'archived_at 记归档时刻');
    assert.equal(row.state, 'done', '归档≠state（口径 3067/3095）');
    assert.equal(eventCount(f.db, f.taskId, 'task_archived'), 1);

    const again = await handleTaskTransition(f, { taskId: f.taskId, event: 'archive' });
    assert.deepEqual(again, { ok: true }, '重复归档不炸（行可重入，幂等为 patch 覆写）');
    assert.equal(eventCount(f.db, f.taskId, 'task_archived'), 2, '每次动作留一条审计（如实记两次）');
  } finally {
    f.db.close();
  }
});

test('archive：failed → 归档；非终态（executing）→ 拒（transition_failed，人话）', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE tasks SET state='failed', closed_at=? WHERE id=?").run(AT - 2 * DAY, f.taskId);
    const res = await handleTaskTransition(f, { taskId: f.taskId, event: 'archive' });
    assert.deepEqual(res, { ok: true }, 'failed 同样可归档（failed/cancelled 行）');
    assert.equal(taskRow(f.db, f.taskId).archived, 1);

    const f2 = await fixture();
    try {
      f2.db.prepare("UPDATE tasks SET state='executing' WHERE id=?").run(f2.taskId);
      const bad = await handleTaskTransition(f2, { taskId: f2.taskId, event: 'archive' });
      assert.equal(bad.ok, false, '非终态不许归档（05 §3.1.1 只列终态行）');
      if (!bad.ok) assert.equal(bad.code, 'transition_failed');
    } finally {
      f2.db.close();
    }
  } finally {
    f.db.close();
  }
});
