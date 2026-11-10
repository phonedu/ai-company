/**
 *  真实调用冒烟驱动（**非测试文件**；key 到位后手工跑一次）。
 *
 * 用法（key 放好后）：
 *   . .\scripts\env.ps1 # 或设 $env:DEEPSEEK_API_KEY
 *   .\scripts\with-node22.ps1 pnpm build # 先编译出 dist（或已被 pnpm test 生成）
 *   .\scripts\with-node22.ps1 node dist\test\fixtures\pi-smoke.js
 *
 * 输出：模型 / 凭据来源 / 耗时 / 回复摘要 / toolCall 数 / 落库的 task_events 与 plan_steps。
 * 缺 key 会以非 0 退出（不静默 mock）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteCounterStore,
  createTask,
  listPlanSteps,
  listTaskEvents,
  openDatabase,
  runMigrations,
  upsertPlanStepsFromDraft,
} from '../../src/main/db/index.js';
import { createPiAssistantRuntime } from '../../src/main/agent/pi-assistant.js';

const dir = mkdtempSync(join(tmpdir(), 'aico-pi-smoke-'));
const file = join(dir, 'aico.db');
const db = openDatabase(file);
runMigrations(db);

const projectId = Number(
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('冒烟', 'D:/tmp/冒烟', 1)").run().lastInsertRowid,
);
const task = createTask(db, new SqliteCounterStore(db), {
  projectId,
  title: '真实会话冒烟',
  goal: '验证幕僚长真实回复 + tool_call 落库',
  riskLevel: 1,
});
upsertPlanStepsFromDraft(db, task.id, ['第一步', '第二步', '第三步'], 1);

const started = Date.now();
try {
  const { assistant, credentialSource, credentialDescriptor, modelRef } = await createPiAssistantRuntime({
    db,
    model: process.env.AICO_PI_MODEL ?? 'deepseek-flash',
    cwd: dir,
  });

  const turn = await assistant.runTurn({
    text: '你好，请用一句话介绍你自己，并把你认为的第 1 步标为 running。',
    taskId: task.id,
  });

  const events = listTaskEvents(db, task.id);
  const out = {
    modelRef,
    credentialSource,
    credentialDescriptor,
    elapsedMs: Date.now() - started,
    reply: turn.reply.slice(0, 200),
    replyLength: turn.reply.length,
    toolCalls: turn.toolCalls.map((t) => ({ name: t.name, isError: t.isError })),
    usage: turn.usage ?? null,
    taskEvents: events.map((e) => e.kind),
    planSteps: listPlanSteps(db, task.id).map((s) => ({ idx: s.idx, state: s.state })),
    replyMessageId: turn.replyMessageId,
  };
  process.stdout.write(`SMOKE ${JSON.stringify(out)}\n`);
  assistant.dispose();
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
