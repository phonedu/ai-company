/**
 * （启动偶发白窗）自我恢复判据（纯函数，可单测）。
 *
 * 口径：`did-finish-load` 后 N 秒内没收到渲染层 `ui:mounted` ⇒ 判为疑似白窗，**自动重载一次**；
 * 第二次仍无挂载 → 只响亮留痕（stderr/console），不再无限重载（防抖动）。收到 `ui:mounted` 即清账。
 */
export const BLANK_WINDOW_TIMEOUT_MS = 15_000;

/**
 *  挂钟启动看门狗（pre-commit 失败专用；`did-finish-load` 在该失败模式下不触发）。
 * 复验实测（2026-10-25）：首捕现场 6s 首次重发撞上 network service 恢复窗口（ERR_ABORTED），
 * ⇒ **有界重试**：每 `STARTUP_RETRY_MS` 重发一次、共 `STARTUP_RETRY_MAX` 次；全败 ⇒ unrecovered。
 * 有界（不无限重试、不掩盖失败）；与既有 did-finish-load 看门狗并行、互不接管。
 */
export const STARTUP_RETRY_MS = 6_000;
export const STARTUP_RETRY_MAX = 3;
export const STARTUP_UNRECOVERED_MS = STARTUP_RETRY_MS * (STARTUP_RETRY_MAX + 1);

/**
 * 早探针（2026-10-24）：15s 太长——首启白屏时老板已经以为卡死。
 * `did-finish-load` 后 6s 主动执行一次页面探针（`window.api` + app-shell 节点）；
 * 探针确认空白才重载，避免把“慢启动但已在渲染”的正常窗口误杀。
 * 必须早于 `BLANK_WINDOW_TIMEOUT_MS`。
 */
export const BLANK_EARLY_PROBE_MS = 6_000;

export interface BlankWindowState {
  /** 当前页面是否已收到 `ui:mounted`。 */
  mounted: boolean;
  /** 本次页面加载是否已经自动重载过一次。 */
  alreadyReloaded: boolean;
  /** `did-finish-load` 至今的毫秒数。 */
  elapsedMs: number;
  timeoutMs?: number;
}

export function shouldReloadBlankWindow(state: BlankWindowState): boolean {
  return !state.mounted && !state.alreadyReloaded && state.elapsedMs >= (state.timeoutMs ?? BLANK_WINDOW_TIMEOUT_MS);
}

/** 渲染层 console 环形缓冲（白窗发生时把最后 N 条写进诊断文件；不改变控制台行为）。 */
export function appendConsoleLine(lines: readonly string[], line: string, max = 50): string[] {
  const next = [...lines, line];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 *  根因修复（2026-10-25 两次现场）：**pre-commit 失败**（真实导航从未提交，stderr 实证
 * network service crashed）时 `did-finish-load` 不触发 ⇒ 挂在它上面的看门狗整条失明。
 * 本判据＝挂钟启动看门狗的触发条件：未挂载且 URL 为空/about:blank（真实导航未提交）。
 * 纯函数（可单测）；已提交到真实 URL（含错误页）的失败由既有 did-finish-load 看门狗接管。
 */
export function isStuckOnPreCommit(input: { uiMounted: boolean; url: string }): boolean {
  if (input.uiMounted) return false;
  const url = input.url.trim();
  return url.length === 0 || url.startsWith('about:blank');
}

export interface BlankWindowDiagnosticsInput {
  at: number;
  url: string;
  elapsedMs: number;
  alreadyReloaded: boolean;
  /** 诊断阶段：首次超时 / 自动重载后仍未恢复。 */
  phase: 'reloading' | 'unrecovered';
  consoleLines: readonly string[];
}

/** 白窗诊断文本（纯函数；写盘由 main 做）。 */
export function formatBlankWindowDiagnostics(input: BlankWindowDiagnosticsInput): string {
  return [
    '# ai-company blank-window diagnostics',
    `at: ${new Date(input.at).toISOString()}`,
    `phase: ${input.phase}`,
    `url: ${input.url || '(empty)'}`,
    `elapsedMs: ${input.elapsedMs}`,
    `alreadyReloaded: ${input.alreadyReloaded}`,
    'console:',
    ...(input.consoleLines.length > 0 ? input.consoleLines : ['(none)']),
    '',
  ].join('\n');
}
