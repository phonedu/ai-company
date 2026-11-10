/**
 * 只读命令快速通道（`readonly_command`）——放行档 strict 不再拦白名单只读命令。
 *
 * 背景（2026-10-26 包发现）：W1 写边界管的是**写**，但 strict 把 `ls/find/grep` 等只读命令
 * 也逐次拦 ⇒ 权限卡堆积、助手近乎不可用。修法（保守）：命令白名单＋保守解析＋路径圈在
 * 已授权根内，三者全过才走快速通道；任何一点不满足回落原有门禁。
 *
 * 判据（对抗性——宁可多问一次，不可错放一条）：
 * ① 白名单只读命令（含管道/分号串联）→ allow（rule=readonly_command）；
 * ② 重定向 / 命令替换 / 反引号 / 后台 / 非白名单首词 / 带路径的可执行 → 不走快速通道（ask/deny）；
 * ③ find 破坏性参数（-delete/-exec/-ok/-fprint*）→ 不走快速通道；
 * ④ 路径参数越出项目根/工作目录（含 ~、.. 穿越、绝对路径在外）→ 不走快速通道；
 * ⑤ 黑名单/预检（deny）与 consent 规则（ask）仍优先于快速通道；
 * ⑥ sandbox 能力档仍拒绝一切 command（第①层，先于快速通道）；写工具不受影响（strict 仍 ask）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { permissionGate, type GateContext } from '../src/main/permission/index.js';

const strict: GateContext = {
  capabilityTier: 'standard',
  autonomy: 'strict',
  riskLevel: 1,
  projectRoot: 'D:/repo',
  cwd: 'D:/repo',
};

const run = (command: string, ctx: GateContext = strict) =>
  permissionGate({ name: 'bash', args: { command } }, ctx);

test('F19 ①：白名单只读命令放行（含管道/串联/参数）', () => {
  for (const command of [
    'ls',
    'ls -la',
    'cat a.txt',
    'grep -n foo bar.txt',
    'ls | grep x',
    'find . -name "*.ts"',
    'head -n 5 f.txt; tail -n 3 f.txt',
    'rg pattern src',
    'wc -l out/a.txt',
    'pwd',
    'dir',
    'echo hello',
    'stat f.bin',
  ]) {
    const r = run(command);
    assert.equal(r.decision, 'allow', `应放行：${command}（实际 ${r.decision}/${r.reason}）`);
    assert.equal(r.rule, 'readonly_command', `应走只读快速通道：${command}`);
  }
});

test('F19 ②：重定向/替换/后台/非白名单/带路径可执行 → 不走快速通道', () => {
  for (const command of [
    'cat a > b',
    'ls >> out.txt',
    'echo $(cat s)',
    'grep x `cat list`',
    'ls & notepad',
    'ls; rm -rf /tmp/x',
    'echo hi && notepad x',
    '/bin/sh -c ls',
    'C:\\Windows\\System32\\whoami.exe',
    'python -c "print(1)"',
    'node -e "1"',
  ]) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}`);
  }
});

test('F19 ③：find 破坏性参数 → 不走快速通道', () => {
  for (const command of ['find . -delete', 'find . -exec rm {} \\;', 'find . -okdir cmd {} ;', 'find . -fprint /tmp/x', 'find . -fprintf out.txt %p']) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}`);
  }
});

test('F19 ④：路径越出授权根（~/../绝对路径）→ 不走快速通道', () => {
  for (const command of [
    'cat ../../outside.txt',
    'cat ~/secret.txt',
    'grep x D:/other/file.txt',
    'ls C:\\Windows',
    'find .. -name x',
  ]) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}`);
  }
});

test('F19 ⑤：预检 deny 优先于快速通道（rm -rf 根目录）', () => {
  const r = run('ls; rm -rf /');
  assert.equal(r.decision, 'deny');
  assert.notEqual(r.rule, 'readonly_command');
});

test('F19 ⑥：sandbox 档仍拒绝 command；strict 写工具仍 ask（快速通道不改写边界）', () => {
  const sandbox: GateContext = { ...strict, capabilityTier: 'sandbox' };
  assert.equal(run('ls', sandbox).decision, 'deny', 'sandbox 第①层先拒');
  const w = permissionGate({ name: 'write', args: { path: 'D:/repo/a.txt', content: 'x' } }, strict);
  assert.equal(w.decision, 'ask', 'strict 写仍需批准（不受只读快速通道影响）');
});

test('F19 ⑦：快速通道在授权根内接受绝对路径', () => {
  const r = run('cat D:/repo/src/a.ts');
  assert.equal(r.decision, 'allow');
  assert.equal(r.rule, 'readonly_command');
});

test('F19 ⑧：选项参数通道堵死——rg --pre / fd -x / --file= / $VAR / ~user 不得放行', () => {
  for (const command of [
    'rg --pre=sh x',
    'rg --pre-command="sh -c x" x',
    'fd -x rm',
    'fd -X rm {}',
    'fd --exec rm',
    'grep --file=/etc/passwd x',
    'cat $HOME/x',
    'cat $HOME/.ssh/id_rsa',
    'cat ~dev/x',
    'ls --color=auto',
  ]) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}（实际 ${r.decision}/${r.reason}）`);
  }
});

test('F19 ⑨：短选项附加值/旗标白名单外的形态不得放行（正向白名单）', () => {
  for (const command of [
    'fd -xrm .',
    'fd -Xrm .',
    'rg -f/etc/passwd x',
    'grep -f/etc/passwd x',
    'grep "-f/etc/passwd" x',
    'file -f/etc/passwd',
    'tree -o out.txt',
    'tree -ofile',
    'head -n5 f.txt',
    'ls --sort=time',
    'cat --number=nonempty f',
    'grep -R x .',
    'rg -L x src',
    'ls -L',
  ]) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}（实际 ${r.decision}/${r.reason}）`);
  }
});

test('F19 ⑩：白名单内旗标（含捆绑/长旗标/find 原语/--）仍放行', () => {
  for (const command of ['ls -la', 'ls -lah', 'grep -in foo bar.txt', 'rg -i pattern src', 'head -n 5 f.txt', 'find . -name "*.ts" -maxdepth 2', 'cat -- file.txt', 'tail -f log.txt', 'wc -l out/a.txt', 'du -sh .', 'tree -a -d', 'stat f.bin']) {
    const r = run(command);
    assert.equal(r.rule, 'readonly_command', `应走快速通道：${command}（实际 ${r.decision}/${r.reason}）`);
    assert.equal(r.decision, 'allow', `应放行：${command}`);
  }
});

test('F19 ⑪：cd 链式只读（cd 项目根 && ls）放行；后台/引号藏结构符/越根 cd 仍拦', () => {
  const allow = [
    'cd "D:/repo" && ls -la',
    'cd . && ls',
    'cd D:/repo/src && rg -i pattern .',
  ];
  for (const command of allow) {
    const r = run(command);
    assert.equal(r.rule, 'readonly_command', `应走快速通道：${command}（实际 ${r.decision}/${r.reason}）`);
    assert.equal(r.decision, 'allow', `应放行：${command}`);
  }
  for (const command of [
    'ls & cmd', // 单 & 后台
    'cd / && ls', // 越根 cd
    'cd .. && ls', // 穿越
    'ls "a && rm -rf /"', // 引号内藏 &&（token 含 &）
    'cat "x;rm" y', // 引号内藏分号
  ]) {
    const r = run(command);
    assert.notEqual(r.rule, 'readonly_command', `不得走快速通道：${command}`);
    assert.notEqual(r.decision, 'allow', `不得放行：${command}（实际 ${r.decision}/${r.reason}）`);
  }
});
