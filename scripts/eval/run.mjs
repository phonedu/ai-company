#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// `OPT-AI-13` 评测跑器（M2 §7 序 5）。把 `scripts/eval/tasks.json` 的每条任务在**真引擎**上跑一遍，
// 判分器在本跑器里（命令型 `check`，在工作区执行），产出**质量 / 成本 / 时长**三列。
//
//   用法（`pnpm eval …`；Node ≥22）：
//     pnpm eval --dry-run                          # 管线自测：fake 运行时（零真调、零花费）
//     pnpm eval --tiers=eco --limit=4              # 真跑：省钱档 4 条
//     pnpm eval --tiers=eco,std --limit=4 --warmup # 真跑：两档对照（**加 --warmup 剔除冷启动**；V1 读数）
//     pnpm eval --tasks=add-fn,slug --orchestration=l0 --tiers=eco
//   产物：`out/eval/eval-<stamp>.json`（明细）＋ 控制台三列表 ＋（末尾）挂牌读数一行。
//
//   口径（重要）：
//   ① **隔离**：每条任务＝全新临时工作区＋全新临时库（`%TEMP%\aico-eval-*`），**不碰真实数据目录**
//      （会话落 `<tmp>/sessions`）。
//   ② **真跑＝真引擎**（headless 装配：db → Engine → 真员工运行时），与生产同一条链（D1/D3/C2/R3-1…），
//      差别只在"没有 Electron 壳与窗口"；真窗口保真由 `verify:ui --only=chain-e2e` 覆盖。
//   ③ **档位**：`eco` ⇒ `AICO_ECONOMY_MODEL`＋默认档都设为省钱档（L0 执行员工走省钱档）；
//      `std` ⇒ 默认档设为标准档（规划/执行同档，保证对照只差"模型"这一个变量）。
//   ④ **少真调纪律**：先 `--dry-run` 验管线；真跑默认只前 4 条 × 所选档。
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distMain = join(root, 'dist', 'src', 'main');
// 评测明细落 out/eval（gitignored），不进版本库。
const outDir = join(root, 'out', 'eval');

const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const hasFlag = (name) => process.argv.includes(`--${name}`);
const DRY = hasFlag('dry-run');
// V2（欠账实证）：role_map 显式压过档位默认——默认档＝std，执行员工被 role_map 指定到 eco。
const V2 = hasFlag('v2');
const KEEP = hasFlag('keep');
const LIMIT = DRY ? Number(arg('limit', '99')) : Number(arg('limit', '4'));
const TIERS = arg('tiers', DRY ? 'dry' : 'eco').split(',').map((s) => s.trim()).filter(Boolean);
// 编排轴：`--orchestration=l0,l1` 显式覆盖；缺省 `task`＝按任务自带的 risk（0⇒L0 / 1⇒L1）。
const ORCH = arg('orchestration', 'task').split(',').map((s) => s.trim()).filter(Boolean);
const TASK_FILTER = arg('tasks', '').split(',').map((s) => s.trim()).filter(Boolean);
const TASKS_FILE = arg('tasks-file', 'scripts/eval/tasks.json');
const TIMEOUT_MS = Number(arg('timeout', DRY ? '30' : '240')) * 1000;
const ECO_MODEL = arg('model-eco', 'deepseek-flash');
const STD_MODEL = arg('model-std', 'deepseek-v4-pro');
// CTX-1 P3：上下文工程 A/B 单变量（`--ctx=on|off` → AICO_CTX；默认 on）。
const CTX_ARM = arg('ctx', 'on');
if (CTX_ARM !== 'on' && CTX_ARM !== 'off') {
  console.error('[eval] --ctx 只接受 on|off');
  process.exit(2);
}
process.env.AICO_CTX = CTX_ARM;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(distMain, 'engine', 'loop.js'))) {
  console.error('[eval] 缺编译产物（dist/src/main/**）——先跑 `pnpm test`（或 `pnpm exec tsc -p tsconfig.json`）再评测。');
  process.exit(2);
}
const keyFile = ['deepseek_api_key', 'deepseek-api-key.txt', 'deepseek_api_key.txt'].find((name) =>
  existsSync(join(homedir(), '.aico', 'secrets', name)),
);
if (!DRY && !process.env.DEEPSEEK_API_KEY && !keyFile) {
  console.error('[eval] 真跑需要真 Key（`env DEEPSEEK_API_KEY` 或 `~/.aico/secrets/deepseek_api_key`；兼容 dash/underscore .txt）；或先用 `--dry-run` 验管线。');
  process.exit(2);
}

const load = async (rel) => import(pathToFileURL(join(distMain, ...rel.split('/'))).href);
const dbMod = await load('db/index.js');
const engineMod = await load('engine/index.js');
const agentMod = await load('agent/index.js');
const policyMod = await load('agent/model-policy.js');
const evalMod = await load('eval/eval.js');

const taskSet = evalMod.validateEvalTasks(JSON.parse(readFileSync(join(root, ...TASKS_FILE.split('/')), 'utf8')));
if (!taskSet.ok) {
  console.error('[eval] 任务集不合法：\n  - ' + taskSet.errors.join('\n  - '));
  process.exit(2);
}
let tasks = taskSet.tasks;
if (TASK_FILTER.length > 0) tasks = tasks.filter((t) => TASK_FILTER.includes(t.id));
else tasks = tasks.slice(0, LIMIT);

/** 判分命令执行（真跑：shell；超时/非零 ⇒ 不通过）。 */
function runCheckCmd(command, { cwd, timeoutMs }) {
  const res = spawnSync(command, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8' });
  const code = res.status === null ? 124 : res.status; // 超时/被杀 ⇒ 124
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { code, output };
}

/** dry-run 的脚本化员工：按任务声明的 `dryRunArtifacts` 写盘，再提交工作项。 */
function dryRunRouter(workspaceDir, artifacts) {
  return agentMod.makeFakeAgentRuntime((input) => {
    const key = input.sessionKey ?? '';
    if (key.startsWith('role:planner')) {
      return { text: 'plan', toolCalls: [{ id: 'p1', name: 'submit_plan', input: { steps: ['读懂任务并动手', '自检产出'] }, isError: false }] };
    }
    if (key.startsWith('role:critic')) {
      return { text: 'ok', toolCalls: [{ id: 'c1', name: 'submit_review', input: { verdict: 'approve' }, isError: false }] };
    }
    if (key.startsWith('role:verifier')) {
      return { text: 'ok', toolCalls: [{ id: 'v1', name: 'submit_review', input: { verdict: 'pass' }, isError: false }] };
    }
    if (key.startsWith('employee:')) {
      // 脚本化"干活"：按任务声明写盘（真跑由模型自己干；dry-run 只验管线与判分器）。
      for (const [p, content] of Object.entries(artifacts ?? {})) {
        const abs = join(workspaceDir, ...p.split('/'));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      }
      return { text: '', toolCalls: [{ id: 'w1', name: 'submit_work_item', input: { summary: '（dry-run）脚本化产出' }, isError: false }] };
    }
    return { text: '', toolCalls: [] };
  });
}

/** 跑一条（任务 × 编排 × 档）——返回 { row, detail }。 */
async function runOne(task, orchestration, tier) {
  // 实际编排：显式 l0/l1 覆盖任务自带 risk（评测的「编排」轴＝同一任务两种编排各跑一遍）。
  const actualOrch = orchestration === 'task' ? (task.risk === 1 ? 'l1' : 'l0') : orchestration;
  const dir = mkdtempSync(join(tmpdir(), 'aico-eval-'));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  for (const [p, content] of Object.entries(task.seedFiles ?? {})) {
    const abs = join(workspace, ...p.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  const db = dbMod.openDatabase(join(dir, 'aico.sqlite'));
  dbMod.runMigrations(db);
  const projectId = Number(db.prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?,?,?)').run('评测项目', workspace, 1).lastInsertRowid);
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(0,'幕僚长','assistant','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(7,'工程师','dev','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(9,'验证者','reviewer','standard',1)").run();
  // 档位（对照的**唯一变量**）：eco ⇒ 省钱档；std ⇒ 标准档；dry ⇒ 不动（fake 无模型）
  if (DRY) {
    policyMod.setRoleMap(null);
  } else if (tier === 'eco') {
    process.env.AICO_ECONOMY_MODEL = ECO_MODEL;
    policyMod.setDefaultModel(ECO_MODEL);
  } else {
    process.env.AICO_ECONOMY_MODEL = STD_MODEL;
    policyMod.setDefaultModel(STD_MODEL);
    policyMod.setRoleMap(V2 ? { employee: { model: ECO_MODEL } } : null);
  }

  let engine;
  let bundle = null;
  let runtime;
  if (DRY) {
    runtime = new agentMod.EmployeeSessionRuntime(dryRunRouter(workspace, task.dryRunArtifacts));
  } else {
    // `createEmployeeRuntime`/`buildEmployeeContext` 未从 `agent/index` 出口导出 ⇒ 按模块直引（不复制实现）。
    const factoryMod = await load('agent/employee-factory.js');
    const ctxMod = await load('agent/context.js');
    bundle = await factoryMod.createEmployeeRuntime({
      db,
      cwd: workspace,
      sessionDir: join(dir, 'sessions'),
      buildContext: ctxMod.buildEmployeeContext,
    });
    runtime = bundle.runtime;
  }
  const executor = bundle
    ? bundle.createExecutor((e) => engine?.dispatch(e), (input) => engine?.recordCost(input))
    : agentMod.createEmployeeExecutor({ db, runtime, dispatch: (e) => engine?.dispatch(e) });
  engine = new engineMod.Engine(db, executor, { autoSchedule: true });

  const taskRow = dbMod.createTask(db, new dbMod.SqliteCounterStore(db), {
    projectId,
    title: task.title,
    goal: task.goal,
    acceptance: task.acceptance.map((a) => ({ text: a.text, ...(a.check ? { check: a.check } : {}) })),
    riskLevel: actualOrch === 'l1' ? 1 : 0,
    ownerId: 7,
  });

  const startedAt = Date.now();
  const state = () => (db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskRow.id) ?? { state: '?' }).state;
  let notes = '';
  try {
    await engine.dispatch({ scope: 'task', id: taskRow.id, event: 'triage', actor: 'boss', payload: { via: 'eval' } });
    const TERMINAL = new Set(['done', 'failed', 'cancelled', 'needs_decision']);
    while (!TERMINAL.has(state()) && Date.now() - startedAt < TIMEOUT_MS) {
      if (actualOrch === 'l1' && state() === 'awaiting_approval') {
        // 评测跑器扮演老板：按 L1 口径批准（真实跑里这一步是人点卡；评测要可复现 ⇒ 自动批准并留痕）。
        await engine.dispatch({ scope: 'task', id: taskRow.id, event: 'plan_approved', actor: 'boss', payload: { via: 'eval-boss' } });
      } else {
        await engine.schedulePass();
      }
      await sleep(300);
    }
  } catch (error) {
    notes = `引擎异常：${error instanceof Error ? error.message : String(error)}`;
  }
  const wallMs = Date.now() - startedAt;
  const finalState = state();
  const overTime = !['done', 'failed', 'cancelled', 'needs_decision'].includes(finalState) || wallMs >= TIMEOUT_MS;

  // 判分（真工作区）
  const graded = evalMod.gradeAcceptance(task, workspace, runCheckCmd, 30_000);
  const costRow = db.prepare('SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cache_read_tokens),0) cread FROM costs WHERE task_id = ?').get(taskRow.id);
  const models = db.prepare('SELECT DISTINCT model FROM costs WHERE task_id = ? AND model IS NOT NULL').all(taskRow.id).map((r) => r.model);
  // CTX-1 P3：上下文读数（每会话一行；压缩次数按会话取最大值再求和，避免逐轮累计重复加）。
  const ctxAgg = db
    .prepare(
      `SELECT COUNT(*) n,
              COALESCE(SUM(total_tokens),0) total,
              COALESCE(SUM(system_tokens),0) sys,
              COALESCE(SUM(cache_read_tokens),0) cread,
              COALESCE(SUM(cache_write_tokens),0) cwrite,
              COALESCE(MAX(truncated),0) trunc
         FROM context_metrics WHERE task_id = ?`,
    )
    .get(taskRow.id);
  const ctxComp = db
    .prepare('SELECT COALESCE(SUM(c),0) comp FROM (SELECT MAX(CASE WHEN compaction_count IS NULL THEN 0 ELSE compaction_count END) c FROM context_metrics WHERE task_id = ? GROUP BY session_key)')
    .get(taskRow.id);
  // B1-2：分层上下文读数（哪层最烧钱）——按 context_metrics.layers_json 聚合 name→tokens。
  const layerRows = db.prepare('SELECT layers_json FROM context_metrics WHERE task_id = ?').all(taskRow.id);
  const layerTotals = new Map();
  for (const row of layerRows) {
    try {
      for (const layer of JSON.parse(String(row.layers_json ?? '[]'))) {
        const name = String(layer?.name ?? layer?.layer ?? 'unknown');
        layerTotals.set(name, (layerTotals.get(name) ?? 0) + Number(layer?.estTokens ?? layer?.tokens ?? 0));
      }
    } catch {
      /* 坏行跳过（不猜） */
    }
  }
  const ctxLayers = [...layerTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, tokens]) => ({ name, tokens }));
  const ctx = {
    arm: CTX_ARM,
    rows: Number(ctxAgg.n ?? 0),
    totalTokens: Number(ctxAgg.total ?? 0),
    systemTokens: Number(ctxAgg.sys ?? 0),
    cacheReadTokens: Number(ctxAgg.cread ?? 0),
    cacheWriteTokens: Number(ctxAgg.cwrite ?? 0),
    compactions: Number(ctxComp.comp ?? 0),
    truncated: Number(ctxAgg.trunc ?? 0) === 1,
  };
  const detail = {
    taskId: task.id,
    orchestration: actualOrch,
    tier: DRY ? 'dry' : tier,
    taskState: finalState,
    wallMs,
    notes,
    usd: Number(costRow.usd ?? 0),
    tokensIn: Number(costRow.tin ?? 0),
    tokensOut: Number(costRow.tout ?? 0),
    cacheReadTokens: Number(costRow.cread ?? 0),
    models,
    ctx,
    ctxLayers,
    planSteps: dbMod.listPlanSteps(db, taskRow.id).length,
    events: db.prepare('SELECT kind FROM task_events WHERE task_id = ? ORDER BY id').all(taskRow.id).map((e) => e.kind),
    grade: graded,
    workspaceFiles: spawnSync(process.execPath, ['-e', "const fs=require('fs');const p=process.cwd();console.log(fs.readdirSync(p).join(','))"], { cwd: workspace, encoding: 'utf8' }).stdout.trim(),
    workspace,
    dir,
  };
  db.close();
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  const row = {
    taskId: task.id,
    orchestration: actualOrch,
    tier: DRY ? 'dry' : tier,
    taskState: overTime ? `${finalState}(超时)` : finalState,
    quality: graded.quality,
    verdict: graded.verdict,
    usd: detail.usd,
    wallMs,
    models,
    tokensIn: detail.tokensIn,
    tokensOut: detail.tokensOut,
    cacheReadTokens: detail.cacheReadTokens,
    ctxTokens: detail.ctx.totalTokens,
    ctxCompactions: detail.ctx.compactions,
    ...(notes ? { notes } : {}),
  };
  return { row, detail };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rows = [];
const details = [];
// 冷启动剔除（实测：进程内**首条**真跑会额外背 ~4min 的过程级装配/模型目录拉取 ⇒ 时长不可比）。
// `--warmup`：先跑一条不计入读数；两档对照建议开启（否则第一档的时长被冷启动污染）。
if (!DRY && hasFlag('warmup')) {
  console.log('[eval] 预热一条（不计入读数；剔除过程级冷启动）…');
  const t0 = Date.now();
  try {
    await runOne(tasks[0], ORCH[0], TIERS[0]);
    console.log(`[eval] 预热完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (error) {
    console.log(`[eval] 预热失败（忽略，不影响读数）：${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`[eval] 模式=${DRY ? 'dry-run（fake 运行时，零真调）' : `真跑（${TIERS.join('+')}）`} 编排=${ORCH.join('+')} 任务=${tasks.length} 条 CTX=${CTX_ARM} 集=${TASKS_FILE}`);
for (const orchestration of ORCH) {
  for (const tier of TIERS) {
    for (const task of tasks) {
      const label = `${task.id} · ${orchestration} · ${tier}`;
      const t0 = Date.now();
      try {
        const { row, detail } = await runOne(task, orchestration, tier);
        rows.push(row);
        details.push(detail);
        console.log(`[eval] ${label} → 判=${row.verdict} 质量=${row.quality === null ? '—' : Math.round(row.quality * 100) + '%'} 终态=${row.taskState} $${row.usd.toFixed(4)} ${((Date.now() - t0) / 1000).toFixed(0)}s${row.notes ? `（${row.notes}）` : ''}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rows.push({ taskId: task.id, orchestration, tier: DRY ? 'dry' : tier, taskState: 'error', quality: null, verdict: 'fail', usd: 0, wallMs: Date.now() - t0, models: [], notes: message });
        console.log(`[eval] ${label} → 跑失败：${message}`);
      }
    }
  }
}

const table = evalMod.formatEvalTable(rows);
const summary = evalMod.evalSummaryLine(rows, stamp);
console.log('\n' + table + '\n');
console.log('[eval] 挂牌读数：' + summary);

mkdirSync(outDir, { recursive: true });
// D-3 复核：评测必须能追溯到候选 commit（此前 JSON 无 gitHead，无法证明跑在哪个代码上）。
const gitHead = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim();
const dirty = (spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim().length > 0;
const outFile = join(outDir, `eval-${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify({ stamp, mode: DRY ? 'dry-run' : 'real', ctxArm: CTX_ARM, tiers: TIERS, orchestration: ORCH, provenance: { gitHead, dirty }, rows, details }, null, 2) + '\n',
  'utf8',
);
console.log(`[eval] 明细=${outFile}`);
const failed = rows.filter((r) => r.verdict === 'fail').length;
console.log(`[eval] 完成：${rows.length} 行，判 fail ${failed} 行（有牙样本按设计必在其列）`);
if (DRY && failed === 0) {
  console.error('[eval] ⚠️ dry-run 无 fail——有牙样本必须 fail（判分器异常）');
  process.exitCode = 1;
}
