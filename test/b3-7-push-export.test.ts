/**
 * B3-7/D-31⑤：交付出口——git push P0 最小形态＋产物导出（md/html）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listRemotes, currentBranch, pushBranch, markdownToHtml, exportArtifact } from '../src/main/git/push-export.js';

function makeGitRepo(): { dir: string; bare: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'b3-7-repo-'));
  const bare = mkdtempSync(join(tmpdir(), 'b3-7-bare-'));
  const git = (args: string[], cwd?: string) =>
    execFileSync('git', args, { cwd: cwd ?? dir, encoding: 'utf8', timeout: 10_000 });
  execFileSync('git', ['init', '--bare'], { cwd: bare });
  git(['init', '-b', 'main']);
  writeFileSync(join(dir, 'readme.md'), 'init', 'utf8');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init', '--allow-empty']);
  git(['remote', 'add', 'origin', bare]);
  writeFileSync(join(dir, 'hello.txt'), 'hello', 'utf8');
  git(['add', 'hello.txt']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'add hello']);
  return { dir, bare, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); } };
}

test('B3-7: listRemotes——识别 origin；无 remote 返回空', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    const remotes = listRemotes(dir);
    assert.ok(remotes.some((r) => r.name === 'origin'), 'origin 在案');
    const noRemote = mkdtempSync(join(tmpdir(), 'b3-7-nr-'));
    execFileSync('git', ['init'], { cwd: noRemote });
    assert.equal(listRemotes(noRemote).length, 0);
    rmSync(noRemote, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test('B3-7: pushBranch——显式 push 成功（复用系统凭据）；坏 remote 人话失败', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    const branch = currentBranch(dir);
    const result = pushBranch(dir, 'origin', branch);
    assert.equal(result.ok, true, `push 应成功（实际：${result.output}）`);
    const bad = pushBranch(dir, 'no-such-remote', branch);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /不存在/);
    // MIMOSA-1：分支名以 - 开头会被 git 当选项（--all/--force 等价强推全部分支）——必须在进 argv 前拒。
    for (const evil of ['--all', '--force', '-f', 'main --force']) {
      const r = pushBranch(dir, 'origin', evil);
      assert.equal(r.ok, false, `非法分支名应拒：${evil}`);
      assert.match(r.output, /分支名不合法/);
    }
  } finally {
    cleanup();
  }
});

test('B3-7: markdownToHtml——标题/粗体/代码块四规则', () => {
  const html = markdownToHtml('# Title\n\n**bold** text\n\n```\ncode here\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<pre><code>/);
  assert.match(html, /code here/);
});

test('B3-7: exportArtifact——md 原样＋html 转换落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-7-exp-'));
  try {
    const src = join(dir, 'report.md');
    writeFileSync(src, '# Report\n\n**key** finding.', 'utf8');
    const outDir = join(dir, 'exports');
    const md = exportArtifact(src, outDir, 'md');
    assert.ok(md.ok);
    assert.equal(readFileSync(md.path, 'utf8'), '# Report\n\n**key** finding.');
    const html = exportArtifact(src, outDir, 'html');
    assert.ok(html.ok);
    const htmlContent = readFileSync(html.path, 'utf8');
    assert.match(htmlContent, /<h1>Report<\/h1>/);
    assert.match(htmlContent, /<strong>key<\/strong>/);
    const missing = exportArtifact(join(dir, 'nope.md'), outDir, 'md');
    assert.equal(missing.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
