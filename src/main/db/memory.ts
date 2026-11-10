import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
/**
 * G11 · 员工长期记忆（`employee_memory`：DAO ＋ 任务收尾的确定性投影）。
 *
 * 口径（`docs/` §13.5 / `docs/` §7 / 施工图 `plan-reorg-r1-r4.md` R2-1）：
 *  - 分区：`project_id = 0`＝跨项目通用；否则＝项目记忆。**v1 只写项目记忆**（通用记忆由显式"提升"动作负责，后续做）；
 *  - **写点**＝任务进 `done`（引擎同事务调 `recordTaskMemory`，见 `src/main/engine/loop.ts`）；
 *  - **幂等**：块以 `[任务 T-XXXX]` 打头，已存在即跳过（重开/重试/重放不重复写）；
 *  - **确定性投影、不调 LLM**（省钱；LLM 摘要＝"项目记忆短简报"，后续）；
 *  - **不臆造**：无成本行只写 token 数并标「未计价」；无产物/验收则省该行（不写假 `0`）。
 */
import type { SqliteDb } from './open.js';
import { getTaskById } from './tasks.js';
import { isDocsCheckAcceptance } from '../docs/contract.js';
import { listArtifactsByTask } from './artifacts.js';
import { listCosts } from './costs.js';

/** 单员工单分区最多保留的任务块数（超出丢最旧；块以空行分隔）。 */
export const MAX_MEMORY_BLOCKS = 20;

const BLOCK_SEP = '\n\n';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `tasks.acceptance` 的两种形状（`string` / `{text}`）→ 文本数组；与 `agent/context.ts` 同口径。
 *  （C2 真拆派复用：引擎建工作项的 `brief` 里要带验收。） */
export function acceptanceTexts(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((a) => !isDocsCheckAcceptance(a))
    .map((a) =>
      typeof a === 'string' ? a : typeof (a as { text?: unknown })?.text === 'string' ? String((a as { text: string }).text) : '',
    )
    .filter((s) => s.length > 0);
}

/** 读某员工在某分区的记忆（无行 → `''`，不臆造）。 */
export function readMemory(db: SqliteDb, input: { employeeId: number; projectId: number }): string {
  const row = db
    .prepare('SELECT memory FROM employee_memory WHERE employee_id = ? AND project_id = ?')
    .get(input.employeeId, input.projectId) as { memory?: string } | undefined;
  return row?.memory ?? '';
}

/** 项目记忆短简报最多列几件（防它自己变成新的上下文债；`` 口径）。 */
export const MEMORY_BRIEF_MAX_BLOCKS = 5;

/**
 * 项目记忆短简报（N5 尾项）：从完整记忆块里抽出**最近 N 件的首行**（任务号＋标题＋日期），
 * 作为会话开头的快速索引。**确定性投影、不调 LLM**（省钱；完整记忆仍在 `[员工记忆]` 层）。
 * 无记忆 → `（暂无）`（不臆造）；每行截断到 100 字符（防单块超长）。
 */
export function buildProjectMemoryBrief(memory: string, maxBlocks: number = MEMORY_BRIEF_MAX_BLOCKS): string {
  const blocks = memory
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return '（暂无）';
  return blocks
    .slice(-Math.max(1, maxBlocks))
    .map((block) => {
      const first = (block.split('\n')[0] ?? '').trim();
      return first.length > 100 ? `${first.slice(0, 99)}…` : first;
    })
    .join('\n');
}

/** 追加一块（幂等：现有内容已含 `marker` 即跳过）。返回是否真写入。 */
export function appendMemory(
  db: SqliteDb,
  input: { employeeId: number; projectId: number; block: string; marker: string; now: number },
): boolean {
  const current = readMemory(db, { employeeId: input.employeeId, projectId: input.projectId });
  if (current.includes(input.marker)) return false;
  const blocks = current.split(BLOCK_SEP).filter((b) => b.trim().length > 0);
  blocks.push(input.block);
  // /：超 MAX_MEMORY_BLOCKS 的挤出块**归档不丢弃**——落库旁
  // `.aico/memory-archive/<emp>-<proj>.md`（追加写；与 notes 同哲学）；内存库跳过（无盘可归）。
  if (blocks.length > MAX_MEMORY_BLOCKS) {
    const evicted = blocks.slice(0, blocks.length - MAX_MEMORY_BLOCKS);
    try {
      const dbName = (db as unknown as { name?: string }).name ?? ':memory:';
      if (dbName !== ':memory:') {
        const archiveDir = join(dbName, '..', '.aico', 'memory-archive');
        mkdirSync(archiveDir, { recursive: true });
        appendFileSync(
          join(archiveDir, `${input.employeeId}-${input.projectId}.md`),
          evicted.map((b) => `## 归档（${new Date(input.now).toISOString()}）\n\n${b}`).join('\n\n') + '\n',
          'utf8',
        );
      }
    } catch (error) {
      // 归档失败不阻断记忆写入，但必须响（不静默）。
      console.error('[memory] 归档写入失败（挤出块仍被丢弃，响亮报错）', error);
    }
  }
  const memory = blocks.slice(-MAX_MEMORY_BLOCKS).join(BLOCK_SEP);
  db.prepare(
    `INSERT INTO employee_memory(employee_id, project_id, memory, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(employee_id, project_id) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`,
  ).run(input.employeeId, input.projectId, memory, input.now);
  return true;
}

export interface TaskMemoryRecord {
  marker: string;
  block: string;
  projectId: number;
  /** 该任务的参与者（有 work item 的员工；去重升序）。 */
  employees: number[];
  /** 本次真写入的员工（幂等跳过的不在内）。 */
  writtenTo: number[];
}

/** 任务收尾投影：任务 → 参与者 × 项目记忆。引擎在任务进 `done` 时同事务调用（幂等，可重放）。 */
export function recordTaskMemory(db: SqliteDb, taskId: number, now: number): TaskMemoryRecord | null {
  const task = getTaskById(db, taskId) as
    | { short_id?: string | null; title?: string; goal?: string; acceptance?: unknown; project_id?: number | null }
    | undefined;
  if (!task) return null;
  const shortId = task.short_id ?? `#${taskId}`;
  const marker = `[任务 ${shortId}]`;
  const employees = (
    db.prepare('SELECT DISTINCT employee_id FROM work_items WHERE task_id = ? ORDER BY employee_id').all(taskId) as Array<{
      employee_id: number;
    }>
  ).map((r) => r.employee_id);
  const projectId = task.project_id ?? 0;
  const block = buildTaskBlock(db, {
    taskId,
    shortId,
    title: task.title ?? '（无题）',
    goal: task.goal ?? '',
    acceptance: task.acceptance,
    now,
  });
  const writtenTo: number[] = [];
  for (const employeeId of employees) {
    if (appendMemory(db, { employeeId, projectId, block, marker, now })) writtenTo.push(employeeId);
  }
  return { marker, block, projectId, employees, writtenTo };
}

/** 确定性小结（不调 LLM）：标题/日期 + 目标 + 验收 + 产物 + 成本（有才写）。 */
export function buildTaskBlock(
  db: SqliteDb,
  input: { taskId: number; shortId: string; title: string; goal: string; acceptance: unknown; now: number },
): string {
  const date = new Date(input.now).toISOString().slice(0, 10);
  const lines = [`[任务 ${input.shortId}] ${truncate(input.title, 80)}（${date} 完成）`];
  if (input.goal.trim().length > 0) lines.push(`目标：${truncate(input.goal.trim(), 160)}`);
  const acceptance = acceptanceTexts(input.acceptance);
  if (acceptance.length > 0) lines.push(`验收：${acceptance.slice(0, 5).map((t) => truncate(t, 60)).join('；')}`);
  const artifacts = listArtifactsByTask(db, input.taskId)
    .slice(-5)
    .map((a) => a.path);
  if (artifacts.length > 0) lines.push(`产物：${artifacts.join('；')}`);
  const costs = listCosts(db, input.taskId);
  if (costs.length > 0) {
    const tokens = costs.reduce((sum, c) => sum + c.tokens_in + c.tokens_out, 0);
    const usd = costs.reduce((sum, c) => sum + c.usd, 0);
    lines.push(usd > 0 ? `成本：$${usd.toFixed(4)} · ${tokens} tokens` : `成本：${tokens} tokens（未计价）`);
  }
  return lines.join('\n');
}
