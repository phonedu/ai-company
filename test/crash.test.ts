import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatCrashLog, runCleanupSafely, writeCrashLog, type CrashEnv } from '../src/main/crash.js';

// ─────────── 崩溃兜底 + 崩溃日志（纯 Node 可测：不依赖 electron/DB）───────────

const ENV: CrashEnv = {
  appVersion: '0.0.1',
  electron: '44.7.0',
  chrome: '142',
  node: '22.20.0',
  platform: 'win32',
  arch: 'x64',
  osVersion: '10.0.19044',
};

test('crash: formatCrashLog 含 版本/时间/平台/栈 + 崩溃前最后在做什么', () => {
  const text = formatCrashLog(
    'uncaughtException',
    new Error('boom'),
    { lastActivity: ['task_events #41 tool_call', 'action_log #7 done'] },
    ENV,
    '2026-01-01T00:00:00.000Z',
  );
  for (const key of [
    '# ai-company crash log',
    'time: 2026-01-01T00:00:00.000Z',
    'reason: uncaughtException',
    'appVersion: 0.0.1',
    'electron: 44.7.0',
    'node: 22.20.0',
    'platform: win32 x64 10.0.19044',
    'error: Error: boom',
    'recent activity:',
    'task_events #41 tool_call',
  ]) {
    assert.ok(text.includes(key), `崩溃日志缺少：${key}`);
  }
  // 无 lastActivity → 不出现该段
  assert.ok(!formatCrashLog('r', new Error('e'), {}, ENV, '2026-01-01T00:00:00.000Z').includes('recent activity:'));
  // 非 Error 值也能格式化
  assert.ok(formatCrashLog('r', 'just a string', {}, ENV, '2026-01-01T00:00:00.000Z').includes('just a string'));
});

test('crash: writeCrashLog 落盘到注入目录（文件名 crash-<ts>.log）且非法目录不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-crash-'));
  const file = writeCrashLog('unhandledRejection', new Error('nope'), { lastActivity: ['x'] }, {
    dir,
    env: ENV,
    nowIso: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(file, '应写出文件');
  assert.ok(file!.endsWith(join('crash-2026-01-01T00-00-00-000Z.log')), `文件名异常：${file}`);
  const content = readFileSync(file!, 'utf8');
  assert.ok(content.includes('reason: unhandledRejection'));
  assert.ok(content.includes('Error: nope'));
  assert.equal(readdirSync(dir).length, 1);

  // 非法目录：返回 null、绝不抛
  assert.equal(writeCrashLog('x', new Error('y'), {}, { dir: '\0bad\0' }), null);
});

test('crash: runCleanupSafely 任一步抛不打断后续、且必留痕（不静默）', () => {
  const ran: string[] = [];
  const logs: Array<{ message: string; error: unknown }> = [];
  runCleanupSafely(
    [
      {
        name: 'engine.stop',
        run: () => {
          throw new Error('boom-stop');
        },
      },
      { name: 'evtSink.dispose', run: () => ran.push('dispose') },
    ],
    (message, error) => logs.push({ message, error }),
  );
  assert.deepEqual(ran, ['dispose'], '前一步抛后，后续步骤仍应执行（退出序列不被打断）');
  assert.equal(logs.length, 1, '清理失败必须留痕');
  assert.ok(logs[0].message.includes('engine.stop'), `留痕应含步骤名：${logs[0].message}`);
});
