/**
 * T0.6「手工推进」引擎侧走查驱动（**非测试文件**；供UI 对齐 / T0.8 复用）。
 *
 * 用法：
 *   .\scripts\with-node22.ps1 pnpm test          # 先编译出 dist
 *   .\scripts\with-node22.ps1 node dist\test\fixtures\t06-walkthrough.js
 *
 * 逐步 `engine.dispatch({scope,id,event,payload})`，打印每步：
 *   event → tasks.state（+ resume_state/ready_since）→ 新增 task_events.kind → plan_steps。
 * `autoSchedule:false`：每次 dispatch 只走一步，便于逐条对照 05 §3.1。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  getTaskById,
  listPlanSteps,
  listTaskEvents,
  openDatabase,
  runMigrations,
} from '../../src/main/db/index.js';
import { Engine, makeRecordingExecutor, type EngineEvent } from '../../src/main/engine/index.js';
import { projectProgressReported } from '../../src/main/agent/tool-events.js';

const dir = mkdtempSync(join(tmpdir(), 'aico-t06-'));
const db = openDatabase(join(dir, 'aico.db'));
runMigrations(db);

const projectId = Number(
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('演示', 'D:/tmp/演示', 1)").run().lastInsertRowid,
);

// ① 建任务（短号在 createTask 内分配；状态 inbox；同事务落 task_created）
const task = createTask(db, new SqliteCounterStore(db), {
  projectId,
  title: 'T0.6 手工推进',
  goal: '走通主链 + paused 往返',
  riskLevel: 1, // L1：plan_drafted 后需 critic → plan_reviewed 才到 awaiting_approval
});
const taskId = task.id;

const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1_000 });
const ev = (event: string, payload?: Record<string, unknown>): EngineEvent => ({
  scope: 'task',
  id: taskId,
  event,
  actor: 'boss',
  payload,
});

const rows: Array<Record<string, unknown>> = [];
async function step(event: string, payload?: Record<string, unknown>): Promise<void> {
  const before = listTaskEvents(db, taskId).length;
  await engine.dispatch(ev(event, payload));
  const kinds = listTaskEvents(db, taskId)
    .slice(before)
    .map((e) => e.kind);
  const t = getTaskById(db, taskId);
  rows.push({
    step: rows.length,
    event,
    state: t?.state,
    resume_state: t?.resume_state ?? null,
    ready_since: t?.ready_since ?? null,
    newKinds: kinds,
    planSteps: listPlanSteps(db, taskId).map((s) => `${s.idx}:${s.state}`).join(','),
  });
}

rows.push({
  step: 0,
  event: '(createTask)',
  state: getTaskById(db, taskId)?.state,
  newKinds: listTaskEvents(db, taskId).map((e) => e.kind),
});

/** 进度上报（`report_progress` 工具路径：写 progress_reported 事件 + 投影 plan_steps）。 */
function progress(stepIdx: number, state: 'pending' | 'running' | 'done' | 'skipped' | 'failed', note?: string): void {
  projectProgressReported(db, { taskId, stepIdx, state, note, actor: 'assistant', at: 1_000 });
  rows.push({
    step: rows.length,
    event: `report_progress(${stepIdx},${state})`,
    state: getTaskById(db, taskId)?.state,
    newKinds: ['progress_reported'],
    planSteps: listPlanSteps(db, taskId).map((s) => `${s.idx}:${s.state}`).join(','),
  });
}

// ② 主链 + 一次 paused 往返（逐条对照 05 §3.1.1）
await step('triage'); // inbox → planning            [task_triaged]
await step('plan_drafted', { steps: ['收集资料', '写初稿', '校对'] }); // planning(不变) [plan_drafted] + plan_steps 初始化
await step('plan_reviewed'); // planning → awaiting_approval [plan_reviewed]
await step('plan_approved'); // awaiting_approval → ready     [plan_approved] + ready_since
await step('start_task'); // ready → executing               [task_started]
progress(1, 'done', '资料齐了'); // 第 1 步 done（进度条 1/3）
progress(2, 'running'); // 第 2 步 running
await step('pause'); // executing → paused             [task_paused]
await step('resume'); // paused → ready               [task_resumed]
await step('start_task'); // ready → executing               [task_started]
await step('all_work_items_done'); // executing → verifying   [verification_started]
await step('verification_completed', { verdict: 'pass' }); // verifying → done [verification_completed, task_completed]

console.log('T06_WALKTHROUGH ' + JSON.stringify(rows, null, 0));
console.log('final_state=' + getTaskById(db, taskId)?.state);
console.log('events=' + listTaskEvents(db, taskId).map((e) => e.kind).join(','));

db.close();
rmSync(dir, { recursive: true, force: true });
