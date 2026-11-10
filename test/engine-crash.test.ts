/**
 *  真·崩溃恢复测试：起子进程驱动到 executing → taskkill 强杀 → 重启恢复。
 * 断言：action_log 无重复副作用（effects 只 1 条、action 全 done、无 pending）、任务状态不回退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, 'fixtures', 'crash-driver.js');

interface RecoverReport {
  taskState: string | null;
  wiState: string | null;
  effects: string[];
  actions: Array<{ key: string; state: string }>;
  replayed: { executed: string[]; skipped: string[]; failed: unknown[] };
  interrupted: number;
  redispatched: number;
}

test('T0.3②: taskkill 强杀进程后重启 —— action_log 无重复副作用、状态不回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-crash-'));
  const dbFile = join(dir, 'aico.db');
  const effectsFile = join(dir, 'effects.log');
  const child = spawn(process.execPath, [driver, dbFile, effectsFile, 'crash'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // 等子进程报告 READY（已到 executing + 已派发 work item）
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`driver 未就绪，输出：${out}`)), 30_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', () => reject(new Error(`driver 提前退出：${out}`)));
    });

    const killed = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { encoding: 'utf8' });
    console.log('[T0.3②] taskkill:', `${killed.stdout ?? ''}${killed.stderr ?? ''}`.trim());
    // 等子进程退出：**必须有超时 + 兵底 SIGKILL**（taskkill 偶发失败/高负载下抖动时,
    // 旧写法 `await child.on('exit')` 会永不返回 → `node --test` 打完绿字却不退出）。失败**可见**（断言崩）。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('crash 子进程 5s 内未退出（taskkill 可能失败）；已补 SIGKILL'));
      }, 5_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // 重启恢复
    const rec = spawnSync(process.execPath, [driver, dbFile, effectsFile, 'recover'], { encoding: 'utf8' });
    assert.equal(rec.status, 0, `recover 子进程失败：${rec.stderr}`);
    const line = rec.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('REPORT '))
      .pop();
    assert.ok(line, `recover 未输出 REPORT：${rec.stdout}`);
    const report = JSON.parse(line.slice('REPORT '.length)) as RecoverReport;
    console.log('[T0.3②] recover:', JSON.stringify(report));

    // 副作用恰好一次、无重复；重启后无任何 pending 被重放（不会重复副作用）
    // 注：`plan_work_items` 由**引擎侧**处理（同 renew/spawn_work_item），不出现在 delegate executor 的 effects 文件里。
    assert.deepEqual(
      [...report.effects].sort(),
      [
        'dispatch:work_item:1:0',
        'dispatch_critic:task:1:0',
        'dispatch_planning:task:1:0',
      ],
      '三类 delegate 副作用各一次（notify_* 自 D4 起由引擎侧执行，不经 delegate）',
    );
    assert.equal(report.actions.length, 5, 'action_log 应为 5 条（C2 加 plan_work_items）');
    const planKey = report.actions.find((a) => a.key === 'plan_work_items:task:1:0');
    assert.equal(planKey?.state, 'done', 'plan_work_items 应已 done（幂等可重放）');
    assert.ok(
      report.actions.every((a) => a.state === 'done'),
      '所有动作应已 done，无 pending 待重放',
    );
    assert.deepEqual(report.replayed.executed, [], '重启恢复不得重放任何已完成动作');

    // 状态不回退：任务仍在 executing；running 件按先 interrupted 再自动重派为 queued
    assert.equal(report.taskState, 'executing');
    assert.equal(report.wiState, 'queued', 'BRK8：崩溃恢复自动重派（queued）');
    assert.equal(report.interrupted, 1);
    assert.equal(report.redispatched, 1, 'BRK8：重派计数如实');

    // effects 文件里没有任何重复行
    const lines = readFileSync(effectsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(new Set(lines).size, lines.length, 'effects 不得有重复键');
    assert.equal(existsSync(dbFile), true);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
