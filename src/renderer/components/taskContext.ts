/**
 * UG-01/UG-03 · 任务详情上下文与任务级设置的**纯函数**（无 React / IPC / 存储依赖）。
 *
 * 口径：
 *  - 截止时间只做展示（UG-02 的提醒/逾期由引擎负责；这里不发明行为）。
 *  - 负责人与执行员工分开：负责人是建单/编制给的，执行员工是当前工作项的人；两者不同都显示。
 *  - 依赖只显示短号 + 完成态；不展开标题（标题进 title 悬停）。
 *  - 强制技能取**最后一条** `task_skill_forced`（与 `handleSkillCommand` 的“最后一条为准”一致）。
 */
import type { TaskDetailDTO, TimelineItemDTO } from './TaskDetail.js';

export interface TaskOwnerRef {
  id: number;
  name: string;
}

export interface TaskDependencyRef {
  id: number;
  shortId: string | null;
  title: string;
  state: string;
}

export interface DeadlineInfo {
  /** 本地日期时间（`MM-DD HH:mm`）；未设置 → `未设置`。 */
  date: string;
  /** 相对读数（`剩 3 天` / `已逾期 2 小时`）；未设置 → 空串。 */
  relative: string;
  tone: 'none' | 'normal' | 'warn' | 'danger';
  overdue: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDeadline(deadline: number | null | undefined, now: number = Date.now()): DeadlineInfo {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) {
    return { date: '未设置', relative: '', tone: 'none', overdue: false };
  }
  const d = new Date(deadline);
  const date = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diff = deadline - now;
  if (diff <= 0) {
    const late = Math.abs(diff);
    const relative = late >= DAY ? `已逾期 ${Math.floor(late / DAY)} 天` : `已逾期 ${Math.max(1, Math.ceil(late / HOUR))} 小时`;
    return { date, relative, tone: 'danger', overdue: true };
  }
  if (diff < DAY) {
    return { date, relative: `剩 ${Math.max(1, Math.ceil(diff / HOUR))} 小时`, tone: 'warn', overdue: false };
  }
  const days = Math.ceil(diff / DAY);
  return { date, relative: `剩 ${days} 天`, tone: days <= 3 ? 'warn' : 'normal', overdue: false };
}

/** 负责人显示：负责人在场显负责人；**未设置显「未指定」**（执行员工另在 meta 注明——UG-01：空值不冒充）。 */
export function ownerDisplay(
  owner: TaskOwnerRef | null | undefined,
  executor: { id: number; name: string | null } | null | undefined,
): { name: string; meta: string | null; title: string } {
  if (owner) {
    const meta =
      executor && executor.id !== owner.id
        ? `执行：${executor.name ?? `员工#${executor.id}`}`
        : null;
    return {
      name: owner.name,
      meta,
      title: `负责人：${owner.name}${meta ? `（${meta}）` : ''}`,
    };
  }
  const meta = executor ? `执行：${executor.name ?? `员工#${executor.id}`}` : null;
  return { name: '未指定', meta, title: `未指定负责人（按编制/缺省链）${meta ? `；${meta}` : ''}` };
}

/** 依赖摘要：最多 3 个短号；完成态带 ✓；其余折叠为 `+N`。无依赖 → `无`。 */
export function dependencySummary(
  deps: readonly TaskDependencyRef[] | null | undefined,
): { text: string; title: string } {
  if (!deps || deps.length === 0) return { text: '无', title: '无前置任务' };
  const labels = deps.map((dep) => {
    const short = dep.shortId ?? `#${dep.id}`;
    return dep.state === 'done' ? `${short} ✓` : short;
  });
  const head = labels.slice(0, 3).join(' · ');
  const text = labels.length > 3 ? `${head} · +${labels.length - 3}` : head;
  const title = deps
    .map((dep) => `${dep.shortId ?? `#${dep.id}`} · ${dep.title} · ${dep.state}`)
    .join('\n');
  return { text, title };
}

/** 当前强制技能：最后一条 `task_skill_forced` 的 skill；没有/已清除 → null。 */
export function forcedSkillOf(timeline: readonly TimelineItemDTO[] | null | undefined): string | null {
  if (!timeline || timeline.length === 0) return null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const event = timeline[i];
    if (event.kind !== 'task_skill_forced') continue;
    const payload = event.payload as { skill?: unknown } | null | undefined;
    return typeof payload?.skill === 'string' && payload.skill.length > 0 ? payload.skill : null;
  }
  return null;
}

/** 上下文条的数据形状（TaskDetail 内部用；导出便于测试）。 */
export interface TaskContextView {
  goal: string;
  project: string;
  owner: { name: string; meta: string | null; title: string };
  deadline: DeadlineInfo;
  deps: { text: string; title: string };
}

export function taskContextView(data: TaskDetailDTO, now: number = Date.now()): TaskContextView {
  return {
    goal: data.task.goal?.trim() || '未填写目标',
    project:
      data.task.projectName ??
      (data.task.projectAlias ? `项目 ${data.task.projectAlias}` : '未归属项目'),
    owner: ownerDisplay(data.owner, data.task.executor),
    deadline: formatDeadline(data.task.deadline, now),
    deps: dependencySummary(data.dependsOn),
  };
}
