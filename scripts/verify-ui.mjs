#!/usr/bin/env node
/**
 * `pnpm verify:ui` —— UI 真机取证配方入口（2026-11-07 带入最小可用版）。
 *
 * 口径：**逐条跑自包含配方**（各自起隔离实例、按 PID 回收、截图落 `out/ui-evidence/`），
 * 最后打印一行结论；任一失败即非 0 退出。**未跑的配方不得写成通过**。
 *
 * 只保留**可公开复现**的配方（不引用真实项目名/本地路径）。新增配方＝`scripts/verification/<id>.mjs`
 * 并登记到下方 `RECIPES`。
 *
 * 用法：
 *   pnpm verify:ui 全部跑一遍
 *   pnpm verify:ui --list 只列配方不执行
 *   pnpm verify:ui --only=<id,...> 只跑指定配方
 *   pnpm verify:ui --results=<path> 额外落一份逐条结果清单（JSON）
 *
 * 前置：`pnpm build`（配方跑 `out/` 里的构建产物，不跑源码）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();

/** 配方登记表（id → 脚本）。描述写在这里，脚本自带判据。 */
const RECIPES = [
  {
    id: 'ui2-project-cdp',
    file: 'scripts/verification/ui2-project-cdp.mjs',
    desc: 'UI-2 S1：项目页行下展开 / Esc 回焦 / 三条深链 / 720 窄窗 / 深色 / 异常卡渲染',
  },
  {
    id: 'security-keys-cdp',
    file: 'scripts/verification/security-keys-cdp.mjs',
    desc: 'B0-9：供应商 Key 真 IPC 保存 → 落盘 v1 密文（safeStorage）→ 重启可读掩码 → 清除即删',
  },
  {
    id: 'startup-migration-backup-cdp',
    file: 'scripts/verification/startup-migration-backup-cdp.mjs',
    desc: 'B0-12：库落后一版 → 迁移前自动备份 → 毒迁移 fail-closed（非 0 退出，不开窗，原库完好）',
  },
  {
    id: 'update-manual-download-cdp',
    file: 'scripts/verification/update-manual-download-cdp.mjs',
    desc: 'B0-9：更新人工确认链路（假更新器）——不自动下载 → 点「下载更新」→ 完成才出现「重启安装」',
  },
];

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
const list = process.argv.includes('--list');
const resultsArg = process.argv.find((a) => a.startsWith('--results='));
const resultsPath = resultsArg ? resultsArg.slice('--results='.length) : null;

const picked = RECIPES.filter((r) => !only || only.includes(r.id));
if (list) {
  console.log('[verify:ui] 配方：');
  for (const r of RECIPES) console.log(`  - ${r.id}${picked.includes(r) ? '' : '（本次跳过）'}: ${r.desc}`);
  process.exit(0);
}

// 构建产物预检：配方跑 `out/`，没构建就等于跑旧代码（宁失败不假绿）。
for (const artifact of ['out/main/index.cjs', 'out/renderer/index.html']) {
  if (!existsSync(join(ROOT, artifact))) {
    console.error(`[verify:ui] 缺少构建产物 ${artifact}——先跑 \`pnpm build\`。`);
    process.exit(1);
  }
}

// 实例上限（2026-10-14）：本机同时最多 3 个；超限拒绝启动，**只报告 PID、不代杀**。
function appInstancePids() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'ai-company' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId",
    ],
    { encoding: 'utf8' },
  );
  return (r.stdout || '').trim().split(/\s+/).filter((s) => /^\d+$/.test(s));
}
const running = appInstancePids();
if (running.length >= 3) {
  console.error(
    `[verify:ui] 预检失败：现有实例 ${running.length} 个（≥ 上限 3）——请**全部关闭**后重跑（PID: ${running.join(', ')}）。`,
  );
  process.exit(1);
}
console.log(`[verify:ui] 预检：现有实例 ${running.length} 个（上限 3）${running.length > 0 ? `（PID: ${running.join(', ')}）` : ''}`);

console.log(`[verify:ui] 将跑 ${picked.length} 条自包含配方（各自起隔离实例、按 PID 回收）`);
const results = [];
for (const r of picked) {
  const file = join(ROOT, r.file);
  if (!existsSync(file)) {
    results.push({ recipe: r.id, ok: false, note: '缺脚本' });
    console.log(`[verify:ui] ${r.id}: 缺脚本 ${file}`);
    continue;
  }
  console.log(`\n[verify:ui] === ${r.id} ===`);
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: ROOT });
  const ok = res.status === 0;
  results.push({ recipe: r.id, ok, exitCode: res.status });
  console.log(`[verify:ui] ${r.id}: ${ok ? 'PASS' : 'FAIL'}（exit=${res.status}）`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n[verify:ui] 结论：${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `；失败：${failed.map((f) => f.recipe).join(', ')}` : ''),
);
if (resultsPath) {
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        recipes: picked.map((r) => r.id),
        results,
        passed: results.length - failed.length,
        total: results.length,
        failed: failed.map((f) => f.recipe),
        note: 'exitCode 为准；配方内部 SKIP 子项以当次运行日志为准。',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`[verify:ui] 结果清单：${resultsPath}`);
}
console.log('[verify:ui] 产物：out/ui-evidence/ 下同名截图（AICO_UI_EVIDENCE_DIR 可改）');
process.exit(failed.length === 0 ? 0 : 1);
