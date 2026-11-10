/**
 * 自动更新控制器（2026-11-06 后决定：GitHub）。
 *
 * 设计：**纯控制器**——electron-updater 的实例与事件通过 `UpdaterLike` 注入，Node 单测里用
 * 假实现即可覆盖状态机；main 只负责把状态推给渲染层。
 *
 * 边界（不摆假入口）：
 * - 开发版（未打包）不检查、不显示假「已是最新」；
 * - portable（免安装版）禁用自动更新并说明「请手动下载新版本」——portable 无法可靠自替换；
 * - 网络/源错误如实显示，不吞。
 */
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  /** 0–100；仅 downloading 有。 */
  percent?: number;
  /** 人话状态（UI 直接显示；不藏错误）。 */
  message: string;
  canCheck: boolean;
  /** 已发现新版本、等老板点「下载」（：autoDownload=false）。 */
  canDownload?: boolean;
  canInstall: boolean;
  checkedAt?: number;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (arg?: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  /** 手动下载（autoDownload=false 后由控制器显式调用）。 */
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateControllerDeps {
  updater: UpdaterLike;
  currentVersion: string;
  enabled: boolean;
  disabledReason?: string;
  onStatus?: (status: UpdateStatus) => void;
  now?: () => number;
}

export interface UpdateController {
  getStatus(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  /** 要求后手动下载（autoDownload=false）。 */
  download(): Promise<{ ok: boolean; error?: string }>;
  install(): { ok: boolean; error?: string };
}

function versionOf(info: unknown): string | undefined {
  if (info != null && typeof info === 'object' && typeof (info as { version?: unknown }).version === 'string') {
    return (info as { version: string }).version;
  }
  return undefined;
}

function percentOf(info: unknown): number | undefined {
  if (info != null && typeof info === 'object' && typeof (info as { percent?: unknown }).percent === 'number') {
    const p = (info as { percent: number }).percent;
    return Math.max(0, Math.min(100, Math.round(p)));
  }
  return undefined;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '未知错误');
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const now = deps.now ?? (() => Date.now());
  let status: UpdateStatus = deps.enabled
    ? {
        phase: 'idle',
        currentVersion: deps.currentVersion,
        message: '尚未检查更新',
        canCheck: true,
        canInstall: false,
      }
    : {
        phase: 'disabled',
        currentVersion: deps.currentVersion,
        message: deps.disabledReason ?? '当前版本不支持自动更新',
        canCheck: false,
        canInstall: false,
      };

  const emit = (patch: Partial<UpdateStatus>): void => {
    status = { ...status, ...patch };
    deps.onStatus?.(status);
  };
  const busy = (): boolean => status.phase === 'checking' || status.phase === 'downloading';

  if (deps.enabled) {
    // **不自动下载、不自动装**——签名缺失前，发布源被劫持一次即全员静默 RCE。
    // 发现新版本只提示，老板点「下载」才下载；点「重启安装」才装。
    deps.updater.autoDownload = false;
    deps.updater.autoInstallOnAppQuit = false;
    deps.updater.on('checking-for-update', () => {
      emit({ phase: 'checking', message: '正在检查更新…', canCheck: false, canInstall: false, checkedAt: now() });
    });
    deps.updater.on('update-available', (info) => {
      const v = versionOf(info);
      emit({
        phase: 'available',
        availableVersion: v,
        percent: 0,
        message: v ? `发现新版本 v${v}——点「下载更新」获取（不会自动下载/安装）` : '发现新版本——点「下载更新」获取',
        canCheck: true,
        canDownload: true,
        canInstall: false,
      });
    });
    deps.updater.on('download-progress', (info) => {
      const percent = percentOf(info);
      emit({
        phase: 'downloading',
        percent,
        message: percent == null ? '正在下载新版本…' : `正在下载新版本… ${percent}%`,
        canCheck: false,
        canDownload: false,
        canInstall: false,
      });
    });
    deps.updater.on('update-downloaded', (info) => {
      const v = versionOf(info) ?? status.availableVersion;
      emit({
        phase: 'downloaded',
        availableVersion: v,
        percent: 100,
        message: v ? `新版本 v${v} 已下载，重启后安装` : '新版本已下载，重启后安装',
        canCheck: true,
        canDownload: false,
        canInstall: true,
        checkedAt: now(),
      });
    });
    deps.updater.on('update-not-available', () => {
      emit({
        phase: 'up-to-date',
        message: `已是最新版本（v${deps.currentVersion}）`,
        canCheck: true,
        canDownload: false,
        canInstall: false,
        checkedAt: now(),
      });
    });
    deps.updater.on('error', (error) => {
      emit({
        phase: 'error',
        message: `检查更新失败：${errorText(error)}`,
        canCheck: true,
        canDownload: false,
        canInstall: false,
        checkedAt: now(),
      });
    });
  }

  return {
    getStatus: () => status,
    async check() {
      if (!deps.enabled || busy()) return status;
      emit({ phase: 'checking', message: '正在检查更新…', canCheck: false, canInstall: false });
      try {
        await deps.updater.checkForUpdates();
      } catch (error) {
        // electron-updater 通常已发 'error'；避免重复覆盖更具体的信息。
        if (status.phase !== 'error') {
          emit({
            phase: 'error',
            message: `检查更新失败：${errorText(error)}`,
            canCheck: true,
            canDownload: false,
            canInstall: false,
            checkedAt: now(),
          });
        }
      }
      return status;
    },
    async download() {
      if (!deps.enabled) return { ok: false, error: '当前版本不支持自动更新' };
      if (status.phase !== 'available') return { ok: false, error: '没有待下载的新版本（先检查更新）' };
      emit({ phase: 'downloading', percent: 0, message: '正在下载新版本…', canCheck: false, canDownload: false, canInstall: false });
      try {
        await deps.updater.downloadUpdate();
        return { ok: true };
      } catch (error) {
        emit({
          phase: 'error',
          message: `下载更新失败：${errorText(error)}`,
          canCheck: true,
          canDownload: false,
          canInstall: false,
          checkedAt: now(),
        });
        return { ok: false, error: errorText(error) };
      }
    },
    install() {
      if (!deps.enabled || status.phase !== 'downloaded') {
        return { ok: false, error: '没有已下载的新版本' };
      }
      try {
        // 测试/无人值守：AICO_UPDATE_NO_RELAUNCH=1 时安装后不强制拉起应用，
        // 便于冒烟脚本用隔离 userData 手动启动新版本（默认仍自动重启）。
        const forceRunAfter = process.env['AICO_UPDATE_NO_RELAUNCH'] !== '1';
        deps.updater.quitAndInstall(true, forceRunAfter);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  };
}
