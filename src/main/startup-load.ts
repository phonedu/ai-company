/**
 * （2026-11-06 决定「发布前必须解决」）：冷启不再出现纯白窗口。
 *
 * 现场：39s 停在 about:blank + `ERR_ABORTED loading file:///.../index.html`。根因不是单一
 * 「网络服务抖动」，而是**三套看门狗互相踩**：
 *   ① `about:blank` 自己触发 did-finish-load → 6s 早探针 + 15s 兜底计时器启动；
 *   ② 挂钟看门狗在 6/12/18s 重发 loadFile；
 *   ③ 页面级兜底调 `reload()`——在 about:blank 上只会重载空白页，还会把正在进行的加载
 *      abort 掉（就是日志里的 ERR_ABORTED）。
 *
 * 现口径：同窗启动页（data: URL，不依赖网络栈）→ 真实加载**单飞**（同一时刻只有一个在飞）
 * → 失败按 0.3/1/2/4s 退避重发（不 abort 正常加载）→ 全败显示可读错误页。
 * 本模块只做纯状态迁移（main 负责 loadURL/定时器/日志），故可在 Node 里单测。
 */

/** 启动页/错误页都是内联 data URL：不经过网络栈，避免和真实加载抢。 */
export const SPLASH_URL_PREFIX = 'data:text/html';

/** 真实加载的退避序列：首败后 300ms，其后 1s/2s/4s；共 1 次首载 + 4 次重试。 */
export const REAL_LOAD_RETRY_DELAYS_MS = [300, 1000, 2000, 4000] as const;

/** 已发起但 15s 仍未提交（真实 URL 未出现）→ 视为本次加载卡住。 */
export const COMMIT_STUCK_MS = 15_000;

/** 已提交但 15s 仍未收到 `ui:mounted` → 允许重载一次；再超时显示错误页。 */
export const MOUNT_STUCK_MS = 15_000;

export type StartupPhase = 'booting' | 'loading' | 'committed' | 'mounted' | 'failed';

export interface StartupState {
  phase: StartupPhase;
  /** 已发起的真实加载次数（含首次）；用于决定退避档位。 */
  attempts: number;
  /** 当前是否有真实加载在飞（单飞：在飞时不允许再发）。 */
  inFlight: boolean;
  committedUrl: string | null;
  /** 已因 mounted 超时重载过一次（只一次，防抖动）。 */
  mountReloaded: boolean;
  lastError: string | null;
  /** 已排定的下次重试延迟；null＝没有待重试。 */
  pendingRetryMs: number | null;
}

export function initialStartupState(): StartupState {
  return {
    phase: 'booting',
    attempts: 0,
    inFlight: false,
    committedUrl: null,
    mountReloaded: false,
    lastError: null,
    pendingRetryMs: null,
  };
}

/** 真实渲染层 URL（file:/http(s):）。data: 启动页与 about:blank 都不算「已提交」。 */
export function isRealRendererUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith('file://') || u.startsWith('http://') || u.startsWith('https://');
}

/** 发起一次真实加载；**在飞/已挂载/已失败时不重复发**（这就是单飞）。 */
export function beginRealLoad(state: StartupState): StartupState {
  if (state.phase === 'mounted' || state.phase === 'failed' || state.inFlight) return state;
  return {
    ...state,
    phase: 'loading',
    attempts: state.attempts + 1,
    inFlight: true,
    pendingRetryMs: null,
    lastError: null,
  };
}

/** 加载完成事件；只有真实 URL 才算提交（启动页/空白页的 finish 事件必须被忽略）。 */
export function settleLoadOk(state: StartupState, url: string): StartupState {
  if (state.phase === 'mounted') return state;
  if (!isRealRendererUrl(url)) return state;
  return {
    ...state,
    phase: 'committed',
    inFlight: false,
    committedUrl: url,
    pendingRetryMs: null,
  };
}

/**
 * 一次真实加载失败（did-fail-load / 提交超时 / loadFile reject）。
 * 按 attempts 取退避档；档位用尽 → failed（不再无限重试）。
 */
export function settleLoadFail(state: StartupState, reason: string): StartupState {
  if (state.phase === 'mounted' || state.phase === 'failed') return state;
  const nextDelay = REAL_LOAD_RETRY_DELAYS_MS[state.attempts - 1];
  const base = { ...state, inFlight: false, lastError: reason };
  if (nextDelay == null) {
    return { ...base, phase: 'failed', pendingRetryMs: null };
  }
  return { ...base, pendingRetryMs: nextDelay };
}

/** 取出待执行的重试延迟并清账（调用方负责 setTimeout）。 */
export function takeRetryDelay(state: StartupState): { state: StartupState; delayMs: number | null } {
  if (state.pendingRetryMs == null) return { state, delayMs: null };
  return { state: { ...state, pendingRetryMs: null }, delayMs: state.pendingRetryMs };
}

/** 渲染层自报挂载成功（ui:mounted）。 */
export function markMounted(state: StartupState): StartupState {
  if (state.phase === 'mounted') return state;
  return {
    ...state,
    phase: 'mounted',
    inFlight: false,
    pendingRetryMs: null,
    mountReloaded: false,
    lastError: null,
  };
}

/**
 * 已提交但迟迟未 mounted：第一次 → reload 真实页面（不再 reload about:blank）；
 * 第二次 → 放弃并把窗口换成可读错误页（不是白窗）。
 */
export function onMountTimeout(state: StartupState): { state: StartupState; action: 'none' | 'reload' | 'give-up' } {
  if (state.phase !== 'committed') return { state, action: 'none' };
  if (!state.mountReloaded) {
    return { state: { ...state, mountReloaded: true }, action: 'reload' };
  }
  return { state: { ...state, phase: 'failed', lastError: 'mounted-timeout' }, action: 'give-up' };
}

/** 提交超时：在飞的那次视为失败（走同一退避序列）。 */
export function onCommitTimeout(state: StartupState): { state: StartupState; action: 'none' | 'failed' } {
  if (!state.inFlight) return { state, action: 'none' };
  return { state: settleLoadFail(state, 'commit-timeout'), action: 'failed' };
}
