/**
 * CTX-1 P2（CTX1-3）· 压缩后的**确定性交接块**（不替换 Pi 摘要，不额外调 LLM）。
 *
 * 口径（上下文工程口径（C3））：
 *  - Pi 的 `session_compact` 成功后，本模块从**真库**重建任务状态：目标/验收、计划步骤与状态、
 *    已完成工作项/产物、最近失败或打回、下一步；作为一条 custom message 注入下一轮上下文。
 *  - 同时落 `task_events.kind='compaction_handoff'`（可审计：谁、哪个会话、多少字符）。
 *  - 任务不存在 → null（不发空块）；任何查询失败都不抛出（压缩不能因交接块而失败）。
 */
import {
  acceptanceTexts,
  getTaskById,
  insertTaskEvent,
  listArtifactsByTask,
  listPlanSteps,
  listTaskEvents,
} from '../db/index.js';
import type { SqliteDb } from '../db/open.js';

/** 从会话键取任务 id（`employee:<id>:task:<tid>:wi:<wid>` / `role:<role>:task:<tid>[:wi:<id>]`）。 */
export function taskIdFromSessionKey(sessionKey: string): number | null {
  const m = /(?:^|:)task:(\d+)(?::|$)/.exec(sessionKey);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 会话角色（审计字段；无法识别 → 'unknown'）。 */
export function roleFromSessionKey(sessionKey: string): string {
  const role = /^role:([^:]+):/.exec(sessionKey);
  if (role) return role[1] as string;
  if (sessionKey.startsWith('employee:')) return 'employee';
  return 'unknown';
}

function workItemIdFromSessionKey(sessionKey: string): number | null {
  const m = /(?:^|:)wi:(\d+)(?::|$)/.exec(sessionKey);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function clip(text: string, max: number): string {
  const s = text.trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

interface HandoffEvent {
  kind: string;
  payload: string;
}

/** 最近一次失败/打回（人话一段；无 → null）。只认有证据的事件 kind。 */
export function latestSetbackText(events: ReadonlyArray<{ kind: string; payload: string }>): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (!['error', 'revise', 'plan_reviewed', 'escalate', 'task_failed'].includes(e.kind)) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const verdict = typeof payload.verdict === 'string' ? payload.verdict : null;
    if (e.kind === 'plan_reviewed' && verdict !== 'revise') continue;
    const text =
      (typeof payload.notes === 'string' && payload.notes.trim()) ||
      (typeof payload.reason === 'string' && payload.reason.trim()) ||
      (typeof payload.message === 'string' && payload.message.trim()) ||
      '';
    if (text.length > 0) return `${e.kind}：${clip(text, 220)}`;
  }
  return null;
}

/**
 * 从真库构建交接块；任务不存在 → null。所有查询异常 → null（不阻断压缩后的会话）。
 * 不做语义摘要、不调 LLM；文本长度受 `MAX_HANDOFF_CHARS` 限制（超出显式截断）。
 */
export const MAX_HANDOFF_CHARS = 4000;

export function buildCompactionHandoffText(db: SqliteDb, taskId: number): string | null {
  try {
    const task = getTaskById(db, taskId) as
      | { id: number; short_id?: string | null; title?: string | null; goal?: string | null; acceptance?: unknown; state?: string | null }
      | undefined;
    if (!task) return null;
    const steps = listPlanSteps(db, taskId);
    const items = db
      .prepare('SELECT id, title, state FROM work_items WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as Array<{ id: number; title: string; state: string }>;
    const artifacts = listArtifactsByTask(db, taskId) as Array<{ name?: string | null; kind?: string | null; path?: string | null }>;
    const events = listTaskEvents(db, taskId) as HandoffEvent[];

    const lines: string[] = ['【压缩后交接（确定性重建，不依赖摘要；以本块为准）】'];
    lines.push(`任务：${task.short_id ?? `#${task.id}`} · ${task.title ?? '—'}（${task.state ?? '—'}）`);
    lines.push(`目标：${clip(task.goal ?? '—', 300)}`);
    const acceptance = acceptanceTexts(task.acceptance);
    if (acceptance.length > 0) {
      lines.push(`验收：${acceptance.slice(0, 6).map((a) => clip(a, 140)).join('；')}${acceptance.length > 6 ? '；…' : ''}`);
    }
    if (steps.length > 0) {
      const done = steps.filter((s) => s.state === 'done').length;
      lines.push(`计划（${done}/${steps.length} 已完）：`);
      for (const s of steps.slice(0, 12)) lines.push(`- ${s.idx}. [${s.state}] ${clip(s.text, 160)}`);
      if (steps.length > 12) lines.push(`- …（另有 ${steps.length - 12} 步，用任务详情看全量）`);
    } else {
      lines.push('计划：未生成');
    }
    const finished = items.filter((i) => ['submitted', 'done'].includes(i.state));
    const pending = items.filter((i) => ['queued', 'running'].includes(i.state));
    if (finished.length > 0) {
      lines.push(`已完成工作项：${finished.map((i) => `#${i.id} ${clip(i.title, 80)}（${i.state}）`).join('；')}`);
    }
    if (artifacts.length > 0) {
      lines.push(
        `产物：${artifacts.slice(0, 8).map((a) => a.name ?? a.path ?? '(未命名)').join('、')}${artifacts.length > 8 ? ` 等 ${artifacts.length} 个` : ''}`,
      );
    }
    const setback = latestSetbackText(events);
    if (setback) lines.push(`最近失败/打回：${setback}`);
    lines.push(
      pending.length > 0
        ? `下一步：${pending.map((i) => `#${i.id} ${clip(i.title, 100)}（${i.state}）`).join('；')}`
        : '下一步：无排队/在跑工作项（按计划继续或收尾）',
    );
    const text = lines.join('\n');
    return text.length <= MAX_HANDOFF_CHARS ? text : `${text.slice(0, MAX_HANDOFF_CHARS)}\n…（交接块已截断）`;
  } catch (error) {
    console.error(`[ctx-handoff] 构建交接块失败（task=${taskId}）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 给 `pi-runtime` 用的提供者：按会话键重建交接块，并落审计事件。
 * 任务不存在/解析失败 → null（不写假事件）。
 */
export function createCompactionHandoffProvider(
  db: SqliteDb,
  now: () => number = Date.now,
): (sessionKey: string) => string | null {
  return (sessionKey: string): string | null => {
    const taskId = taskIdFromSessionKey(sessionKey);
    if (taskId == null) return null;
    const text = buildCompactionHandoffText(db, taskId);
    if (text == null) return null;
    try {
      insertTaskEvent(db, {
        taskId,
        workItemId: workItemIdFromSessionKey(sessionKey),
        ts: now(),
        kind: 'compaction_handoff',
        actor: 'system',
        payload: { role: roleFromSessionKey(sessionKey), chars: text.length, sessionKey },
      });
    } catch (error) {
      console.error(`[ctx-handoff] 交接块审计事件写入失败（task=${taskId}）：${error instanceof Error ? error.message : String(error)}`);
    }
    return text;
  };
}
