/**
 * 证据「可回指 / provenance」（OPT-M8-2）：给门禁 / 验收 / 基准的产出附
 * `gitHead` + `dirty` + `version` + `generatedAt`，让「红也留痕」时能回指到某个提交与工作区状态。
 *
 * 纯采集、**best-effort**：任何一步采集失败 → 该字段为 `null`（**绝不抛**）。
 * git 执行器可注入，便于单测（不真跑 git）。
 */
import { execFileSync } from 'node:child_process';

export interface Provenance {
  /** 当前提交（`git rev-parse HEAD`）；采集失败为 null。 */
  gitHead: string | null;
  /** 工作区是否有未提交改动（`git status --porcelain` 非空）；采集失败为 null。 */
  dirty: boolean | null;
  /** 产出方版本（如 app/package 版本）；缺省 'unknown'。 */
  version: string;
  /** 采集时刻（ISO）。 */
  generatedAt: string;
}

export interface ProvenanceOptions {
  cwd?: string;
  version?: string;
  /** 注入的 git 执行器：返回 stdout；抛即视为采集失败。缺省真跑 `git`。 */
  runGit?: (args: string[], cwd: string) => string;
  nowIso?: string;
}

function defaultRunGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 4000,
  });
}

export function getProvenance(options: ProvenanceOptions = {}): Provenance {
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? defaultRunGit;

  let gitHead: string | null = null;
  try {
    gitHead = runGit(['rev-parse', 'HEAD'], cwd).trim() || null;
  } catch {
    gitHead = null;
  }

  let dirty: boolean | null = null;
  try {
    dirty = runGit(['status', '--porcelain'], cwd).trim().length > 0;
  } catch {
    dirty = null;
  }

  return {
    gitHead,
    dirty,
    version: options.version ?? 'unknown',
    generatedAt: options.nowIso ?? new Date().toISOString(),
  };
}
