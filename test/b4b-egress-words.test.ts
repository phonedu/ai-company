/**
 * 存量安全债（B4b 安全审查 F3，2026-11-09 老板批「其他的那就补上」）：
 * bash **外发词表**此前只认 curl/wget/git push 等命令行工具，`node -e "fetch(...)"`、
 * `python -c "requests.post(...)"`、PowerShell 的 .NET 客户端、certutil、bitsadmin、nc、/dev/tcp
 * 全部零弹卡（配了 Key 就能绕开 spend 闸直接外发/花钱）。
 *
 * 样本放 `test/fixtures/egress-samples.json`（数据与逻辑分离）：这里只做字符串匹配判定，
 * **样本从不执行**（本文件无 spawn/exec/shell）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { detectEgressCommand, permissionGate } from '../src/main/permission/gate.js';

interface Sample {
  cmd: string;
  expected: string | null;
}
const { samples } = JSON.parse(readFileSync('test/fixtures/egress-samples.json', 'utf8')) as { samples: Sample[] };

test('安全 F3：外发词表覆盖脚本语言/系统工具（含防误伤对照）', () => {
  assert.ok(samples.length >= 10, '样本要够（含 ffmpeg/ls 两条不误伤的对照）');
  for (const { cmd, expected } of samples) {
    assert.equal(detectEgressCommand(cmd), expected, cmd);
  }
});

test('安全 F3：闸门层 standard 档下这些命令一律 ask（不只靠词表函数）', () => {
  const base = { capabilityTier: 'standard' as const, autonomy: 'standard' as const, riskLevel: 0, projectRoot: 'D:/repo' };
  const mustAsk = samples.filter((s) => s.expected != null);
  assert.ok(mustAsk.length >= 9);
  for (const { cmd } of mustAsk) {
    const r = permissionGate({ name: 'bash', args: { command: cmd } }, base);
    assert.equal(r.decision, 'ask', `${cmd} → 应 ask（实际 ${r.decision}/${r.rule ?? '-'}）`);
  }
});

test('安全 F3：非外发命令不被误伤（ffmpeg/ls 仍放行）', () => {
  const base = { capabilityTier: 'standard' as const, autonomy: 'standard' as const, riskLevel: 0, projectRoot: 'D:/repo' };
  for (const { cmd, expected } of samples.filter((s) => s.expected == null)) {
    const r = permissionGate({ name: 'bash', args: { command: cmd } }, base);
    assert.notEqual(r.decision, 'ask', `${cmd} 不该被外发词表拦（实际 ${r.decision}/${r.rule ?? '-'}）`);
  }
});
