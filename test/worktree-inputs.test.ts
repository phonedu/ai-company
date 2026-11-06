/**
 * UG-04b · staging worktree 输入镜像。
 *
 * 判据：
 *  - 项目根 `inputs/<短号>/` 复制到 worktree 同相对路径（含子目录/多文件）；
 *  - worktree 的 `.git/info/exclude` 含 `inputs/`（不被自动提交）；
 *  - 清理只删 worktree 镜像，项目根原件保留；
 *  - 无输入附件 → skipped（不报错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupMirroredInputs,
  mirrorTaskInputs,
  taskInputsRelative,
} from '../src/main/engine/workspace-inputs.js';

function setup(): { base: string; project: string; worktree: string; exclude: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aico-ws-inputs-'));
  const project = join(base, 'project');
  const worktree = join(base, 'worktree');
  const exclude = join(worktree, '.git', 'info', 'exclude');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(worktree, '.git', 'info'), { recursive: true });
  writeFileSync(exclude, '# existing\nnode_modules/\n', 'utf8');
  return { base, project, worktree, exclude, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const git = (exclude: string) => ({
  run: (args: string[]) =>
    args[0] === 'rev-parse' && args[1] === '--git-path'
      ? { status: 0, stdout: exclude, stderr: '' }
      : { status: 1, stdout: '', stderr: 'unexpected' },
});

test('UG-04b：镜像 inputs 到 worktree，并写 exclude；清理只删镜像', () => {
  const f = setup();
  try {
    const shortId = 'T-1042';
    const src = join(f.project, 'inputs', shortId);
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, '1-a.txt'), 'a', 'utf8');
    writeFileSync(join(src, 'sub', '2-b.txt'), 'b', 'utf8');

    const result = mirrorTaskInputs({
      projectRoot: f.project,
      worktreePath: f.worktree,
      shortId,
      git: git(f.exclude) as never,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.copied, 2);
    assert.deepEqual(result.warnings, []);
    assert.equal(readFileSync(join(f.worktree, 'inputs', shortId, '1-a.txt'), 'utf8'), 'a');
    assert.equal(readFileSync(join(f.worktree, 'inputs', shortId, 'sub', '2-b.txt'), 'utf8'), 'b');
    const exclude = readFileSync(f.exclude, 'utf8');
    assert.match(exclude, /inputs\//);
    assert.match(exclude, /existing/);

    const cleaned = cleanupMirroredInputs(f.worktree, shortId);
    assert.deepEqual(cleaned, { removed: true });
    assert.equal(existsSync(join(f.worktree, 'inputs', shortId)), false, 'worktree 镜像应删除');
    assert.equal(existsSync(join(f.project, 'inputs', shortId, '1-a.txt')), true, '项目根原件保留');
  } finally {
    f.cleanup();
  }
});

test('UG-04b：无输入附件 → skipped；相对路径做短号白名单', () => {
  const f = setup();
  try {
    const result = mirrorTaskInputs({
      projectRoot: f.project,
      worktreePath: f.worktree,
      shortId: 'T-1042',
      git: git(f.exclude) as never,
    });
    assert.deepEqual(result, { skipped: true, copied: 0, warnings: [] });
    assert.equal(taskInputsRelative('../evil'), 'inputs/.._evil');
  } finally {
    f.cleanup();
  }
});
