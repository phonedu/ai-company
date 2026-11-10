/**
 * 项目树页 / 归档页（2026-10-18，老板裁「站在导航栏的就是导航，就该开一个页面」）——**纯展示**
 *   （props 进 DOM 出，可 node 测）；数据面＝`tasks.list`（归档页进页时容器会先拉 `includeArchived`）。
 *
 * 口径：
 *   - **项目树页**（一级页，无返回）：按项目归并（组题＝名＋别名＋N 个任务，**可点进项目概览**）＋
 *     组内任务行（点 → 任务详情）；空态＝「还没有项目」；
 *   - **归档页**（一级页，无返回）：归档任务列表（行同款，点 → 详情）＋计数；空态＝「暂无归档任务」；
 *   - 行＝状态点（语义色，`taskVisuals`）＋短号＋标题（截断）＋执行员工头像——与左栏同款（同一份
 *     `taskVisuals`，防漂移；行结构简版：不含任务行内的归档钮/等待小字）。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import type { TaskDTO } from '../types.js';
import { EmptyState } from './EmptyState.js';
import { PROJECT_STATE_LABEL } from './projectView.js';
import { avatarChar, STATE_TONE } from './taskVisuals.js';
import { waitingSummary } from './waitingReason.js';

export type ArchiveFilter = 'all' | 'done' | 'cancelled';

/** 归档行状态人话（done/cancelled 用「已完成/已取消」，与筛选一致）。 */
function archiveStateLabel(state: string): string {
  if (state === 'done') return '已完成';
  if (state === 'cancelled') return '已取消';
  return PROJECT_STATE_LABEL[state] ?? state;
}

/** 归档筛选（纯函数，可单测）：只认终态；failed 保留在「全部」。 */
export function filterArchivedTasks(tasks: readonly TaskDTO[], filter: ArchiveFilter): TaskDTO[] {
  const archived = tasks.filter((task) => task.archived === 1);
  if (filter === 'all') return archived;
  return archived.filter((task) => task.state === filter);
}

/** 行（简版任务行；左栏行另有等待小字与归档钮——本页只做"看、续办"）。 */
export function TaskListItem({
  task,
  onOpen,
  onRenew,
  selectable = false,
  selected = false,
  onSelectToggle,
}: {
  task: TaskDTO;
  onOpen?: (id: number) => void;
  onRenew?: (id: number) => void;
  /** 2026-10-29 P2（D-N08）：归档页批量续办用的勾选。 */
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: number) => void;
}): ReactElement {
  const waitText = waitingSummary(task.waits);
  return (
    <li className="tlist__row" data-testid="tlist-row" data-task-id={task.id} data-state={task.state}>
      {selectable ? (
        <input
          type="checkbox"
          className="tlist__select"
          data-testid="tlist-select"
          aria-label={`选择 ${task.shortId ?? `#${task.id}`}`}
          checked={selected}
          onChange={() => onSelectToggle?.(task.id)}
        />
      ) : null}
      <span
        className="tlist__dot"
        data-testid="tlist-dot"
        data-tone={STATE_TONE[task.state] ?? 'dim'}
        aria-hidden="true"
      />
      <button type="button" className="tlist__open" data-testid="tlist-open" title="打开任务详情" onClick={() => onOpen?.(task.id)}>
        <span className="tlist__short">{task.shortId ?? `#${task.id}`}</span>
        <span className="tlist__title">{task.title}</span>
        {waitText ? (
          <span className="tlist__wait" data-testid="tlist-wait" title={waitText}>
            {waitText}
          </span>
        ) : null}
      </button>
      <span className="tlist__state" data-testid="tlist-state">
        {archiveStateLabel(task.state)}
      </span>
      {task.executor ? (
        <span className="tlist__avatar" data-testid="tlist-avatar" title={`执行：${task.executor.name ?? `员工#${task.executor.id}`}`}>
          {avatarChar(task.executor.name)}
        </span>
      ) : null}
      <span className="tlist__actions">
        <button type="button" data-testid="tlist-view" onClick={() => onOpen?.(task.id)}>
          查看
        </button>
        <button
          type="button"
          data-testid="tlist-renew"
          disabled={!onRenew}
          title={onRenew ? '以该任务为来源续办' : '续办未接线'}
          onClick={() => onRenew?.(task.id)}
        >
          续办
        </button>
      </span>
    </li>
  );
}

/** 归档页：归档任务列表＋全部/已完成/已取消筛选；每行只留「查看 / 续办」。 */
export function ArchiveView({
  tasks,
  onOpenTask,
  onRenewTask,
  renewNotice,
  error = null,
  onRetry,
  archivedProjects = [],
  onOpenProject,
  onRestoreProject,
  onExportProject,
  onDeleteProject,
  actionError = null,
  actionMessage = null,
}: {
  /** **含归档行**的列表（容器进页时已按 `includeArchived` 取）。 */
  tasks: readonly TaskDTO[];
  onOpenTask?: (taskId: number) => void;
  onRenewTask?: (taskId: number) => void;
  /** 续办回执（失败也在这里显式给出；不静默）。 */
  renewNotice?: string | null;
  /** 2026-11-03（逐页错误注入）：加载失败显式报错，不伪装成「暂无归档」。 */
  error?: string | null;
  onRetry?: () => void;
  /** UI-2 S2b：归档项目（恢复/导出/删除的唯一入口在这里；项目页只留任务与归档动作）。 */
  archivedProjects?: ReadonlyArray<{ projectId: number; name: string; alias: string | null; taskCount: number }>;
  onOpenProject?: (projectId: number) => void;
  onRestoreProject?: (projectId: number) => void;
  onExportProject?: (projectId: number) => void;
  onDeleteProject?: (projectId: number) => void;
  /** S2b 复核 P2：恢复/导出/删除的回执（此前失败静默，只写进 projectActions）。 */
  actionError?: string | null;
  actionMessage?: string | null;
}): ReactElement {
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [filter, setFilter] = useState<ArchiveFilter>('all');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const archived = filterArchivedTasks(tasks, 'all');
  const filtered = filterArchivedTasks(tasks, filter);
  const visibleIds = filtered.map((task) => task.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (): void => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  };
  const counts: Record<ArchiveFilter, number> = {
    all: archived.length,
    done: archived.filter((task) => task.state === 'done').length,
    cancelled: archived.filter((task) => task.state === 'cancelled').length,
  };
  const tabs: Array<{ key: ArchiveFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'done', label: '已完成' },
    { key: 'cancelled', label: '已取消' },
  ];
  return (
    <section className="tlist" data-testid="archive-view">
      <header className="tlist__head">
        <h2 className="tlist__title">归档</h2>
        <span className="tlist__count" data-testid="archive-count">
          {archived.length} 个任务
        </span>
      </header>
      {/* UI-2 S2b（2026-11-09）：归档项目的**集中入口**——恢复/导出/删除在这里一律可达；
          项目页的「已归档」分支仍保留同样三个按钮（你正打开那个项目时的上下文操作），两处同源。 */}
      {archivedProjects.length > 0 ? (
        <section className="tlist__archived-projects" data-testid="archive-projects">
          <h3 className="tlist__subtitle">归档项目（{archivedProjects.length} 个）</h3>
          {archivedProjects.map((p) => (
            <div className="tlist__archived-project-row" data-testid="archive-project-row" data-project-id={p.projectId} key={p.projectId}>
              <button
                type="button"
                className="tlist__linklike"
                data-testid="archive-project-open"
                onClick={() => onOpenProject?.(p.projectId)}
                title="打开项目页"
              >
                {p.name}
                {p.alias ? `（${p.alias}）` : ''}
              </button>
              <span className="tlist__muted">{p.taskCount} 个任务</span>
              <button type="button" data-testid="archive-project-restore" onClick={() => onRestoreProject?.(p.projectId)}>
                恢复
              </button>
              <button type="button" data-testid="archive-project-export" onClick={() => onExportProject?.(p.projectId)}>
                导出
              </button>
              {confirmDeleteId === p.projectId ? (
                <>
                  <span className="tlist__muted">删除后不可恢复，确定？</span>
                  <button type="button" data-testid="archive-project-delete-confirm" onClick={() => { setConfirmDeleteId(null); onDeleteProject?.(p.projectId); }}>
                    确认删除
                  </button>
                  <button type="button" data-testid="archive-project-delete-cancel" onClick={() => setConfirmDeleteId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="archive-project-delete"
                  disabled={p.taskCount > 0}
                  title={
                    p.taskCount > 0
                      ? `项目下还有 ${p.taskCount} 个任务；当前只允许删除空归档项目（文件夹不动）`
                      : '只删项目行；删除前会自动导出档案；文件夹不动'
                  }
                  onClick={() => setConfirmDeleteId(p.projectId)}
                >
                  删除
                </button>
              )}
            </div>
          ))}
        </section>
      ) : null}
      {/* 复核补（2026-11-10）：回执必须**独立于行**——删掉最后一个归档项目后区块整体卸载，
          此前「已删除项目 #3」的确认也跟着消失（真机实抓 message=null）。放区块外，0 行也可见。 */}
      {actionError != null && actionError.length > 0 ? (
        <p className="tlist__action-error" data-testid="archive-project-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {actionMessage != null && actionMessage.length > 0 ? (
        <p className="tlist__muted" data-testid="archive-project-action-message">
          {actionMessage}
        </p>
      ) : null}
      {error != null && error.length > 0 ? (
        <div className="tlist__error" data-testid="archive-error" role="alert">
          <span>归档加载失败：{error}</span>
          <button type="button" data-testid="archive-error-retry" onClick={() => onRetry?.()}>
            重试
          </button>
        </div>
      ) : null}
      {renewNotice ? (
        <p className="tlist__notice" data-testid="archive-renew-notice" role="status">
          {renewNotice}
        </p>
      ) : null}
      {filtered.length > 0 ? (
        <div className="tlist__batch" data-testid="archive-batch">
          <label>
            <input type="checkbox" data-testid="archive-select-all" checked={allVisibleSelected} onChange={toggleSelectAll} />{' '}
            全选（当前筛选）
          </label>
          <button
            type="button"
            data-testid="archive-batch-renew"
            disabled={selected.size === 0 || !onRenewTask}
            title={onRenewTask ? '以选中任务为来源批量续办' : '续办未接线'}
            onClick={() => {
              for (const id of [...selected]) onRenewTask?.(id);
              setSelected(new Set());
            }}
          >
            批量续办（{selected.size}）
          </button>
        </div>
      ) : null}
      {archived.length > 0 ? (
        <div className="tlist__filters" data-testid="archive-filters">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-testid={`archive-filter-${tab.key}`}
              aria-pressed={filter === tab.key}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label} {counts[tab.key]}
            </button>
          ))}
        </div>
      ) : null}
      {/* 归档＝软操作（文件夹未动）；归档任务仍可点进详情（只读回溯）。 */}
      {error != null && error.length > 0 ? null : archived.length === 0 ? (
        <EmptyState
          testid="archive-empty"
          variant="page"
          title="暂无归档任务"
          hint="归档是软操作，任务文件夹不会动。"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          testid="archive-filter-empty"
          variant="page"
          title="没有符合筛选的任务"
          hint="切回「全部」看所有归档任务。"
        />
      ) : (
        <ul className="tlist__rows" data-testid="archive-list">
          {filtered.map((task) => (
            <TaskListItem
              key={task.id}
              task={task}
              onOpen={onOpenTask}
              onRenew={onRenewTask}
              selectable
              selected={selected.has(task.id)}
              onSelectToggle={toggleSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 左列项目列表（纯视图，可 node 测）：名＋别名＋任务数；选中行 panel-2；点＝切换右栏。 */
export function ProjectsList({
  groups,
  archivedGroups = [],
  selectedId,
  onSelect,
  error = null,
}: {
  groups: ReadonlyArray<{
    projectId: number;
    name: string;
    alias: string | null;
    taskCount: number;
    /** P2（D-N10）：第二读数（可选，兼容旧调用）。 */
    runningCount?: number;
    waitingCount?: number;
    failedCount?: number;
  }>;
  /** 归档项目：折叠显示，保证导出/删除/恢复仍有入口。 */
  archivedGroups?: ReadonlyArray<{
    projectId: number;
    name: string;
    alias: string | null;
    taskCount: number;
    /** P2（D-N10）：归档组同样带第二读数（可选，兼容旧调用）。 */
    runningCount?: number;
    waitingCount?: number;
    failedCount?: number;
  }>;
  selectedId: number | null;
  onSelect?: (projectId: number) => void;
  /** 2026-11-03（逐页错误注入）：加载失败显式报错，不伪装成空。 */
  error?: string | null;
}): ReactElement {
  return (
    <>
      <header className="projects-page__head">
        <h2 className="projects-page__title">项目</h2>
        <span className="projects-page__count" data-testid="ptree-count">
          {groups.length} 个
        </span>
      </header>
      {error != null && error.length > 0 ? (
        <p className="projects-page__error" data-testid="ptree-error" role="alert">
          项目列表加载失败：{error}
        </p>
      ) : groups.length === 0 && archivedGroups.length === 0 ? (
        <EmptyState
          testid="ptree-empty"
          variant="page"
          title="还没有项目"
          hint="新建项目或从老板频道建任务后，项目会出现在这里。"
        />
      ) : null}
      {groups.map((group) => (
        <button
          key={group.projectId}
          type="button"
          className="projects-page__item"
          data-testid="ptree-group"
          data-project-id={group.projectId}
          aria-current={selectedId === group.projectId ? 'page' : undefined}
          onClick={() => onSelect?.(group.projectId)}
        >
          <span className="projects-page__itemname">
            {group.name}
            {group.alias ? `（${group.alias}）` : ''}
          </span>
          <span className="projects-page__itemcount">
            {group.taskCount} 个任务
            {(group.runningCount ?? 0) > 0 ? ` · 进行 ${group.runningCount}` : ''}
            {(group.waitingCount ?? 0) > 0 ? ` · 待你处理 ${group.waitingCount}` : ''}
            {(group.failedCount ?? 0) > 0 ? ` · 失败 ${group.failedCount}` : ''}
          </span>
        </button>
      ))}
      {archivedGroups.length === 0 ? null : (
        <details className="projects-page__archived" data-testid="ptree-archived">
          <summary className="projects-page__archived-summary">已归档（{archivedGroups.length}）</summary>
          {archivedGroups.map((group) => (
            <button
              key={group.projectId}
              type="button"
              className="projects-page__item"
              data-testid="ptree-archived-group"
              data-project-id={group.projectId}
              aria-current={selectedId === group.projectId ? 'page' : undefined}
              onClick={() => onSelect?.(group.projectId)}
            >
              <span className="projects-page__itemname">
                {group.name}
                {group.alias ? `（${group.alias}）` : ''}
              </span>
              <span className="projects-page__itemcount">
            {group.taskCount} 个任务
            {(group.runningCount ?? 0) > 0 ? ` · 进行 ${group.runningCount}` : ''}
            {(group.waitingCount ?? 0) > 0 ? ` · 待你处理 ${group.waitingCount}` : ''}
            {(group.failedCount ?? 0) > 0 ? ` · 失败 ${group.failedCount}` : ''}
          </span>
            </button>
          ))}
        </details>
      )}
    </>
  );
}
