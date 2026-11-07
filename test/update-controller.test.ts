/**
 * 自动更新控制器（2026-11-06）：状态机/禁用边界/错误如实上报。
 * 不装 electron-updater 也能测——控制器只依赖注入的 UpdaterLike。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdateController, type UpdaterLike, type UpdateStatus } from '../src/main/update.js';

class FakeUpdater implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  handlers = new Map<string, (arg?: unknown) => void>();
  checkCalls = 0;
  downloadCalls = 0;
  quitCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  checkImpl: () => Promise<unknown> = async () => ({});
  on(event: string, listener: (arg?: unknown) => void): unknown {
    this.handlers.set(event, listener);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    this.handlers.get(event)?.(arg);
  }
  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    return this.checkImpl();
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    return {};
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitCalls.push([isSilent, isForceRunAfter]);
  }
}

test('自动更新：开发版/免安装版禁用——不检查、不假报「已是最新」、install 不可用', async () => {
  const updater = new FakeUpdater();
  const seen: UpdateStatus[] = [];
  const c = createUpdateController({
    updater,
    currentVersion: '0.1.0',
    enabled: false,
    disabledReason: '免安装版请手动下载新版本',
    onStatus: (s) => seen.push(s),
  });
  assert.equal(c.getStatus().phase, 'disabled');
  assert.equal(c.getStatus().canCheck, false);
  await c.check();
  assert.equal(updater.checkCalls, 0, '禁用时不得触网');
  assert.equal(c.getStatus().message, '免安装版请手动下载新版本');
  assert.equal(c.install().ok, false);
  assert.equal(updater.quitCalls.length, 0);
  assert.equal(seen.length, 0, '禁用态不推状态（避免 UI 假动）');
});

test('自动更新：check → available → downloading → downloaded；install 只在 downloaded 生效', async () => {
  const updater = new FakeUpdater();
  const gate: { resolve?: () => void } = {};
  updater.checkImpl = () => new Promise<void>((res) => { gate.resolve = res; });
  const c = createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });

  const pending = c.check();
  assert.equal(c.getStatus().phase, 'checking');
  assert.equal(c.getStatus().canCheck, false);
  assert.equal(c.install().ok, false, '检查中不可安装');

  updater.emit('update-available', { version: '0.2.0' });
  assert.equal(c.getStatus().phase, 'available');
  assert.equal(c.getStatus().availableVersion, '0.2.0');
  assert.match(c.getStatus().message, /0\.2\.0/);

  updater.emit('download-progress', { percent: 41.7 });
  assert.equal(c.getStatus().phase, 'downloading');
  assert.equal(c.getStatus().percent, 42);
  assert.match(c.getStatus().message, /42%/);

  updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(c.getStatus().phase, 'downloaded');
  assert.equal(c.getStatus().canInstall, true);
  assert.equal(c.install().ok, true);
  assert.deepEqual(updater.quitCalls, [[true, true]], '自动更新应静默安装（不弹安装器 UI）');

  gate.resolve?.();
  await pending;
  assert.equal(c.getStatus().phase, 'downloaded', 'check resolve 不得覆盖已下载状态');
});

test('自动更新：已是最新 / 错误如实上报（不伪装成功）', async () => {
  const updater = new FakeUpdater();
  const c = createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });

  updater.emit('update-not-available', {});
  assert.equal(c.getStatus().phase, 'up-to-date');
  assert.match(c.getStatus().message, /已是最新版本（v0\.1\.0）/);
  assert.equal(c.getStatus().canCheck, true);

  updater.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'));
  assert.equal(c.getStatus().phase, 'error');
  assert.match(c.getStatus().message, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(c.getStatus().canInstall, false);
});

test('自动更新：check 期间重复点击不重复发请求；Promise reject 也落 error（不静默）', async () => {
  const updater = new FakeUpdater();
  const gate: { reject?: (e: Error) => void } = {};
  updater.checkImpl = () => new Promise((_res, rej) => { gate.reject = rej; });
  const c = createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });

  const first = c.check();
  const second = c.check();
  assert.equal(updater.checkCalls, 1, 'checking 中不得重复触网');
  gate.reject?.(new Error('404 latest.yml'));
  await Promise.all([first, second]);
  assert.equal(c.getStatus().phase, 'error');
  assert.match(c.getStatus().message, /404 latest\.yml/);
  assert.equal(c.getStatus().canCheck, true);
});

test('B0-9：autoDownload/autoInstallOnAppQuit 必须关闭——下载与安装都由老板点（不静默 RCE 面）', () => {
  const updater = new FakeUpdater();
  createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });
  assert.equal(updater.autoDownload, false, '发现新版本不得自动下载（签名缺失前的硬要求）');
  assert.equal(updater.autoInstallOnAppQuit, false, '退出时不得自动安装（必须点「重启安装」）');
});

test('B0-9：available → 老板点「下载更新」才 downloadUpdate；未检查/未发现时拒绝', async () => {
  const updater = new FakeUpdater();
  const c = createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });
  assert.equal((await c.download()).ok, false, 'idle 时不得下载');
  assert.equal(updater.downloadCalls, 0);
  await c.check();
  updater.emit('update-available', { version: '0.1.2' });
  assert.equal(c.getStatus().phase, 'available');
  assert.equal(c.getStatus().canDownload, true);
  const r = await c.download();
  assert.equal(r.ok, true);
  assert.equal(updater.downloadCalls, 1, '确认后只下载一次');
  assert.equal(c.getStatus().phase, 'downloading');
  updater.emit('update-downloaded', { version: '0.1.2' });
  assert.equal(c.getStatus().canInstall, true, '下载完成才出现「重启安装」');
});

test('自动更新：AICO_UPDATE_NO_RELAUNCH=1 时安装后不强制重启（冒烟隔离用）', () => {
  const updater = new FakeUpdater();
  const c = createUpdateController({ updater, currentVersion: '0.1.0', enabled: true });
  updater.emit('update-downloaded', { version: '0.1.1' });
  const previous = process.env.AICO_UPDATE_NO_RELAUNCH;
  process.env.AICO_UPDATE_NO_RELAUNCH = '1';
  try {
    assert.equal(c.install().ok, true);
    assert.deepEqual(updater.quitCalls, [[true, false]], '测试开关下静默安装且不强制拉起应用');
  } finally {
    if (previous == null) delete process.env.AICO_UPDATE_NO_RELAUNCH;
    else process.env.AICO_UPDATE_NO_RELAUNCH = previous;
  }
});
