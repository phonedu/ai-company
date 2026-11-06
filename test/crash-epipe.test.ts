/**
 * D5 复核崩溃修复（2026-10-26）：标准流 EPIPE 不再致命。
 *
 * 事故（crash-2026-10-26T11-17-08-608Z.log）：应用由外部进程以管道接管 stderr 启动，外部进程被
 * 回收后管道断端；一次 IPC 错误触发 Electron `replyWithError` 的 `console.error` → EPIPE →
 * uncaughtException → 整个应用退出（把一个可恢复的错误升级成崩溃）。
 *
 * 判据：装上 `installMainProcessCrashHandlers` 的子进程往**已断的** stdout/stderr 持续写，
 * 应存活并正常退出 0（护栏只吞 EPIPE；真实未捕获异常仍走落盘→提示→退出）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('EPIPE 护栏：断管上的 console.log/error 不再杀进程（真实异常路径不受影响）', async () => {
  const crashModule = join(process.cwd(), 'dist', 'src', 'main', 'crash.js');
  // 与实机同强度：大块写入＋持续间隔（小写入会被缓冲，断管错误不触发——首轮夹具假绿）
  const script = `
    const { installMainProcessCrashHandlers } = require(${JSON.stringify(crashModule)});
    installMainProcessCrashHandlers({
      logDir: ${JSON.stringify(tmpdir())},
      notify: () => {},
      fatalExit: () => process.exit(1),
    });
    const big = 'x'.repeat(1024 * 1024);
    let n = 0;
    const t = setInterval(() => {
      for (let i = 0; i < 10; i += 1) { console.log(big); console.error(big); n += 1; }
      if (n > 200) {
        clearInterval(t);
        setTimeout(() => process.exit(0), 300);
      }
    }, 20);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  child.stderr.destroy();
  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (c) => resolve(c));
    child.on('error', () => resolve(-1));
    setTimeout(() => resolve(-2), 20_000);
  });
  assert.equal(code, 0, `子进程应存活退出 0（实际 ${code}）——断管写不应升级为未捕获异常`);
});
