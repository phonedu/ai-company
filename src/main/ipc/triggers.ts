/**
 * B-1（M4）· 触发管理 UI 的后端入口（`project:trigger-manage`）。
 *
 * 口径：
 *  - **与频道命令同源**：都调 `TriggerService`（`timers` 表；不新表/不新调度器）；
 *  - **项目边界**：list/create/cancel 都以 `projectId` 为准；不能列出/取消别的项目的触发；
 *  - **不做假读数**：无触发 → 空数组；无下次时间（事件触发）→ `nextDueAt:null`；
 *  - **校验显式拒**：项目不存在/已归档、调度二选一非法、源任务不在本项目/已终态，均返回错误码。
 */
import type { ChatRepo } from './ports.js';
import type { TriggerService, TriggerView } from '../triggers/service.js';

export interface TriggerHandlerDeps {
  repo: ChatRepo;
  triggerService?: TriggerService | null;
}

export type TriggerManageResult =
  | { ok: true; action: 'list'; triggers: TriggerView[] }
  | { ok: true; action: 'create-cron' | 'create-event'; trigger: TriggerView }
  | { ok: true; action: 'cancel'; id: number; cancelled: boolean }
  | { ok: false; code: string; message: string };

const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

function bad(message: string, code = 'bad_request'): TriggerManageResult {
  return { ok: false, code, message };
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeShortId(value: string): string {
  const raw = value.trim().replace(/^#/, '');
  const m = /^T-?(\d+)$/i.exec(raw);
  return m ? `T-${m[1]}` : raw;
}

/**
 * `project:trigger-manage`：
 *  - `{projectId, action:'list'}`
 *  - `{projectId, action:'create-cron', goal, title?, name?, intervalMinutes?|dailyMinute?, riskLevel?}`
 *  - `{projectId, action:'create-event', goal, title?, name?, sourceTaskId|sourceShortId, riskLevel?}`
 *  - `{projectId, action:'cancel', id}`
 */
export function handleProjectTriggerManage(
  deps: TriggerHandlerDeps,
  raw: unknown,
  now: number = Date.now(),
): TriggerManageResult {
  const input = (raw ?? {}) as Record<string, unknown>;
  const projectId = readPositiveInt(input.projectId);
  if (projectId == null) return bad('projectId 需为正整数');
  const project = deps.repo.getProject(projectId);
  if (!project) return bad(`项目不存在：${projectId}`, 'not_found');

  const action = typeof input.action === 'string' ? input.action : '';
  const service = deps.triggerService;
  if (!service) return bad('触发服务未就绪（主进程未装配）', 'not_ready');

  if (action === 'list') {
    const triggers = service
      .list()
      .filter((trigger) => trigger.projectId === projectId)
      .sort((a, b) => (a.nextDueAt ?? Number.MAX_SAFE_INTEGER) - (b.nextDueAt ?? Number.MAX_SAFE_INTEGER));
    return { ok: true, action: 'list', triggers };
  }

  if (action === 'cancel') {
    const id = readPositiveInt(input.id);
    if (id == null) return bad('id 需为正整数');
    const row = service.list().find((trigger) => trigger.id === id);
    // 别的项目的触发不暴露存在性：统一 not_found。
    if (!row || row.projectId !== projectId) return bad(`未找到未触发的触发 #${id}`, 'not_found');
    return { ok: true, action: 'cancel', id, cancelled: service.cancel(id) };
  }

  if (project.archived === 1) return bad('项目已归档——不能新建触发', 'project_archived');

  const goal = readText(input.goal);
  if (goal == null) return bad('goal 不能为空');
  const title = readText(input.title) ?? (goal.slice(0, 40) || '定时任务');
  const name = readText(input.name) ?? title;
  const riskRaw = input.riskLevel ?? 1;
  if (typeof riskRaw !== 'number' || !Number.isInteger(riskRaw) || riskRaw < 0 || riskRaw > 2) {
    return bad('riskLevel 需为 0/1/2');
  }

  if (action === 'create-cron') {
    const intervalMinutes = input.intervalMinutes;
    const dailyMinute = input.dailyMinute;
    const hasInterval = intervalMinutes !== undefined && intervalMinutes !== null;
    const hasDaily = dailyMinute !== undefined && dailyMinute !== null;
    if (hasInterval === hasDaily) return bad('intervalMinutes 与 dailyMinute 必须二选一');
    if (hasInterval) {
      if (
        typeof intervalMinutes !== 'number' ||
        !Number.isInteger(intervalMinutes) ||
        intervalMinutes <= 0 ||
        intervalMinutes > 10_080
      ) {
        return bad('intervalMinutes 需为 1–10080 的整数（分钟）');
      }
    }
    if (hasDaily) {
      if (typeof dailyMinute !== 'number' || !Number.isInteger(dailyMinute) || dailyMinute < 0 || dailyMinute > 1439) {
        return bad('dailyMinute 需为 0–1439 的整数（当天分钟数）');
      }
    }
    try {
      const trigger = service.createCron({
        name,
        projectId,
        title,
        goal,
        riskLevel: riskRaw,
        ...(hasInterval ? { intervalMinutes: intervalMinutes as number } : {}),
        ...(hasDaily ? { dailyMinute: dailyMinute as number } : {}),
        now,
      });
      return { ok: true, action: 'create-cron', trigger };
    } catch (error) {
      return bad(`触发未创建：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (action === 'create-event') {
    const sourceTaskIdRaw = input.sourceTaskId;
    const sourceShortId = readText(input.sourceShortId);
    const source =
      typeof sourceTaskIdRaw === 'number'
        ? deps.repo.getTask(sourceTaskIdRaw)
        : sourceShortId != null
          ? deps.repo.findTaskByShortId(normalizeShortId(sourceShortId))
          : null;
    if (!source) return bad('未找到源任务', 'not_found');
    if (source.projectId !== projectId) return bad('源任务不属于当前项目', 'wrong_project');
    if (TERMINAL_STATES.has(source.state)) return bad('源任务已是终态，不会再“完成”', 'source_terminal');
    try {
      const trigger = service.createEvent({
        name,
        projectId,
        title,
        goal,
        riskLevel: riskRaw,
        sourceTaskId: source.id,
        eventKind: 'task_completed',
        now,
      });
      return { ok: true, action: 'create-event', trigger };
    } catch (error) {
      return bad(`触发未创建：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return bad(`未知 action：${action || '-'}`);
}
