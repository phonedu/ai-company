/**
 * OPT-AI-1 真实会话端到端驱动（**非测试文件**；key 到位后手工跑一次，产出验收证据）。
 *
 * 用法：
 *   .\scripts\with-node22.ps1 pnpm build
 *   .\scripts\with-node22.ps1 node dist\test\fixtures\employee-e2e.js
 *
 * 做：真 `createPiAgentRuntime`（persistDir）→ 真执行器 → 员工会话跑一个 work item →
 * 会话调 `submit_work_item` → 执行器发 `submit_work_item` 事件 → 落库；并验证**会话落盘**。
 * 缺 key 非 0 退出（不静默 mock）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { toPersistedAction } from '../../src/main/engine/index.js';
import type { EngineEvent } from '../../src/main/engine/types.js';
import { createPiAgentRuntime } from '../../src/main/agent/pi-runtime.js';
import { createReportProgressTool } from '../../src/main/agent/report-progress-tool.js';
import { createSubmitWorkItemTool } from '../../src/main/agent/submit-work-item-tool.js';
import { createExportFormatTool, createImageGenerateTool } from '../../src/main/agent/tools/content-tools.js';
import { createScreenshotTool, createWebFetchTool } from '../../src/main/agent/tools/web-tools.js';
import { EmployeeSessionRuntime, createEmployeeExecutor } from '../../src/main/agent/index.js';

const dir = mkdtempSync(join(tmpdir(), 'aico-emp-e2e-'));
const sessionsDir = join(dir, 'sessions');
const db = openDatabase(join(dir, 'aico.db'));
runMigrations(db);

const projectId = Number(
  db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('E2E', '" + dir.replace(/\\/g, '/') + "', 1)").run()
    .lastInsertRowid,
);
db.prepare("INSERT INTO employees(id, name, role, persona, created_at) VALUES(7,'小工','dev','你是一名务实工程师。',1)").run();
const task = createTask(db, new SqliteCounterStore(db), {
  projectId,
  title: '真实员工会话',
  goal: '完成一个最小工作项并调用 submit_work_item 提交',
  riskLevel: 1,
  ownerId: 7,
});
const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: '写一句问候', brief: '在回复里写一句问候，然后调用 submit_work_item 提交。', now: 1 });

const events: EngineEvent[] = [];
const started = Date.now();
try {
  const runtime = await createPiAgentRuntime({
    model: process.env.AICO_PI_MODEL ?? 'deepseek-flash',
    cwd: dir,
    systemPrompt: '[平台底座] ai-company 员工。\n[角色规则] 你是员工 #7。\n[人设] 务实工程师。',
    persistDir: sessionsDir,
    extensionFactories: [
      (pi: unknown) => {
        const api = pi as { registerTool(t: unknown): void };
        void createReportProgressTool().then((t) => api.registerTool(t));
        void createSubmitWorkItemTool().then((t) => api.registerTool(t));
        // B4b 接线审查 F3：行为级激活验证——四个内容工具走真注册链（声明给模型即真激活）。
        void createWebFetchTool().then((t) => api.registerTool(t));
        void createScreenshotTool(dir).then((t) => api.registerTool(t));
        void createImageGenerateTool(dir).then((t) => api.registerTool(t));
        void createExportFormatTool(dir).then((t) => api.registerTool(t));
      },
    ],
  });

  const executor = createEmployeeExecutor({
    db,
    runtime: new EmployeeSessionRuntime(runtime),
    dispatch: (e) => void events.push(e),
  });
  await executor.execute(
    toPersistedAction(`dispatch:work_item:${wi.id}:0`, 'dispatch', task.id, JSON.stringify({ attempt: 0 })),
  );

  const toolCalls = events[0]?.event === 'submit_work_item';
  const files = existsSync(sessionsDir) ? join(sessionsDir, '') : '(none)';
  console.log(
    JSON.stringify(
      {
        modelRef: runtime.modelRef,
        credentialSource: runtime.credentialSource,
        elapsedMs: Date.now() - started,
        wiState: getWorkItem(db, wi.id)?.state,
        event: events[0]?.event,
        eventPayload: events[0]?.payload,
        submittedViaTool: toolCalls,
        taskEvents: listTaskEvents(db, task.id).map((e) => e.kind),
        sessionsDir: files,
        sessionFiles: existsSync(sessionsDir) ? true : false,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
