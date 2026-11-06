/**
 * UG-04b · staging 工作区的任务输入镜像。
 *
 * 背景：`registerTaskInputArtifacts` 把建单附件复制到**项目根** `inputs/<短号>/`；
 * inplace 项目员工 cwd＝项目根，相对路径可读；staging 项目员工 cwd＝任务 worktree，
 * 项目根在 worktree 之外，相对路径读不到。这里在 worktree 建立时把该任务 inputs 镜像进去，
 * 并把 `inputs/` 写进**该 worktree**的 `.git/info/exclude`，避免输入文件被 `git add -A`
 * 卷进变更集；工作项结束再清理镜像（项目根的原件保留）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { GitRunner } from '../git/index.js';

export interface MirrorTaskInputsInput {
  projectRoot: string;
  worktreePath: string;
  shortId: string;
  git?: Pick<GitRunner, 'run'>;
}

export interface MirrorTaskInputsResult {
  /** 源目录不存在（该任务没有输入附件）⇒ skipped，不报错。 */
  skipped: boolean;
  copied: number;
  /** 非致命问题（例如无法写 exclude）；已复制但可能被提交。 */
  warnings: string[];
}

function safeShortId(shortId: string): string {
  return shortId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'task';
}

export function taskInputsRelative(shortId: string): string {
  return `inputs/${safeShortId(shortId)}`;
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir).reduce((sum, name) => {
      const full = join(dir, name);
      return sum + (statSync(full).isDirectory() ? countFiles(full) : 1);
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * 把 `projectRoot/inputs/<shortId>/` 复制到 `worktreePath/inputs/<shortId>/`，
 * 并确保 worktree 的 git exclude 含 `inputs/`（只在能拿到 git 路径时）。
 * 不抛：复制失败返回 warnings，由调用方决定是否留痕。
 */
export function mirrorTaskInputs(input: MirrorTaskInputsInput): MirrorTaskInputsResult {
  const rel = taskInputsRelative(input.shortId);
  const source = join(input.projectRoot, ...rel.split('/'));
  if (!existsSync(source)) return { skipped: true, copied: 0, warnings: [] };
  const dest = join(input.worktreePath, ...rel.split('/'));
  const warnings: string[] = [];
  try {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true, force: true });
  } catch (error) {
    warnings.push(`输入附件镜像失败：${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, copied: 0, warnings };
  }

  if (input.git) {
    try {
      const res = input.git.run(['rev-parse', '--git-path', 'info/exclude'], input.worktreePath);
      if (res.status !== 0 || res.stdout.trim().length === 0) {
        warnings.push('无法定位 worktree 的 info/exclude；输入附件可能被提交进变更集');
      } else {
        const excludePath = res.stdout.trim();
        const abs = excludePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(excludePath)
          ? excludePath
          : join(input.worktreePath, excludePath);
        mkdirSync(dirname(abs), { recursive: true });
        const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        if (!/(^|\n)\s*inputs\/\s*(\n|$)/.test(current)) {
          writeFileSync(abs, `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}# ai-company task inputs\ninputs/\n`, 'utf8');
        }
      }
    } catch (error) {
      warnings.push(`写 worktree exclude 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { skipped: false, copied: countFiles(dest), warnings };
}

/** 工作项结束清理 worktree 里的镜像；项目根 `inputs/` 原件不动。 */
export function cleanupMirroredInputs(worktreePath: string, shortId: string): { removed: boolean; error?: string } {
  const dir = join(worktreePath, ...taskInputsRelative(shortId).split('/'));
  if (!existsSync(dir)) return { removed: false };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
