/**
 *  诊断专用：**假更新器**（仅开发版 + `AICO_UPDATE_FAKE=1` 时启用）。
 *
 * 用途：自动化冒烟验证「发现新版本 → 老板点下载 → 下载完成 → 重启安装」的 UI/IPC 链路，
 * 不联网、不影响打包版（`initAutoUpdate` 里用 `!app.isPackaged` 双重守卫）。
 */
import type { UpdaterLike } from './update.js';

export function createFakeUpdater(version = '9.9.9'): UpdaterLike {
  const handlers = new Map<string, (arg?: unknown) => void>();
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(event: string, listener: (arg?: unknown) => void): unknown {
      handlers.set(event, listener);
      return this;
    },
    async checkForUpdates(): Promise<unknown> {
      setTimeout(() => handlers.get('update-available')?.({ version }), 60);
      return {};
    },
    async downloadUpdate(): Promise<unknown> {
      setTimeout(() => handlers.get('download-progress')?.({ percent: 42 }), 60);
      setTimeout(() => handlers.get('update-downloaded')?.({ version }), 160);
      return {};
    },
    quitAndInstall(): void {
      /* 冒烟不真装 */
    },
  };
}
