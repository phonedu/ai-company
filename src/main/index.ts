import { installProviderKeyCodec } from './security/key-codec.js';
import { backupBeforeMigration } from './db/startup-backup.js';
import { createFakeUpdater } from './update-fake.js';
import { app, BrowserWindow, Menu, Tray, Notification, ipcMain, nativeImage, dialog, shell, nativeTheme, safeStorage, protocol } from 'electron';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter as pathDelimiter } from 'node:path';

import {
  acknowledgePendingAsksIfTaskSettled,
  createTask,
  getTaskById,
  insertReport,
  insertTaskEvent,
  insertWorkItem,
  listProjects,
  openDatabase,
  readSetting,
  runMigrations,
  SqliteCounterStore,
  unreadCardsCount,
  updatePlanStepState,
  writeSetting,
  type SqliteDb,
} from './db/index.js';
import { ensureAssistantSeeded } from './db/employees.js';
import { assignBuiltinSkillsToAssistantIfEmpty, ensureBuiltinSkills } from './agent/builtin-skills.js';
import { getProvenance } from './provenance.js';
import { Engine } from './engine/index.js';
import { shouldClearPendingAsks } from './ipc/card-sync.js';
import { createGitRunner, WorktreeManager } from './git/index.js';
import { pruneStagingWorktrees } from './git/worktree-prune.js';
import { checkpointWal, runRetention } from './db/maintenance.js';
import { digestText, emitDailyDigest } from './notify/digest.js';
import { setNotifyDeliveryHook, notify } from './notify/index.js';
import { deliverDesktopNotification, type OpenViewTarget } from './notify/desktop.js';
import { trayStatusView, type TrayState } from './tray/status.js';
import { createTriggerService } from './triggers/service.js';
import { TRAY_ICON_PNG_BASE64 } from './tray/icons.js';
import { engineTuningFromSettings } from './engine/tuning.js';
import type { EngineEvent } from './engine/types.js';
import { createLazyEmployeeRuntime, defaultSessionDir } from './agent/employee-factory.js';
import { employeeSessionKey, roleSessionKeysForCancel } from './agent/employee-runtime.js';
import { buildEmployeeContext } from './agent/context.js';
import { createUnavailableExecutor } from './agent/unavailable-executor.js';
import { createUnavailableReassigner } from './agent/reassign.js';
import { setDefaultModel, setFallbackChain, setRoleMap } from './agent/model-policy.js';
import { loadModelCatalog } from './agent/model-catalog.js';
import { createSemanticClassifier } from './agent/semantic-classifier.js';
import { readTriageMode } from './ipc/ipc.js';
import { autoUpdater } from 'electron-updater';
import { createUpdateController, type UpdateController, type UpdaterLike, type UpdateStatus } from './update.js';
import { EvtSink } from './evt-sink.js';
import { createSqliteChatRepo, handleTaskCreate, registerAllIpc, seedDemoData, type IpcDeps } from './ipc/index.js';
import { registerAicoFileProtocol } from './ipc/attachment-protocol.js';
import { ImManager, WeChatIlinkAdapter, createFileCredentialStore, handleImInbound } from './im/index.js';
import { attachDidFailLoad, defaultEnv, installAppCrashHandlers, installMainProcessCrashHandlers, runCleanupSafely } from './crash.js';
import { appendConsoleLine, formatBlankWindowDiagnostics } from './ui-watchdog.js';
import {
  COMMIT_STUCK_MS,
  MOUNT_STUCK_MS,
  beginRealLoad,
  initialStartupState,
  isRealRendererUrl,
  markMounted,
  onCommitTimeout,
  onMountTimeout,
  settleLoadFail,
  settleLoadOk,
  takeRetryDelay,
  type StartupState,
} from './startup-load.js';
import { buildSplashDataUrl, buildStartupErrorDataUrl } from './startup-splash.js';

// ─────────────────────────────────────────────────────────────────────────────
// T0.1 骨架 + T0.5 接线：生命周期 / 窗口 / 托盘 / 单实例锁 / DB+迁移 / IPC。
//   T0.5：DB 只在主进程打开（唯一写者）；IPC 只暴露 §7.3 的通道。
// ─────────────────────────────────────────────────────────────────────────────

// 2026-11-06 v0.1.1：隔离/便携场景的 userData 覆盖（必须在 app ready 前设置）。
// 用途：自动更新重启、安装版冒烟、便携副本都可用同一套环境变量隔离数据目录。
const userDataOverride = process.env['AICO_USER_DATA_DIR']?.trim();
if (userDataOverride) app.setPath('userData', userDataOverride);

// 附件预览专用协议：standard/secure 才能在 <img>/<iframe> 里加载；必须在 app ready 前注册。
protocol.registerSchemesAsPrivileged([
  { scheme: 'aico-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const gotSingleInstanceLock = app.requestSingleInstanceLock();

// ── 崩溃兜底 + 崩溃日志（`DEV §11`；老板拍板：本地、不上传）──
let crashDb: ReturnType<typeof openDatabase> | null = null;
/** OPT-EXT-1b：主进程 repo（托盘未读读数用；init 后回填）。 */
let mainRepo: ReturnType<typeof createSqliteChatRepo> | null = null;
/** M3：微信 1:1 通道（主进程内，无额外进程；demo/selftest 不装配）。 */
let imManager: ImManager | null = null;
function recentActivityLines(limit = 5): string[] {
  if (!crashDb) return [];
  try {
    const rows = crashDb
      .prepare('SELECT action_key, state FROM action_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ action_key: string; state: string }>;
    return rows.map((row) => `action_log ${row.state} ${row.action_key}`);
  } catch {
    return [];
  }
}
const crashSelftest = process.env['AICO_CRASH_SELFTEST'] === '1';
const crashLogDir = join(app.getPath('userData'), 'logs');

/** Windows toast 的稳定 AppUserModelID（安装器/注册表/开发态共用；勿随安装路径变化）。 */
export const AICO_APP_USER_MODEL_ID = 'AICo.OneCompany.Desktop';

/** 自测：扫 logDir 找含标记的崩溃日志、断言必需字段，打印 PASS/FAIL 后退出（独立验证入口）。 */
function verifyCrashSelftest(): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.existsSync(crashLogDir)
      ? fs.readdirSync(crashLogDir).filter((f) => f.startsWith('crash-'))
      : [];
    const newest = files.sort().reverse()[0] ?? null;
    const text = newest ? fs.readFileSync(join(crashLogDir, newest), 'utf8') : '';
    const ok =
      newest !== null &&
      text.includes('# ai-company crash log') &&
      text.includes('reason: uncaughtException') &&
      text.includes('AICO_CRASH_SELFTEST');
    console.log(`[crash-selftest] ${JSON.stringify({ ok, file: newest })} -> ${ok ? 'PASS' : 'FAIL'}`);
    const code = ok ? 0 : 1;
    process.exitCode = code;
    // 注意：实测 `app.exit(code)` **会返回、不退出** → 不能只靠它。
    try {
      app.exit(code);
    } catch {
      /* fall through */
    }
    setTimeout(() => process.exit(code), 150);
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }, 800);
  } catch (error) {
    console.error('[crash-selftest] failed:', error);
    process.exit(1);
  }
}

const crashOptions = {
  logDir: crashLogDir,
  // 真实版本快照（appVersion 取自 app；其余取运行时版本）。
  env: { ...defaultEnv(), appVersion: app.getVersion() },
  // 自测模式用 console（避免模态弹框阻塞自动化）；生产用原生 dialog（含日志路径 + 如何反馈）。
  notify: crashSelftest
    ? (title: string, detail: string): void => {
        console.error(`[crash-selftest] notify ${title} :: ${detail}`);
      }
    : (title: string, detail: string): void => {
        dialog.showErrorBox(title, detail);
      },
  getContext: (): { lastActivity: string[] } => ({ lastActivity: recentActivityLines() }),
  fatalExit: crashSelftest ? (): void => verifyCrashSelftest() : (): void => app.exit(1),
};
installMainProcessCrashHandlers(crashOptions);
installAppCrashHandlers(app, crashOptions);

/** 冒烟截图：设 `AICO_SHOT=<png>` 时，shell 挂载后截图并退出（无 CDP 环境）。 */
const screenshotPath = process.env['AICO_SHOT'] ?? '';
const screenshotDelayMs = Number(process.env['AICO_SHOT_DELAY_MS'] ?? '900');
/** 启动基准（Q-D）：设 `AICO_BENCH=<json 路径|1>` 时，量测启动→壳挂载→首帧并输出 `[bench] {json}` 后退出。 */
const benchOutput = process.env['AICO_BENCH'] ?? '';
const benchEnabled = benchOutput.length > 0;
const bootAt = Date.now();
let appReadyAt = 0;
/** UI 自测：设 `AICO_T05_SELFTEST=1` 时，注入计数假 preload 并点一次按钮，验证「一次点击=一条 IPC」。 */
const selfTestEnabled = process.env['AICO_T05_SELFTEST'] === '1';
/** 演示数据：设 `AICO_T05_DEMO=1` 且库为空时灌入（仅用于截图/查看）。 */
const demoEnabled = process.env['AICO_T05_DEMO'] === '1';
/** T0.7 演示：`AICO_T07_DEMO=1` 时种子一个带 `plan_steps`/`tool_call`/`acceptance` 的任务，并让渲染层打开任务详情视图。 */
const t07DemoEnabled = process.env['AICO_T07_DEMO'] === '1';
/** T0.7 自测：`AICO_T07_SELFTEST=1` 时逐 tab 数 DOM 条数 vs `task:get().counts`，打印 `[t07]`；不一致则 `exitCode=1`。 */
const t07SelfTestEnabled = process.env['AICO_T07_SELFTEST'] === '1';
/** 就绪可见自测：`AICO_ASSIST_STATUS_TEST=1` 时推一条 `assistant_starting` → 断言状态行出现/消失，打印 `[assist-status]`。 */
const assistStatusTestEnabled = process.env['AICO_ASSIST_STATUS_TEST'] === '1';
/** GenUI 自测（M1-5）：`AICO_GENUI_SELFTEST=1` 时种入 GenUI 示例卡 → 断言 AC1/AC2/AC4/AC5，打印 `[genui]`。 */
const genuiSelfTestEnabled = process.env['AICO_GENUI_SELFTEST'] === '1';
/** M1-3 自测：`AICO_WAITS_SELFTEST=1` 时假 preload 注入 `task:get().waits` → 断言等待条，打印 `[waits]`。 */
const waitsSelfTestEnabled = process.env['AICO_WAITS_SELFTEST'] === '1';
/** M1-3 端到端：`AICO_WAITS_E2E=1` 时种入**真实路径冲突**（引擎 hold）→ 渲染层读真 `waits`，打印 `[waits-e2e]`。 */
const waitsE2eEnabled = process.env['AICO_WAITS_E2E'] === '1';
/** M1-5 GenUI 自测用的 schemaId。 */
const GENUI_DEMO_SCHEMA_ID = 'sch_demo1';
/** 基准场景清单（Q-D）：startup / ipc / evt / scroll / sqlite。 */
const benchScenarios = (process.env['AICO_BENCH_SCENARIOS'] ?? 'startup,ipc,evt,scroll,sqlite,switch,projection,input,memory')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
/** P-01/P-02/P-03 的正确口径：预热+空库（不 seed 1000 消息/50 任务）。 */
const benchSkipSeed = process.env['AICO_BENCH_SKIP_SEED'] === '1';
// 基准模式：关掉 Chromium 的后台/遮挡节流，否则 rAF 被压到 ~1fps，滚动帧率测不准。
if (benchEnabled) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}
/** 滚动基准用的 seeded 消息条数。 */
const BENCH_MESSAGE_COUNT = Number(process.env['AICO_BENCH_MESSAGES'] ?? '1000');

/** 主题起跑钩子：`AICO_THEME=light|dark` 强制主题（截图/预览用）；缺省＝跟随系统。
 *  同一位点即未来「设置 → 通用 → 明/暗/跟随」的落点（`OPT-UI-7` 口径）。 */
const themePref = process.env['AICO_THEME'];
if (themePref === 'light' || themePref === 'dark') nativeTheme.themeSource = themePref;

let mainWindow: BrowserWindow | null = null;
/** BRK20：渲染层挂载握手（ui:mounted）。 */
let uiMounted = false;
/**
 * F-05（2026-11-06）：启动加载状态机——启动页（data:）→ 真实加载单飞 → committed → mounted。
 * 规则见 `startup-load.ts`；旧的 about:blank 早探针/15s 兜底/6s 固定重发三套看门狗已退役
 * （它们会互相 abort，机器慢时把白窗放大到 ~39s）。
 */
let startupState: StartupState = initialStartupState();
/** 当前真实加载的「提交超时」计时器（在飞时有效）。 */
let startupCommitTimer: NodeJS.Timeout | null = null;
/** 已排定的下一次重试计时器。 */
let startupRetryTimer: NodeJS.Timeout | null = null;
/** 已提交后的 mounted 超时计时器。 */
let startupMountTimer: NodeJS.Timeout | null = null;
/** 本窗口启动起点（诊断/读数用）。 */
let startupLoadStartedAt = 0;
/** 自动更新（P-N05/E-6；2026-11-06 老板裁接 GitHub）。 */
let updateController: UpdateController | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;
/** BRK20 诊断：渲染层 console 最近 50 条（白窗时落盘）。 */
const rendererConsoleLines: string[] = [];
let tray: Tray | null = null;
/** M3-P-3：上次托盘状态（只在变化时留日志，防刷屏）。 */
let lastTrayState: TrayState | null = null;
/** 托盘/OS 通知点击的目标；窗口未挂载时暂存，ui:mounted 后补推。 */
let pendingOpenView: OpenViewTarget | null = null;
let shotTaken = false;
let shotTimer: ReturnType<typeof setTimeout> | null = null;
let selfTestDone = false;
let shellMountedAt = 0;
/** D-22 模型目录预热：首帧后再启动，避免动态 import Pi SDK 抢主线程（D-2 startup 红）。 */
let catalogPreheatStarted = false;
let benchRepo: ReturnType<typeof createSqliteChatRepo> | null = null;
/** P-06/P-07：bench 专用项目/任务（50 任务＋一条 1000 事件任务）。 */
let benchProjectIds: number[] = [];
let benchTaskId: number | null = null;
let engine: Engine | null = null;
/** GAP1：cron/事件触发器（main 注入物化器；tick 在引擎事务外）。 */
let triggerService: ReturnType<typeof createTriggerService> | null = null;
/** T0.7 演示任务 id（DEMO/SELFTEST 用）。 */
let t07TaskId: number | null = null;
/** evt-sink（最小版）：统一信封 `{channel,batchSeq,items[]}`，16ms 窗口 / 单批 ≤500。 */
const evtSink = new EvtSink(() =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null,
);
// F-G8：渲染层订阅时拉一次"每通道最新值"（补上**订阅前**丢失的事件，如启动期装配失败）。`evt` 是内部前缀。
ipcMain.handle('evt:snapshot', () => evtSink.snapshot());

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolvePreloadPath(): string {
  return join(__dirname, '../preload/index.cjs');
}

function resolveRendererIndex(): string {
  return join(__dirname, '../renderer/index.html');
}

async function initDatabaseAndIpc(): Promise<void> {
  try {
    const dbFile = benchEnabled
      ? join(app.getPath('userData'), 'aico-bench.sqlite')
      : join(app.getPath('userData'), 'aico.sqlite');
    mkdirSync(dirname(dbFile), { recursive: true });
    // 基准每次用干净库，避免跑两次数据叠加。
    if (benchEnabled && existsSync(dbFile)) unlinkSync(dbFile);
    const db = openDatabase(dbFile);
    crashDb = db;
    // B0-12：迁移前**自动备份**（有未应用迁移才做）；备份或迁移失败 → 拒绝继续开窗（不带坏库跑）。
    let result;
    try {
      const backup = backupBeforeMigration(db, { dataDir: app.getPath('userData') });
      if (backup.path) console.log(`[db] 迁移前备份 ${backup.path}（${backup.bytes ?? 0} 字节）`);
      result = runMigrations(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[db] 迁移前备份/迁移失败——拒绝继续（不带着坏库开窗）:', error);
      // 自动化演练（startup-migration-backup-cdp）用：跳过模态框，直接以退出码 1 收场。
      if (process.env['AICO_STARTUP_FAIL_SILENT'] !== '1') {
        crashOptions.notify(
          '数据库升级失败（已停止启动）',
          `${message}

数据目录：${app.getPath('userData')}
若已有 backups/ 自动备份，可联系维护者按备份恢复。`,
        );
      }
      app.exit(1);
      return;
    }
    console.log(`[db] opened ${dbFile} | migrations ${JSON.stringify(result)}`);
    // M2-D：可控时点 WAL checkpoint（装配期，非热路径）——防 -wal 无限增长；busy 不打断启动（下次时点再试）。
    const cp = checkpointWal(db);
    console.log(`[db] wal checkpoint ${cp.ok ? 'ok' : 'busy（下次时点重试）'}`);
    // 2026-10-29 P2（P-N05）：开机自启（默认 false；只读设置，不静默写系统）。
    if (process.platform === 'win32') {
      try {
        const openAtLogin = readSetting(db, 'app.openAtLogin') === true;
        app.setLoginItemSettings({ openAtLogin });
      } catch (error) {
        console.error('[app] 开机自启设置应用失败（不阻塞启动）：', error instanceof Error ? error.message : String(error));
      }
    }
    // CR15（2026-10-20）：启动装配后做一次可控保留/清理；失败只报告，不阻塞启动。
    try {
      runStartupMaintenance(db);
    } catch (error) {
      console.error('[maint] 启动维护失败（不阻塞启动）', error);
    }
    // （A）生产首启引导名册：仅空表时只补幕僚长一人（幂等；非空绝不插；不臆造）。
    if (ensureAssistantSeeded(db).seeded) {
      console.log('[db] 引导名册：已种幕僚长（0 号；employee 表为空时）');
    }
    // B1（M3-N-3）：内置技能包落 `<userData>/skills/builtin`；新库默认勾给幕僚长（已有配置不动）。
    try {
      const builtins = ensureBuiltinSkills(db, join(app.getPath('userData'), 'skills'));
      // 只做一次：老板清空技能是明确意图，重启不能又把内置技能补回去。
      if (readSetting(db, 'skills.builtinSeeded') !== true) {
        if (assignBuiltinSkillsToAssistantIfEmpty(db)) {
          console.log('[skills] 内置技能已勾给幕僚长（新库默认）');
        }
        writeSetting(db, 'skills.builtinSeeded', true);
      }
      console.log(`[skills] 内置技能 ${builtins.length} 个在场`);
    } catch (error) {
      // 内置技能失败不阻塞启动，但必须可见（不静默）。
      console.error('[skills] 内置技能初始化失败：', error instanceof Error ? error.message : String(error));
    }
    const repo = createSqliteChatRepo(db);
    benchRepo = repo;
    mainRepo = repo;
    // R2-3：设置页「默认模型」（`settings['models.default']`）→ **启动时注入**装配期档位解析；未设置回落 env
    setDefaultModel((readSetting(db, 'models.default') as string | null) ?? null);
    // N5（`R3-3`）：`models.role_map` → 启动时注入逐会话档位解析（非法项逐条留痕丢弃，见 `setRoleMap`）
    setRoleMap(readSetting(db, 'models.role_map'));
    // N5 余账（2026-10-16）：`models.fallback_chain` → 启动注入（运行时降级＋critic/verifier 异供应商备选）
    setFallbackChain(readSetting(db, 'models.fallback_chain'));
    // D-22 assistant：模型目录改到 `ui:mounted` 后再预热（见下）。启动期动态 import Pi SDK
    // 会与窗口首帧争主线程——D-2 实测壳挂载 1835ms/首帧 2803ms；不在此处同步预热。
    // M4-C：主题（light/dark/system）——启动即应用；写入时由 settings:set 立即切换。
    const savedTheme = readSetting(db, 'ui.theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      nativeTheme.themeSource = savedTheme;
    }
    if (demoEnabled) {
      seedDemoData(db, repo);
      console.log('[db] demo data seeded (AICO_T05_DEMO)');
    }
    if (benchEnabled && !benchSkipSeed) {
      seedBenchMessages(repo, BENCH_MESSAGE_COUNT);
      seedBenchTasks(db);
    }
    // ── 引擎装配（DEV §4.5 / engine README）：openDatabase → runMigrations → Engine → recover → start ──
    // onEvent → evt-sink（同一主体 16ms 窗口内 last-wins）→ `evt:batch` 推渲染层。
    // OPT-AI-1：**懒装配**（2564）—— 启动路径**不被装配阻塞**；首次派发才装配（含 30s 超时），
    // 失败/无凭据 → **不可用态**（
    // 绝不回落 mock 桩，L39）。
    const dispatchToEngine = (event: EngineEvent) => engine?.dispatch(event);
    // BRK7：员工不可用时按策略改派同角色在职员工；无候选返回 false（走 BRK2 的 error＋异常卡）。
    const reassignUnavailable = createUnavailableReassigner(db, async (event) => {
      await dispatchToEngine(event);
    });
    // OPT-AI-1：**懒装配**（2564/2570）—— 启动路径**不被装配阻塞**（构造期零 await）；
    // 首次派发才装配（含 30s 超时）；三态可见；失败/超时/无凭据 → **不可用态**（绝不回落 mock 桩，L39）。
    const empLazy = createLazyEmployeeRuntime({
      db,
      cwd: process.cwd(), // 构造期缺省 cwd（M1 inplace：任务工作目录 == 项目根）；任务级 cwd 隔离 → M2
      sessionDir: defaultSessionDir(app.getPath('userData')),
      toolOutputDir: join(app.getPath('userData'), 'tool-output'),
      buildContext: buildEmployeeContext,
      // B2-4/D-30：实测路径登记 → 引擎（内存 ws.touched ∪ DB brief，崩溃恢复不丢）。
      onTouchedPaths: (workItemId: number, paths: string[]) => engine?.recordWorkItemTouchedPaths(workItemId, paths),
      timeoutMs: 30_000,
      onStatus: (s) => {
        evtSink.push('evt:agent', s);
        console.log('[agent] 员工运行时', s.state, s); // 三态可见：装配中/就绪(model,credentialSource,耗时)/失败(原因)
        // G8（2911 / 2917 授权）：把同一状态推给渲染层（既有 `evt:batch` 通道；`evt:*` 不入 IPC 契约计数）。
        evtSink.push('evt:agent', s);
      },
      onUnavailable: (reason) =>
        createUnavailableExecutor({ dispatch: dispatchToEngine, reason, onWorkItemUnavailable: reassignUnavailable }),
    });
    // M2-D：员工会话成本走**引擎**入口（预算闸门才会真生效；缺引擎时回退记账并显式告警）。
    const executor = empLazy.createExecutor(dispatchToEngine, (input) => engine?.recordCost(input));
    // 件 A（调度与费率可配面）：设置页「高级」→ 装配期读设置 → Engine 配置（写入即生效于**下次装配**；
    // 未设置/越界值不出现于配置 → Engine 回落自身缺省——不臆造）。
    engine = new Engine(db, executor, {
      onEvent: (event) => {
        evtSink.push('evt:task', event, `${event.scope}:${event.id}`);
        // BRK15（挂载 2）：任务状态即大厅「谁在干什么」的数据源——一并推 `evt:hall`（实时刷新，不靠下一次拉取）。
        evtSink.push('evt:hall', { reload: `${event.scope}:${event.id}` }, `hall:${event.scope}:${event.id}`);
        // GAP1：任务完成事件 → 排队给 trigger service（真正建任务在 tick，避开引擎事务内重入）。
        triggerService?.onEngineEvent(event);
      },
      // RM-2（2026-10-19 真机）：任务已离开待决策/待批准后，同任务的 pending ask 卡一并标已阅。
      // 只在**已提交**回调里做；按任务当前状态判，不猜事件名（D4：task_started/task_completed 等不是真事件名）。
      onCommitted: (event) => {
        if (event.scope !== 'task') return;
        if (!shouldClearPendingAsks(event, getTaskById(db, event.id)?.state)) return;
        // 决策/批准事件只清决策卡；终态事件才连同权限卡一起清（任务已结束，权限卡不再有意义）。
        const includePermission = [
          'all_work_items_done',
          'verification_completed',
          'finish_manual',
          'finish',
          'fail',
          'cancel',
          'discard',
        ].includes(event.event);
        const changed = acknowledgePendingAsksIfTaskSettled(db, event.id, Date.now(), { includePermission });
        if (changed > 0) evtSink.push('evt:inbox', { reload: 'inbox' }, `inbox:resolved:${event.id}`);
      },
      // BRK15：卡片落库 → `evt:notify`/`evt:inbox`（新卡/待办实时刷新；同一主体 16ms 窗口 last-wins）。
      onCard: (info) => {
        evtSink.push('evt:notify', info, `card:${info.card}:${info.taskId ?? 'global'}`);
        evtSink.push('evt:inbox', info, `card:${info.card}:${info.taskId ?? 'global'}`);
        refreshTrayStatus(); // OPT-EXT-1b：托盘待办随真卡刷新
        // RM-5：卡片已落库＝任务进入等老板态；停掉**同任务**正在跑的幕僚长会话，
        // 防止批准前继续写文件/外发（原 F3：T-1002 批准前已落两个文件并发出长文）。
        if (info.taskId != null && (info.card === 'approval' || info.card === 'decision')) {
          void deps.assistant
            ?.abortForTask?.(info.taskId)
            .then((stopped) => {
              if (stopped) console.log(`[agent] 卡片落库，已中止同任务幕僚长会话（task ${info.taskId}）`);
            })
            .catch((error: unknown) => {
              console.error('[agent] 中止幕僚长会话失败（卡片已落，不阻塞）', error);
            });
        }
      },
      // UG-02：截止前提醒 / 逾期卡（只提醒，不改状态；终态任务的残留 timer 由引擎丢弃）。
      onDeadline: ({ taskId, shortId, title, deadline, overdue }) => {
        const label = shortId ?? `#${taskId}`;
        const due = new Date(deadline).toLocaleString('zh-CN', { hour12: false });
        const remainMs = deadline - Date.now();
        const remainText =
          remainMs >= 24 * 60 * 60 * 1000
            ? `${Math.ceil(remainMs / (24 * 60 * 60 * 1000))} 天`
            : `${Math.max(1, Math.ceil(remainMs / (60 * 60 * 1000)))} 小时`;
        const dedupeKey = `deadline:${taskId}:${overdue ? 'overdue' : 'remind'}`;
        const result = notify(db, {
          taskId,
          kind: 'alert',
          dedupeKey,
          payload: {
            title: overdue ? `已逾期：${label}` : `快到期：${label}`,
            shortId: label,
            summary: overdue ? `截止 ${due} 已过；任务仍在处理中。` : `截止 ${due}；还剩约 ${remainText}。`,
            notes: title,
            deadline,
          },
          urgent: overdue,
        });
        if (!result.delivered) return;
        const info = { taskId, kind: 'alert', card: 'alert' };
        evtSink.push('evt:notify', info, dedupeKey);
        evtSink.push('evt:inbox', info, dedupeKey);
        refreshTrayStatus();
      },
      // BRK17/BRK4：任务级取消/暂停真中断在跑的件 → **真停该件的员工会话**
      //（`AgentSession.abort()`；懒装配未就绪 ⇒ 返回 false 如实——会话可能还在起，停件不受影响）。
      onWorkItemInterrupted: ({ workItemId, employeeId, taskId }) => {
        const stopped = empLazy.abort(employeeSessionKey({ employeeId, taskId, workItemId }));
        console.log(
          `[agent] 中止工作项 ${workItemId}（员工 ${employeeId}）：会话${stopped ? '已中止' : '未找到（可能未在跑）'}`,
        );
      },
      // BRK17/BRK4：不挂件的**角色会话**（planner/critic/verifier）同样真停——
      // 如验证中取消/暂停时跑着的 verifier 会话。
      onTaskCancelled: ({ taskId }) => {
        const workItemIds = (
          db.prepare('SELECT id FROM work_items WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number }>
        ).map((row) => row.id);
        const keys = roleSessionKeysForCancel({ taskId, workItemIds });
        for (const key of keys) {
          if (empLazy.abort(key)) console.log(`[agent] 中止角色会话 ${key}`);
        }
      },
      // M1-4 接缝生产注入（BRK22，2026-10-16）：此前 Engine 无 `git` ⇒ 工作区/指纹整条未接——
      // 产物 `source`/`sha256` 恒 NULL、`staging` 项目实按 inplace 派发、派发 payload 无 cwd。
      // 注入后：dispatch 即建工作区（inplace=项目根 / staging=worktree）→ 产物带来源指纹、changesets 真写。
      // worktree 落 `userData`（软件数据不散在仓库旁；PLAN：软件自己的东西全在自身数据目录）。
      git: createGitRunner(),
      worktreesBaseDir: join(app.getPath('userData'), 'worktrees'),
      ...engineTuningFromSettings((key) => readSetting(db, key)),
    });
    const recovery = await engine.recover();
    engine.start();
    // GAP1：cron/事件触发器（物化在引擎 tick 外：createTask + triage）。
    triggerService = createTriggerService({
      db,
      materialize: async (template) => {
        if (!engine) throw new Error('引擎未就绪');
        // C4：公司日预算已用尽 → 不物化（trigger 保持 due/pending，预算恢复后再试）。
        const budgetHold = engine.companyDailyBudgetHold();
        if (budgetHold) throw new Error(budgetHold);
        // GAP1：触发建任务走**共享建任务管线**（docs-check/编制/默认档/来源），
        // 不再裸 createTask 绕过 M3-DOC-4/D-11。
        const task = await handleTaskCreate(deps, {
          projectId: template.projectId,
          title: template.title,
          goal: template.goal,
          riskLevel: template.riskLevel,
          origin: `trigger:${template.kind}`,
          via: `trigger:${template.kind}:${template.triggerId}`,
        });
        return task.id;
      },
    });
    triggerService.start();
    // M2-A 余：日报 tick——每分钟检查一次「是否已过当日日报时间」（幂等键 digest:<date> ⇒ 一天只发一次、重启安全）。
    // 时间来源＝设置 `notify.digestAtMinutes`（未设 → 540 ＝ 09:00，与 UI 文案一致）。
    const digestTimer = setInterval(() => {
      try {
        const atRaw = readSetting(db, "notify.digestAtMinutes");
        const atMinutes = typeof atRaw === "number" && atRaw >= 0 && atRaw <= 1439 ? atRaw : 540;
        const nowMs = Date.now();
        const d = new Date(nowMs);
        if (d.getHours() * 60 + d.getMinutes() >= atMinutes) {
          const res = emitDailyDigest(db, { now: nowMs });
          if (res.delivered) {
            console.log(`[notify] 日报已发：${digestText(res.content)}`);
            // BRK15：全局卡也要实时可见（taskId=null ⇒ 信封照送、store 路由刷新）
            evtSink.push('evt:notify', { taskId: null, kind: 'notification', card: 'digest' });
            evtSink.push('evt:inbox', { taskId: null, kind: 'notification', card: 'digest' });
          }
        }
      } catch (error) {
        console.error("[notify] 日报生成失败（不静默）", error);
      }
    }, 60_000);
    digestTimer.unref?.(); // 不吊住进程（测试/退出安全）
    console.log(
      `[engine] started (interrupted=${recovery.interrupted}, timersRebuilt=${recovery.timersRebuilt})`,
    );

    if (t07DemoEnabled || genuiSelfTestEnabled || waitsSelfTestEnabled) {
      try {
        t07TaskId = await seedT07Demo(db, engine);
        seedGenUiDemoReports(db, t07TaskId);
        console.log(`[t07-demo] seeded taskId=${t07TaskId} + GenUI demo reports`);
      } catch (error) {
        console.error('[t07] demo seed failed:', error);
      }
    }

    if (waitsE2eEnabled) {
      try {
        const seeded = await seedPathConflictDemo(db, engine);
        console.log(`[waits-e2e] seeded path conflict: heldTask=${seeded.heldShortId} conflictShortId=${seeded.conflictShortId}`);
      } catch (error) {
        console.error('[waits-e2e] seed failed:', error);
      }
    }

    const deps: IpcDeps = {
      repo,
      // RW-50（2026-11-05）：真语义分类器——幕僚长听懂自然话的地基（此前从未注入，
      // defaultClassify 一律 chat → 频道自由文本派任务整链失效；失败回落 chat 绝不误建）。
      // B2-2（D-30①）：默认 triage=assistant——自由文本交幕僚长唯一分诊，分诊器只在
      // `AICO_TRIAGE=classifier` 回退模式才被调用（代码保留至 B2 验收后另批删除）。
      triageMode: readTriageMode(process.env['AICO_TRIAGE']),
      classify: createSemanticClassifier({
        db,
        secretsDir: () => join(app.getPath('home'), '.aico', 'secrets'),
        timeoutMs: 8000,
      }),
      // 仅开发态允许故障注入（逐页错误态测试用；生产恒 false）。
      allowFaultInjection: !app.isPackaged,
      engine,
      // M4-C：主题切换 → nativeTheme（renderer 的 prefers-color-scheme 随即变化）。
      // P-N05：应用信息（版本/数据目录）——只读，路径由主进程解析。
      appInfo: () => ({ version: app.getVersion(), userDataDir: app.getPath('userData') }),
      setTheme: (theme) => {
        nativeTheme.themeSource = theme;
      },
      // BRK9（挂载 2）：插话直通 → steer 进行中的员工会话（懒装配未就绪 ⇒ false，handler 如实回执）。
      steerEmployee: (sessionKey, text) => empLazy.steer(sessionKey, text),
      // M4-B-9：Key 保存/清除后丢弃已装配运行时，下一次员工会话用新凭据重新装配。
      onProviderKeyChanged: () => empLazy.reset(),
      // R2-4：项目接入的目录选择——**只经主进程 dialog**（renderer 永远拿不到任意路径，D1 铁律）
      pickDirectory: async () => {
        // 自动化验收专用：仅非打包态、且显式设了 env 时生效（生产/打包态绝不读任意路径）。
        const testPick = process.env.AICO_TEST_PICK_DIR?.trim();
        if (!app.isPackaged && testPick) return testPick;
        // 2026-10-17 真机反馈：不挂父窗口的目录框在无边框窗口上会跑到后面/“打开”无响应。
        // 挂 mainWindow 使其成模态；标题写清「选父目录，不是选项目文件夹」；Windows 无 createDirectory。
        const options = {
          title: '选择项目父目录（将在此目录下新建项目文件夹）',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory'] as Array<'openDirectory'>,
        };
        const r = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        return r.canceled || r.filePaths.length === 0 ? null : (r.filePaths[0] as string);
      },
      // GAP7（M3-N-3）：技能安装受管根＋目录选择（标题与项目目录明确区分）。
      db,
      stagedFilesDir: () => join(app.getPath('userData'), 'staged-inputs'),
      skillsDir: () => join(app.getPath('userData'), 'skills'),
      pickSkillDirectory: async () => {
        const testPick = process.env.AICO_TEST_PICK_SKILL_DIR?.trim();
        if (!app.isPackaged && testPick) return testPick;
        const options = {
          title: '选择技能文件夹（文件夹内需有 SKILL.md）',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory'] as Array<'openDirectory'>,
        };
        const r = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        return r.canceled || r.filePaths.length === 0 ? null : (r.filePaths[0] as string);
      },
      // BRK16-a（挂载 3）：系统打开 / 在文件夹中显示 / 导出目录——同样**只经主进程**（注入 `shell`，handler 不直接碰 electron）。
      openPath: (absPath) => shell.openPath(absPath),
      revealPath: (absPath) => shell.showItemInFolder(absPath),
      exportDir: () => join(app.getPath('userData'), 'exports'),
      // M4-D-1：工具大输出归档根（展开时主进程按 ref 受控读取）。
      toolOutputDir: join(app.getPath('userData'), 'tool-output'),
      // 2026-10-17 真机反馈：测试通知（不写日报幂等键；走真实 desktop 通道＋系统通知旁路）。
      notifyTest: () => {
        notify(db, {
          taskId: null,
          kind: 'notification',
          dedupeKey: `test:${Date.now()}`,
          payload: { title: '测试通知', text: '系统通知工作正常（AI 一人公司）。' },
        });
      },
      triggerService,
      onInboxChanged: () => {
        // 卡片/消息处理变化 → 渲染层频道与「待我处理」同源刷新（IM 批准/桌面动作都走这里）。
        evtSink.push('evt:inbox', { reload: 'inbox' }, `inbox:${Date.now()}`);
        refreshTrayStatus();
      },
      // 读游标变化（桌面动作/IM 批准）：推 `evt:read` 让两个 surface 各自重拉，并刷新托盘。
      onReadChanged: () => {
        evtSink.push('evt:read', { reload: 'read' }, `read:${Date.now()}`);
        refreshTrayStatus();
      },
    };

    // M3 微信 1:1（官方 B 运输）：主进程内 adapter，不引入 OpenClaw/额外进程。
    // demo/bench/selftest 不接外网；非这些模式才装配（未绑定则状态 login_required）。
    const imEnabled =
      !benchEnabled &&
      !screenshotPath &&
      !selfTestEnabled &&
      !demoEnabled &&
      !t07DemoEnabled &&
      !t07SelfTestEnabled &&
      !assistStatusTestEnabled &&
      !genuiSelfTestEnabled &&
      !waitsSelfTestEnabled &&
      !waitsE2eEnabled;
    if (imEnabled) {
      const imStore = createFileCredentialStore(join(app.getPath('userData'), 'im', 'wechat.json'), {
        safeStorage: {
          isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: (plain) => safeStorage.encryptString(plain),
          decryptString: (encrypted) => safeStorage.decryptString(encrypted),
        },
        log: (message, error) => console.warn(message, error ?? ''),
      });
      imManager = new ImManager({
        db,
        createAdapter: (callbacks) =>
          new WeChatIlinkAdapter({
            store: imStore,
            callbacks,
            qrEncoder: encodeQrToDataUrl,
            log: (message, error) => console.warn(message, error ?? ''),
          }),
        onInbound: (msg, host) => handleImInbound(deps, msg, Date.now(), (text) => host.sendText(text)),
        log: (message, error) => console.warn(message, error ?? ''),
      });
      deps.im = imManager;
      void imManager.start();
      app.on('before-quit', () => {
        void imManager?.stop();
      });
    }
    registerAllIpc(ipcMain, deps);
    if (benchEnabled) ipcMain.handle('ipc:bench:ping', () => Date.now());
    console.log(
      '[ipc] registered: chat:send/chat:list/inbox:list/inbox:answer/task:approve/task:create/task:list/task:get/task:transition',
    );

    // 幕僚长真实会话（T0.4 + 就绪可见 L13）：Pi SDK 是 ESM-only、冷启可达数十秒 →
    //  ① app ready 后**后台预热**（不阻塞窗口：把冷启从"首条消息时"提前到"启动时"）；
    //  ② deps.assistant 是**懒端口**：收到消息才 `ensureAssistant`，未就绪先推
    //     `evt:message{status:'assistant_starting'}`（UI 显示「幕僚长启动中…」），就绪后补真回复；
    //     缺 key / 模型不可用 → 明确报错（不 mock）。
    //  DEMO/SELFTEST/bench/截图模式跳过装配（不加载 SDK，让取证确定、省冷启）。
    if (
      !benchEnabled &&
      !screenshotPath &&
      !selfTestEnabled &&
      !demoEnabled &&
      !t07DemoEnabled &&
      !t07SelfTestEnabled &&
      !assistStatusTestEnabled &&
      !genuiSelfTestEnabled &&
      !waitsSelfTestEnabled &&
      !waitsE2eEnabled
    ) {
      const assistantOptions = {
        db,
        // N4：幕僚长会话落盘（重启继续；此前缺省 inMemory ⇒ 每次启动幕僚长失忆）。
        persistDir: defaultSessionDir(app.getPath('userData')),
        toolOutputDir: join(app.getPath('userData'), 'tool-output'),
        onTextDelta: (delta: string) => evtSink.push('evt:message', { delta }),
        // RW-51：卡片工具的引擎事件/待办刷新/grant 联动（与 deps 同源）。
        engine,
        // B2-1：幕僚长指挥四工具的宿主侧回调——create_task 走 handleTaskCreate 全部门（预算预检/
        // 模型白名单/D1 分诊），steer 复用 LazyEmployeeRuntime.steer（与 `#短号` 插话同一实现）。
        createTask: (input: Record<string, unknown>) => handleTaskCreate(deps, input),
        steerEmployee: (sessionKey: string, text: string) => empLazy.steer(sessionKey, text),
        onInboxChanged: () => {
          evtSink.push('evt:inbox', { status: 'changed' });
        },
        onGrant: (approvalId: number, chosen: string) => {
          void import('./permission/grants.js').then((m) => {
            void m.applyApprovalAsGrant(db, approvalId, { now: Date.now(), approvedBy: 'boss' });
          });
          void chosen;
        },
      };
      deps.assistant = {
        async runTurn(input) {
          const mod = await import('./agent/pi-assistant.js');
          const assistant = await mod.ensureAssistant(assistantOptions, () => {
            evtSink.push('evt:message', { status: 'assistant_starting' });
          });
          if (!assistant) {
            throw new Error('[agent] 幕僚长不可用（缺 key / 模型不可用）');
          }
          return assistant.runTurn({ text: input.text, taskId: input.taskId ?? null, projectId: input.projectId ?? null });
        },
        async abortForTask(taskId) {
          const mod = await import('./agent/pi-assistant.js');
          return mod.abortAssistantForTask(taskId);
        },
      };
      // 后台预热：不阻塞窗口；状态变化用日志留痕（绝不静默）。
      void import('./agent/pi-assistant.js')
        .then(async (mod) => {
          mod.preloadPiAssistant(assistantOptions);
          console.log('[agent] 幕僚长预热中…（后台装配，不阻塞窗口）');
          for (let i = 0; i < 180; i += 1) {
            const status = mod.assistantStatus();
            if (status === 'ready') {
              console.log('[agent] 幕僚长就绪');
              return;
            }
            if (status === 'unavailable') {
              console.error(`[agent] 幕僚长不可用（缺 key / 模型不可用？）: ${mod.assistantError() ?? ''}`);
              return;
            }
            await delay(500);
          }
        })
        .catch((error: unknown) => {
          console.error(`[agent] 幕僚长装配异常: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  } catch (error) {
    console.error('[db] 初始化失败（窗口仍会打开）:', error);
  }
}

/** 基准固定数据集：确定性生成 N 条人工消息（用真 DAO 写库）。 */
function seedBenchMessages(repo: ReturnType<typeof createSqliteChatRepo>, count: number): void {
  const base = Date.now() - count * 1000;
  for (let i = 0; i < count; i += 1) {
    repo.insertMessage({
      direction: i % 3 === 0 ? 'out' : 'in',
      taskId: null,
      content: `基准消息 #${i} — ${'字'.repeat(30 + (i % 50))}`,
      attachments: [],
      now: base + i * 1000,
    });
  }
  console.log(`[bench] seeded ${count} messages`);
}

/**
 * P-06/P-07 bench 固定数据集：2 个项目 × 25 任务（共 50）＋一条 1000 事件的详情任务。
 * 只在 `AICO_BENCH` 下调用；普通启动不受影响。
 */
function seedBenchTasks(db: SqliteDb): void {
  const root = join(app.getPath('userData'), 'bench-project');
  mkdirSync(root, { recursive: true });
  const at = Date.now();
  const counter = new SqliteCounterStore(db);
  const projects = ['基准项目 A', '基准项目 B'].map((name) =>
    Number(
      db
        .prepare("INSERT INTO projects(name, root_dir, created_at) VALUES(?,?,?)")
        .run(name, root, at).lastInsertRowid,
    ),
  );
  benchProjectIds = projects;
  const ids: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const task = createTask(db, counter, {
      projectId: projects[i % 2],
      title: `基准任务 ${i + 1}`,
      goal: `基准目标 ${i + 1}`,
      riskLevel: 1,
    });
    // 不改 tasks.state（状态写者唯一＝引擎；bench 只需项目树/详情数据）。
    ids.push(task.id);
  }
  benchTaskId = ids[0] ?? null;
  if (benchTaskId != null) {
    for (let i = 0; i < 1000; i += 1) {
      insertTaskEvent(db, {
        taskId: benchTaskId,
        ts: at + i,
        kind: 'tool_call',
        actor: 'system',
        payload: { seq: i, tool: 'bench', isError: false },
      });
    }
  }
  console.log(`[bench] seeded ${ids.length} tasks / 1000 events (task=${benchTaskId ?? '—'})`);
}

/**
 * T0.7 演示数据（`AICO_T07_DEMO=1`）：建一个任务，**经引擎驱动**出 `plan_steps` 投影
 * （`plan_drafted.payload.steps[]`）+ `progress_reported` + `tool_call`，供任务详情三 tab 有真实数据。
 * 库非空时复用第一条任务（幂等）。
 */
async function seedT07Demo(db: SqliteDb, engineRef: Engine): Promise<number> {
  const existing = db.prepare('SELECT id FROM tasks ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (existing) return existing.id;

  const at = Date.now();
  const project = db
    .prepare(`INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?, ?, ?, ?) RETURNING id`)
    .get('记账系统', '记账', join(homedir(), '.aico', 'projects', 'bookkeeping'), at) as { id: number };

  const task = createTask(db, new SqliteCounterStore(db), {
    projectId: project.id,
    title: '竞品对账脚本调研与实现',
    goal: '调研竞品对账脚本并实现',
    riskLevel: 1,
    acceptance: [
      { text: '对比表齐全' },
      { text: 'pytest 全过', check: 'pytest -q' },
      { text: 'diff 报表逐项核对', check: 'python check.py' },
    ],
    now: at,
  });

  const dispatch = async (event: string, payload?: Record<string, unknown>): Promise<void> => {
    try {
      await engineRef.dispatch({ scope: 'task', id: task.id, event, actor: 'boss', payload });
    } catch (error) {
      // 注意措辞：demo 日志**不出现 “failed”**（避免"看着像错误、其实不是"误导人，1510）。
      console.error(`[t07-demo] dispatch ${event} rejected:`, error instanceof Error ? error.message : error);
    }
  };

  await dispatch('triage');
  await dispatch('plan_drafted', {
    steps: ['调研 3 家竞品导出格式', '实现 reconcile.py', '验证与交付', '写交付文档'],
  });
  await dispatch('plan_reviewed');
  await dispatch('plan_approved');
  // `autoSchedule`（默认 true）可能在 `plan_approved` 后同一 fixpoint 里就把任务推进到 `executing`；
  // 已是 `executing` 就**跳过**显式 `start_task`，否则会打出一条"看着像错误、其实不是"的 rejected 日志（1510）。
  const stateBeforeStart = getTaskById(db, task.id)?.state;
  if (stateBeforeStart === 'ready') {
    await dispatch('start_task');
  } else {
    console.log(`[t07-demo] start_task skipped (state=${stateBeforeStart ?? 'unknown'})`);
  }

  // 进展（进度条）+ 工具调用（行为日志）：与引擎同构：写事件 + 投影。
  const progress: Array<{ idx: number; state: 'done' | 'running' }> = [
    { idx: 1, state: 'done' },
    { idx: 2, state: 'running' },
  ];
  progress.forEach((step, i) => {
    insertTaskEvent(db, {
      taskId: task.id,
      ts: at + 10 + i,
      kind: 'progress_reported',
      actor: 'assistant',
      payload: { stepIdx: step.idx, state: step.state },
    });
    updatePlanStepState(db, { taskId: task.id, stepIdx: step.idx, state: step.state });
  });
  const toolCalls: Array<Record<string, unknown>> = [
    { tool: 'read_file', command: 'cat competitors/a.csv' },
    { tool: 'run_command', command: 'pytest -q' },
    { tool: 'run_command', command: 'python check.py' },
  ];
  toolCalls.forEach((payload, i) => {
    insertTaskEvent(db, { taskId: task.id, ts: at + 20 + i, kind: 'tool_call', actor: 'employee:1', payload });
  });

  return task.id;
}

/** M1-5：种入三张 GenUI 示例卡（供 `AICO_GENUI_SELFTEST` 断言 AC1/AC4；不影向任务详情）。 */
function seedGenUiDemoReports(db: SqliteDb, taskId: number): void {
  const at = Date.now();
  const valid = {
    v: 1,
    id: GENUI_DEMO_SCHEMA_ID,
    complete: true,
    meta: {
      generatedBy: { employeeId: 3, employeeName: '研究员', taskId, taskShortId: 'T-1001' },
      provenance: 'employee',
      at,
    },
    root: {
      type: 'stack',
      id: 'root',
      props: {},
      children: [
        { type: 'text', id: 'q', props: { text: '对账脚本用 Python 还是 Node？' } },
        { type: 'progress', id: 'p', props: { value: 1, max: 4, label: '计划步骤' } },
        {
          type: 'disclosure',
          id: 'd',
          props: { summary: '看评审细节' },
          children: [{ type: 'text', id: 'dt', props: { text: 'critic：建议换模型。' } }],
        },
        {
          type: 'button-group',
          id: 'b',
          props: {
            actions: [
              { key: '1', label: 'Python', variant: 'primary', recommended: true },
              { key: '2', label: 'Node' },
            ],
          },
        },
      ],
    },
  };
  const externalEcho = {
    v: 1,
    id: 'sch_demo_ext',
    complete: true,
    meta: { generatedBy: { employeeName: '外部来源' }, provenance: 'external-echo', at },
    root: {
      type: 'stack',
      id: 'root',
      props: {},
      children: [
        { type: 'text', id: 'x', props: { text: '外部回显内容不可点' } },
        { type: 'button-group', id: 'bx', props: { actions: [{ key: 'x', label: '不应可点' }] } },
      ],
    },
  };
  const invalid = { v: 1, id: 'sch_demo_bad', complete: true, meta: { provenance: 'employee' }, root: { type: 'chart', id: 'c', props: {} } };

  insertReport(db, { taskId, kind: 'ask', payload: { question: '对账脚本用 Python 还是 Node？', schema: valid }, state: 'pending', now: at });
  insertReport(db, { taskId, kind: 'report', payload: { title: '外部回显卡（应只读）', schema: externalEcho }, state: 'delivered', now: at + 1 });
  insertReport(db, { taskId, kind: 'report', payload: { title: '非法 schema 的兜底文本（不应白屏）', schema: invalid }, state: 'delivered', now: at + 2 });
}

/**
 * CR15：启动维护——过期数据保留 + staging worktree 清理（只清终态且 >30 天/孤儿，保留在办与新近）。
 * 所有删除都由既有纯规划/SQL 计数返回；日志带真实读数，不静默。
 */
function runStartupMaintenance(db: SqliteDb): void {
  const retention = runRetention(db);
  if (retention.remoteEvents + retention.outbox + retention.checkpoints + retention.timers > 0) {
    console.log(`[maint] retention ${JSON.stringify(retention)}`);
  }
  const git = createGitRunner();
  const base = join(app.getPath('userData'), 'worktrees');
  for (const project of listProjects(db)) {
    if (project.archived === 1 || project.access_mode !== 'staging') continue;
    try {
      const manager = new WorktreeManager(project.root_dir, base, git);
      const result = pruneStagingWorktrees(
        manager,
        (shortId) => {
          const row = db.prepare('SELECT state, updated_at FROM tasks WHERE short_id = ?').get(shortId) as
            | { state: string; updated_at: number }
            | undefined;
          return row ? { state: row.state, updatedAt: row.updated_at } : null;
        },
        { maxAgeDays: 30, now: Date.now() },
      );
      if (result.removed.length > 0 || result.kept.length > 0) {
        console.log(`[maint] worktrees ${project.name}: removed=${result.removed.length} kept=${result.kept.length}`);
      }
    } catch (error) {
      console.error(`[maint] worktree 清理失败（${project.name}，不阻塞启动）`, error);
    }
  }
}

/** BRK20 根因修复：渲染层加载唯一入口——拒绝**响亮留痕**（此前 `void loadFile()` 把 pre-commit 失败吞掉）。 */
function loadRenderer(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  const loading = devServerUrl
    ? mainWindow.loadURL(devServerUrl)
    : mainWindow.loadFile(resolveRendererIndex());
  return loading.then(
    () => true,
    (error: unknown) => {
      console.error(
        '[ui] 渲染层加载失败（pre-commit；诊断见 userData/logs/blank-*）：',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    },
  );
}

/** 自动更新接线：开发版/免安装版禁用并说明；安装版启动 20s 后静默自查。 */
function initAutoUpdate(): void {
  const portable = Boolean(process.env['PORTABLE_EXECUTABLE_DIR']);
  // B0-9 冒烟钩子：仅**开发版** + 显式 env；打包版永远走真 updater。
  const fakeUpdater =
    !app.isPackaged && process.env['AICO_UPDATE_FAKE'] === '1' ? createFakeUpdater() : null;
  const enabled = (app.isPackaged && !portable) || fakeUpdater != null;
  const disabledReason = !app.isPackaged
    ? '开发版不支持自动更新'
    : portable
      ? '免安装版请手动下载新版本'
      : undefined;
  updateController = createUpdateController({
    updater: (fakeUpdater ?? autoUpdater) as unknown as UpdaterLike,
    currentVersion: app.getVersion(),
    enabled,
    ...(disabledReason != null ? { disabledReason } : {}),
    onStatus: (status: UpdateStatus) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
    },
  });
  ipcMain.handle('update:get', () => updateController?.getStatus() ?? null);
  ipcMain.handle('update:check', async () => updateController?.check() ?? null);
  // B0-9：手动下载（autoDownload=false）——老板确认后才下载。
  ipcMain.handle('update:download', async () => updateController?.download() ?? { ok: false, error: '更新控制器未就绪' });
  ipcMain.handle('update:install', () => updateController?.install() ?? { ok: false, error: '更新控制器未就绪' });
  if (enabled) {
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      void updateController?.check();
    }, 20_000);
    console.log('[update] 自动检查已排定（启动 20s 后）');
  } else {
    console.log(`[update] 自动更新禁用：${disabledReason ?? '未知原因'}`);
  }
}

function createWindow(): void {
  // F-05：窗口（重）建时启动状态归零——旧窗口的计时器已在 closed 里清掉。
  startupState = initialStartupState();
  uiMounted = false;
  startupLoadStartedAt = Date.now();
  // 验证用窗口尺寸（真窗口，不是设备仿真）：AICO_WINDOW_WIDTH/HEIGHT；缺省保持 1280×820。
  const envWidth = Number(process.env['AICO_WINDOW_WIDTH']);
  const envHeight = Number(process.env['AICO_WINDOW_HEIGHT']);
  mainWindow = new BrowserWindow({
    width: Number.isFinite(envWidth) && envWidth >= 720 ? envWidth : 1280,
    height: Number.isFinite(envHeight) && envHeight >= 600 ? envHeight : 820,
    // RM-7（2026-10-19 真机）：Windows 半屏（1920/2=960、1366/2=683）下 960 会把窗口顶出半屏。
    // 720 保留最小可用三栏；右栏在窄窗由 CSS 收窄/可折叠，不靠窗口下限硬撑。
    minWidth: 720,
    minHeight: 600,
    show: false,
    // 壳层重排（2026-10-16 替换批，设计件 §4.1/§6.1）：**无边框自绘**——系统标题栏让位给
    // 自绘顶栏（品牌＋搜索＋折叠钮＋窗口三键，`ui:win-*` IPC 驱动）；拖拽区＝`.topbar`。
    frame: false,
    // 启动底色跟随系统明暗（新主题日间默认；避免旧深色底在浅色主题下闪黑）。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f2f2f2',
    title: 'AI 一人公司',
    webPreferences: {
      preload: resolvePreloadPath(),
      // DEV §7.4：渲染进程隔离三件套。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 基准模式下关掉后台节流，否则 rAF 可能被暂停 → 滚动帧率测不到（甚至挂住）。
      ...(benchEnabled ? { backgroundThrottling: false } : {}),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 导航守卫（裁决②）：拖入文件/外链不得把窗口导航走（Electron 默认会把 drop 的文件当页面打开）。
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  attachDidFailLoad(mainWindow.webContents, crashOptions);

  // BRK20 诊断：白窗发生时把 console 最后 50 条 + URL/耗时 + 截图落盘；再按看门狗重载一次。
  mainWindow.webContents.on('console-message', (event) => {
    const next = appendConsoleLine(
      rendererConsoleLines,
      `[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
    );
    rendererConsoleLines.length = 0;
    rendererConsoleLines.push(...next);
  });

  const writeBlankDiagnostics = (phase: 'reloading' | 'unrecovered', elapsedMs: number): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const at = Date.now();
    const report = formatBlankWindowDiagnostics({
      at,
      url: mainWindow.webContents.getURL(),
      elapsedMs,
      alreadyReloaded: startupState.mountReloaded,
      phase,
      consoleLines: rendererConsoleLines,
    });
    const logPath = join(crashLogDir, `blank-${at}-${phase}.log`);
    const shotPath = join(crashLogDir, `blank-${at}-${phase}.png`);
    try {
      mkdirSync(crashLogDir, { recursive: true });
      writeFileSync(logPath, report, 'utf8');
      console.error(`[ui] 白窗诊断已留痕：${logPath}`);
    } catch (error) {
      console.error('[ui] 白窗诊断文本写入失败（不阻断重载）', error);
    }
    void mainWindow.webContents
      .capturePage()
      .then((image) => {
        try {
          writeFileSync(shotPath, image.toPNG());
          console.error(`[ui] 白窗截图已留痕：${shotPath}`);
        } catch (error) {
          console.error('[ui] 白窗截图写入失败（不阻断重载）', error);
        }
      })
      .catch(() => undefined);
  };

  // F-05（2026-11-06）：启动加载状态机——同窗启动页 → 真实加载单飞 → committed → mounted。
  // 旧的三套看门狗（about:blank 6s/15s 探针 + 6/12/18s 固定重发 + reload 空白页）已退役：
  // 它们会互相 abort，机器慢时把白窗放大到 ~39s（ERR_ABORTED 现场）。
  const clearStartupTimers = (): void => {
    for (const timer of [startupCommitTimer, startupRetryTimer, startupMountTimer]) {
      if (timer) clearTimeout(timer);
    }
    startupCommitTimer = null;
    startupRetryTimer = null;
    startupMountTimer = null;
  };

  const startupElapsed = (): number => Date.now() - startupLoadStartedAt;

  /** 全败时的可读错误页——不白窗、不静默。 */
  const showStartupError = (reason: string): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow
      .loadURL(buildStartupErrorDataUrl({ reason, logDir: crashLogDir }))
      .catch((error: unknown) => {
        console.error('[ui] 启动失败页加载失败（窗口保持原样）', error instanceof Error ? error.message : String(error));
      });
    mainWindow.show();
  };

  /** 失败 → 按退避重发；档位用尽 → 错误页。 */
  const failAndScheduleRetry = (reason: string): void => {
    startupState = settleLoadFail(startupState, reason);
    clearStartupTimers();
    if (startupState.phase === 'failed') {
      console.error(`[ui] 渲染层加载连续失败（${reason}）——显示启动失败页`);
      showStartupError(reason);
      return;
    }
    const taken = takeRetryDelay(startupState);
    startupState = taken.state;
    if (taken.delayMs == null) return;
    console.error(`[ui] 第 ${startupState.attempts} 次真实加载失败（${reason}）——${taken.delayMs}ms 后重试`);
    startupRetryTimer = setTimeout(() => {
      startupRetryTimer = null;
      startRealLoad();
    }, taken.delayMs);
  };

  const scheduleCommitTimeout = (): void => {
    if (startupCommitTimer) clearTimeout(startupCommitTimer);
    startupCommitTimer = setTimeout(() => {
      startupCommitTimer = null;
      const outcome = onCommitTimeout(startupState);
      if (outcome.action === 'none') return;
      startupState = outcome.state;
      writeBlankDiagnostics('reloading', startupElapsed());
      console.error(`[ui] 真实加载 ${Math.round(COMMIT_STUCK_MS / 1000)}s 未提交——按失败重试`);
      failAndScheduleRetry('commit-timeout');
    }, COMMIT_STUCK_MS);
  };

  const scheduleMountWatchdog = (): void => {
    if (startupMountTimer) clearTimeout(startupMountTimer);
    startupMountTimer = setTimeout(() => {
      startupMountTimer = null;
      if (uiMounted || !mainWindow || mainWindow.isDestroyed()) return;
      const outcome = onMountTimeout(startupState);
      startupState = outcome.state;
      if (outcome.action === 'reload') {
        writeBlankDiagnostics('reloading', startupElapsed());
        console.error(`[ui] 已提交但 ${Math.round(MOUNT_STUCK_MS / 1000)}s 未见 ui:mounted——重载真实页面一次`);
        mainWindow.webContents.reload();
      } else if (outcome.action === 'give-up') {
        writeBlankDiagnostics('unrecovered', startupElapsed());
        console.error('[ui] 重载后仍未见 ui:mounted——显示启动失败页（不白窗）');
        showStartupError('mounted-timeout');
      }
    }, MOUNT_STUCK_MS);
  };

  function startRealLoad(): void {
    if (!mainWindow || mainWindow.isDestroyed() || uiMounted) return;
    const next = beginRealLoad(startupState);
    if (next === startupState) return; // 单飞：在飞/已挂载/已失败
    startupState = next;
    clearStartupTimers();
    console.log(`[ui] 第 ${startupState.attempts} 次加载真实渲染层（t=${startupElapsed()}ms）`);
    scheduleCommitTimeout();
    void loadRenderer().then((ok) => {
      // did-finish-load / did-fail-load 通常已先结算；这里只兜 Promise reject 的路径。
      if (!ok && startupState.inFlight) failAndScheduleRetry('load-rejected');
    });
  }

  mainWindow.webContents.on('did-start-loading', () => {
    uiMounted = false;
  });

  // 提交判据：只有真实 URL 的 finish 才算；启动页（data:）与 about:blank 必须忽略。
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (!isRealRendererUrl(url)) return;
    startupState = settleLoadOk(startupState, url);
    if (startupState.phase !== 'committed') return;
    if (startupCommitTimer) clearTimeout(startupCommitTimer);
    startupCommitTimer = null;
    console.log(`[ui] 真实渲染层已提交（t=${startupElapsed()}ms）`);
    scheduleMountWatchdog();
  });

  // 失败：只处理主框架；在飞的加载被 abort 也走同一退避（不再固定 6s 重发）。
  mainWindow.webContents.on(
    'did-fail-load',
    (_event: unknown, code: number, description: string, failedUrl: string, isMainFrame?: boolean) => {
      if (isMainFrame === false) return;
      if (!startupState.inFlight) return;
      const url = String(failedUrl ?? '');
      if (url.length > 0 && !isRealRendererUrl(url) && !url.startsWith('about:blank')) return;
      writeBlankDiagnostics('reloading', startupElapsed());
      failAndScheduleRetry(`did-fail-load ${code} ${description} ${url || '(empty)'}`);
    },
  );

  mainWindow.on('closed', () => {
    clearStartupTimers();
    mainWindow = null;
  });

  // 先显示内联启动页（不依赖网络栈）；完成后再发起真实加载，避免启动页被抢掉。
  startupLoadStartedAt = Date.now();
  void mainWindow
    .loadURL(buildSplashDataUrl())
    .then(() => {
      console.log(`[ui] 启动页已显示（t=${startupElapsed()}ms）`);
      startRealLoad();
    })
    .catch((error: unknown) => {
      // 连启动页都失败：直接尝试真实加载（窗口底色仍在，不白屏）。
      console.error('[ui] 启动页加载失败（继续真实加载）：', error instanceof Error ? error.message : String(error));
      startRealLoad();
    });
}

function pendingInboxCount(): number {
  if (!crashDb) return 0;
  try {
    // 与左栏 badge/底栏「待办」完全同口径（channel:cards 游标；FYI/已处理不计）。
    return unreadCardsCount(crashDb);
  } catch {
    return 0;
  }
}

/** 正在跑的工作项数（托盘绿点真读数；库未就绪/查询失败 → 0，不臆造）。 */
function runningWorkItemCount(): number {
  if (!crashDb) return 0;
  try {
    const row = crashDb.prepare("SELECT COUNT(*) AS n FROM work_items WHERE state = 'running'").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

const trayIconCache = new Map<TrayState, NativeImage>();
/** 托盘图标（按状态缓存；生成脚本＝scripts/gen-tray-icons.ps1）。 */
function trayIconFor(state: TrayState): NativeImage | null {
  const cached = trayIconCache.get(state);
  if (cached) return cached;
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64[state]}`);
    if (icon.isEmpty()) return null;
    trayIconCache.set(state, icon);
    return icon;
  } catch (error) {
    console.error(`[app] 托盘图标不可用（${state}）`, error);
    return null;
  }
}

/**
 * 打开主窗口并**指向**某个视图/任务（托盘菜单、OS 通知点击共用）。
 * 窗口还没挂载时先记下目标，`ui:mounted` 后补推（否则事件会丢在订阅前）。
 */
function openAppView(target: OpenViewTarget): void {
  pendingOpenView = target;
  showMainWindow();
  if (uiMounted) flushPendingOpenView();
}

function flushPendingOpenView(): void {
  if (pendingOpenView == null) return;
  const target = pendingOpenView;
  pendingOpenView = null;
  evtSink.push('evt:open-view', target, `open:${Date.now()}`);
}

/** M3-P-3：托盘状态（待我处理真读数＋正在干活真读数；状态点＝橙等/绿干/无）。 */
function refreshTrayStatus(): void {
  if (!tray) return;
  const view = trayStatusView({ pending: pendingInboxCount(), running: runningWorkItemCount() });
  tray.setToolTip(view.tooltip);
  const icon = trayIconFor(view.state);
  if (icon) tray.setImage(icon);
  if (lastTrayState !== view.state) {
    console.log(`[tray] state=${view.state} pending=${view.pending} running=${view.running}`);
    lastTrayState = view.state;
  }
  const template: MenuItemConstructorOptions[] = [];
  if (view.menuLabel != null) {
    template.push(
      view.state === 'waiting'
        ? { label: view.menuLabel, click: (): void => openAppView({ view: 'inbox' }) }
        : { label: view.menuLabel, enabled: false },
    );
  }
  template.push(
    { type: 'separator' },
    { label: '显示主窗口', click: (): void => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: (): void => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  try {
    const icon = trayIconFor('idle');
    if (!icon) throw new Error('托盘 idle 图标为空');
    tray = new Tray(icon);
    tray.on('click', () => showMainWindow());
    refreshTrayStatus();
  } catch (error) {
    console.error('[app] tray unavailable:', error);
  }
}

/**
 * 微信二维码渲染：官方 B 传输层只给二维码 URL，主进程用 `qrcode` 转 data URL。
 * qrcode 不可用 → 原样返回 URL（设置页显示可点链接），不阻塞绑定。
 */
async function encodeQrToDataUrl(url: string): Promise<string> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<unknown>;
    const mod = (await dynamicImport('qrcode')) as {
      toDataURL?: (text: string, opts?: unknown) => Promise<string>;
      default?: { toDataURL?: (text: string, opts?: unknown) => Promise<string> };
    };
    const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
    if (!toDataURL) return url;
    return await toDataURL(url, { margin: 1, width: 240 });
  } catch {
    return url;
  }
}

/**
 * OPT-EXT-1b：系统通知旁路——`notify()` 投递成功且走 `desktop` 时弹 OS 通知；
 * `digest`（静默期收纳）与 `employee:*`（员工间 mailbox）不弹。托盘读数同步刷新。
 * GAP3 收口：点击 OS 通知回到对应任务；不可用/失败如实记日志（通知已落库）。
 */
function installNotifyDeliveryHook(): void {
  setNotifyDeliveryHook((delivery) => {
    refreshTrayStatus();
    deliverDesktopNotification(delivery, {
      isSupported: () => Notification.isSupported(),
      createNotification: ({ title, body }) => new Notification({ title, body }),
      pushToast: ({ title, text, reportId }) => {
        evtSink.push('evt:toast', { title, text, reportId }, `toast:${delivery.dedupeKey}`);
      },
      openView: (target) => openAppView(target),
      logError: (message, error) => {
        if (error === undefined) console.error(`[app] ${message}`);
        else console.error(`[app] ${message}`, error);
      },
    });
    // 只把**老板面**的卡（desktop/digest）转给 IM；员工 mailbox（channel='employee:*'）永不外发。
    if ((delivery.channel === 'desktop' || delivery.channel === 'digest') && delivery.reportId != null) {
      imManager?.onReport(delivery.reportId, delivery.taskId);
    }
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function captureShellScreenshot(target: string): Promise<void> {
  if (!mainWindow) throw new Error('main window is not available');
  const testIds = (await withTimeout(
    mainWindow.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))",
    ),
    5000,
    'inventory',
  )) as string[];
  console.log(`[ui] data-testid inventory: ${JSON.stringify(testIds)}`);
  // 强制等两帧 rAF，确保「异步数据到达后的重渲染」已被合成，再截图（否则可能拿到数据到达前的旧帧）。
  await withTimeout(
    mainWindow.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    ),
    5000,
    'raf',
  );
  const image = await withTimeout(mainWindow.webContents.capturePage(), 8000, 'capturePage');
  const png = image.toPNG();
  if (png.length === 0) throw new Error('capturePage returned empty image');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`[ui] screenshot saved: ${target} (${png.length} bytes)`);
}

/**
 * T0.5 自测：注入**计数假 preload**（`globalThis.__AICO_API__`），
 * 程序化点 1 次「发送」+ 1 次「决策卡选项」，回报各自 IPC 计数。
 * 目的：证明「一次点击 = 恰好一条 IPC」（防按钮重复触发）。
 */
async function runSelfTest(): Promise<{ counts: Record<string, number> }> {
  if (!mainWindow) throw new Error('main window is not available');
  const script = `(async () => {
    const counts = { 'chat:send': 0, 'task:approve': 0 };
    const real = window.api;
    const fake = Object.assign({}, real, {
      chat: Object.assign({}, real.chat, {
        send: async () => { counts['chat:send'] += 1; return { ok: true, messageId: 0, resolution: { kind: 'chat' } }; },
      }),
      task: Object.assign({}, real.task, {
        approve: async () => { counts['task:approve'] += 1; return { ok: true }; },
      }),
      inbox: Object.assign({}, real.inbox, { answer: async () => ({ ok: true }) }),
    });
    globalThis.__AICO_API__ = fake;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(300);
    const textarea = document.querySelector('[data-testid=composer-input]');
    const sendButton = document.querySelector('[data-testid=composer-send]');
    if (textarea && sendButton) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'T0.5 自测消息');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(50);
      sendButton.click();
      await wait(120);
    }
    const option = document.querySelector('[data-testid=card-option]');
    if (option) { option.click(); await wait(120); }
    return counts;
  })()`;
  const counts = (await mainWindow.webContents.executeJavaScript(script)) as Record<string, number>;
  return { counts };
}

/** 打开任务详情视图并等它渲染出数据（T0.7 DEMO / SELFTEST 用）。 */
async function openT07View(): Promise<void> {
  if (!mainWindow) throw new Error('main window is not available');
  const wc = mainWindow.webContents;
  // 左栏是唯一导航（UI §1）：点第一条任务行 → 中栏进该任务详情。
  await wc.executeJavaScript(
    "(() => { const row = document.querySelector('[data-testid=left-rail] [data-task-id]'); if (row) row.click(); return !!row; })()",
  );
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = (await wc.executeJavaScript("!!document.querySelector('[data-testid=plan-panel]')")) as boolean;
    if (ready) return;
    await delay(100);
  }
  throw new Error('task-detail 视图未在 10s 内渲染出数据');
}

/**
 * T0.7 自测（验收②）：逐 tab 数**真 DOM**条数 vs `task:get().counts`（查询返回条数）。
 * 不靠肉眼；任一 tab 不相等即返回 `ok:false`（调用方置 `exitCode=1`）。
 */
async function runT07SelfTest(): Promise<{
  ok: boolean;
  taskId: number | null;
  res: Record<string, { dom: number; query: number }>;
}> {
  if (!mainWindow) throw new Error('main window is not available');
  await openT07View();
  const script = `(async () => {
    const count = (id) => document.querySelectorAll('[data-testid="' + id + '"]').length;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const clickTab = async (tab) => { const el = document.querySelector('[data-testid="' + tab + '"]'); if (el) el.click(); await nextFrame(); };
    const root = document.querySelector('[data-testid=task-detail]');
    const taskId = root && root.dataset ? Number(root.dataset.taskId) : null;
    const detail = await window.api.task.get({ taskId });
    const res = {};
    await clickTab('plan');
    res.planSteps = { dom: count('plan-step'), query: detail.counts.planSteps };
    res.acceptance = { dom: count('acceptance-item'), query: detail.counts.acceptance };
    await clickTab('timeline');
    res.timeline = { dom: count('timeline-item'), query: detail.counts.timeline };
    await clickTab('behavior');
    res.behaviorLog = { dom: count('behavior-item'), query: detail.counts.behaviorLog };
    const ok = Object.values(res).every((x) => x.dom === x.query);
    return { ok, taskId, res };
  })()`;
  return (await mainWindow.webContents.executeJavaScript(script)) as {
    ok: boolean;
    taskId: number | null;
    res: Record<string, { dom: number; query: number }>;
  };
}

/**
 * 就绪可见自测（`UI §4.5` 系统状态行 / L13「绝不静默」）：
 *  推 `evt:message{status:'assistant_starting'}` → 断言状态行出现；再推一条内容事件 → 断言状态行消失。
 * 全程走真事件管道（`evt-sink` → preload 订阅 → store），不联网、不花钱。
 */
async function runAssistantStatusSelfTest(): Promise<{ ok: boolean; shown: string | null; cleared: boolean }> {
  if (!mainWindow) throw new Error('main window is not available');
  const wc = mainWindow.webContents;
  // 先确保在老板频道视图（状态行在消息流里）。
  await wc.executeJavaScript(
    "(() => { const b = document.querySelector('[data-testid=leftrail-channel]'); if (b) b.click(); return true; })()",
  );
  await delay(100);

  evtSink.push('evt:message', { status: 'assistant_starting' });
  evtSink.flush();
  await delay(200);
  const shown = (await wc.executeJavaScript(
    "(() => { const el = document.querySelector('[data-testid=assistant-status]'); return el ? el.textContent : null; })()",
  )) as string | null;

  evtSink.push('evt:message', { delta: '（就绪自测：真回复到达）' });
  evtSink.flush();
  await delay(200);
  const cleared = (await wc.executeJavaScript(
    "!document.querySelector('[data-testid=assistant-status]')",
  )) as boolean;

  const ok = shown != null && shown.includes('幕僚长启动中') && cleared;
  return { ok, shown, cleared };
}

/**
 * M1-5 GenUI 自测（真 DOM）：AC1（非法 schema 降级文本）、AC2（点一次=1 条 `chat:card-action`）、
 * AC4（来源标注 + external-echo 强制只读）、AC5（`evt:message{schemaPatch}` 增量更新 DOM）。
 * 不联网、不花钱。
 */
async function runGenuiSelfTest(): Promise<{
  ok: boolean;
  ac1Fallback: string | null;
  ac2Count: number;
  ac4: { provenance: number; echoDisabled: boolean };
  ac5Updated: boolean;
}> {
  if (!mainWindow) throw new Error('main window is not available');
  const wc = mainWindow.webContents;

  const deadline = Date.now() + 10000;
  for (;;) {
    const rendered = (await wc.executeJavaScript(
      "document.querySelectorAll('[data-testid=card]').length >= 3 && !!document.querySelector('[data-testid=genui-fallback]')",
    )) as boolean;
    if (rendered) break;
    if (Date.now() > deadline) throw new Error('GenUI 示例卡未在 10s 内渲染');
    await delay(100);
  }

  // AC1：非法 schema → 降级 legacy 文本（非空白）
  const ac1Fallback = (await wc.executeJavaScript(
    "(() => { const el = document.querySelector('[data-testid=genui-fallback]'); return el ? el.textContent.trim() : null; })()",
  )) as string | null;

  // AC4：每张 GenUI 卡有来源标注；external-echo 卡的所有按钮 disabled
  const ac4 = (await wc.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid=genui-card]'));
    const provenance = cards.filter((c) => c.querySelector('[data-testid=card-provenance]')).length;
    const echo = cards.find((c) => c.getAttribute('data-provenance') === 'external-echo');
    const echoButtons = echo ? Array.from(echo.querySelectorAll('[data-testid=genui-button]')) : [];
    const echoDisabled = echoButtons.length > 0 && echoButtons.every((b) => b.disabled === true);
    return { provenance, echoButtons: echoButtons.length, echoDisabled };
  })()`) as { provenance: number; echoButtons: number; echoDisabled: boolean });

  // AC2：注入计数假 preload → 点一次 → 恰好 1 条 `chat:card-action`
  const ac2Count = (await wc.executeJavaScript(`(async () => {
    let count = 0;
    const real = window.api;
    globalThis.__AICO_API__ = Object.assign({}, real, {
      chat: Object.assign({}, real.chat, { cardAction: async () => { count += 1; return { ok: true }; } }),
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(200);
    const btn = document.querySelector('[data-testid=genui-card][data-provenance=employee] [data-testid=genui-button]');
    if (btn) { btn.click(); await wait(200); }
    return count;
  })()`) as number);

  // AC5：`evt:message{schemaPatch}` → 增量更新 DOM
  evtSink.push('evt:message', {
    schemaPatch: {
      id: GENUI_DEMO_SCHEMA_ID,
      ops: [{ op: 'replace', path: '/root/children/0/props/text', value: '（已更新）' }],
    },
  });
  evtSink.flush();
  await delay(250);
  const ac5Updated = (await wc.executeJavaScript(
    `(() => { const c = document.querySelector('[data-testid=genui-card][data-schema-id=\"${GENUI_DEMO_SCHEMA_ID}\"]'); return !!c && c.textContent.includes('（已更新）'); })()`,
  )) as boolean;

  const ok =
    ac1Fallback !== null &&
    ac1Fallback.length > 0 &&
    ac4.provenance >= 2 &&
    ac4.echoDisabled &&
    ac2Count === 1 &&
    ac5Updated;
  return { ok, ac1Fallback, ac2Count, ac4, ac5Updated };
}

/**
 * M1-3 自测（真 DOM）：假 preload 注入 `task:get().waits` →
 * AC① 路径冲突文案、AC③ 第二个枚举（employee_busy）、AC② 无等待时不显示占位。
 */
async function runWaitsSelfTest(): Promise<{
  ok: boolean;
  phase1Count: number;
  phase1Texts: string[];
  phase2HasWaits: boolean;
  rowHint: string | null;
  rowHintCleared: boolean;
}> {
  if (!mainWindow) throw new Error('main window is not available');
  const wc = mainWindow.webContents;

  // 等左栏出现任务行（真 task:list）
  const deadline = Date.now() + 10000;
  for (;;) {
    const hasRow = (await wc.executeJavaScript(
      "!!document.querySelector('[data-testid=left-rail] [data-task-id]')",
    )) as boolean;
    if (hasRow) break;
    if (Date.now() > deadline) throw new Error('左栏任务行未在 10s 内出现');
    await delay(100);
  }

  const phase1 = (await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const base = await real.task.get({ taskId: 1 });
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, {
        get: async () => Object.assign({}, base, { waits: [
          { workItemId: 2, reason: 'path_conflict', conflictsWith: [1], conflictsWithShortIds: ['T-1001'] },
          { workItemId: 3, reason: 'employee_busy', detail: '研究员 正忙（T-1038）' },
        ] }),
      }),
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(150);
    const row = document.querySelector('[data-testid=left-rail] [data-task-id]');
    if (row) row.click();
    await wait(400);
    const texts = Array.from(document.querySelectorAll('[data-testid=task-wait]')).map((e) => e.textContent);
    return { count: texts.length, texts };
  })()`)) as { count: number; texts: string[] };

  // ② 无等待 → 不得出现等待条
  const phase2HasWaits = (await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const base = await real.task.get({ taskId: 1 });
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, { get: async () => Object.assign({}, base, { waits: [] }) }),
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(150);
    const row = document.querySelector('[data-testid=left-rail] [data-task-id]');
    if (row) row.click();
    await wait(400);
    return !!document.querySelector('[data-testid=task-waits]');
  })()`)) as boolean;

  // ③ 落点②（左栏任务行行内提示）：假 task:list 带 waits → evt:task 触发 loadTasks → 行内出现提示
  await wc.executeJavaScript(
    "(() => { const b = document.querySelector('[data-testid=leftrail-channel]'); if (b) b.click(); return true; })()",
  );
  await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const list = await real.task.list({});
    const withWaits = list.map((t, i) => i === 0
      ? Object.assign({}, t, { waits: [{ workItemId: 2, reason: 'path_conflict', conflictsWith: [1], conflictsWithShortIds: ['T-1001'] }] })
      : t);
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, { list: async () => withWaits }),
    });
    return withWaits.length;
  })()`);
  evtSink.push('evt:task', { reload: 'waits-selftest' });
  evtSink.flush();
  await delay(350);
  const rowHint = (await wc.executeJavaScript(
    "(() => { const el = document.querySelector('[data-testid=task-wait-hint]'); return el ? el.textContent : null; })()",
  )) as string | null;

  // ④ 行内空则不显示
  await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const list = await real.task.list({});
    const noWaits = list.map((t) => Object.assign({}, t, { waits: [] }));
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, { list: async () => noWaits }),
    });
    return true;
  })()`);
  evtSink.push('evt:task', { reload: 'waits-selftest-empty' });
  evtSink.flush();
  await delay(350);
  const rowHintCleared = (await wc.executeJavaScript(
    "!document.querySelector('[data-testid=task-wait-hint]')",
  )) as boolean;

  const ok =
    phase1.count === 2 &&
    phase1.texts.includes('等待：路径冲突 @T-1001') &&
    phase1.texts.includes('等待：等员工空闲（研究员 正忙（T-1038））') &&
    phase2HasWaits === false &&
    rowHint === '等待：路径冲突 @T-1001' &&
    rowHintCleared === true;
  return { ok, phase1Count: phase1.count, phase1Texts: phase1.texts, phase2HasWaits, rowHint, rowHintCleared };
}

/**
 * M1-3 端到端：种入**真实路径冲突**（两个任务、work item 的 `touched_paths` 相交）
 * → 引擎调度 hold 第二个（`path_conflict`）→ `task:list`/`task:get` 的 `waits` 由此而来。
 */
async function seedPathConflictDemo(db: SqliteDb, engineRef: Engine): Promise<{ heldShortId: string; conflictShortId: string }> {
  const at = Date.now();
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?, 'standard', ?)").run('E1', at);
  db.prepare("INSERT INTO employees(name, role, created_at) VALUES(?, 'standard', ?)").run('E2', at + 1);
  const project = db
    .prepare('INSERT INTO projects(name, root_dir, created_at) VALUES(?, ?, ?) RETURNING id')
    .get('等待演示', 'D:/repo', at) as { id: number };
  const t1 = createTask(db, new SqliteCounterStore(db), { projectId: project.id, title: '冲突任务 A', goal: 'g', now: at });
  const t2 = createTask(db, new SqliteCounterStore(db), { projectId: project.id, title: '被挡任务 B', goal: 'g', now: at + 1 });
  insertWorkItem(db, { taskId: t1.id, employeeId: 1, title: 'A', brief: 'b', touchedPaths: ['src/a.ts'], now: at });
  insertWorkItem(db, { taskId: t2.id, employeeId: 2, title: 'B', brief: 'b', touchedPaths: ['src/a.ts'], now: at + 1 });
  const drive = async (id: number): Promise<void> => {
    for (const event of ['triage', 'plan_drafted', 'plan_reviewed', 'plan_approved']) {
      await engineRef.dispatch({ scope: 'task', id, event, actor: 'boss' });
    }
  };
  await drive(t1.id);
  await drive(t2.id);
  return { heldShortId: t2.short_id ?? '', conflictShortId: t1.short_id ?? '' };
}

/**
 * M1-3 端到端自测：真实路径冲突 → 左栏行内提示 + 任务详情等待条（短号 `@T-…`）；
 * 另用假 DTO 验证**无短号回退 `@#7`** 与**空则不显示**（均为真 DOM）。
 */
async function runWaitsE2eSelfTest(): Promise<{
  ok: boolean;
  rowHint: string | null;
  detailTexts: string[];
  fallbackText: string | null;
  emptyHidden: boolean;
}> {
  if (!mainWindow) throw new Error('main window is not available');
  const wc = mainWindow.webContents;
  const deadline = Date.now() + 10000;
  for (;;) {
    const ready = (await wc.executeJavaScript(
      "document.querySelectorAll('[data-testid=left-rail] [data-task-id]').length >= 2 && !!document.querySelector('[data-testid=task-wait-hint]')",
    )) as boolean;
    if (ready) break;
    if (Date.now() > deadline) throw new Error('等待场景未在 10s 内渲染');
    await delay(100);
  }

  // ① 左栏行内提示（真 `task:list().waits`）
  const rowHint = (await wc.executeJavaScript(
    "(() => { const el = document.querySelector('[data-testid=task-wait-hint]'); return el ? el.textContent : null; })()",
  )) as string | null;

  // ② 任务详情等待条（点带 waits 的那一行 → 真 `task:get().waits`）
  await wc.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid=left-rail] [data-task-id]'));
    const row = rows.find((r) => r.querySelector('[data-testid=task-wait-hint]')) || rows[0];
    if (row) row.click();
    return !!row;
  })()`);
  await delay(450);
  const detailTexts = (await wc.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-testid=task-wait]')).map((e) => e.textContent)",
  )) as string[];

  // ③ 无短号回退：`conflictsWithShortIds: []` → `@#7`（真 DOM）
  const fallbackText = (await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const row = document.querySelector('[data-testid=left-rail] [data-task-id]');
    const taskId = row ? Number(row.dataset.taskId) : 1;
    const base = await real.task.get({ taskId });
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, {
        get: async () => Object.assign({}, base, { waits: [{ workItemId: 7, reason: 'path_conflict', conflictsWith: [7], conflictsWithShortIds: [] }] }),
      }),
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (row) row.click();
    await wait(450);
    const el = document.querySelector('[data-testid=task-wait]');
    return el ? el.textContent : null;
  })()`)) as string | null;

  // ④ 空则不显示
  const emptyHidden = (await wc.executeJavaScript(`(async () => {
    const real = window.api;
    const row = document.querySelector('[data-testid=left-rail] [data-task-id]');
    const taskId = row ? Number(row.dataset.taskId) : 1;
    const base = await real.task.get({ taskId });
    globalThis.__AICO_API__ = Object.assign({}, real, {
      task: Object.assign({}, real.task, { get: async () => Object.assign({}, base, { waits: [] }) }),
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (row) row.click();
    await wait(450);
    return !document.querySelector('[data-testid=task-waits]');
  })()`)) as boolean;

  const ok =
    rowHint !== null &&
    rowHint.includes('等待：路径冲突 @T-') &&
    detailTexts.some((t) => t.includes('等待：路径冲突 @T-')) &&
    fallbackText === '等待：路径冲突 @#7' &&
    emptyHidden === true;
  return { ok, rowHint, detailTexts, fallbackText, emptyHidden };
}

function registerShellHooks(): void {
  // 壳层自绘三键（2026-10-16 替换批·壳层重排）：`frame:false` 后系统标题栏不存在，
  // 窗口控制只能由渲染层驱动。`ui:` ＝内部前缀（同 `ui:mounted`），非业务域。
  // ✕ 走 `close()`＝与原生关闭同语义（window-all-closed → quit；托盘逻辑不变）。
  ipcMain.handle('ui:win-minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('ui:win-toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('ui:win-is-maximized', () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle('ui:win-close', () => {
    mainWindow?.close();
  });

  ipcMain.on('ui:mounted', () => {
    // F-05：渲染层挂载成功——启动状态机收口，清掉提交/mounted 计时器。
    uiMounted = true;
    startupState = markMounted(startupState);
    for (const timer of [startupCommitTimer, startupRetryTimer, startupMountTimer]) {
      if (timer) clearTimeout(timer);
    }
    startupCommitTimer = null;
    startupRetryTimer = null;
    startupMountTimer = null;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    console.log('[ui] shell mounted');
    flushPendingOpenView();
    // D-22：首帧已上屏后再预热模型目录（非阻塞；未加载时选型回落并说明，不静默猜）。
    if (!catalogPreheatStarted) {
      catalogPreheatStarted = true;
      setTimeout(() => {
        void loadModelCatalog().catch((error: unknown) => {
          console.warn(`[model-catalog] 预热失败（assistant 选型会回落）：${error instanceof Error ? error.message : String(error)}`);
        });
      }, 10000);
    }

    // M1-3 端到端（真路径冲突 hold，真 DOM）。
    if (waitsE2eEnabled) {
      void runWaitsE2eSelfTest()
        .then((result) => {
          console.log(`[waits-e2e] ${JSON.stringify(result)} -> ${result.ok ? 'PASS' : 'FAIL'}`);
          if (!result.ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[waits-e2e] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }

    // M1-3 等待可见自测（真 DOM；不联网）。
    if (waitsSelfTestEnabled) {
      void runWaitsSelfTest()
        .then((result) => {
          console.log(`[waits] ${JSON.stringify(result)} -> ${result.ok ? 'PASS' : 'FAIL'}`);
          if (!result.ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[waits] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }

    // M1-5 GenUI 自测（真 DOM；不联网）。
    
    if (genuiSelfTestEnabled) {
      void runGenuiSelfTest()
        .then((result) => {
          console.log(`[genui] ${JSON.stringify(result)} -> ${result.ok ? 'PASS' : 'FAIL'}`);
          if (!result.ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[genui] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }


    // 就绪可见自测（状态行出现/消失）—— 不联网。
    if (assistStatusTestEnabled) {
      void runAssistantStatusSelfTest()
        .then((result) => {
          console.log(`[assist-status] ${JSON.stringify(result)} -> ${result.ok ? 'PASS' : 'FAIL'}`);
          if (!result.ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[assist-status] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }

    // T0.7 自测：真 DOM 条数 vs 查询条数（逐 tab）——优先于其它模式。
    if (t07SelfTestEnabled) {
      selfTestDone = true;
      void runT07SelfTest()
        .then((result) => {
          console.log(`[t07] ${JSON.stringify(result)} -> ${result.ok ? 'PASS' : 'FAIL'}`);
          if (!result.ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[t07] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }

    // T0.7 演示/截图：先打开任务详情视图，再截图（`AICO_SHOT`）。
    if (t07DemoEnabled) {
      if (shotTaken) return;
      if (shotTimer) clearTimeout(shotTimer);
      shotTimer = setTimeout(() => {
        shotTaken = true;
        void (async () => {
          await openT07View();
          if (screenshotPath) await captureShellScreenshot(screenshotPath);
        })()
          .catch((error: unknown) => {
            console.error('[t07] demo failed:', error);
            process.exitCode = 1;
          })
          .finally(() => {
            if (screenshotPath) app.quit();
          });
      }, Number.isFinite(screenshotDelayMs) ? screenshotDelayMs : 900);
      return;
    }

    if (selfTestEnabled && !selfTestDone) {
      selfTestDone = true;
      void runSelfTest()
        .then((result) => {
          const counts = result.counts;
          const ok = counts['chat:send'] === 1 && counts['task:approve'] === 1;
          console.log(`[t05] fake-preload IPC counts: ${JSON.stringify(counts)} (expect 1/1) -> ${ok ? 'PASS' : 'FAIL'}`);
          if (!ok) process.exitCode = 1;
        })
        .catch((error: unknown) => {
          console.error('[t05] self-test failed:', error);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
      return;
    }

    if (benchEnabled) {
      shellMountedAt = Date.now();
      // 挂载 ≠ 已绘制：等一拍首帧合成，再跑全部基准场景（capturePage 作为「首帧就绪」代理）。
      setTimeout(() => {
        void runBench()
          .catch((error: unknown) => {
            console.error('[bench] run failed:', error);
            process.exitCode = 1;
          })
          .finally(() => app.quit());
      }, Number.isFinite(screenshotDelayMs) ? screenshotDelayMs : 900);
      return;
    }

    if (!screenshotPath) return;
    if (shotTaken) return;
    // 去抖：Vite 首次依赖优化会触发一次 page reload → 再发一次 ui:mounted；
    // 重排定时器，只在「最后一次挂载」后延时截图，避免在导航中截图而卡死。
    if (shotTimer) clearTimeout(shotTimer);
    shotTimer = setTimeout(() => {
      shotTaken = true;
      void captureShellScreenshot(screenshotPath)
        .catch((error: unknown) => {
          console.error('[ui] screenshot failed:', error);
          process.exitCode = 1;
        })
        .finally(() => {
          app.quit();
        });
    }, Number.isFinite(screenshotDelayMs) ? screenshotDelayMs : 900);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// M0 基准场景（DEV §7.3.1 ⑤ / Q-D）。全部复用现有机制，不引新依赖。
//   重要：dev 模式含 bundler / 首次依赖优化，**只作看门狗**；生产结论以**打包版基线**为准。
// ─────────────────────────────────────────────────────────────────────────────

/** IPC 环回：渲染层连续 `bench.ping`，报告 P50/P95/max。 */
const IPC_BENCH_SCRIPT = `(async () => {
  const N = 300; const dts = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await window.api.bench.ping(); dts.push(performance.now() - t); }
  dts.sort((a, b) => a - b);
  const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  return { count: N, p50Ms: +pct(0.5).toFixed(3), p95Ms: +pct(0.95).toFixed(3), maxMs: +dts[dts.length - 1].toFixed(3) };
})()`;

/** 滚动帧率：对已渲染列表做 1.5s 程序化滚动，rAF 采样帧间隔。 */
const SCROLL_BENCH_SCRIPT = `(async () => {
  const stream = document.querySelector('[data-testid=message-stream]');
  if (!stream) return { error: 'no message-stream' };
  const frameTimes = []; let running = true; let last = performance.now();
  const onFrame = (now) => { frameTimes.push(now - last); last = now; if (running) requestAnimationFrame(onFrame); };
  requestAnimationFrame(onFrame);
  const total = Math.max(0, stream.scrollHeight - stream.clientHeight);
  // 双保险：rAF 驱动 + setTimeout 兵底（rAF 被节流/暂停时不会挂住）。
  await new Promise((res) => {
    const start = performance.now();
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    const cap = setTimeout(finish, 5000);
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / 1500);
      stream.scrollTop = total * p;
      if (p < 1) requestAnimationFrame(step); else { clearTimeout(cap); finish(); }
    };
    requestAnimationFrame(step);
  });
  running = false;
  await new Promise((r) => requestAnimationFrame(r));
  frameTimes.sort((a, b) => a - b);
  const pct = (p) => frameTimes[Math.min(frameTimes.length - 1, Math.floor(frameTimes.length * p))] ?? 0;
  const median = pct(0.5);
  return {
    frames: frameTimes.length,
    p50FrameMs: +median.toFixed(2),
    p95FrameMs: +pct(0.95).toFixed(2),
    maxFrameMs: +(frameTimes[frameTimes.length - 1] ?? 0).toFixed(2),
    longFramesOver32ms: frameTimes.filter((t) => t > 32).length,
    p50Fps: median > 0 ? +(1000 / median).toFixed(1) : 0,
    scrollHeight: stream.scrollHeight,
  };
})()`;

/** 给渲染层脚本加超时，避免任一场景挂住整轮基准。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

async function waitForNumber(
  wc: BrowserWindow['webContents'],
  expression: string,
  predicate: (value: number) => boolean,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = (await wc.executeJavaScript(expression)) as number;
    if (predicate(last)) return last;
    await delay(100);
  }
  return last;
}

async function runEvtBurst(wc: BrowserWindow['webContents']): Promise<Record<string, unknown>> {
  // 监听统一信封 evt:batch（evt-sink 的真实出口）。
  await wc.executeJavaScript(`window.__benchEvtOff && window.__benchEvtOff();
    window.__aicoBenchEvt = { n: 0, last: -1, batches: 0, maxBatch: 0, latencies: [] };
    window.__benchEvtOff = window.api.on('evt:batch', (env) => {
      if (!env || env.channel !== 'evt:task') return;
      const items = Array.isArray(env.items) ? env.items : [];
      window.__aicoBenchEvt.batches += 1;
      window.__aicoBenchEvt.maxBatch = Math.max(window.__aicoBenchEvt.maxBatch, items.length);
      if (typeof env.emitAt === 'number') window.__aicoBenchEvt.latencies.push(Date.now() - env.emitAt);
      for (const it of items) { window.__aicoBenchEvt.n += 1; window.__aicoBenchEvt.last = (it && it.seq) ?? -1; }
    });
    true;`);
  const N = 1000;
  const start = Date.now();
  // 每个事件用不同 key（不去重）：验证「单批 ≤500」的拆批行为。
  for (let i = 0; i < N; i += 1) evtSink.push('evt:task', { seq: i, type: 'bench', payload: {} }, `bench:${i}`);
  evtSink.flush();
  const mainElapsedMs = Date.now() - start;
  await delay(300);
  const got = (await wc.executeJavaScript('window.__aicoBenchEvt')) as {
    n: number;
    last: number;
    batches: number;
    maxBatch: number;
    latencies: number[];
  };
  await wc.executeJavaScript('window.__benchEvtOff && window.__benchEvtOff(); true;');
  const lat = [...(got.latencies ?? [])].sort((a, b) => a - b);
  const pct = (p: number): number => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  return {
    sent: N,
    received: got.n,
    lastSeq: got.last,
    batches: got.batches,
    maxBatch: got.maxBatch,
    latencySamples: lat.length,
    latencyP50Ms: +pct(0.5).toFixed(2),
    latencyP95Ms: +pct(0.95).toFixed(2),
    latencyMaxMs: +(lat[lat.length - 1] ?? 0).toFixed(2),
    sinkStats: evtSink.stats(),
    mainElapsedMs,
    perEventMainUs: +((mainElapsedMs * 1000) / N).toFixed(1),
  };
}

async function runScrollBench(wc: BrowserWindow['webContents']): Promise<Record<string, unknown>> {
  // 提高列表上限（bench-only hook）并触发重载；BossChannel 监听 evt:message → loadChannel。
  await wc.executeJavaScript(`globalThis.__AICO_BENCH_LIST_LIMIT__ = ${BENCH_MESSAGE_COUNT}; true;`);
  evtSink.push('evt:message', { bench: 'reload' });
  evtSink.flush();
  const target = BENCH_MESSAGE_COUNT;
  const rows = await waitForNumber(
    wc,
    "document.querySelectorAll('[data-testid=message]').length",
    (n) => n >= target,
    15000,
  );
  const metrics = (await wc.executeJavaScript(SCROLL_BENCH_SCRIPT)) as Record<string, unknown>;
  return { renderedRows: rows, ...metrics };
}

/** SQLite P95：主进程真库上跑代表性查询（同步 API，单位 ms）。 */
function runSqliteBench(): Record<string, unknown> {
  if (!benchRepo) return { error: 'repo not ready' };
  const repo = benchRepo;
  const measure = (fn: () => void, n = 200): Record<string, number> => {
    const dts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const t = process.hrtime.bigint();
      fn();
      dts.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    dts.sort((a, b) => a - b);
    const pct = (p: number): number => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? 0;
    return { p50: +pct(0.5).toFixed(3), p95: +pct(0.95).toFixed(3), max: +(dts[dts.length - 1] ?? 0).toFixed(3) };
  };
  return {
    list100: measure(() => void repo.listMessages({ limit: 100 })),
    list1000: measure(() => void repo.listMessages({ limit: 1000 }), 100),
    reports50: measure(() => void repo.listReports({ limit: 50 })),
  };
}

/** P-06：切项目/任务（DOM 真点击 → 任务详情首屏出现；50 任务/2 项目）。 */
const TASK_SWITCH_BENCH_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 4000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(16);
    }
    return null;
  };
  const times = [];
  const nav = document.querySelector('[data-testid=leftrail-projects]');
  if (!nav) return { error: 'no project nav' };
  nav.click();
  const groups = await waitFor(() => {
    const list = Array.from(document.querySelectorAll('[data-testid=ptree-group]'));
    return list.length > 0 ? list : null;
  }, 5000);
  if (!groups) return { error: 'no project groups' };
  for (let round = 0; round < 12; round += 1) {
    const target = Array.from(document.querySelectorAll('[data-testid=ptree-group]'))[round % groups.length];
    if (!target) return { error: 'missing group', times };
    const t0 = performance.now();
    target.click();
    const rows = await waitFor(() => {
      const list = Array.from(document.querySelectorAll('[data-testid=project-task]'));
      return list.length > 1 ? list : null;
    }, 4000);
    if (!rows) return { error: 'no task row', times, groups: groups.length };
    // 跳过第一条（P-07 的 1000 事件任务），避免把投影成本算进“切任务”。
    const open = rows[(round % (rows.length - 1)) + 1]?.querySelector('[data-testid=project-task-open]');
    if (!open) return { error: 'no task open', times, groups: groups.length };
    open.click();
    const detail = await waitFor(() => document.querySelector('[data-testid=task-detail]'), 5000);
    if (!detail) return { error: 'no task detail', times, groups: groups.length };
    if (round > 0) times.push(performance.now() - t0);
    nav.click();
    await waitFor(() => document.querySelector('[data-testid=ptree-group]'), 3000);
  }
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))] ?? 0;
  return {
    projectGroups: groups.length,
    rounds: times.length,
    p50Ms: +pct(0.5).toFixed(2),
    p95Ms: +pct(0.95).toFixed(2),
    maxMs: +(times[times.length - 1] ?? 0).toFixed(2),
  };
})()`;

/** P-05：CDP 合成 IME → 文本在 composer 可见（主进程用 debugger 驱动）。 */
async function runInputBench(wc: BrowserWindow['webContents']): Promise<Record<string, unknown>> {
  const attachedByUs = !wc.debugger.isAttached();
  try {
    if (attachedByUs) wc.debugger.attach('1.3');
    await wc.executeJavaScript(`(async () => {
      const b = document.querySelector('[data-testid=leftrail-channel]');
      if (b) b.click();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 30; i += 1) { if (document.querySelector('[data-testid=composer-input]')) break; await sleep(100); }
      const el = document.querySelector('[data-testid=composer-input]');
      if (el) el.focus();
      return !!el;
    })()`);
    const times: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      await wc.executeJavaScript(`(() => {
        const el = document.querySelector('[data-testid=composer-input]');
        if (!el) return false;
        const setV = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setV.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        globalThis.__aicoInputStart = Date.now();
        return true;
      })()`);
      await wc.debugger.sendCommand('Input.imeSetComposition', {
        text: '基准输入',
        selectionStart: 4,
        selectionEnd: 4,
        replacementStart: 0,
        replacementEnd: 0,
      });
      const elapsed = (await withTimeout(
        wc.executeJavaScript(`(async () => {
          const until = Date.now() + 1500;
          while (Date.now() < until) {
            const el = document.querySelector('[data-testid=composer-input]');
            if (el && String(el.value).includes('基准输入')) return Date.now() - (globalThis.__aicoInputStart || Date.now());
            await new Promise((r) => setTimeout(r, 4));
          }
          return -1;
        })()`),
        2500,
        'input-wait',
      )) as number;
      if (i > 0 && elapsed >= 0) times.push(elapsed);
      await wc.executeJavaScript(`(() => {
        const el = document.querySelector('[data-testid=composer-input]');
        if (!el) return false;
        const setV = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setV.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    }
    times.sort((a, b) => a - b);
    const pct = (p: number): number => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))] ?? 0;
    return {
      via: 'cdp-imeSetComposition',
      iterations: times.length,
      p50Ms: +pct(0.5).toFixed(2),
      p95Ms: +pct(0.95).toFixed(2),
      maxMs: +(times[times.length - 1] ?? 0).toFixed(2),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attachedByUs && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach();
      } catch {
        /* ignore */
      }
    }
  }
}

/** P-07：单任务 1000 事件的投影耗时 + `task:get` 往返（真 DAO/真 IPC）。 */
async function runProjectionBench(wc: BrowserWindow['webContents']): Promise<Record<string, unknown>> {
  if (!benchRepo || benchTaskId == null) return { error: 'bench task not seeded' };
  const repo = benchRepo;
  const taskId = benchTaskId;
  const measure = (fn: () => unknown, n = 20): { p50: number; p95: number; max: number } => {
    const dts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const t = process.hrtime.bigint();
      fn();
      dts.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    dts.sort((a, b) => a - b);
    const pct = (p: number): number => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? 0;
    return { p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), max: +(dts[dts.length - 1] ?? 0).toFixed(2) };
  };
  const detail = repo.getTaskDetail(taskId);
  const projection = measure(() => repo.getTaskDetail(taskId), 20);
  const api = (await withTimeout(
    wc.executeJavaScript(`(async () => {
      const times = []; let count = 0;
      for (let i = 0; i < 10; i += 1) {
        const t = performance.now();
        const d = await window.api.task.get({ taskId: ${taskId} });
        times.push(performance.now() - t);
        count = Array.isArray(d?.timeline) ? d.timeline.length : 0;
      }
      times.sort((a, b) => a - b);
      const pct = (p) => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))] ?? 0;
      return { p50Ms: +pct(0.5).toFixed(2), p95Ms: +pct(0.95).toFixed(2), maxMs: +(times[times.length - 1] ?? 0).toFixed(2), timeline: count };
    })()`),
    15000,
    'projection-api',
  )) as { p50Ms: number; p95Ms: number; maxMs: number; timeline: number };
  return {
    taskId,
    events: detail?.timeline.length ?? 0,
    projectionP50Ms: projection.p50,
    projectionP95Ms: projection.p95,
    projectionMaxMs: projection.max,
    apiP50Ms: api.p50Ms,
    apiP95Ms: api.p95Ms,
    apiMaxMs: api.maxMs,
    apiTimeline: api.timeline,
  };
}

/** P-12：短窗内存曲线（默认 60s；`AICO_BENCH_SOAK_MS` 可调）。 */
async function runMemorySoak(): Promise<Record<string, unknown>> {
  const windowMs = Math.max(5000, Number(process.env['AICO_BENCH_SOAK_MS'] ?? '60000'));
  const intervalMs = Math.max(1000, Number(process.env['AICO_BENCH_SOAK_INTERVAL_MS'] ?? '10000'));
  const rssMb = (): number => {
    const metrics = app.getAppMetrics();
    const totalKb = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
    return +(totalKb / 1024).toFixed(2);
  };
  const samples: Array<{ tMs: number; rssMb: number }> = [{ tMs: 0, rssMb: rssMb() }];
  const t0 = Date.now();
  for (let t = intervalMs; t <= windowMs; t += intervalMs) {
    const wait = t0 + t - Date.now();
    if (wait > 0) await delay(wait);
    samples.push({ tMs: Date.now() - t0, rssMb: rssMb() });
  }
  const first = samples[0]!.rssMb;
  const last = samples[samples.length - 1]!.rssMb;
  const growthPct = first > 0 ? +(((last - first) / first) * 100).toFixed(2) : 0;
  const n = samples.length;
  const meanX = samples.reduce((sum, s) => sum + s.tMs / 60_000, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + s.rssMb, 0) / n;
  const denom = samples.reduce((sum, s) => sum + (s.tMs / 60_000 - meanX) ** 2, 0);
  const slope =
    denom > 0
      ? samples.reduce((sum, s) => sum + (s.tMs / 60_000 - meanX) * (s.rssMb - meanY), 0) / denom
      : 0;
  return {
    samples: n,
    windowMs,
    intervalMs,
    firstRssMb: first,
    lastRssMb: last,
    rssGrowthPct: growthPct,
    slopeMbPerMin: +slope.toFixed(3),
  };
}

async function runBench(): Promise<void> {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const want = (s: string): boolean => benchScenarios.includes(s);
  const results: Record<string, unknown>[] = [];
  const record = async (scenario: string, fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<void> => {
    try {
      results.push({ scenario, ...(await fn()) });
    } catch (error) {
      results.push({ scenario, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // 首帧就绪代理（capturePage）。
  let firstFrameMs = Date.now() - bootAt;
  try {
    await wc.capturePage();
    firstFrameMs = Date.now() - bootAt;
  } catch {
    /* 取证失败不阻断 */
  }

  // P-02：渲染层首个 React effect 的时间（epoch ms；同机时钟）。
  let interactiveMs: number | null = null;
  try {
    const at = (await wc.executeJavaScript('globalThis.__AICO_INTERACTIVE_AT__ ?? 0')) as number;
    if (typeof at === 'number' && at > 0) interactiveMs = Math.max(0, at - bootAt);
  } catch {
    /* 采样失败如实 null */
  }

  if (want('startup')) {
    results.push({
      scenario: 'startup',
      appReadyMs: appReadyAt - bootAt,
      shellMountedMs: shellMountedAt - bootAt,
      firstFrameMs,
      interactiveMs,
    });
  }
  if (want('ipc')) await record('ipc-roundtrip', async () => (await withTimeout(wc.executeJavaScript(IPC_BENCH_SCRIPT), 20000, 'ipc')) as Record<string, unknown>);
  if (want('evt')) await record('evt-burst', () => withTimeout(runEvtBurst(wc), 20000, 'evt'));
  if (want('scroll')) await record('scroll-fps-1000', () => withTimeout(runScrollBench(wc), 25000, 'scroll'));
  if (want('sqlite')) await record('sqlite-p95', () => runSqliteBench());
  if (want('switch')) {
    await record('task-switch', async () => {
      const result = await withTimeout(
        wc.executeJavaScript(TASK_SWITCH_BENCH_SCRIPT),
        30000,
        'task-switch',
      );
      return result as Record<string, unknown>;
    });
  }
  if (want('projection')) await record('task-projection', () => runProjectionBench(wc));
  if (want('input')) await record('input-latency', () => runInputBench(wc));
  if (want('memory')) await record('memory-soak', () => runMemorySoak());

  // 可信度标记（性能方案 §4.5）：**每条结果都带** `packaged` / `throttling`，缺标记 ⇒ 该数字不可采信。
  //  - `packaged`: app.isPackaged（打包版基线为 true；dev 为 false，dev 数字只作看门狗）
  //  - `throttling`: bench 模式下已关后台节流（`backgroundThrottling:false` + 三条 disable-*-throttling 开关）
  const benchMeta = { packaged: app.isPackaged, throttling: false };
  // OPT-M8-2（a）：bench run JSON 带「可回指」provenance（同一公共件）。
  const provenance = getProvenance({ version: app.getVersion() });
  for (const m of results) Object.assign(m, benchMeta);

  for (const m of results) console.log(`[bench] ${JSON.stringify(m)}`);
  if (benchOutput !== '1') {
    mkdirSync(dirname(benchOutput), { recursive: true });
    writeFileSync(
      benchOutput,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), provenance, meta: benchMeta, results }, null, 2)}\n`,
    );
    console.log(`[bench] results written: ${benchOutput}`);
  }
}

if (!gotSingleInstanceLock) {
  console.log('[app] another instance is already running -- exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[app] second instance launched -- focusing existing window');
    showMainWindow();
  });

  app.whenReady().then(() => {
    appReadyAt = Date.now();
    console.log('[app] ready');
    // 裁决 6（2026-11-09）：内置 ffmpeg 进 PATH——员工 bash 直接 `ffmpeg ...` 即可用。
    // 打包态＝<resources>/ffmpeg；开发态＝仓库 vendor/ffmpeg（scripts/fetch-ffmpeg.mjs 取）。
    // 只是**前置**到 PATH：系统已装 ffmpeg 时两者都能用（前置保证随包版本优先、版本可控）。
    try {
      const candidates = [
        join(process.resourcesPath ?? '', 'ffmpeg'),
        join(process.cwd(), 'vendor', 'ffmpeg'),
      ];
      const dir = candidates.find((d) => d.length > 3 && existsSync(join(d, 'ffmpeg.exe')) || (d.length > 3 && existsSync(join(d, 'ffmpeg'))));
      if (dir != null) {
        process.env.PATH = `${dir}${pathDelimiter}${process.env.PATH ?? ''}`;
        console.log(`[app] 内置 ffmpeg 已加入 PATH：${dir}`);
      }
    } catch (error) {
      console.error(`[app] 内置 ffmpeg 挂载失败（不阻断启动）：${error instanceof Error ? error.message : String(error)}`);
    }
    // B0-9：先接系统密钥环，再开库/引擎（供应商 Key 解析在会话装配时发生）。
    // B0-9 事故修复：隔离 profile（AICO_USER_DATA_DIR）下 OSCrypt 密钥随临时目录消失 ⇒ 禁用加密。
    // 仅显式允许（自动化 Key 加密配方）才视为稳定。
    installProviderKeyCodec({
      stable: userDataOverride == null || process.env['AICO_ALLOW_EPHEMERAL_ENCRYPTION'] === '1',
    });
    // 2026-10-17 真机反馈「没通知」：Windows 无 AppUserModelID 时 `Notification.show()` 会被系统静默丢弃。
    // 未打包态用 `process.execPath`（与开始菜单里 electron.exe 快捷方式登记的 AUMID 对齐，官方 dev 做法）；
    // 打包态同样指向本 exe，安装器建的快捷方式自然匹配。macOS/Linux 不需要。
    // 2026-10-29：AUMID 改为稳定标识——execPath 随开发/安装路径变化，注册表与快捷方式无法稳定登记，toast 会被系统静默丢弃。
    if (process.platform === 'win32') app.setAppUserModelId(AICO_APP_USER_MODEL_ID);
    registerAicoFileProtocol();
    void initDatabaseAndIpc().then(() => refreshTrayStatus());
    registerShellHooks();
    initAutoUpdate();
    createWindow();
    createTray();
    installNotifyDeliveryHook();

    if (crashSelftest) {
      // 主动抛一次：走 uncaughtException → 落盘 →（console）提示 → verify + exit。
      setTimeout(() => {
        throw new Error('AICO_CRASH_SELFTEST: intentional crash');
      }, 300);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 清理是 best-effort：**绝不允许清理打断退出序列**；失败必留痕（不静默）。
    runCleanupSafely([
      { name: 'engine.stop', run: () => engine?.stop() },
      { name: 'evtSink.dispose', run: () => evtSink.dispose() },
    ]);
  });
}
