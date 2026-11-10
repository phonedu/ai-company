/**
 *  · 验收项里的**机器检查**（P6：命令门禁，不让模型代判）。
 *
 * 口径：
 *  - 只跑 `acceptance[].check` 非空的条目；无 check 的条目仍由 verifier 人话判定；
 *  - 任一条 check 失败 ⇒ **硬门失败**（调用方跳过 verifier 模型、直接 fail，不许模型翻案）；
 *  - `aico:docs-check` 是**进程内**文档检查（项目根 `.aico/docs`），不是 shell 命令；
 *  - 项目关闭文档检查（`projects.docs_check_enabled=0`）或无文档树 ⇒ 状态 `skip`（未检查，不冒充通过）；
 *  - 普通命令在**项目根**执行，**默认 10 分钟**超时（：60s 会掐断 `pnpm test` 级验收；
 *    `AICO_ACCEPTANCE_TIMEOUT_MS` 可配，显式参数优先）；输出只留尾部摘要（防爆报告）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getProjectById, getTaskById } from '../db/index.js';
import { checkDocs, defaultDocsPolicy } from '../docs/check.js';
import { DOCS_CHECK_COMMAND } from '../docs/contract.js';
import { readDocText, walkDocsTree } from '../docs/fs.js';
import type { SqliteDb } from '../db/open.js';

export { DOCS_CHECK_COMMAND };

/**
 * （ADV-1 G2）：验收命令默认超时。旧值 60s 对 `pnpm test` 级检查必掐断 → 永远过不了硬门。
 * 默认 10 分钟；`AICO_ACCEPTANCE_TIMEOUT_MS` 覆盖（正整数毫秒）；显式参数最优先。
 */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 10 * 60_000;

export function acceptanceTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = process.env.AICO_ACCEPTANCE_TIMEOUT_MS;
  const parsed = raw != null && raw.trim().length > 0 ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACCEPTANCE_TIMEOUT_MS;
}

export type MachineCheckStatus = 'pass' | 'fail' | 'skip';

export interface MachineCheckItem {
  text: string;
  check: string;
  status: MachineCheckStatus;
  /** 通过/失败/未检查的原因（人话；失败带尾部输出）。 */
  reason: string;
}

export interface MachineCheckResult {
  items: MachineCheckItem[];
  /** 是否存在至少一条真正执行了（pass/fail）的检查。 */
  judged: boolean;
  /** 任一 check 失败（硬门）。 */
  failed: boolean;
}

interface AcceptanceCheckItem {
  text: string;
  check: string;
}

/** 容忍旧格式（纯字符串 / `{text}` / 坏 JSON）：只取有 `check` 的条目。 */
export function parseAcceptanceChecks(raw: unknown): AcceptanceCheckItem[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: AcceptanceCheckItem[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') continue;
    if (!item || typeof item !== 'object') continue;
    const rec = item as { text?: unknown; check?: unknown };
    const text = typeof rec.text === 'string' ? rec.text : '';
    const check = typeof rec.check === 'string' ? rec.check.trim() : '';
    if (check.length > 0) out.push({ text: text.length > 0 ? text : check, check });
  }
  return out;
}

/** 项目根（任务所属项目；找不到 → null，不猜文件系统）。 */
function projectRootFor(db: SqliteDb, taskId: number): string | null {
  const task = getTaskById(db, taskId) as { project_id?: number | null } | undefined;
  if (!task?.project_id) return null;
  const project = getProjectById(db, task.project_id) as { root_dir?: string } | undefined;
  return project?.root_dir ?? null;
}

/** 进程内文档检查（只读；项目关闭/无树 ⇒ skip）。 */
function runDocsCheck(db: SqliteDb, taskId: number): MachineCheckItem {
  const task = getTaskById(db, taskId) as { project_id?: number | null } | undefined;
  const project = task?.project_id ? (getProjectById(db, task.project_id) as { root_dir?: string; docs_check_enabled?: number } | undefined) : undefined;
  if (project && project.docs_check_enabled === 0) {
    return { text: '文档检查', check: DOCS_CHECK_COMMAND, status: 'skip', reason: '项目已关闭文档检查（未检查）' };
  }
  const root = project?.root_dir;
  if (!root) return { text: '文档检查', check: DOCS_CHECK_COMMAND, status: 'skip', reason: '任务无项目根（未检查）' };
  const docsRoot = resolve(root, '.aico', 'docs');
  if (!existsSync(docsRoot)) {
    return { text: '文档检查', check: DOCS_CHECK_COMMAND, status: 'skip', reason: '无 .aico/docs 文档树（未检查）' };
  }
  const walk = walkDocsTree(docsRoot);
  const read = (p: string): string | null => readDocText(join(docsRoot, ...p.split('/')));
  const result = checkDocs(defaultDocsPolicy(), {
    listFiles: () => walk.files,
    read,
    exists: (p: string) => existsSync(join(docsRoot, ...p.split('/'))),
  });
  const pass = result.counts.issues === 0;
  const summary = `活文档 ${result.counts.live} · 归档 ${result.counts.archive} · 悬空 ${result.counts.dangling} · 超线 ${result.counts.oversized} · 问题 ${result.counts.issues}`;
  const first = result.issues.slice(0, 3).map((i) => i.message).join('；');
  return {
    text: '文档检查',
    check: DOCS_CHECK_COMMAND,
    status: pass ? 'pass' : 'fail',
    reason: pass ? summary : `${summary}${first.length > 0 ? `；${first}` : ''}`,
  };
}

/** 跑全部机器检查（同步；命令超时 60s）。 */
export function runAcceptanceChecks(
  db: SqliteDb,
  taskId: number,
  options: { cwd?: string; timeoutMs?: number } = {},
): MachineCheckResult {
  const task = getTaskById(db, taskId) as { acceptance?: string | null } | undefined;
  const checks = parseAcceptanceChecks(task?.acceptance ?? '[]');
  const root = projectRootFor(db, taskId);
  const items: MachineCheckItem[] = [];
  for (const item of checks) {
    if (item.check === DOCS_CHECK_COMMAND) {
      items.push(runDocsCheck(db, taskId));
      continue;
    }
    const cwd = options.cwd ?? root;
    if (!cwd) {
      items.push({ text: item.text, check: item.check, status: 'skip', reason: '任务无项目根（未检查）' });
      continue;
    }
    const res = spawnSync(item.check, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: acceptanceTimeoutMs(options.timeoutMs),
      windowsHide: true,
      env: process.env,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    const tail = output.length > 600 ? output.slice(-600) : output;
    if (res.error) {
      items.push({ text: item.text, check: item.check, status: 'fail', reason: `执行失败：${res.error.message}` });
    } else if (res.status === 0) {
      items.push({ text: item.text, check: item.check, status: 'pass', reason: '命令通过（exit=0）' });
    } else {
      items.push({
        text: item.text,
        check: item.check,
        status: 'fail',
        reason: `命令失败（exit=${res.status ?? 'null'}）${tail.length > 0 ? `：${tail}` : ''}`,
      });
    }
  }
  return {
    items,
    judged: items.some((i) => i.status !== 'skip'),
    failed: items.some((i) => i.status === 'fail'),
  };
}

/** 异步跑一条 shell 检查（不阻塞主进程事件循环）。 */
function runShellCheckAsync(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ status: number | null; output: string; error: string | null; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 已退出
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ status: null, output, error: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        status: code,
        output,
        error: timedOut ? `命令超时（${timeoutMs}ms）` : null,
        timedOut,
      });
    });
  });
}

/** 异步版 `runAcceptanceChecks`（verifier 生产路径用；避免 spawnSync 卡主进程）。 */
export async function runAcceptanceChecksAsync(
  db: SqliteDb,
  taskId: number,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<MachineCheckResult> {
  const task = getTaskById(db, taskId) as { acceptance?: string | null } | undefined;
  const checks = parseAcceptanceChecks(task?.acceptance ?? '[]');
  const root = projectRootFor(db, taskId);
  const items: MachineCheckItem[] = [];
  for (const item of checks) {
    if (item.check === DOCS_CHECK_COMMAND) {
      items.push(runDocsCheck(db, taskId));
      continue;
    }
    const cwd = options.cwd ?? root;
    if (!cwd) {
      items.push({ text: item.text, check: item.check, status: 'skip', reason: '任务无项目根（未检查）' });
      continue;
    }
    const res = await runShellCheckAsync(item.check, cwd, acceptanceTimeoutMs(options.timeoutMs));
    const output = res.output.trim();
    const tail = output.length > 600 ? output.slice(-600) : output;
    if (res.error) {
      items.push({ text: item.text, check: item.check, status: 'fail', reason: `执行失败：${res.error}` });
    } else if (res.status === 0) {
      items.push({ text: item.text, check: item.check, status: 'pass', reason: '命令通过（exit=0）' });
    } else {
      items.push({
        text: item.text,
        check: item.check,
        status: 'fail',
        reason: `命令失败（exit=${res.status ?? 'null'}）${tail.length > 0 ? `：${tail}` : ''}`,
      });
    }
  }
  return {
    items,
    judged: items.some((i) => i.status !== 'skip'),
    failed: items.some((i) => i.status === 'fail'),
  };
}

/** 给人/模型看的一行摘要（verifier 上下文与失败报告共用）。 */
export function formatMachineChecks(result: MachineCheckResult): string {
  if (result.items.length === 0) return '';
  return result.items
    .map((i) => `- ${i.text}（${i.check}）：${i.status === 'pass' ? '通过' : i.status === 'fail' ? '失败' : '未检查'} — ${i.reason}`)
    .join('\n');
}
