#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// `audit:chain` 跑器 —— 功能链条断点审计（老板 2026-10-15「第一步」令）。
// 把 `docs/work/research-feature-chain-gap.md` §6「复跑配方」＋五类孤儿探测机器化：
// 一跑输出「BRK 存活表（锚探针）＋ 孤儿普查 ＋ 账本对账」；判断"链条还有没有断"＝跑一条命令。
//
//   用法（一律经 Node22 包装：`.\scripts\with-node22.ps1 pnpm audit:chain`）：
//     pnpm audit:chain            # 人读报告
//     pnpm audit:chain -- --json  # 机器可读（测试用）
//   退出码：0＝无红项（黄项＝「账本待更新/待复核」，不挡）；1＝新孤儿或回归；2＝缺编译产物。
//
// 口径：扫描域 src/main＋src/preload（排除 statemachine.ts 与本件自身）；整行注释不计读数；
//       逻辑在 `src/main/audit/chain-audit.ts`（纯函数、可内存测），账本在 `chain-registry.*`。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distMain = join(root, 'dist', 'src', 'main');

if (!existsSync(join(distMain, 'audit', 'chain-audit.js'))) {
  console.error('[audit:chain] 缺编译产物（dist/src/main/**）——先跑 `pnpm test`（或 `pnpm exec tsc -p tsconfig.json`）再审计。');
  process.exit(2);
}

const load = async (rel) => import(pathToFileURL(join(root, 'dist', 'src', ...rel.split('/'))).href);
const audit = await load('main/audit/chain-audit.js');
const registry = await load('main/audit/chain-registry.js');
const engine = await load('main/engine/index.js');
const { TASK_ACTIONS_TABLE } = await load('renderer/components/taskActions.js');

const asJson = process.argv.includes('--json');

// ── 文件收集（src/main ＋ src/preload，.ts）──
function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const toRel = (abs) => abs.slice(root.length + 1).split('\\').join('/');
const files = [];
for (const dir of ['src/main', 'src/preload']) {
  for (const abs of walk(join(root, dir), [])) {
    files.push({ path: toRel(abs), text: readFileSync(abs, 'utf8') });
  }
}
const isExcluded = (p) => audit.auditScanExcluded(p);

// 探针另含 renderer（BRK19 锚 / BRK13 UI 面读数在 src/renderer）；派发/生产类扫描仍只用 src/main＋src/preload。
const probeFiles = [...files];
for (const abs of walk(join(root, 'src/renderer'), [])) {
  probeFiles.push({ path: toRel(abs), text: readFileSync(abs, 'utf8') });
}

// ── 探测 ──
const defs = audit.eventDefs(engine.TASK_TRANSITIONS, engine.WORK_ITEM_TRANSITIONS);
const uiEvents = audit.uiImplementedEvents(TASK_ACTIONS_TABLE);
const census = audit.censusEvents(defs, files, uiEvents, isExcluded);
const validPairs = new Set(defs.map((d) => `${d.scope}:${d.event}`));
const sites = audit.collectDispatchSites(files, isExcluded);

// ⑥ 孤儿动作：以 dummy ctx 逐行执行 actions() 收集 kind（条件分支由字面量 act('K' 兜底）
const statemachineText = files.find((f) => f.path.endsWith('engine/statemachine.ts'))?.text ?? '';
const actionExecutions = [
  audit.executeActionKinds(engine.TASK_TRANSITIONS, 'task'),
  audit.executeActionKinds(engine.WORK_ITEM_TRANSITIONS, 'work_item'),
];
const actionCensus = audit.actionKindCensus(actionExecutions, audit.literalActionKinds(statemachineText));
const actionFailures = actionExecutions.flatMap((r) => r.failures);

const findings = [
  ...audit.orphanEventFindings(census),
  ...audit.invalidDispatchFindings(sites, validPairs),
  ...audit.writerFindings(files, registry.WRITER_SPECS),
  ...audit.toolFindings(files, registry.TOOL_SPECS),
  ...audit.timerKindFindings(files, registry.TIMER_KINDS),
  ...audit.actionKindFindings(actionCensus, files),
  ...audit.ipcPushFindings(probeFiles),
];
const recon = audit.reconcile(findings, registry.ORPHAN_DISPOSITIONS);
const probeResults = audit.runProbes(registry.PROBES, probeFiles);
const summary = audit.summarize(recon, probeResults);

// ── 输出 ──
const CHECK_LABELS = {
  event: '孤儿迁移（事件 0 生产者）',
  'invalid-dispatch': '非法派发（真值表无此迁移）',
  writer: '孤儿写者（调用者仅测试）',
  tool: '孤儿工具（员工会话侧无消费者）',
  'timer-kind': '孤儿 timer（无调度/处理引用）',
  action: '孤儿动作（动作 kind 无消费者）',
  'ipc-push': '孤儿推送通道（声明/推送/路由 三腿）',
};

const today = new Date().toISOString().slice(0, 10);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        date: today,
        ledgerDate: registry.CHAIN_AUDIT_DATE,
        scannedFiles: files.length,
        censusSize: census.length,
        summary,
        reconciliation: recon,
        probes: probeResults,
        actionKinds: actionCensus,
        actionFailures,
        pushChain: audit.pushChainCensus(probeFiles),
        notes: registry.MANUAL_NOTES,
      },
      null,
      2,
    ),
  );
} else {
  const L = [];
  L.push(`链条断点审计（audit:chain）· 账本 ${registry.CHAIN_AUDIT_DATE} · 读数 ${today}`);
  L.push(
    `扫描：src/main＋src/preload（${files.length} 文件；排除 statemachine.ts / src/main/audit/）＋探针含 src/renderer（${probeFiles.length - files.length} 文件）；事件普查 ${census.length} 条`,
  );
  L.push('');
  L.push('════ ① 固定锚探针（账本记读数：fixed 偏移＝回归；open 偏移＝待复核）════');
  for (const r of probeResults) {
    const mark = r.ok ? (r.probe.status === 'fixed' ? '✔' : '·') : r.probe.status === 'fixed' ? '✘ 回归' : '△ 待复核';
    const state = r.probe.status === 'fixed' ? '已修' : '断/现状';
    L.push(`  ${mark} ${r.probe.id}（${state}） 读数 ${r.reading}，期望 ${r.probe.op}${r.probe.value} —— ${r.probe.note}`);
  }
  L.push('');
  L.push('════ ② 孤儿普查（对账本：open/intended＝已登记；无 disposition＝✘ 新孤儿；fixed 仍在场＝✘ 回归）════');
  const byCheck = new Map();
  for (const f of findings) {
    const arr = byCheck.get(f.check) ?? [];
    arr.push(f);
    byCheck.set(f.check, arr);
  }
  const dispOf = (f) => registry.ORPHAN_DISPOSITIONS.find((d) => d.check === f.check && d.name === f.name);
  for (const [check, label] of Object.entries(CHECK_LABELS)) {
    const list = byCheck.get(check) ?? [];
    const openCount = list.filter((f) => dispOf(f)?.status !== 'fixed').length;
    L.push(`  ${label}：${list.length} 项（按账本登记 ${openCount}）`);
    for (const f of list) {
      const d = dispOf(f);
      const tag = d ? `${d.status === 'fixed' ? '✘' : '·'} ${d.status}  ${d.ref}` : '✘ 未登记';
      L.push(`    ${f.name}  [${tag}]  ${f.detail}`);
    }
  }
  if (actionFailures.length > 0) {
    L.push(`  孤儿动作枚举失败 ${actionFailures.length} 行（条件闭包，如实列出）：`);
    for (const f of actionFailures) L.push(`    ${f.row} — ${f.error}`);
  }
  L.push('');
  L.push('════ ③ 人工注记（不计红）════');
  for (const n of registry.MANUAL_NOTES) L.push(`  · ${n.title}：${n.note}`);
  L.push('');
  L.push('════ 结论 ════');
  L.push(
    `  新孤儿 ${recon.unknown.length} · 回归 ${recon.regressions.length} · 账本待更新 ${recon.possiblyFixed.length} · 探针偏移 ${probeResults.filter((r) => !r.ok).length}`,
  );
  for (const reason of summary.redReasons) L.push(`  ✘ ${reason}`);
  for (const reason of summary.yellowReasons) L.push(`  △ ${reason}`);
  L.push(`  （退出码 ${summary.red ? 1 : 0}${summary.red ? '；红项未清零' : '；无红项'}）`);
  console.log(L.join('\n'));
}

process.exit(summary.red ? 1 : 0);
