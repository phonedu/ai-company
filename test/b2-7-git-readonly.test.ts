/**
 * B2-7（58 §2.5 G6；D-30）：员工 bash git 只读白名单——提交收口归宿主。
 *
 * 旧实现：`git commit` 不在外发族（B0-9 只拦 push/remote）、不在黑名单（默认空）、
 * 不在只读快速通道（readonly-bash 明确「git 不入」）⇒ 员工 standard 档 `git commit`
 * 自动放行，与宿主 auto_commit 双提交并存（58 §2.4 坐实）。
 *
 * 新口径：
 *  - **员工会话**（`GateContext.employeeSession = true`）的 bash 命令含 **git 写子命令**
 *    （commit/push/pull/checkout/reset/rebase/merge/tag/…）→ **deny**（人话提示「提交由
 *    宿主在验收后统一完成」；deny 不可被 grant 翻案——一刀切，不做员工级开关）；
 *  - **只读 git 照常**（status/log/diff/show/branch 裸/读旗标/remote -v/config --get/
 *    stash list/worktree list…不走 deny，回落既有门禁：standard 放行、strict 照旧 ask）；
 *  - 频道助手（employeeId=0）**不在本件范围**（W1 口径不变，push 仍走 egress ask）。
 *
 * 放行/拦截面都覆盖真实形态（L55 教训）：`git -C <path>` 全局旗标、`&&` 链、
 * `bash -c` 包裹、`--grep=merge` 这类**旗标含写词**的读命令不得误伤。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectGitWriteCommand,
  permissionGate,
  type GateContext,
} from '../src/main/permission/index.js';

const base: GateContext = {
  capabilityTier: 'standard',
  autonomy: 'standard',
  riskLevel: 1,
  projectRoot: 'D:/repo',
  cwd: 'D:/repo',
};

const bash = (command: string, ctx: Partial<GateContext> = {}) =>
  permissionGate({ name: 'bash', args: { command } }, { ...base, ...ctx });

const employee = (ctx: Partial<GateContext> = {}): Partial<GateContext> => ({ employeeSession: true, ...ctx });

// ── ① 纯函数：git 写子命令识别 ────────────────────────────────────────────

test('B2-7：git 写子命令识别（无条件写族）', () => {
  assert.equal(detectGitWriteCommand('git commit -m "fix: x"'), 'git commit');
  assert.equal(detectGitWriteCommand('git commit'), 'git commit');
  assert.equal(detectGitWriteCommand('git push origin main'), 'git push');
  assert.equal(detectGitWriteCommand('git pull'), 'git pull');
  assert.equal(detectGitWriteCommand('git checkout -b feat/x'), 'git checkout');
  assert.equal(detectGitWriteCommand('git checkout main'), 'git checkout');
  assert.equal(detectGitWriteCommand('git switch -c feat/x'), 'git switch');
  assert.equal(detectGitWriteCommand('git restore src/a.ts'), 'git restore');
  assert.equal(detectGitWriteCommand('git reset --hard HEAD~1'), 'git reset');
  assert.equal(detectGitWriteCommand('git rebase main'), 'git rebase');
  assert.equal(detectGitWriteCommand('git merge main'), 'git merge');
  assert.equal(detectGitWriteCommand('git cherry-pick abc1234'), 'git cherry-pick');
  assert.equal(detectGitWriteCommand('git revert HEAD'), 'git revert');
  assert.equal(detectGitWriteCommand('git clean -fd'), 'git clean');
  assert.equal(detectGitWriteCommand('git apply patch.diff'), 'git apply');
  assert.equal(detectGitWriteCommand('git fetch origin'), 'git fetch');
  assert.equal(detectGitWriteCommand('git rm --cached x.log'), 'git rm');
  assert.equal(detectGitWriteCommand('git mv a.ts b.ts'), 'git mv');
});

test('B2-7：条件写子命令（branch/remote/tag/stash/config/worktree 按参数区分读写）', () => {
  // 写形态
  assert.equal(detectGitWriteCommand('git branch feat/x'), 'git branch');
  assert.equal(detectGitWriteCommand('git branch -d feat/x'), 'git branch');
  assert.equal(detectGitWriteCommand('git branch -D feat/x'), 'git branch');
  assert.equal(detectGitWriteCommand('git branch -m old new'), 'git branch');
  assert.equal(detectGitWriteCommand('git remote add origin https://x'), 'git remote');
  assert.equal(detectGitWriteCommand('git remote set-url origin https://y'), 'git remote');
  assert.equal(detectGitWriteCommand('git remote remove origin'), 'git remote');
  assert.equal(detectGitWriteCommand('git tag v1.0.0'), 'git tag');
  assert.equal(detectGitWriteCommand('git tag -d v1.0.0'), 'git tag');
  assert.equal(detectGitWriteCommand('git stash'), 'git stash');
  assert.equal(detectGitWriteCommand('git stash pop'), 'git stash');
  assert.equal(detectGitWriteCommand('git stash drop'), 'git stash');
  assert.equal(detectGitWriteCommand('git config user.name "A B"'), 'git config');
  assert.equal(detectGitWriteCommand('git worktree add ../out x'), 'git worktree');
  assert.equal(detectGitWriteCommand('git worktree remove ../out'), 'git worktree');
  // 读形态 → null（回落既有门禁，不得误伤）
  assert.equal(detectGitWriteCommand('git branch'), null);
  assert.equal(detectGitWriteCommand('git branch -a -v'), null);
  assert.equal(detectGitWriteCommand('git remote'), null);
  assert.equal(detectGitWriteCommand('git remote -v'), null);
  assert.equal(detectGitWriteCommand('git tag'), null);
  assert.equal(detectGitWriteCommand('git stash list'), null);
  assert.equal(detectGitWriteCommand('git config --get user.name'), null);
  assert.equal(detectGitWriteCommand('git config --list'), null);
  assert.equal(detectGitWriteCommand('git worktree list'), null);
});

test('B2-7：读命令不得误伤（含旗标携带写词的真实形态）', () => {
  assert.equal(detectGitWriteCommand('git status'), null);
  assert.equal(detectGitWriteCommand('git status --short'), null);
  assert.equal(detectGitWriteCommand('git log --oneline -5'), null);
  assert.equal(detectGitWriteCommand('git log --grep=merge --oneline'), null);
  assert.equal(detectGitWriteCommand('git diff HEAD~1'), null);
  assert.equal(detectGitWriteCommand('git show abc1234'), null);
  assert.equal(detectGitWriteCommand('git rev-parse HEAD'), null);
  assert.equal(detectGitWriteCommand('git ls-files'), null);
  assert.equal(detectGitWriteCommand('git blame src/main/index.ts'), null);
  assert.equal(detectGitWriteCommand('git grep TODO'), null);
  assert.equal(detectGitWriteCommand('git -C sub log --oneline'), null);
  assert.equal(detectGitWriteCommand('pnpm test'), null);
  assert.equal(detectGitWriteCommand('npm run build'), null);
});

test('B2-7：链式与包裹形态（&& 链 / bash -c / 前置全局旗标）', () => {
  assert.equal(detectGitWriteCommand('git add -A && git commit -m x'), 'git commit');
  assert.equal(detectGitWriteCommand('pnpm test || git commit -m "wip"'), 'git commit');
  assert.equal(detectGitWriteCommand('bash -c "git commit -m x"'), 'git commit');
  assert.equal(detectGitWriteCommand('git -C ../repo commit -m x'), 'git commit');
  assert.equal(detectGitWriteCommand('git -c core.hooksPath=/dev/null commit -m x'), 'git commit');
});

test('B2-7/D4：绕过面收紧——引号 bin / env·xargs 包裹 / 命令替换内层', () => {
  // D4 P2-1：bin 名剥引号（此前 `"git" commit` 绕过）
  assert.equal(detectGitWriteCommand('"git" commit -m x'), 'git commit');
  assert.equal(detectGitWriteCommand("'git' commit -m x"), 'git commit');
  // D4 P2-2：包裹型 bin 剥壳递归（此前 `env git commit` / `xargs git commit` 绕过）
  assert.equal(detectGitWriteCommand('env git commit -m x'), 'git commit');
  assert.equal(detectGitWriteCommand('env VAR=1 git push origin main'), 'git push');
  assert.equal(detectGitWriteCommand('nohup git commit -m x'), 'git commit');
  assert.equal(detectGitWriteCommand('xargs git commit'), 'git commit');
  assert.equal(detectGitWriteCommand('xargs ls'), null, '非 git 包裹不误伤');
  // D4 P3-1 收紧：命令替换内层同检（`echo $(git commit -m x)` 此前绕过）
  assert.equal(detectGitWriteCommand('echo $(git commit -m x)'), 'git commit');
  assert.equal(detectGitWriteCommand('echo "版本 $(git describe)"'), null, '读替换不误伤');
});

// ── ② permissionGate 集成：员工会话 deny ─────────────────────────────────

test('B2-7：员工会话 git 写操作一律 deny（人话提示，任何放行档不可翻案）', () => {
  for (const autonomy of ['strict', 'standard', 'loose'] as const) {
    const res = bash('git commit -m "fix: x"', employee({ autonomy }));
    assert.equal(res.decision, 'deny', `autonomy=${autonomy} 时 git commit 必须 deny`);
    assert.equal(res.rule, 'git_write_deny');
    assert.ok(res.reason.includes('宿主'), `提示要说清「提交归宿主」，实际：${res.reason}`);
  }
  // push 对员工是 deny（强于 egress ask）；链式提交同样 deny。
  assert.equal(bash('git push origin main', employee()).decision, 'deny');
  assert.equal(bash('git add -A && git commit -m x', employee()).decision, 'deny');
  assert.equal(bash('bash -c "git commit -m x"', employee()).decision, 'deny');
});

test('B2-7：员工会话只读 git 照常（standard 放行、strict 照旧 ask，不走 git deny）', () => {
  for (const cmd of ['git status', 'git log --oneline -5', 'git diff HEAD~1', 'git branch -a', 'git remote -v', 'git show HEAD']) {
    const res = bash(cmd, employee());
    assert.equal(res.decision, 'allow', `${cmd} 在 standard 档应照常放行，实际：${res.decision}（${res.reason}）`);
  }
  const strict = bash('git status', employee({ autonomy: 'strict' }));
  assert.equal(strict.decision, 'ask', 'strict 档读命令行为不变（仍 ask）');
});

test('B2-7：deny 不可被 grant 翻案（一刀切，无员工级开关）', () => {
  const granted: GateContext = {
    ...base,
    employeeSession: true,
    policy: { grants: [{ rule: 'git_write_deny', toolName: 'bash', grantedAt: 1 }] } as GateContext['policy'],
  };
  assert.equal(bash('git commit -m x', granted).decision, 'deny');
});

test('B2-7/D4 P1-a：precheck grant 不得短路 git_write_deny（绝对 deny 先于可翻案检查）', () => {
  // precheck 的 ask 规则获批后直接 allow 会跳过后续检查——git 写检查必须在其之前。
  const precheckGranted: GateContext = {
    ...base,
    employeeSession: true,
    policy: {
      grants: [{ rule: 'command_precheck:env_file', toolName: 'bash', grantedAt: 1 }],
    } as GateContext['policy'],
  };
  const res = bash('cat .env && git commit -m bypass', precheckGranted);
  assert.equal(res.decision, 'deny', `precheck grant 存在时 git 写仍必须 deny，实际：${JSON.stringify(res)}`);
  assert.equal(res.rule, 'git_write_deny');
});

test('B2-7：非员工会话（频道助手/引擎）不受本件影响（W1 口径不变）', () => {
  // employeeSession 未设置（频道助手/引擎动作）→ 不走 git_write_deny（回落既有门禁）。
  const assistantCommit = bash('git commit -m x');
  assert.notEqual(assistantCommit.rule, 'git_write_deny');
  // push 仍走 B0-9 的 egress ask（B2-7 不改变助手面）。
  assert.equal(bash('git push origin main').rule, 'consent:egress');
});

// ── ③ 员工纪律层：提示词明说「不自行提交」 ────────────────────────────────

test('B2-7：交付纪律层写明「不自行 git 提交/推送，宿主统一收口」', async () => {
  const { DELIVERY_DISCIPLINE_LAYER } = await import('../src/main/agent/context.js');
  assert.ok(DELIVERY_DISCIPLINE_LAYER.includes('不自行'), '纪律层应禁止员工自行提交');
  assert.ok(DELIVERY_DISCIPLINE_LAYER.includes('git'), '纪律层应提及 git');
  assert.ok(DELIVERY_DISCIPLINE_LAYER.includes('宿主'), '纪律层应说明提交归宿主收口');
});
