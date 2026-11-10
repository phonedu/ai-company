/**
 * 崩溃兜底 + 崩溃日志（要求 · 简单 / 不引依赖 / 日志只在本地、不上传）。
 *
 * - 主进程：`uncaughtException` / `unhandledRejection` → 尽力弹**友好提示**（含日志路径与如何反馈）＋ **落盘后再退出**。
 * - 渲染/子进程：`render-process-gone` / `child-process-gone` / `did-fail-load` → 落日志 ＋ 友好提示（不白屏、不静默）。
 * - 崩溃日志：`<userData>/logs/crash-<ts>.log`，含版本 / 时间 / 平台 / Electron/Node / 错误栈 ＋ **崩溃前最后在做什么**。
 *
 * 设计：本模块**不依赖 electron、不查 DB** —— `app` / `notify` / `logDir` / `getContext` 都由 `src/main/index.ts` 注入，
 * 因此可被 `node --test` 直接 import（格式化与落盘均可在纯 Node 下单测）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

export interface CrashContext {
  /** 崩溃前最后在做什么（若干行，已格式化好的文本）；由调用方提供（读 action_log/task_events 或内存环形缓冲）。 */
  lastActivity?: string[];
}

/** 运行环境快照（可注入，便于测试）。 */
export interface CrashEnv {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  osVersion: string;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/** 纯函数：生成崩溃日志文本（不触碰 fs/electron，便于单测）。 */
export function formatCrashLog(
  reason: string,
  error: unknown,
  context: CrashContext,
  env: CrashEnv,
  nowIso: string,
): string {
  const err = toError(error);
  const lines = [
    '# ai-company crash log',
    `time: ${nowIso}`,
    `reason: ${reason}`,
    `appVersion: ${env.appVersion}`,
    `electron: ${env.electron}`,
    `chrome: ${env.chrome}`,
    `node: ${env.node}`,
    `platform: ${env.platform} ${env.arch} ${env.osVersion}`.trim(),
    '',
    `error: ${err.name}: ${err.message}`,
    'stack:',
    err.stack ?? '(no stack)',
  ];
  if (context.lastActivity && context.lastActivity.length > 0) {
    lines.push('', 'recent activity:', ...context.lastActivity);
  }
  return `${lines.join('\n')}\n`;
}

export interface WriteCrashLogOptions {
  /** 崩溃日志目录（通常 `<userData>/logs`）。 */
  dir: string;
  env?: CrashEnv;
  nowIso?: string;
}

/** 落盘崩溃日志；返回文件路径（失败返回 null，**绝不抛**）。 */
export function writeCrashLog(
  reason: string,
  error: unknown,
  context: CrashContext = {},
  options: WriteCrashLogOptions,
): string | null {
  try {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const stamp = nowIso.replace(/[:.]/g, '-');
    mkdirSync(options.dir, { recursive: true });
    const file = `${options.dir}/crash-${stamp}.log`;
    writeFileSync(file, formatCrashLog(reason, error, context, options.env ?? defaultEnv(), nowIso), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** 无注入时的默认环境（Electron 下由调用方注入更准的快照；此处只做兜底）。 */
export function defaultEnv(): CrashEnv {
  return {
    appVersion: 'unknown',
    electron: process.versions.electron ?? 'n/a',
    chrome: process.versions.chrome ?? 'n/a',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osVersion: typeof (process as { getSystemVersion?: () => string }).getSystemVersion === 'function'
      ? (process as { getSystemVersion: () => string }).getSystemVersion()
      : '',
  };
}

// ── 兜底安装器（electron 对象由 main 注入；本模块自身不 import electron）──

export interface AppLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface CrashInstallOptions {
  /** 崩溃日志目录（`<userData>/logs`）。 */
  logDir: string;
  /** 友好提示实现（通常 `dialog.showErrorBox`）。 */
  notify: (title: string, detail: string) => void;
  /** 「崩溃前最后在做什么」。 */
  getContext?: () => CrashContext;
  /** 致命异常落盘+提示后的退出动作（默认 `process.exit(1)`；Electron 下可传 `() => app.exit(1)`）。 */
  fatalExit?: () => void;
  env?: CrashEnv;
}

/** 主进程全局兜底：`uncaughtException`（落盘→提示→退出）+ `unhandledRejection`（落盘→提示，不退出）。 */
/**
 * 主进程全局兜底：`uncaughtException`（落盘→提示→退出）+ `unhandledRejection`（落盘→提示，不退出）。
 *
 * **不变量（顺序不可倒）**：`uncaughtException` 一律 **先同步落盘 → 再提示 → 最后退出**；提示文案必须含**日志路径** + **如何反馈**。
 */
/**
 * 主进程全局兜底：`uncaughtException`（落盘→提示→退出）+ `unhandledRejection`（落盘→提示，不退出）。
 *
 * **不变量（顺序不可倒）**：`uncaughtException` 一律 **先同步落盘 → 再提示 → 尽快退出**；
 * 提示文案必须含**日志路径** + **如何反馈**；退出最迟由 **SIGKILL 硬兜底（800ms）** 保证（绝不留下半死进程）。
 */
/** 断管写（EPIPE）判定：标准流已无接收端——唯一安全的处置是忽略（写不出去不等于该退出）。 */
function isStdStreamEpipe(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}
export function installMainProcessCrashHandlers(options: CrashInstallOptions): void {
  const getContext = options.getContext ?? ((): CrashContext => ({}));
  const fatalExit = options.fatalExit ?? ((): void => process.exit(1));

  process.on('uncaughtException', (error) => {
    //  复核崩溃根因（2026-10-26 crash-…log）：stderr/stdout 管道断端后 console.error 同步抛 EPIPE
    // （Windows 管道为同步写，挂流 error 监听拦不住同步路径）——把可恢复的断管写升级成了应用崩溃。
    // EPIPE＝日志无处可去，不致命：吞掉继续跑（真实异常仍走下方落盘→提示→退出）。
    if (isStdStreamEpipe(error)) return;
    const file = writeCrashLog('uncaughtException', error, getContext(), { dir: options.logDir, env: options.env });
    options.notify(
      'AI 一人公司 出错了',
      `应用遇到未处理的异常，即将退出。\n崩溃日志：${file ?? '(写入失败)'}\n请把该日志反馈给开发者。`,
    );
    fatalExit();
    // (b) 硬兜底：无论 fatalExit 是否真的退出，都保证不留下"半死/zombie"进程（先落盘已在上面同步完成）。
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }, 800);
  });

  process.on('unhandledRejection', (reason) => {
    const file = writeCrashLog('unhandledRejection', reason, getContext(), { dir: options.logDir, env: options.env });
    options.notify(
      'AI 一人公司 出错了',
      `应用遇到未处理的 Promise 拒绝（已记录，界面继续运行）。\n崩溃日志：${file ?? '(写入失败)'}\n请把该日志反馈给开发者。`,
    );
  });
}

interface RenderGoneDetails {
  reason: string;
  exitCode: number;
}
interface ChildGoneDetails {
  type: string;
  reason: string;
}

/** 渲染/子进程异常：`render-process-gone` / `child-process-gone` → 落日志 + 友好提示。 */
export function installAppCrashHandlers(app: AppLike, options: CrashInstallOptions): void {
  const getContext = options.getContext ?? ((): CrashContext => ({}));
  app.on('render-process-gone', ((_event: unknown, _contents: unknown, details: RenderGoneDetails): void => {
    const file = writeCrashLog(
      `render-process-gone:${details.reason}`,
      new Error(`renderer gone (${details.reason}, exitCode=${details.exitCode})`),
      getContext(),
      { dir: options.logDir, env: options.env },
    );
    options.notify(
      '界面进程异常',
      `界面进程已退出（${details.reason}）。\n崩溃日志：${file ?? '(写入失败)'}\n可重载或重启应用。`,
    );
  }) as (...args: never[]) => void);
  app.on('child-process-gone', ((_event: unknown, details: ChildGoneDetails): void => {
    const file = writeCrashLog(
      `child-process-gone:${details.type}:${details.reason}`,
      new Error(`child gone (${details.type}, ${details.reason})`),
      getContext(),
      { dir: options.logDir, env: options.env },
    );
    options.notify('子进程异常', `子进程异常（${details.type}/${details.reason}）。\n崩溃日志：${file ?? '(写入失败)'}`);
  }) as (...args: never[]) => void);
}

/** webContents 加载失败 → 落日志（不白屏：调用方可在此重载）。 */
export function attachDidFailLoad(contents: AppLike, options: CrashInstallOptions): void {
  const getContext = options.getContext ?? ((): CrashContext => ({}));
  contents.on('did-fail-load', ((_event: unknown, code: number, description: string, url: string): void => {
    const file = writeCrashLog(
      `did-fail-load:${code}`,
      new Error(`did-fail-load ${code} ${description} url=${url}`),
      getContext(),
      { dir: options.logDir, env: options.env },
    );
    console.error(`[crash] did-fail-load code=${code} desc=${description} url=${url} log=${file}`);
  }) as (...args: never[]) => void);
}

/**
 * 退出前 best-effort 清理：任一步抛都**不打断退出序列**，且**必留痕**（不静默）。
 * 供 `before-quit` 使用（清理失败必须可见，否则“退出时清理失败”被吞掉）。
 */
export function runCleanupSafely(
  steps: Array<{ name: string; run: () => void }>,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): void {
  for (const step of steps) {
    try {
      step.run();
    } catch (error) {
      log(`[app] before-quit: ${step.name} 失败（退出继续）:`, error);
    }
  }
}
