/**
 * 废 semantic-classifier 并入幕僚长——特性开关可回退。
 *
 * 口径：`AICO_TRIAGE=assistant|classifier`，**默认 assistant**（唯一指挥脑）。
 *  - assistant 模式：自由文本**不再调用 LLM 分诊器**（零成本、无双答案），一律交幕僚长
 *    会话（由 create_task/steer 工具自行分诊—— 已落）；确定性路径（文本命令/#任务
 *    引用/回复链/序号确认/「建任务：」直通）双模式保留；
 *  - classifier 模式：与 v0.2.1 完全一致（旧链路可回退，验收出口 A 的回归面）；
 *  - 分诊器文件保留至验收后另批删除（本件只做开关与消费端转换）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { SqliteCounterStore } from '../src/main/db/counters.js';
import { createTask } from '../src/main/db/tasks.js';
import { writeSetting } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleChatSend, readTriageMode, type IpcDeps } from '../src/main/ipc/ipc.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';

const AT = 1_700_000_000_000;

function setup(triageMode?: 'assistant' | 'classifier'): { db: SqliteDb; deps: IpcDeps; assistantTurns: Array<{ text: string; taskId: number | null }> } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const projectId = Number(
    (db.prepare('INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?,?,?,?) RETURNING id')
      .get('记账系统', '记账', 'D:/proj', AT) as { id: number }).id,
  );
  void projectId;
  const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => AT });
  const seeded = createTask(db, new SqliteCounterStore(db), { projectId, title: 'seed', goal: 'g', now: AT });
  void seeded;
  writeSetting(db, 'projects.default_id', projectId); // 归属明确（否则 new_task 落 confirm 只问一次）
  const assistantTurns: Array<{ text: string; taskId: number | null }> = [];
  const deps: IpcDeps = {
    repo,
    engine: { dispatch: (e: unknown) => engine.dispatch(e as never) },
    ...(triageMode != null ? { triageMode } : {}),
    assistant: {
      async runTurn(input) {
        assistantTurns.push({ text: input.text, taskId: input.taskId ?? null });
        return { replyMessageId: 1, reply: '好的，我用 create_task 给你建。' };
      },
    },
    // 语义分诊器桩：被调用即计数——assistant 模式下必须零调用（省 LLM、无双答案）。
    classify: async () => {
      classifyCalls += 1;
      return { intent: 'new_task' as const, confidence: 0.95, titleGuess: '分诊器建的' };
    },
  };
  return { db, deps, assistantTurns };
}

let classifyCalls = 0;

const FREE_TEXT = '帮我把对账脚本补上测试';

test('B2-2: 默认（assistant）——自由文本不建任务、不调分诊器，交幕僚长会话', async () => {
  classifyCalls = 0;
  const { deps, assistantTurns } = setup();
  const result = await handleChatSend(deps, { text: FREE_TEXT }, AT);
  assert.equal(result.resolution.kind, 'chat', '自由文本裁定 chat（由幕僚长分诊）');
  assert.equal(result.createdTaskId ?? null, null, '默认模式绝不自动建任务（D-30①）');
  assert.equal(classifyCalls, 0, 'LLM 分诊器零调用（省成本、无双答案）');
  await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落定
  assert.equal(assistantTurns.length, 1, '消息必须到达幕僚长');
  assert.equal(assistantTurns[0]?.text, FREE_TEXT);
});

test('B2-2: assistant 模式下确定性路径保留——#任务引用/「建任务：」直通照旧', async () => {
  classifyCalls = 0;
  const { db, deps } = setup();
  const task = createTask(db, new SqliteCounterStore(db), { projectId: 1, title: '对账', goal: 'g', now: AT });
  // #任务引用 → task_message（确定性，不经分诊器）
  const ref = await handleChatSend(deps, { text: `#${task.short_id ?? `T-${task.id}`} 把验收改成三条` }, AT);
  assert.equal(ref.resolution.kind, 'task_message');
  assert.equal(classifyCalls, 0);
  // 「建任务：」显式直通 → 自动建任务（双模式一致；确定性，不烧 LLM）
  // 注：直通路径（runDirectCommand）早期返回 createdTaskId:null——建没建以任务列表为准。
  await handleChatSend(deps, { text: '建任务：整理竞品简报' }, AT + 1);
  const tasksAfter = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  assert.ok(tasksAfter.n >= 3, `显式建任务指令在 assistant 模式仍然直通（任务数 ${tasksAfter.n}）`);
  assert.equal(classifyCalls, 0);
});

test('B2-2: classifier 模式——与 v0.2.1 一致（自由文本按分诊器信号自动建任务）', async () => {
  classifyCalls = 0;
  const { deps } = setup('classifier');
  const result = await handleChatSend(deps, { text: FREE_TEXT }, AT);
  assert.equal(classifyCalls, 1, '旧链路必须真实调用分诊器（可回退面）');
  assert.equal(result.resolution.kind, 'new_task');
  assert.notEqual(result.createdTaskId ?? null, null, '旧链路行为不变（回归面）');
});

test('B2-2: classifier 模式无 stub —— defaultClassify（一律 chat）不建任务', async () => {
  const { db, deps } = setup('classifier');
  delete (deps as { classify?: unknown }).classify;
  const result = await handleChatSend(deps, { text: FREE_TEXT }, AT);
  assert.equal(result.resolution.kind, 'chat');
  assert.equal(result.createdTaskId ?? null, null);
  void db;
});

test('B2-2: readTriageMode —— env 解析（缺省/合法/非法）', () => {
  assert.equal(readTriageMode(undefined), 'assistant', '缺省＝assistant（唯一指挥脑）');
  assert.equal(readTriageMode('assistant'), 'assistant');
  assert.equal(readTriageMode('classifier'), 'classifier');
  assert.equal(readTriageMode('Classifier'), 'classifier', '大小写宽松（环境变量手输友好）');
  assert.equal(readTriageMode('bogus'), 'assistant', '非法值回落默认（不静默换脑）');
  assert.equal(readTriageMode(''), 'assistant');
});
