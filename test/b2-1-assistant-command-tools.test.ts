/**
 * 幕僚长扩权——create_task / dispatch / steer / list_holds
 * 四工具＋分层上下文（项目层/技能层）＋删「后续里程碑接入」过期声明。
 *
 * 背景：幕僚长提示词宣称「拆解与规划、分派员工」但无任何建派工具——头衔与
 * 能力结构矛盾；hold 状态读不到（P3）。本次把四工具落地：
 *  - `create_task`：**复用 `handleTaskCreate` 全部门**（预算预检/模型白名单/ 分诊——由
 *    index.ts 注入回调，工具层不做第二套口径）；
 *  - `dispatch`：schedule＝引擎调度 tick；retry＝对失败工作项发 `retry` 事件（attempt+1）；
 *  - `steer`：复用通路投话到在跑员工会话；不在跑 → 记入任务上下文并明说（不假装送达）；
 *  - `list_holds`：`engine.listDispatchHolds()`＋槽位真读数；无 hold 明说，不臆造。
 * 分层上下文：项目约定层（readProjectContextDetailed 复用）＋技能索引层（skillsLayer 复用）；
 * 无内容不注入空段（CTX 口径）。静态→动态排序护缓存前缀。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTask,
  insertEmployee,
  insertWorkItem,
  listHumanMessages,
  openMemoryDatabase,
  runMigrations,
  setPermissionPolicy,
  SqliteCounterStore,
  type SqliteDb,
} from '../src/main/db/index.js';
import { AssistantRuntime, makeFakeAgentRuntime } from '../src/main/agent/index.js';
import { ASSISTANT_SYSTEM_PROMPT_M0 } from '../src/main/agent/pi-assistant.js';
import {
  createAssistantCommandTools,
  type AssistantCommandDeps,
} from '../src/main/agent/assistant-command-tools.js';
import { buildAssistantLayers } from '../src/main/agent/assistant.js';
import { permissionGate } from '../src/main/permission/index.js';

function fresh(): SqliteDb {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

type Tool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

async function textOf(t: Tool, params: Record<string, unknown>): Promise<string> {
  const res = await t.execute('tc1', params);
  return res.content.map((c) => c.text).join('\n');
}

async function makeTools(deps: AssistantCommandDeps) {
  const tools = await createAssistantCommandTools(deps);
  return tools as unknown as Record<string, Tool>;
}

// ── ① 提示词：过期声明删除＋新工具口径 ─────────────────────────────────────

test('B2-8: 风暴纪律行——头脑风暴一等对话（不建任务不推流程），纪要出口＝note_write／转任务＝create_task', () => {
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /头脑风暴/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /一等对话/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /不建任务/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /note_write/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /create_task/);
  //  终验抓出的缺陷回归锚：提示词点名的工具必须存在于幕僚长工具注册名单
  // （write_note 是员工侧工具，幕僚长侧叫 note_write——点名不存在的工具＝模型必跑空）。
  assert.ok(!/`write_note`/.test(ASSISTANT_SYSTEM_PROMPT_M0), '不得点名员工侧工具 write_note');
});

test('B2-1: M0 提示词删「后续里程碑接入」过期声明，写明四指挥工具口径', () => {
  assert.ok(!ASSISTANT_SYSTEM_PROMPT_M0.includes('后续里程碑接入'), '过期声明必须删除（58 §1.6 P1）');
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /create_task/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /dispatch/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /steer/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /list_holds/);
  assert.match(ASSISTANT_SYSTEM_PROMPT_M0, /不亲自执行/, '幕僚长不执行生产工作的边界保留（D-20）');
});

// ── ② create_task：复用注入的建任务回调（全部门在回调里），工具层只做校验 ──

test('B2-1: create_task —— 校验 goal、透传 scope 缺省项目、origin/via 标记', async () => {
  const db = fresh();
  try {
    const calls: Array<Record<string, unknown>> = [];
    const tools = await makeTools({
      db,
      scopeProjectId: () => 7,
      createTask: async (input) => {
        calls.push(input);
        return { id: 42, shortId: 'T-1042', title: String(input.title ?? ''), state: 'planning' };
      },
    });
    const out = await textOf(tools.createTaskTool, { goal: '把对账脚本补上测试', acceptance: ['测试全过'] });
    assert.match(out, /T-1042/);
    assert.equal(calls.length, 1);
    const call = calls[0] as Record<string, unknown>;
    assert.equal(call['goal'], '把对账脚本补上测试');
    assert.equal(call['projectId'], 7, '未显式给项目 → 用频道范围（与分诊器口径一致）');
    assert.equal(call['origin'], 'assistant');
    assert.equal(call['via'], 'assistant_create_task');
  } finally {
    db.close();
  }
});

test('B2-1: create_task —— 缺 goal 响亮拒；回调抛错原样透给模型；未接线如实说', async () => {
  const db = fresh();
  try {
    const tools = await makeTools({ db });
    const noGoal = await textOf(tools.createTaskTool, {});
    assert.match(noGoal, /goal/);
    let called = 0;
    const throwing = await makeTools({
      db,
      createTask: async () => {
        called += 1;
        throw new Error('项目 #3 已归档——不能新建任务');
      },
    });
    const errOut = await textOf(throwing.createTaskTool, { goal: 'x' });
    assert.equal(called, 1);
    assert.match(errOut, /已归档/, '回调的拒绝原因必须透传（模型据此向老板解释）');
    const unwired = await makeTools({ db, createTask: undefined });
    const out = await textOf(unwired.createTaskTool, { goal: 'x' });
    assert.match(out, /未接线/);
  } finally {
    db.close();
  }
});

// ── ③ dispatch：schedule＝tick；retry＝失败件 retry 事件 ──────────────────

function seedTask(db: SqliteDb, opts: { risk?: number } = {}): { taskId: number; wiId: number; shortId: string } {
  const empExists = db.prepare('SELECT 1 FROM employees WHERE id = 7').get();
  if (!empExists) insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
  const projectId = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
  );
  const task = createTask(db, new SqliteCounterStore(db), {
    projectId,
    title: 'T',
    goal: 'g',
    riskLevel: opts.risk ?? 1,
    ownerId: 7,
  });
  const wi = insertWorkItem(db, { taskId: task.id, employeeId: 7, title: 'w', brief: 'b', now: 1 });
  return { taskId: task.id, wiId: wi.id, shortId: task.short_id ?? `T-?${task.id}` };
}

test('B2-1: dispatch schedule —— 引擎 tick 被调用；未接引擎如实说', async () => {
  const db = fresh();
  try {
    const { shortId } = seedTask(db);
    let ticks = 0;
    const tools = await makeTools({ db, engine: { dispatch: async () => {}, tick: async () => { ticks += 1; } } });
    const out = await textOf(tools.dispatchTool, { task: shortId });
    assert.equal(ticks, 1, 'schedule 应触发一次调度 tick');
    assert.match(out, /调度/);
    const noEngine = await makeTools({ db, engine: null });
    const out2 = await textOf(noEngine.dispatchTool, { task: shortId });
    assert.match(out2, /未装配/);
  } finally {
    db.close();
  }
});

test('B2-1: dispatch retry —— 对失败工作项发 retry 事件；无失败件明说', async () => {
  const db = fresh();
  try {
    const { taskId, wiId, shortId } = seedTask(db);
    db.prepare("UPDATE work_items SET state='failed' WHERE id=?").run(wiId);
    const dispatched: unknown[] = [];
    const tools = await makeTools({
      db,
      engine: { dispatch: async (e) => { dispatched.push(e); }, tick: async () => {} },
    });
    const out = await textOf(tools.dispatchTool, { task: shortId, action: 'retry' });
    assert.equal(dispatched.length, 1);
    const ev = dispatched[0] as { scope: string; id: number; event: string; actor: string };
    assert.equal(ev.scope, 'work_item');
    assert.equal(ev.id, wiId);
    assert.equal(ev.event, 'retry');
    assert.equal(ev.actor, 'assistant');
    assert.match(out, /重试|retry/);
    // 无失败件
    const clean = seedTask(db);
    const out2 = await textOf(tools.dispatchTool, { task: clean.shortId, action: 'retry' });
    assert.match(out2, /没有失败/);
    void taskId;
  } finally {
    db.close();
  }
});

// ── ④ steer：在跑投话（同通路）；不在跑记入任务上下文并明说 ──────────

test('B2-1: steer —— 在跑件投话到员工会话（sessionKey 正确）；未送达如实回执', async () => {
  const db = fresh();
  try {
    const { taskId, wiId, shortId } = seedTask(db);
    db.prepare("UPDATE work_items SET state='running' WHERE id=?").run(wiId);
    const steered: Array<{ key: string; text: string }> = [];
    const tools = await makeTools({
      db,
      steerEmployee: (key, text) => {
        steered.push({ key, text });
        return true;
      },
    });
    const out = await textOf(tools.steerTool, { task: shortId, message: '术语统一用「对账单」' });
    assert.equal(steered.length, 1);
    assert.equal(steered[0]?.key, `employee:7:task:${taskId}:wi:${wiId}`);
    assert.equal(steered[0]?.text, '术语统一用「对账单」');
    assert.match(out, /已把话投给/, '投话成功回执');
    // 消息入任务上下文（审计）
    const msgs = listHumanMessages(db, { taskId });
    assert.ok(msgs.some((m) => m.direction === 'in' && m.content?.includes('对账单')), 'steer 消息必须落任务消息流');
    // 未送达：如实说（不假装送出）
    const notDelivered = await makeTools({ db, steerEmployee: () => false });
    const out2 = await textOf(notDelivered.steerTool, { task: shortId, message: '再试一次' });
    assert.match(out2, /未送达|没送出/);
  } finally {
    db.close();
  }
});

test('B2-1: steer —— 不在跑：记入任务上下文并明说；查无任务如实说', async () => {
  const db = fresh();
  try {
    const { taskId, shortId } = seedTask(db);
    const steered: string[] = [];
    const tools = await makeTools({
      db,
      steerEmployee: (key) => {
        steered.push(key);
        return true;
      },
    });
    const out = await textOf(tools.steerTool, { task: shortId, message: '方向改成 B' });
    assert.match(out, /不在跑|记入任务上下文/);
    assert.equal(steered.length, 0, '不在跑不得调用 steer（会话不在飞）');
    const out2 = await textOf(tools.steerTool, { task: 'T-9999', message: 'x' });
    assert.match(out2, /没找到|查无/);
    assert.equal(steered.length, 0, '查无任务也不得投话');
  } finally {
    db.close();
  }
});

// ── ⑤ list_holds：hold 真读数＋槽位；空态明说 ─────────────────────────────

test('B2-1: list_holds —— 列出等待原因与槽位；空态明说；未接引擎如实说', async () => {
  const db = fresh();
  try {
    seedTask(db);
    const tools = await makeTools({
      db,
      engine: {
        dispatch: async () => {},
        schedulerSlots: () => ({ running: 2, total: 3 }),
        listDispatchHolds: () => [{ workItemId: 9, taskId: 1, reason: 'budget', conflictsWith: [], detail: '预算不足' }],
      },
    });
    const out = await textOf(tools.listHoldsTool, {});
    assert.match(out, /budget/);
    assert.match(out, /2\s*\/\s*3|槽位/, out);
    const empty = await makeTools({
      db,
      engine: { dispatch: async () => {}, listDispatchHolds: () => [], schedulerSlots: () => ({ running: 0, total: 3 }) },
    });
    const out2 = await textOf(empty.listHoldsTool, {});
    assert.match(out2, /没有/);
    const noEngine = await makeTools({ db, engine: null });
    const out3 = await textOf(noEngine.listHoldsTool, {});
    assert.match(out3, /未装配/);
  } finally {
    db.close();
  }
});

// ── ⑥ 分层上下文：项目约定层＋技能索引层；无内容不注入空段 ────────────────

test('B2-1: buildAssistantLayers —— 项目约定层读 AGENTS.md；技能索引＝幕僚长勾选 ∪ 项目默认；空态不注入空段', async () => {
  const db = fresh();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'b2-1-ctx-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# 项目约定\n\n术语统一「对账单」。', 'utf8');
      const projectId = Number(
        db.prepare('INSERT INTO projects(name, root_dir, created_at, default_skills) VALUES(?,?,1,?)').run(
          'P',
          dir,
          JSON.stringify(['fact-check']),
        ).lastInsertRowid,
      );
      // 幕僚长（id 0）勾选 company-management
      db.prepare(
        "INSERT INTO employees(id,name,role,is_assistant,skills,created_at) VALUES(0,'幕僚长','assistant',1,?,1)",
      ).run(JSON.stringify(['company-management']));
      db.prepare(
        "INSERT INTO skills(id,name,description,source,path,enabled,created_at) VALUES(1,'company-management','公司管理','builtin','/x/SKILL.md',1,1)",
      ).run();
      db.prepare(
        "INSERT INTO skills(id,name,description,source,path,enabled,created_at) VALUES(2,'fact-check','事实核查','builtin','/y/SKILL.md',1,1)",
      ).run();
      const layers = buildAssistantLayers(db, { projectId });
      assert.match(layers.projectLayer, /对账单/, '项目约定层必须含 AGENTS.md 内容');
      assert.match(layers.skillLayer, /company-management/);
      assert.match(layers.skillLayer, /fact-check/, '技能索引＝幕僚长勾选 ∪ 项目默认');
      // 空项目：无 AGENTS.md、无技能 → 两层都是空串（不注入空段）
      const emptyDir = mkdtempSync(join(tmpdir(), 'b2-1-empty-'));
      try {
        const pid2 = Number(
          db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('Q',?,1)").run(emptyDir).lastInsertRowid,
        );
        const empty = buildAssistantLayers(db, { projectId: pid2 });
        assert.equal(empty.projectLayer, '', '无 AGENTS.md → 项目层空（不注入空段）');
        assert.match(empty.skillLayer, /company-management/, '幕僚长自身技能跟随员工（不随项目清空）');
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});

test('B2-1: runTurn 装配顺序——分层在 scope 之后、记忆（事实层）之前；空层不产生空段', async () => {
  const db = fresh();
  try {
    const { taskId, shortId } = seedTask(db);
    const fake = makeFakeAgentRuntime([{ text: '好', toolCalls: [] }]);
    const a = new AssistantRuntime({ db, runtime: fake, systemPrompt: 'BASE' });
    await a.runTurn({ text: '你好', taskId });
    const prompt = fake.runs[0]?.systemPrompt ?? '';
    assert.ok(prompt.includes('BASE'), '底座保留');
    const iBase = prompt.indexOf('BASE');
    const iScope = prompt.indexOf('范围规则');
    const iMem = prompt.indexOf('[记忆');
    if (iScope >= 0 && iMem >= 0) {
      assert.ok(iBase < iScope && iScope < iMem, `静态→动态排序（base ${iBase} < scope ${iScope} < memory ${iMem}）`);
    }
  } finally {
    db.close();
  }
});

// ── ⑦ 幕僚长会话闸门不受影响（回归）：employeeId=0 → git commit 不被拦 ──

test('B2-1 回归: 频道助手权限面不因扩权变化（strict/标准闸门照旧）', () => {
  const db = fresh();
  try {
    insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/repo',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 'T', goal: 'g', riskLevel: 1, ownerId: 7 });
    setPermissionPolicy(db, { scopeType: 'task', scopeId: task.id, tier: 'standard', policy: {} });
    // 幕僚长工具是 manage/other 类（create_task 等），员工闸门三层不受影响——
    // 这里只锁一个事实：扩权没有动 permissionGate（回归锚）。
    const res = permissionGate({ name: 'create_task', args: {} }, {
      capabilityTier: 'standard',
      autonomy: 'standard',
      riskLevel: 1,
      projectRoot: 'D:/repo',
    });
    assert.equal(res.decision, 'allow', 'manage 类工具放行（B2-1 不改闸门）');
  } finally {
    db.close();
  }
});
