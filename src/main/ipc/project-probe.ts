/**
 * R2-4 · 项目接入探测（`UI §3.1` 第 2 屏的"不用你填任何信息"）。
 *
 * 口径：**只报从目录里真读到的事实**（存在性/来自文件内容），不臆造：
 *  - 类型标记：`.git` / `package.json` / `pyproject.toml` / `README.md`；
 *  - **建议**验收命令（**建议 ≠ 承诺**：pyproject ⇒ `pytest -q`；package.json 有 `scripts.test` ⇒ `<包管理器> test`；都没有 ⇒ `null`，由引导去"先搭测试底座"）；
 *  - **建议**接入模式：有 `.git` ⇒ `inplace`（每任务一分支）；否则 `staging`（沙盒副本）——PLAN §15.3。
 *
 * 纯函数（注入 `io`，可脱离真实文件系统单测）；**不读项目外的任何路径**、不写任何东西。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectProbe {
  hasGit: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  hasReadme: boolean;
  /** 建议的验收命令（来自真实文件；`null` = 没找到可跑的命令）。 */
  suggestedCheck: string | null;
  /** 建议接入模式（有 `.git` ⇒ inplace；否则 staging）。 */
  suggestedAccessMode: 'inplace' | 'staging';
}

export interface ProbeIo {
  exists(path: string): boolean;
  read(path: string): string;
}

const defaultIo: ProbeIo = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  },
};

/** 从 `package.json` 的 `scripts.test` + 锁文件推断命令（`npm test` / `pnpm test` / `yarn test`）。 */
function npmCheck(rootDir: string, io: ProbeIo): string | null {
  const pkgText = io.read(join(rootDir, 'package.json'));
  if (!pkgText) return null;
  let hasTest = false;
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
    hasTest = typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim().length > 0;
  } catch {
    return null; // 坏 JSON ⇒ 不猜
  }
  if (!hasTest) return null;
  const pm = io.exists(join(rootDir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : io.exists(join(rootDir, 'yarn.lock'))
      ? 'yarn'
      : 'npm';
  return `${pm} test`;
}

export function probeProject(rootDir: string, io: ProbeIo = defaultIo): ProjectProbe {
  const hasGit = io.exists(join(rootDir, '.git'));
  const hasPackageJson = io.exists(join(rootDir, 'package.json'));
  const hasPyproject = io.exists(join(rootDir, 'pyproject.toml'));
  const hasReadme = io.exists(join(rootDir, 'README.md'));
  const suggestedCheck = hasPackageJson ? npmCheck(rootDir, io) : hasPyproject ? 'pytest -q' : null;
  return {
    hasGit,
    hasPackageJson,
    hasPyproject,
    hasReadme,
    suggestedCheck,
    suggestedAccessMode: hasGit ? 'inplace' : 'staging',
  };
}
