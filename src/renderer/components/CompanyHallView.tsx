/**
 * 公司大厅 · **纯展示**（2026-10-17 双栏改版：要求「不做跳转，一页两栏」）。
 *
 * 中栏＝左列 **部门/员工名单**（选中行 panel-2）＋ 右栏 **员工 · 当前任务**（只读；
 * 改人去设置）／**部门协作**／**实时活动流**（左列底部按钮切换）。点人＝右栏切换，**不跳页**。
 * 本文件**不读写 store、不碰 IPC**（容器见 `CompanyHall.tsx`），故可在 node 里用
 * `renderToStaticMarkup` 断言。
 *
 * `data-testid` 契约（稳定）：`company-hall` / `hall-stats` / `hall-status-running|waiting|stuck|idle` /
 * `hall-departments` / `hall-department` / `hall-dept-name` / `hall-employee` / `hall-emp-status` /
 * `hall-ungrouped` / `hall-empty` / `hall-error` / `hall-collab` / `hall-collab-edge` /
 * `hall-recruit` / `hall-roster` / `hall-open-collab`；
 *  新增：`hall-emp-activity` / `hall-emp-task` / `hall-open-activity` / `hall-activity` /
 * `hall-activity-item`。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import type { CollabEdgeDTO, DepartmentDTO, EmployeeDTO, EmployeeDetailDTO, HallStateDTO } from '../types.js';
import { avatarChar } from './taskVisuals.js';
import { EmployeePane } from './EmployeePane.js';
import { SplitLayout } from './SplitLayout.js';

/** 部门分组（含「未分组」）：把员工按 `memberIds` 归组，**未在任何部门的落到「未分组」**（不隐藏、不臆造）。 */
export function groupByDepartment(data: HallStateDTO): {
  groups: Array<{ id: string; name: string; employees: EmployeeDTO[] }>;
  ungrouped: EmployeeDTO[];
} {
  const inDept = new Set<number>();
  for (const dept of data.departments) for (const id of dept.memberIds) inDept.add(id);
  const groups = data.departments.map((dept: DepartmentDTO) => ({
    id: dept.id,
    name: dept.name,
    employees: dept.memberIds
      .map((id) => data.employees.find((e) => e.id === id))
      .filter((e): e is EmployeeDTO => e !== undefined),
  }));
  const ungrouped = data.employees.filter((e) => !inDept.has(e.id));
  return { groups, ungrouped };
}

/**
 * 一条协作边的文案：**只报真实次数、中性文案**（1773：不得凭 `count` 编出动作名细分）。
 * 例：`产品部 → 研发部 · 近 7 天 1 次`。
 */
export function collabEdgeText(edge: CollabEdgeDTO, deptName: (id: string) => string, windowDays?: number): string {
  const from = deptName(edge.from);
  const to = deptName(edge.to);
  const window = typeof windowDays === 'number' && windowDays > 0 ? `近 ${windowDays} 天 ` : '';
  return `${from} → ${to} · ${window}${edge.count} 次`;
}

/** 状态 → 语义色 tone（与任务状态点同族）。 */
const STATUS_TONE: Record<string, string> = {
  running: 'accent',
  waiting: 'warn',
  stuck: 'danger',
  idle: 'dim',
};
/** 状态 → 人话（色点之外的第二编码；不只靠颜色；与 `UI §6.1` 状态表同口径）。 */
const STATUS_TEXT: Record<string, string> = {
  running: '思考中',
  waiting: '等你',
  stuck: '卡住了',
  idle: '空闲',
};

/** 状态读数（页头图例；真计数——没有该项也不写假数）。 */
export function statusCounts(employees: readonly EmployeeDTO[]): {
  running: number;
  waiting: number;
  stuck: number;
  idle: number;
} {
  let running = 0;
  let waiting = 0;
  let stuck = 0;
  let idle = 0;
  for (const employee of employees) {
    const status = employee.activity?.status ?? 'idle';
    if (status === 'running') running += 1;
    else if (status === 'waiting') waiting += 1;
    else if (status === 'stuck') stuck += 1;
    else idle += 1;
  }
  return { running, waiting, stuck, idle };
}

/** 活动流时间（本地 HH:MM；只做展示，不参与判断）。 */
function activityTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 名单行（：头像＋名/角色＋当前任务短号/时长/今日读数＋状态点；点行＝右栏切换）。 */
function EmployeeRow({
  employee,
  selected,
  onOpen,
  onOpenTask,
}: {
  employee: EmployeeDTO;
  selected: boolean;
  onOpen?: (id: number) => void;
  /** 点当前任务短号 → 任务详情（不冒泡成“选员工”）。 */
  onOpenTask?: (taskId: number) => void;
}): ReactElement {
  const status = employee.activity?.status ?? 'idle';
  const activity = employee.activity;
  const currentMinutes =
    typeof activity?.currentMinutes === 'number' && activity.currentMinutes > 0 ? activity.currentMinutes : null;
  return (
    <div
      className="hall-row"
      data-testid="hall-employee"
      data-employee-id={employee.id}
      data-status={status}
      role="button"
      tabIndex={onOpen ? 0 : -1}
      aria-current={selected ? 'page' : undefined}
      aria-disabled={onOpen ? undefined : true}
      title={onOpen ? `看 ${employee.name} 当前在做什么（右栏）` : undefined}
      onClick={() => onOpen?.(employee.id)}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(employee.id);
        }
      }}
    >
      <span className="hall-row__avatar" aria-hidden="true">
        {avatarChar(employee.name)}
      </span>
      <span className="hall-row__main">
        <span className="hall-row__name">
          {employee.name}
          {employee.isAssistant && !employee.name.includes('幕僚长') ? '（幕僚长）' : ''}
        </span>
        <span className="hall-row__role">{employee.role}</span>
        {activity ? (
          <span className="hall-row__activity" data-testid="hall-emp-activity">
            {activity.taskShortId ? (
              <button
                type="button"
                className="hall-row__tasklink"
                data-testid="hall-emp-task"
                data-task-id={activity.taskId ?? ''}
                disabled={!onOpenTask || activity.taskId == null}
                title={activity.taskId == null ? '任务记录缺失' : '打开任务详情'}
                onClick={(event) => {
                  event.stopPropagation();
                  if (activity.taskId != null) onOpenTask?.(activity.taskId);
                }}
              >
                {activity.taskShortId}
              </button>
            ) : null}
            {currentMinutes != null ? <span> · {currentMinutes} 分钟</span> : null}
            <span> · 今日 {activity.todayOutput} 件</span>
            {typeof activity.todayMinutes === 'number' ? <span> · 今日 {activity.todayMinutes} 分钟</span> : null}
            {typeof activity.todayArtifacts === 'number' && activity.todayArtifacts > 0 ? (
              <span> · {activity.todayArtifacts} 产出</span>
            ) : null}
          </span>
        ) : null}
        {/* 当前动作（等你裁定/上一件…）——有才渲染，不摆占位。
            2026-10-25：空闲员工别千篇一律——显「空闲 · 上一件：X」，无历史显「空闲 · 暂无近期任务」。 */}
        {status === 'idle' ? (
          <span className="hall-row__action" data-testid="hall-emp-action" title={activity?.currentAction ?? '空闲'}>
            空闲 · {activity?.currentAction ?? '暂无近期任务'}
          </span>
        ) : activity?.currentAction ? (
          <span className="hall-row__action" data-testid="hall-emp-action" title={activity.currentAction}>
            {activity.currentAction}
          </span>
        ) : null}
      </span>
      <span className="hall-row__state" data-testid="hall-emp-state-text">
        {STATUS_TEXT[status] ?? '空闲'}
      </span>
      <span className="hall-row__dot" data-testid="hall-emp-status" data-tone={STATUS_TONE[status] ?? 'dim'} aria-hidden="true" />
    </div>
  );
}

export function CompanyHallView({
  data,
  loading = false,
  error = null,
  selectedEmployeeId = null,
  pane = 'employee',
  employeeDetail = null,
  employeeLoading = false,
  employeeError = null,
  onSelectEmployee,
  onOpenCollab,
  onOpenActivity,
  onRecruit,
  onOpenTask,
  onBackFromEmployee,
  onGoChannel,
}: {
  data: HallStateDTO | null;
  loading?: boolean;
  error?: string | null;
  /** 右栏：当前选中员工（`employee` 分区）。 */
  selectedEmployeeId?: number | null;
  /** 右栏分区：`employee`＝员工当前任务（缺省）；`collab`＝部门协作；`activity`＝实时活动流。 */
  pane?: 'employee' | 'collab' | 'activity';
  /** 右栏员工详情（`employee:get`；容器取）。 */
  employeeDetail?: EmployeeDetailDTO | null;
  employeeLoading?: boolean;
  employeeError?: string | null;
  /** 左列点人 → 右栏切换（**不跳页**）。 */
  onSelectEmployee?: (id: number) => void;
  /** 左列底部「部门协作」→ 右栏协作流向。 */
  onOpenCollab?: () => void;
  /** 左列底部「活动流」→ 右栏实时公司动态。 */
  onOpenActivity?: () => void;
  /** 左列底部「＋招募」→ 大厅内招募对话框（不跳频道）。 */
  onRecruit?: () => void;
  /** 右栏员工卡片里的「打开任务 ▸」→ 任务详情（跨层）。 */
  onOpenTask?: (taskId: number) => void;
  /** 右栏员工详情里的返回口（嵌入态不显示页头；留作空态/错误时的出口）。 */
  onBackFromEmployee?: () => void;
  /** 全员空闲时右栏的唯一动作。 */
  onGoChannel?: () => void;
}): ReactElement {
  // 2026-10-20 密度批：活动流默认只显示最近 8 条，避免长列表把右栏拖着翻；展开后全量。
  const [activityExpanded, setActivityExpanded] = useState(false);
  const activityAll = data?.activityLog ?? [];
  const activityShown = activityExpanded ? activityAll : activityAll.slice(0, 8);
  if (error) {
    return (
      <section className="hall-page" data-testid="company-hall">
        <div className="hall__muted" data-testid="hall-error">
          公司大厅数据加载失败：{error}
        </div>
      </section>
    );
  }

  if (!data || data.employees.length === 0) {
    return (
      <section className="hall-page" data-testid="company-hall">
        <aside className="hall-page__list">
          <header className="hall-page__head">
            <h2 className="hall-page__title">公司大厅</h2>
          </header>
          <div className="hall-page__group" data-testid="hall-empty">
            <span>{loading ? '加载中…' : '暂无动态'}</span>
            <span className="hall__muted">还没有员工。点下方「＋招募」直接招一名。</span>
            <button type="button" className="hall-page__btn" data-testid="hall-recruit" onClick={onRecruit}>
              ＋招募
            </button>
          </div>
        </aside>
        <div className="hall-page__pane">
          <p className="hall-page__hint">左列还没有员工。</p>
        </div>
      </section>
    );
  }

  const edges = data.collab.filter((edge) => edge.count > 0);
  const deptName = (id: string): string => data.departments.find((d) => d.id === id)?.name ?? id;
  const counts = statusCounts(data.employees);
  const busyCount = counts.running + counts.waiting + counts.stuck;
  const selected = data.employees.find((employee) => employee.id === selectedEmployeeId) ?? null;

  // 2026-11-04 SplitLayout 接入（批次 3）：窄窗堆叠＋名单折叠头（缺省收起）； 的 34vh 截断退役。
  return (
    <div data-testid="company-hall" style={{ height: '100%' }}>
      <SplitLayout
        sideWidth={300}
        label="员工名单"
        storageKey="hall"
        count={data.employees.length}
        side={
        <aside className="hall-page__list" data-testid="hall-roster" aria-label="员工名单">
        <header className="hall-page__head">
          <h2 className="hall-page__title">公司大厅</h2>
          <div className="hall__stats" data-testid="hall-stats">
            <span data-testid="hall-on-duty">{data.employees.length} 人在岗</span>
            <span className="hall__muted" aria-hidden="true">
              ·
            </span>
            <span data-testid="hall-busy">{busyCount} 人在忙</span>
          </div>
        </header>

        <div className="hall-page__rows" data-testid="hall-roster-list">
          {data.employees.map((employee) => (
            <EmployeeRow
              key={employee.id}
              employee={employee}
              selected={employee.id === selectedEmployeeId}
              onOpen={onSelectEmployee}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>

        <footer className="hall-page__actions">
          <button
            type="button"
            className="hall-page__btn"
            data-testid="hall-open-activity"
            aria-pressed={pane === 'activity'}
            onClick={onOpenActivity}
          >
            活动流
          </button>
          <button
            type="button"
            className="hall-page__btn"
            data-testid="hall-open-collab"
            aria-pressed={pane === 'collab'}
            onClick={onOpenCollab}
          >
            部门协作
          </button>
          <button
            type="button"
            className="hall-page__btn"
            data-testid="hall-recruit"
            title="招募一名员工（名字/角色/偏好模型）"
            onClick={onRecruit}
          >
            ＋招募
          </button>
        </footer>
        </aside>
        }
        main={
      <div className="hall-page__pane">
        {pane === 'activity' ? (
          <div className="hall__card" data-testid="hall-activity">
            <h3 className="hall__grouptitle">
              公司动态 · 显示 {activityShown.length}/{activityAll.length} 条
            </h3>
            {activityAll.length === 0 ? (
              <div className="hall__muted">暂无动态。</div>
            ) : (
              <ul className="hall-activity">
                {activityShown.map((item) => (
                  <li key={item.id} className="hall-activity__item" data-testid="hall-activity-item" data-kind={item.kind}>
                    <button
                      type="button"
                      className="hall-activity__btn"
                      disabled={onOpenTask == null}
                      title={onOpenTask ? '打开任务详情' : undefined}
                      onClick={() => onOpenTask?.(item.taskId)}
                    >
                      <span className="hall-activity__dot" data-tone={item.tone} aria-hidden="true" />
                      <span className="hall-activity__main">
                        <span className="hall-activity__text">{item.text}</span>
                        {item.detail ? <span className="hall-activity__detail">{item.detail}</span> : null}
                      </span>
                      <span className="hall-activity__meta">
                        {item.actorName} · {activityTime(item.ts)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {activityAll.length > 8 ? (
              <button
                type="button"
                className="hall-page__btn"
                data-testid="hall-activity-more"
                onClick={() => setActivityExpanded((value) => !value)}
              >
                {activityExpanded ? '收起' : `展开全部（${activityAll.length}）`}
              </button>
            ) : null}
          </div>
        ) : pane === 'collab' ? (
          <div className="hall__card" data-testid="hall-collab">
            <h3 className="hall__grouptitle">部门协作 · 近 {data.windowDays ?? 7} 天</h3>
            {edges.length === 0 ? (
              <div className="hall__muted">暂无真实协作记录（没有往来就不画边）。</div>
            ) : (
              <div className="hall__edges">
                {edges.map((edge) => (
                  <span
                    key={`${edge.from}->${edge.to}`}
                    className="hall__edge"
                    data-testid="hall-collab-edge"
                    data-from={edge.from}
                    data-to={edge.to}
                    data-count={edge.count}
                  >
                    {collabEdgeText(edge, deptName, data.windowDays)}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : busyCount === 0 ? (
          <div className="hall__card" data-testid="hall-idle">
            <h3 className="hall__grouptitle">全员空闲</h3>
            <p className="hall__muted">现在没有在跑的任务。每个人最近的情况：</p>
            {/* 2026-10-25：全员空闲时右栏大栏不要空着——列出每人「空闲 · 上一件：X」。 */}
            <ul className="hall-idle-list" data-testid="hall-idle-list">
              {(data?.employees ?? []).map((employee) => (
                <li key={employee.id} data-testid="hall-idle-employee">
                  <strong>{employee.name}</strong>
                  <span className="hall-idle-list__action">
                    空闲 · {employee.activity?.currentAction ?? '暂无近期任务'}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="hall-page__btn" data-testid="hall-idle-channel" onClick={onGoChannel}>
              去老板频道
            </button>
          </div>
        ) : selected != null ? (
          <EmployeePane
            detail={employeeDetail}
            loading={employeeLoading}
            error={employeeError}
            mode="ops"
            embedded
            onBack={onBackFromEmployee ?? (() => undefined)}
            onOpenTask={onOpenTask}
          />
        ) : (
          <p className="hall-page__hint">点左侧员工看 TA 当前在做什么。</p>
        )}
      </div>
        }
      />
    </div>
  );
}
