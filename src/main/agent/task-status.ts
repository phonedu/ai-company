/**
 * 幕僚长只读任务状态快照（`task_status` 工具的数据面；纯查询、零写入）。
 *
 * 背景：老板问「T-xxxx 什么状态」是高频路径，但幕僚长上下文里没有任务状态、又无查询工具
 * ⇒ 只能如实答「查不到」。本模块直读真库给出紧凑快照——真值来源＝真库，空字段一律 `—`。
 *
 * 等待原因**从真库推导**（不依赖引擎内存态）：排队件 × `runningByEmployee`（与调度器
 * `planScheduling` 同源输入）→ 「等员工空闲 @占用任务短号」。与 UI `waits` 读数同口径。
 */
import type { SqliteDb } from '../db/open.js';
import { runningByEmployee } from '../db/work_items.js';

/** 展示层状态文案（码＋中文并列，避免歧义；快照以原始 state 码为准）。 */
const STATE_LABELS: Record<string, string> = {
  inbox: '待分诊',
  planning: '规划中',
  awaiting_approval: '待批准',
  needs_decision: '待决策',
  ready: '就绪',
  executing: '进行中',
  verifying: '验收中',
  done: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  paused: '已暂停',
  blocked: '受阻',
};

/** 引用归一：`T-1002` / `t1002` → 短号；纯数字 → 任务 id；其余 → null（不猜）。 */
export function normalizeTaskRef(ref: string): { shortId?: string; id?: number } | null {
  const trimmed = ref.trim();
  const m = /^T-?(\d+)$/i.exec(trimmed);
  if (m) return { shortId: `T-${m[1]}` };
  if (/^\d+$/.test(trimmed)) return { id: Number(trimmed) };
  return null;
}

export interface TaskStatusSnapshot {
  taskId: number;
  shortId: string;
  /** 给模型读的紧凑快照（中文、空字段 —）。 */
  text: string;
}

function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return '—';
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

/** 只读快照：查无返回 null（调用方转「没找到」话术）。 */
export function taskStatusSnapshot(db: SqliteDb, ref: string): TaskStatusSnapshot | null {
  const norm = normalizeTaskRef(ref);
  if (!norm) return null;
  const task = db
    .prepare(
      `SELECT t.id, t.short_id, t.title, t.state, t.risk_level, t.archived, t.created_at, t.updated_at,
              p.name AS project_name, e.name AS owner_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN employees e ON e.id = t.owner_id
        WHERE (t.short_id = ? OR t.id = ?) LIMIT 1`,
    )
    .get(norm.shortId ?? '', norm.id ?? -1) as
    | {
        id: number;
        short_id: string;
        title: string;
        state: string;
        risk_level: number;
        archived: number;
        created_at: number;
        updated_at: number;
        project_name: string | null;
        owner_name: string | null;
      }
    | undefined;
  if (!task) return null;

  const steps = db
    .prepare('SELECT idx, text, state FROM plan_steps WHERE task_id = ? ORDER BY idx LIMIT 8')
    .all(task.id) as Array<{ idx: number; text: string; state: string }>;
  const report = db
    .prepare('SELECT kind, payload, created_at FROM reports WHERE task_id = ? ORDER BY id DESC LIMIT 1')
    .get(task.id) as { kind: string; payload: string; created_at: number } | undefined;
  const cost = db.prepare('SELECT COUNT(*) n, SUM(usd) usd FROM costs WHERE task_id = ?').get(task.id) as {
    n: number;
    usd: number | null;
  };
  const artifacts = (db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id = ?').get(task.id) as { n: number }).n;

  // 等待原因（真库推导，与调度器同源输入）
  let wait = '—';
  if (task.state === 'executing') {
    const queued = db
      .prepare("SELECT id, employee_id FROM work_items WHERE task_id = ? AND state = 'queued' ORDER BY id LIMIT 1")
      .get(task.id) as { id: number; employee_id: number } | undefined;
    if (queued) {
      const busy = runningByEmployee(db);
      const occupier = busy.get(queued.employee_id);
      if (occupier != null && occupier !== queued.id) {
        const occupierShort =
          (
            db
              .prepare('SELECT t.short_id AS sid FROM tasks t JOIN work_items w ON w.task_id = t.id WHERE w.id = ?')
              .get(occupier) as { sid: string | null } | undefined
          )?.sid ?? `#${occupier}`;
        wait = `等员工空闲 @${occupierShort}（该员工的另一件在跑）`;
      }
    }
  }

  const stateLabel = STATE_LABELS[task.state] ?? task.state;
  const doneSteps = steps.filter((s) => s.state === 'done').length;
  const lines: string[] = [
    `${task.short_id} · ${task.title}（${task.state}${stateLabel === task.state ? '' : `（${stateLabel}）`}${task.archived ? '；已归档' : ''}）`,
    `项目：${task.project_name ?? '—'}；负责人：${task.owner_name ?? '—'}；风险：L${task.risk_level}`,
  ];
  if (steps.length > 0) {
    lines.push(`计划（${doneSteps}/${steps.length} 已完）：`);
    for (const s of steps) lines.push(`  ${s.idx}. [${s.state}] ${s.text}`);
    // （真机带回）：done＝**工作项验收通过**（合并模型），不等于全部计划步骤已执行——
    // 打回重规划后旧步骤被重算、或验收只覆盖交付项 ⇒ 剩余步骤留在 pending。快照必须写明口径，
    // 否则读快照的模型会得出「自相矛盾、不建议采信」的误判（真机实录）。
    if (task.state === 'done' && doneSteps < steps.length) {
      lines.push(
        `口径说明：done＝交付项验收通过（合并模型），未到 ${steps.length} 步全执行——剩余 ${steps.length - doneSteps} 步因打回/重规划被后续版本替代或未纳入交付，不代表任务未完成。`,
      );
    }
  } else {
    lines.push('计划：—');
  }
  if (report) {
    let tldr = '';
    try {
      const payload = JSON.parse(report.payload) as { tldr?: string; title?: string };
      tldr = payload.tldr ?? payload.title ?? '';
    } catch {
      tldr = '';
    }
    lines.push(`最近汇报：${report.kind}${tldr ? ` —— ${tldr}` : ''}（${fmtTime(report.created_at)}）`);
  } else {
    lines.push('最近汇报：—');
  }
  lines.push(`等待：${wait}`);
  lines.push(`成本：${cost.usd == null ? '—' : `$${cost.usd.toFixed(4)}`}（${cost.n} 笔）；产物：${artifacts} 个`);
  lines.push(`更新：${fmtTime(task.updated_at)}`);
  return { taskId: task.id, shortId: task.short_id, text: lines.join('\n') };
}
