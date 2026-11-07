/**
 * 项目树页（2026-10-17 双栏改版，老板令「不做跳转，一页两栏；任务树放右栏」）：
 *   左列＝**项目列表**（名＋别名＋任务数；选中行 panel-2）；右列＝该项目**概览**（`ProjectOverview`）。
 *   点项目＝右栏切换（不跳页）；右栏任务树行「打开 ▸」→ 任务详情（跨层，返回回本页）。
 *
 * 数据：`store.projectActions.list`（`project:list`，**空项目也显示**）＋ `store.tasks.list`（补任务/计数）；
 * 选中 id＝`session.selectedProjectId`。
 * 选中失效/初次进入 ⇒ **自动选第一个项目**（右栏不空；无项目＝空态，不白屏）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { attachExistingProject, createProject, loadProjectsForOverview, loadTasks, projectActions, session, showArchive, showProject, tasks } from '../store.js';
import type { ProjectDTO, TaskDTO } from '../types.js';
import { EmptyState } from './EmptyState.js';
import { ProjectOverview } from './ProjectOverview.js';
import { ProjectsList } from './TaskListViews.js';
import { archivedProjectsFromList, projectsFromList } from './projectView.js';
import { SplitLayout, useNarrowViewport } from './SplitLayout.js';

export function ProjectsPage(): ReactElement {
  const tasksSnap = useSnapshot(tasks);
  const projectsSnap = useSnapshot(projectActions);
  const sessionSnap = useSnapshot(session);
  // M2 尾：新建项目入口（父目录由主进程 dialog 选；renderer 只给名字）。
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [docsTemplate, setDocsTemplate] = useState(true);
  const [createError, setCreateError] = useState('');
  const [attachError, setAttachError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  // UI-2 S1：项目列表瘦身——搜索过滤（名/别名）。
  const allGroups = projectsFromList(
    projectsSnap.list as unknown as ProjectDTO[],
    (tasksSnap.list as unknown as TaskDTO[]).filter((task) => task.archived !== 1),
  );
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = q.length === 0
    ? allGroups
    : allGroups.filter((g) => g.name.toLowerCase().includes(q) || (g.alias ?? '').toLowerCase().includes(q));
  // F3-12/F3-14：归档项目折叠可见；任务数用全量任务（含已归档）算，不写死 0。
  const narrow = useNarrowViewport();
  const archivedGroups = archivedProjectsFromList(
    projectsSnap.list as unknown as ProjectDTO[],
    tasksSnap.list as unknown as TaskDTO[],
  );
  const selected = sessionSnap.selectedProjectId;
  const firstId = groups[0]?.projectId ?? null;

  useEffect(() => {
    // 项目树以 project:list 为准（空项目也要显示）；归档任务也拉一次，供折叠组真计数。
    void loadProjectsForOverview();
    void loadTasks({ includeArchived: true });
  }, []);

  async function submitCreate(): Promise<void> {
    if (name.trim().length === 0 || createBusy) return;
    setCreateBusy(true);
    setCreateError('');
    const res = await createProject(name.trim(), docsTemplate);
    setCreateBusy(false);
    if (!res.ok) {
      setCreateError(res.error);
      return;
    }
    setName('');
    setCreating(false);
  }

  useEffect(() => {
    // 选中项以 project:list 全量为准（含归档）：归档后仍能停在原项目导出/删除/恢复。
    const selectedExists = selected != null && projectsSnap.list.some((project) => project.id === selected);
    if (selectedExists) return;
    if (firstId != null) showProject(firstId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在「选中缺失/失效」时补选
  }, [firstId, selected, projectsSnap.list.length]);

  // 2026-11-04 SplitLayout 接入（批次 3）：窄窗堆叠＋项目列表折叠头；页级错误块留在分栏外。
  return (
    <div data-testid="projects-tree-view" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {projectsSnap.error != null || tasksSnap.error != null ? (
        <div className="projects-page__listerror" data-testid="projects-load-error" role="alert">
          <span>项目/任务加载失败：{projectsSnap.error ?? tasksSnap.error}</span>
          <button
            type="button"
            data-testid="projects-load-retry"
            onClick={() => {
              void loadProjectsForOverview();
              void loadTasks({ includeArchived: true });
            }}
          >
            重试
          </button>
        </div>
      ) : null}
      <SplitLayout
        sideWidth={300}
        label="项目列表"
        storageKey="projects"
        count={groups.length + archivedGroups.length}
        side={
      <aside className="projects-page__list" data-testid="projects-list" aria-label="项目">
        <div className="projects-page__head">
          <button
            type="button"
            className="projects-page__create"
            data-split-keep
            data-testid="projects-create"
            onClick={() => {
              setCreateError('');
              setCreating(true);
            }}
          >
            ＋新建项目
          </button>
          {/* S13-E P1/D-N02：第二个及以后的既有仓库从这里接入（与首启同一条 project:attach）。 */}
          <button
            type="button"
            className="projects-page__create projects-page__attach"
            data-split-keep
            data-testid="projects-attach"
            onClick={() => {
              void attachExistingProject().then((r) => {
                if (!r.ok && r.error) setAttachError(r.error);
                else setAttachError('');
              });
            }}
          >
            接入已有文件夹…
          </button>
        </div>
        {attachError ? (
          <p className="projects-page__error" data-testid="projects-attach-error" role="alert">
            接入失败：{attachError}
          </p>
        ) : null}
        {creating ? (
          <form
            className="projects-page__create-form"
            data-split-keep
            data-testid="project-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <input
              className="projects-page__create-input"
              data-testid="project-create-name"
              autoFocus
              value={name}
              placeholder="项目名（父目录稍后选）"
              onChange={(event) => setName(event.target.value)}
            />
            <div className="projects-page__create-actions">
              <button type="submit" data-testid="project-create-submit" disabled={createBusy || name.trim().length === 0}>
                {createBusy ? '创建中…' : '创建'}
              </button>
              <button
                type="button"
                data-testid="project-create-cancel"
                onClick={() => {
                  setCreating(false);
                  setCreateError('');
                }}
              >
                取消
              </button>
            </div>
            <label className="projects-page__create-check">
              <input
                type="checkbox"
                data-testid="project-create-docs"
                checked={docsTemplate}
                disabled={createBusy}
                onChange={(event) => setDocsTemplate(event.target.checked)}
              />
              初始化文档骨架（.aico/docs）
            </label>
            {createError.length > 0 ? (
              <p className="projects-page__create-error" data-testid="project-create-error" role="alert">
                {createError}
              </p>
            ) : null}
            <p className="projects-page__create-hint">
              选父目录后，会在其下新建同名文件夹与 README 骨架；勾选时另建 .aico/docs（入口/宪章/状态/命名），已有文件不覆盖。
            </p>
          </form>
        ) : null}
        <input
          className="projects-page__search"
          data-testid="projects-search"
          value={query}
          placeholder="搜索项目…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <ProjectsList
          error={projectsSnap.error ?? tasksSnap.error ?? null}
          groups={groups}
          archivedGroups={archivedGroups}
          selectedId={selected}
          onSelect={(projectId) => showProject(projectId)}
        />
        <button
          type="button"
          className="projects-page__archive-entry"
          data-testid="projects-archive-entry"
          onClick={() => showArchive()}
        >
          归档（{archivedGroups.length}）
        </button>
      </aside>
        }
        main={
      <div className="projects-page__pane">
        {selected != null ? (
          <ProjectOverview />
        ) : (
          <EmptyState
            variant="page"
            title={groups.length === 0 && archivedGroups.length === 0 ? '还没有项目' : narrow ? '点左上角「项目列表」打开抽屉选择项目' : '选择左侧项目查看概览'}
            hint={
              groups.length === 0 && archivedGroups.length === 0
                ? '新建项目或从老板频道建任务后，项目会出现在这里。'
                : undefined
            }
          />
        )}
      </div>
        }
      />
    </div>
  );
}
