/**
 * M2-A · 项目概览（`UI §534` 的**可做部分**；3152 裁定 (A′)；D-5 ③：项目级操作归位本页）。
 * **只渲染有真数据的部分**：项目名/别名 + 项目级操作（归档）+ 该项目任务（按状态分组）+ 同源计数；
 * 其余（路径/接入模式/产物库/IM 绑定/快捷入口）**只留一行说明**，**不摆空壳卡片**（空态不伪装）。
 * 数据源 = `store.tasks.list`（`task:list`）＋ `store.projectActions.list`（`project:list`，真实归档状态）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import {
  applyCompanyConfig,
  applyProjectDocsOrganize,
  archiveTask,
  archiveProject,
  cancelProjectDocsOrganize,
  checkProjectDocs,
  deleteProject,
  exportProject,
  collapseTaskRow,
  expandTaskInline,
  expandTaskRow,
  companyConfig,
  docsHealth,
  exportCompanyConfig,
  previewCompanyConfig,
  rollbackCompanyConfig,
  docsOrganize,
  loadProjectsForOverview,
  loadSkills,
  projectPage,
  loadStaffingDefaults,
  openProjectDir,
  openTaskDetail,
  pauseResumeTask,
  previewProjectDocsOrganize,
  projectActions,
  restoreProject,
  saveProjectAlias,
  saveProjectAssistantWriteMode,
  saveProjectDefaultSkills,
  saveProjectDocsCheck,
  saveProjectStaffing,
  session,
  skillsLibrary,
  staffingDefaults,
  tasks,
} from '../store';
import type { ProjectDTO, TaskDTO } from '../types';
import { docsHealthView, docsOrganizeDiff, groupProjectTasks, projectActionState, projectsFromList, STAFFING_TIER_LABEL, staffingFromProject, staffingSummary, type StaffingForm } from './projectView';
import { EmptyState } from './EmptyState.js';
import { PencilIcon } from './icons.js';
import { STATE_TONE } from './taskVisuals.js';
import { TaskCreateDialog } from './TaskCreateDialog.js';
import { TaskDetailBody } from './TaskDetailView.js';
import { ProjectTriggers } from './ProjectTriggers.js';
import { ProjectMemory } from './ProjectMemory.js';
import { WAITING_REASON_TEXT, waitingSummary } from './waitingReason.js';

/** 终态集（FLOWS：done/failed/cancelled 才可归档）——自左栏任务行退役后，归档入口在本页任务行。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);


/** UI-2 S1：任务行相对时间（`tasks.updated_at`；无值显 —）。 */
function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (ts == null) return '—';
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** UI-2 S1：项目状态 chip（派生自任务真值；归档优先，不臆造）。 */
function projectStatusOf(tasks: ReadonlyArray<TaskDTO>, archived: boolean): { label: string; tone: string } {
  if (archived) return { label: '已归档', tone: 'done' };
  if (tasks.length === 0) return { label: '空', tone: 'empty' };
  const running = tasks.filter((t) => t.state === 'executing').length;
  const waiting = tasks.filter((t) => t.state === 'needs_decision' || t.state === 'awaiting_approval').length;
  const terminal = tasks.every((t) => TERMINAL_STATES.has(t.state));
  if (running > 0) return { label: '进行中', tone: 'run' };
  if (waiting > 0) return { label: '等待拍板', tone: 'wait' };
  if (terminal) return { label: '已结束', tone: 'done' };
  return { label: '进行中', tone: 'run' };
}

export function ProjectOverview(): ReactElement {
  const sessionSnap = useSnapshot(session);
  const tasksSnap = useSnapshot(tasks);
  const actionsSnap = useSnapshot(projectActions);
  const staffingSnap = useSnapshot(staffingDefaults);
  const skillsSnap = useSnapshot(skillsLibrary);
  const companySnap = useSnapshot(companyConfig);
  // 项目分工 v1（D-11）：编辑态＝本地草稿（初值从项目 DTO 取；保存走 store，成功即退出编辑）。
  /** 验收后复查 A：项目别名编辑（新项目/既有项目都从这里写入；`#别名` 解析同源）。 */
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasSaving, setAliasSaving] = useState(false);
  const [aliasError, setAliasError] = useState('');
  /** CR14：空归档项目删除的二次确认。 */
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // P0/C1（S13-E）：归档前让老板选处理方式（不再一键静默暂停）。
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  // S13-G / C3：项目变更历史（project:get 扩展的 changesets；只读）。
  const [history, setHistory] = useState<Array<{
    id: number; taskId: number; shortId: string | null; branch: string | null; headSha: string | null;
    state: string; filesChanged: number; insertions: number; deletions: number;
    summary: string | null; commitMsg: string | null; createdAt: number; mergedAt: number | null;
  }>>([]);
  useEffect(() => {
    const api = (window as unknown as { api?: { project?: { get?: (input: { projectId: number }) => Promise<unknown> } } }).api;
    const id = sessionSnap.selectedProjectId;
    if (id == null || !api?.project?.get) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    void api.project
      .get({ projectId: id })
      .then((raw) => {
        if (cancelled) return;
        const list = (raw as { changesets?: typeof history } | null)?.changesets;
        setHistory(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionSnap.selectedProjectId, tasksSnap.list.length]);
  const [staffingEditing, setStaffingEditing] = useState(false);
  const [staffingDraft, setStaffingDraft] = useState<StaffingForm | null>(null);
  const [staffingSaving, setStaffingSaving] = useState(false);
  const [staffingError, setStaffingError] = useState('');
  const [docsCheckSaving, setDocsCheckSaving] = useState(false);
  const [docsCheckError, setDocsCheckError] = useState('');
  /** D-19 P1：频道助手项目写权限草稿（保存后以 project:list 真值为准）。 */
  const [writeModeDraft, setWriteModeDraft] = useState<'read-only' | 'confirm' | 'auto'>('confirm');
  const [writeModeSaving, setWriteModeSaving] = useState(false);
  const [writeModeError, setWriteModeError] = useState('');
  const [writeModeNotice, setWriteModeNotice] = useState('');
  /** B3（M3-N-3）：项目默认技能草稿（技能名数组；保存后以 project:list 真值为准）。 */
  const [projectSkillsDraft, setProjectSkillsDraft] = useState<string[] | null>(null);
  const [projectSkillsSaving, setProjectSkillsSaving] = useState(false);
  const [projectSkillsError, setProjectSkillsError] = useState('');
  const [projectSkillsNotice, setProjectSkillsNotice] = useState('');
  /** 2026-10-17（建任务入口批）：页头「＋建任务」→ 结构化表单（预填本项目）；成功回执本页显示。 */
  const [createOpen, setCreateOpen] = useState(false);
  const [createNotice, setCreateNotice] = useState('');
  // UI-2 S1：页签容器（任务/设置；产物/运行/记忆随 S3 接入）＋任务搜索＋行下展开（store 承载，深链可写）。
  const [tab, setTab] = useState<'tasks' | 'settings'>('tasks');
  // UI-2 S2：项目设置的组（默认「模型」；只做显示过滤，卡片与读写口径不动）。
  const [settingsGroup, setSettingsGroup] = useState<'model' | 'staffing' | 'permission' | 'skills' | 'docs' | 'advanced'>('model');
  const [taskQuery, setTaskQuery] = useState('');
  const projectPageSnap = useSnapshot(projectPage);
  const expandedTaskId = projectPageSnap.expandedTaskId;
  const pendingTaskId = projectPageSnap.pendingTaskId;
  // 收起后回焦：记住上一次展开行（Esc / 再点同行都走收起）。
  const lastExpandedTaskRef = useRef<number | null>(null);
  const list = tasksSnap.list as unknown as TaskDTO[];
  // 项目概览也以 project:list 为准（空项目可达；2026-10-17 真机修复）。
  const selectedProject = actionsSnap.list.find((p) => p.id === sessionSnap.selectedProjectId) ?? null;
  const groups = projectsFromList(actionsSnap.list as unknown as ProjectDTO[], list);
  // 归档项目不在活跃分组里：用任务真值补组，不写死 0（否则任务数与删除禁用条件都是假读数）。
  const selectedProjectTasks =
    selectedProject != null ? list.filter((task) => task.projectId === selectedProject.id) : [];
  const group =
    groups.find((g) => g.projectId === sessionSnap.selectedProjectId) ??
    (selectedProject
      ? {
          projectId: selectedProject.id,
          name: selectedProject.name,
          alias: selectedProject.alias,
          tasks: selectedProjectTasks,
          taskCount: selectedProjectTasks.length,
        }
      : null);

  useEffect(() => {
    void loadProjectsForOverview();
    void loadStaffingDefaults();
    void loadSkills();
  }, []);

  const project = selectedProject;
  const actionState = projectActionState(project);

  // 真值变化 → 重置草稿（不在项目之间串技能集）；回执/错误只在切换项目时清（保存后的提示要留得住）。
  useEffect(() => {
    setProjectSkillsDraft(project ? [...project.defaultSkills] : []);
  }, [project?.id, project?.defaultSkills.join('\u0000')]);
  useEffect(() => {
    setProjectSkillsError('');
    setProjectSkillsNotice('');
  }, [project?.id]);

  // D-19 P1：写权限草稿跟随真值；切换项目时清回执（保存后的回执保留）。
  useEffect(() => {
    setWriteModeDraft(project?.assistantWriteMode ?? 'confirm');
  }, [project?.id, project?.assistantWriteMode]);
  useEffect(() => {
    setWriteModeError('');
    setWriteModeNotice('');
  }, [project?.id]);

  // 项目切换/别名更新 → 重置别名编辑态；不把上一个项目的别名串过来。
  useEffect(() => {
    setAliasEditing(false);
    setAliasDraft(project?.alias ?? '');
    setAliasError('');
  }, [project?.id, project?.alias]);

  // 分工编辑态随项目走：A 打开的表单不能落到 B 保存。
  useEffect(() => {
    setStaffingEditing(false);
    setStaffingDraft(null);
    setStaffingError('');
  }, [project?.id]);

  // 切换项目 → 清掉上一个项目的公司配置预览/回执（避免误应用）。
  useEffect(() => {
    companyConfig.preview = null;
    companyConfig.notice = null;
    companyConfig.error = null;
    companyConfig.errorList = [];
    projectActions.message = null;
    projectActions.error = null;
    setCreateOpen(false);
    setCreateNotice('');
  }, [sessionSnap.selectedProjectId]);

  // UI-2 S1 深链：频道/待办/命令面板点任务 → 项目页后展开对应行（一次消费）。
  useEffect(() => {
    if (pendingTaskId == null) return;
    const projectId = sessionSnap.selectedProjectId;
    const belongs =
      projectId != null &&
      (tasksSnap.list as unknown as TaskDTO[]).some((task) => task.id === pendingTaskId && task.projectId === projectId);
    if (!belongs) {
      // 目标不属于当前项目（项目又被切走）→ 丢弃，避免误展开别的项目的行。
      projectPage.pendingTaskId = null;
      return;
    }
    setTab('tasks');
    setTaskQuery('');
    projectPage.pendingTaskId = null;
    void expandTaskRow(pendingTaskId);
    // 展开状态同步置位→行立即渲染：滚动/聚焦不等详情 IPC（详情随后回填行内）。
    let tries = 0;
    const focusRow = (): void => {
      const row = document.querySelector<HTMLElement>(`[data-testid="project-task"][data-task-id="${pendingTaskId}"]`);
      if (!row && tries++ < 8) {
        requestAnimationFrame(focusRow);
        return;
      }
      // 已结束组是折叠的 <details>：目标行在里面时先展开，否则聚焦/滚动都落空。
      const bucket = row?.closest('details');
      if (bucket) bucket.open = true;
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector<HTMLElement>('[data-testid="project-task-row"]')?.focus();
    };
    requestAnimationFrame(focusRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在深链目标/项目变化时消费
  }, [pendingTaskId, sessionSnap.selectedProjectId]);

  // 收起后回焦：Esc / 再点同行收起后，焦点回到原行（不丢键盘位置）。
  useEffect(() => {
    if (expandedTaskId != null) {
      lastExpandedTaskRef.current = expandedTaskId;
      return;
    }
    const prev = lastExpandedTaskRef.current;
    if (prev == null) return;
    lastExpandedTaskRef.current = null;
    document
      .querySelector<HTMLElement>(`[data-testid="project-task"][data-task-id="${prev}"] [data-testid="project-task-row"]`)
      ?.focus();
  }, [expandedTaskId]);

  /** 验收后复查 A：保存/清空项目别名（空串＝清空；失败留在输入区，不静默）。 */
  async function submitAlias(): Promise<void> {
    if (sessionSnap.selectedProjectId == null || aliasSaving) return;
    setAliasSaving(true);
    setAliasError('');
    const res = await saveProjectAlias(sessionSnap.selectedProjectId, aliasDraft.trim() || null);
    setAliasSaving(false);
    if (!res.ok) {
      setAliasError(res.error);
      return;
    }
    setAliasEditing(false);
  }

  /** 项目分工 v1（D-11）：保存三项缺省（成功退出编辑；失败块内红字，不静默）。 */
  async function submitStaffing(): Promise<void> {
    if (!staffingDraft || sessionSnap.selectedProjectId == null) return;
    setStaffingSaving(true);
    setStaffingError('');
    const res = await saveProjectStaffing(sessionSnap.selectedProjectId, {
      ownerEmployeeId: staffingDraft.ownerEmployeeId,
      defaultEmployeeId: staffingDraft.defaultEmployeeId,
      defaultRiskTier: staffingDraft.defaultRiskTier,
    });
    setStaffingSaving(false);
    if (res.ok) {
      setStaffingEditing(false);
      setStaffingDraft(null);
    } else {
      setStaffingError(res.error ?? '保存失败');
    }
  }
  /** M3-DOC-4：项目级文档检查开关（只影响新建任务；已有任务运行时按当前开关记未检查）。 */
  async function toggleDocsCheck(enabled: boolean): Promise<void> {
    if (sessionSnap.selectedProjectId == null || docsCheckSaving) return;
    setDocsCheckSaving(true);
    setDocsCheckError('');
    const res = await saveProjectDocsCheck(sessionSnap.selectedProjectId, enabled);
    setDocsCheckSaving(false);
    if (!res.ok) setDocsCheckError(res.error ?? '保存失败');
  }

  /** D-19 P1：保存频道助手项目写权限（main 校验；失败块内红字，不静默）。 */
  async function submitWriteMode(): Promise<void> {
    if (sessionSnap.selectedProjectId == null || writeModeSaving) return;
    setWriteModeSaving(true);
    setWriteModeError('');
    setWriteModeNotice('');
    const res = await saveProjectAssistantWriteMode(sessionSnap.selectedProjectId, writeModeDraft);
    setWriteModeSaving(false);
    if (!res.ok) {
      setWriteModeError(res.error ?? '保存失败');
      return;
    }
    setWriteModeNotice('已保存：下一次幕僚长频道会话生效');
  }

  /** B3（M3-N-3）：保存项目默认技能集（校验在 main；失败块内红字，不静默）。 */
  async function submitProjectSkills(): Promise<void> {
    if (sessionSnap.selectedProjectId == null || projectSkillsDraft == null || projectSkillsSaving) return;
    setProjectSkillsSaving(true);
    setProjectSkillsError('');
    setProjectSkillsNotice('');
    const res = await saveProjectDefaultSkills(sessionSnap.selectedProjectId, projectSkillsDraft);
    setProjectSkillsSaving(false);
    if (res.ok) setProjectSkillsNotice(`已保存（${projectSkillsDraft.length} 个默认技能）`);
    else setProjectSkillsError(res.error ?? '保存失败');
  }

  const docsSnap = useSnapshot(docsHealth);
  const docsView = docsHealthView({
    status: docsSnap.status,
    error: docsSnap.error,
    result: docsSnap.result as never,
    resultProjectId: docsSnap.projectId,
    selectedProjectId: sessionSnap.selectedProjectId ?? null,
  });
  const organizeSnap = useSnapshot(docsOrganize);
  const organizeFresh = organizeSnap.projectId === sessionSnap.selectedProjectId;
  const organizePlan = organizeFresh && organizeSnap.plan ? organizeSnap.plan : null;
  const organizeBusy = organizeSnap.status !== 'idle';

  return (
    <section className="project-pane" data-testid="project-view">
      {group ? (
        <>
          <header className="project-pane__head" data-testid="project-head">
            {/* UI-2 S1：项目头（头像＝首字色环；状态 chip 派生自任务真值，不臆造）。 */}
            <div className="project-head__identity" data-testid="project-identity">
              <span className="project-avatar" data-testid="project-avatar" data-avatar-tone={group.name.charCodeAt(0) % 5} aria-hidden="true">
                {group.name.slice(0, 1)}
              </span>
              <div className="project-head__idtext">
                <div className="project-head__idrow">
            <span className="project-pane__name" data-testid="project-name">
              {group.name}
            </span>
            {(() => {
              const st = projectStatusOf(
                group.tasks,
                (actionsSnap.list.find((pp) => pp.id === group.projectId)?.archived ?? 0) === 1,
              );
              return (
                <span className="project-status" data-testid="project-status" data-tone={st.tone}>
                  {st.label}
                </span>
              );
            })()}
            </div>
            {aliasEditing ? (
              <span className="project-pane__alias-edit" data-testid="project-alias-editor">
                <input
                  className="project-pane__alias-input"
                  data-testid="project-alias-input"
                  value={aliasDraft}
                  placeholder="别名，如 记账"
                  onChange={(event) => setAliasDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitAlias();
                    }
                    if (event.key === 'Escape') {
                      setAliasEditing(false);
                      setAliasError('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="project-pane__btn project-pane__btn--primary"
                  data-testid="project-alias-save"
                  disabled={aliasSaving}
                  onClick={() => void submitAlias()}
                >
                  {aliasSaving ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className="project-pane__btn project-pane__btn--ghost"
                  data-testid="project-alias-cancel"
                  disabled={aliasSaving}
                  onClick={() => {
                    setAliasEditing(false);
                    setAliasError('');
                  }}
                >
                  取消
                </button>
              </span>
            ) : (
              <>
                {group.alias ? (
                  <span className="project-pane__alias-chip" data-testid="project-alias">
                    <span className="project-pane__alias-text">{group.alias}</span>
                    <button
                      type="button"
                      className="project-pane__alias-edit-icon"
                      data-testid="project-alias-edit"
                      title="改别名（设置后可在微信/频道用 #别名 寻址本项目）"
                      aria-label="改别名"
                      onClick={() => {
                        setAliasDraft(project?.alias ?? '');
                        setAliasEditing(true);
                        setAliasError('');
                      }}
                    >
                      <PencilIcon />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="project-pane__alias-chip project-pane__alias-chip--button"
                    data-testid="project-alias-edit"
                    title="设置后可在微信/频道用 #别名 寻址本项目"
                    onClick={() => {
                      setAliasDraft(project?.alias ?? '');
                      setAliasEditing(true);
                      setAliasError('');
                    }}
                  >
                    <span className="project-pane__alias-text">设别名</span>
                    <span className="project-pane__alias-edit-icon" aria-hidden="true">
                      <PencilIcon />
                    </span>
                  </button>
                )}
              </>
            )}
            {aliasError ? (
              <span className="project-pane__alias-error" role="alert" data-testid="project-alias-error">
                {aliasError}
              </span>
            ) : null}
              </div>
            </div>
            <span className="project-pane__count" data-testid="project-count">
              {group.taskCount} 个任务
            </span>
            <span className="project-pane__spacer" />
            {/* 2026-10-17（建任务入口批）：本项目上下文建任务（预填项目；主操作）。归档项目不提供入口。 */}
            {actionState === 'archived' ? null : (
              <button
                type="button"
                className="project-pane__btn project-pane__btn--primary"
                data-testid="project-create-task"
                onClick={() => {
                  setCreateNotice('');
                  setCreateOpen(true);
                }}
              >
                ＋建任务
              </button>
            )}
            {actionState === 'unknown' ? null : actionState === 'archived' ? (
              <>
                <span className="project-pane__archived" data-testid="project-archived">
                  已归档（文件夹未动）
                </span>
                <button
                  type="button"
                  className="project-pane__btn"
                  data-testid="project-unarchive"
                  title="撤销软归档；归档时停用的触发需重新创建"
                  onClick={() => {
                    if (sessionSnap.selectedProjectId != null) void restoreProject(sessionSnap.selectedProjectId);
                  }}
                >
                  恢复项目
                </button>
                <button
                  type="button"
                  className="project-pane__btn"
                  data-testid="project-export"
                  title="导出项目档案（单文件 JSON：项目＋任务详情＋项目记忆）"
                  onClick={() => {
                    if (sessionSnap.selectedProjectId != null) void exportProject(sessionSnap.selectedProjectId);
                  }}
                >
                  导出项目
                </button>
                {deleteConfirm ? (
                  <span className="project-pane__alias-edit">
                    <button
                      type="button"
                      className="project-pane__btn project-pane__btn--primary"
                      data-testid="project-delete-yes"
                      onClick={() => {
                        if (sessionSnap.selectedProjectId != null) {
                          void deleteProject(sessionSnap.selectedProjectId).then((ok) => {
                            if (ok) setDeleteConfirm(false);
                          });
                        }
                      }}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="project-pane__btn project-pane__btn--ghost"
                      data-testid="project-delete-no"
                      onClick={() => setDeleteConfirm(false)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="project-pane__btn"
                    data-testid="project-delete"
                    disabled={group.taskCount > 0}
                    title={group.taskCount > 0 ? '项目还有任务；当前只允许删除空归档项目（文件夹不动）' : '只删项目行；删除前会自动导出档案；文件夹不动'}
                    onClick={() => setDeleteConfirm(true)}
                  >
                    删除项目
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="project-pane__btn"
                data-testid="project-archive"
                onClick={() => setArchiveConfirm(true)}
              >
                归档项目
              </button>
            )}
          </header>

          {/* UI-2 S1：页签容器——任务 / 设置（产物/运行/记忆随 S3 接入，不摆空页签）。 */}
          <nav className="project-tabs" data-testid="project-tabs">
            <button type="button" className="project-tab" data-testid="project-tab-tasks" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>
              任务 <span className="project-tab__count">{group.tasks.length}</span>
            </button>
            <button type="button" className="project-tab" data-testid="project-tab-settings" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
              设置
            </button>
          </nav>

          {/* P0/C1：归档选择卡（文档 F7：全部结束并归档 / 保留暂停任务并归档 / 先不归档） */}
          {archiveConfirm && sessionSnap.selectedProjectId != null ? (
            <div className="project-archive-confirm" data-testid="project-archive-confirm">
              <p className="project-archive-confirm__title">归档这个项目？未结束的任务要怎么处理？</p>
              <p className="project-archive-confirm__hint">归档是软操作：不搬动、不删除你的文件夹；之后可在「归档」页恢复项目。</p>
              <div className="project-archive-confirm__actions">
                <button
                  type="button"
                  className="project-pane__btn project-pane__btn--danger"
                  data-testid="project-archive-finish-all"
                  onClick={() => {
                    const id = sessionSnap.selectedProjectId;
                    setArchiveConfirm(false);
                    if (id != null) void archiveProject(id, 'finish_all');
                  }}
                >
                  全部结束并归档
                </button>
                <button
                  type="button"
                  className="project-pane__btn"
                  data-testid="project-archive-keep-paused"
                  onClick={() => {
                    const id = sessionSnap.selectedProjectId;
                    setArchiveConfirm(false);
                    if (id != null) void archiveProject(id, 'keep_paused');
                  }}
                >
                  保留暂停任务并归档
                </button>
                <button
                  type="button"
                  className="project-pane__btn"
                  data-testid="project-archive-cancel"
                  onClick={() => setArchiveConfirm(false)}
                >
                  先不归档
                </button>
              </div>
            </div>
          ) : null}

          {project ? (
            <div className="project-pane__meta">
              <span className="project-pane__rootdir" data-testid="project-rootdir" title={project.rootDir}>
                {project.rootDir}
              </span>
              <button
                type="button"
                className="project-pane__btn project-pane__btn--ghost"
                data-testid="project-open-dir"
                title="在系统文件管理器中打开项目根目录"
                onClick={() => {
                  void openProjectDir(project.id);
                }}
              >
                打开目录
              </button>
              {/* 2026-10-29 P2（D-N08）：批量归档——只归档已结束任务，逐个走既有 archiveTask（可续办恢复）。 */}
              {(() => {
                const terminal = group.tasks.filter((task) => TERMINAL_STATES.has(task.state) && task.archived !== 1);
                if (terminal.length === 0) return null;
                return (
                  <button
                    type="button"
                    className="project-pane__btn project-pane__btn--ghost"
                    data-testid="project-batch-archive"
                    title="把本项目所有已结束（完成/失败/取消）的任务一次归档"
                    onClick={() => {
                      if (!confirm(`归档 ${terminal.length} 个已结束任务？（归档页可见，可续办恢复）`)) return;
                      void (async () => {
                        for (const task of terminal) await archiveTask(task.id);
                      })();
                    }}
                  >
                    归档已结束（{terminal.length}）
                  </button>
                );
              })()}
            </div>
          ) : null}
          {actionsSnap.error ? (
            <p className="project-pane__error" data-testid="project-error" role="alert">
              {actionsSnap.error}
            </p>
          ) : null}
          {actionsSnap.message ? (
            <p className="project-pane__message" data-testid="project-message">
              {actionsSnap.message}
            </p>
          ) : null}
          {createNotice.length > 0 ? (
            <p className="project-pane__message" data-testid="project-create-notice">
              {createNotice}
            </p>
          ) : null}
          {/* 归档回执（2026-10-17）：左栏任务行退役后 `tasks.notice` 一度无消费者——
              归档成功时行消失却无回执，老板会以为没生效。 */}
          {tasksSnap.notice ? (
            <p className="project-pane__message" data-testid="project-task-notice" role="status">
              {tasksSnap.notice}
            </p>
          ) : null}



          {tab === 'tasks' ? (
          <section className="project-pane__card project-pane__card--grow project-tasks-card" data-testid="project-tasks-card">
            <div className="project-tasks__toolbar">
              <input
                className="project-tasks__search"
                data-testid="project-tasks-search"
                value={taskQuery}
                placeholder="搜索任务…"
                onChange={(event) => setTaskQuery(event.target.value)}
              />
            </div>
            {group.tasks.length === 0 ? (
              <EmptyState
                variant="inline"
                testid="project-tasks-empty"
                title="这个项目还没有任务"
                hint="点上方「＋建任务」，或在老板频道说一句话。"
              />
            ) : (
            <ul className="project-view__tasks" data-testid="project-tasks">
            {groupProjectTasks(group.tasks).map((bucket) => {
              const collapsed = bucket.state === 'cancelled';
              const q = taskQuery.trim().toLowerCase();
              const visible = q.length === 0
                ? bucket.tasks
                : bucket.tasks.filter((t) =>
                    t.title.toLowerCase().includes(q) || (t.shortId ?? '').toLowerCase().includes(q));
              if (visible.length === 0) return null;
              const rows = (
                <ul>
                  {visible.map((task) => {
                    const waitTitle = waitingSummary(task.waits);
                    const waitText = task.waits && task.waits.length > 0
                      ? `等待：${task.waits.map((w) => WAITING_REASON_TEXT[w.reason] ?? String(w.reason)).join('；')}`
                      : null;
                    const expanded = expandedTaskId === task.id;
                    return (
                    <li key={task.id} className="project-task-row" data-testid="project-task" data-task-id={task.id} data-state={task.state} data-expanded={expanded ? '1' : '0'}>
                      <div className="project-task-row__line">
                        <button
                          type="button"
                          className="project-task-row__main"
                          data-testid="project-task-row"
                          data-task-id={task.id}
                          onClick={() => {
                            if (expanded) collapseTaskRow();
                            else void expandTaskRow(task.id);
                          }}
                        >
                          <span className="project-view__dot" data-tone={STATE_TONE[task.state] ?? 'dim'} aria-hidden="true" />
                          <span className="project-view__short">{task.shortId ?? `#${task.id}`}</span>
                          <span className="project-view__task-title">{task.title}</span>
                          {task.executor?.name ? (
                            <span className="project-task-row__executor" data-testid="project-task-executor" data-employee-id={task.executor.id}>
                              {task.executor.name}
                            </span>
                          ) : (
                            <span className="project-task-row__executor project-task-row__executor--none">未派</span>
                          )}
                          <span className="project-task-row__time" data-testid="project-task-updated">
                            {relativeTime(task.updatedAt)}
                          </span>
                        </button>
                        {waitText ? (
                          <span className="project-view__task-wait" data-testid="project-task-wait" title={waitTitle ?? waitText}>
                            {waitText}
                          </span>
                        ) : null}
                        {task.state === 'executing' ? (
                          <button type="button" className="project-view__task-archive" data-testid="project-task-pause"
                            title="暂停（员工会话真中止；恢复后 interrupted 件自动重派，计划/产物不丢）"
                            onClick={() => { void pauseResumeTask(task.id, 'pause'); }}
                          >
                            暂停
                          </button>
                        ) : null}
                        {task.state === 'paused' ? (
                          <button type="button" className="project-view__task-archive" data-testid="project-task-resume"
                            title="恢复（interrupted 件自动重派，继续执行）"
                            onClick={() => { void pauseResumeTask(task.id, 'resume'); }}
                          >
                            恢复
                          </button>
                        ) : null}
                        {TERMINAL_STATES.has(task.state) && task.archived !== 1 ? (
                          <button type="button" className="project-view__task-archive" data-testid="project-task-archive"
                            title="归档（「归档」页可见；归档后不可撤销结束，只能续办）"
                            onClick={() => { void archiveTask(task.id); }}
                          >
                            归档
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="project-view__task-open"
                          data-testid="project-task-open"
                          title="整页打开任务详情（逃生口）"
                          onClick={() => { void openTaskDetail(task.id); }}
                        >
                          ↗
                        </button>
                      </div>
                      {expanded ? (
                        <div className="project-task-row__detail" data-testid="project-task-inline">
                          <TaskDetailBody embedded onEsc={() => collapseTaskRow()} reload={(id) => expandTaskInline(id)} />
                        </div>
                      ) : null}
                    </li>
                    );
                  })}
                </ul>
              );
              return (
                <li key={bucket.state} className="project-view__state-group" data-testid="project-state-group" data-state={bucket.state}>
                  {collapsed ? (
                    <details>
                      <summary className="project-view__state-title">
                        {bucket.label}（{bucket.tasks.length}）
                      </summary>
                      {rows}
                    </details>
                  ) : (
                    <>
                      <h3 className="project-view__state-title">
                        {bucket.label}（{bucket.tasks.length}）
                      </h3>
                      {rows}
                    </>
                  )}
                </li>
              );
            })}
            </ul>
            )}
          </section>
          ) : (
          <section className="project-pane__card" data-testid="project-settings-panel">
          {/* D-22：项目模型策略——概览只读摘要；编辑面在设置·模型与员工（避免项目页再长出一套表单）。 */}
          {project ? (
            <details className="project-settings" data-testid="project-settings" open>
              <summary className="project-settings__summary">项目设置（模型 / 分工 / 权限 / 技能 / 文档 / 定时）</summary>
            <div className="project-settings__body" data-active-group={settingsGroup}>
            {/* UI-2 S2：7 组配置——分段导航只**过滤显示**（卡片不动），默认只开「模型」。 */}
            <nav className="project-tabs project-settings__groupnav" data-testid="project-settings-groupnav">
              {([
                ['model', '模型'],
                ['staffing', '分工'],
                ['permission', '权限'],
                ['skills', '技能'],
                ['docs', '文档'],
                ['advanced', '高级'],
              ] as const).map(([gid, label]) => (
                <button
                  key={gid}
                  type="button"
                  className="project-tab"
                  data-testid={`project-settings-groupnav-${gid}`}
                  aria-selected={settingsGroup === gid}
                  onClick={() => setSettingsGroup(gid)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <section className="project-pane__card" data-group="model" data-testid="project-model-card">
              <h3 className="project-view__state-title">模型</h3>
              <div className="project-view__docs-row" data-testid="project-model-summary">
                <span className="project-view__docs-text">
                  {project.defaultModel ?? '公司默认'}
                  {' · '}
                  {project.modelPolicy === 'fixed'
                    ? '固定模型'
                    : project.modelPolicy === 'assistant'
                      ? '幕僚长调度'
                      : '员工优先'}
                  {' · '}
                  允许 {project.allowedModels.length === 0 ? '不限' : `${project.allowedModels.length} 个`}
                </span>
              </div>
              <p className="project-view__docs-text">在「设置 → 模型与员工 → 项目模型」里改；只影响之后的员工会话。</p>
            </section>

          {/* 项目分工 v1（D-11）：项目三项缺省（负责人／建任务后派给谁／默认档）——只读摘要＋就地编辑。
              未设置＝显式「未设置——按缺省链」（不臆造人名/档）；保存＝`project:staffing-set`，**只影响之后派发的工作项；已派发不变**。 */}
          <section className="project-pane__card" data-group="staffing" data-testid="project-staffing">
            <h3 className="project-view__state-title">项目分工</h3>
            <div className="project-view__docs-row">
              <button
                type="button"
                data-testid="staffing-edit"
                disabled={staffingSaving}
                onClick={() => {
                  if (staffingEditing) {
                    setStaffingEditing(false);
                    setStaffingDraft(null);
                    setStaffingError('');
                    return;
                  }
                  setStaffingDraft(staffingFromProject(project));
                  setStaffingEditing(true);
                }}
              >
                {staffingEditing ? '取消' : '设置'}
              </button>
              <span className="project-view__docs-text" data-testid="staffing-summary">
                {
                  staffingSummary(staffingFromProject(project), (id) => staffingSnap.employees.find((e) => e.id === id)?.name ?? null)
                    .text
                }
              </span>
            </div>
            {staffingEditing && staffingDraft ? (
              <div className="project-view__staffing-form" data-testid="staffing-form">
                <label className="project-view__staffing-field">
                  负责人
                  <select
                    data-testid="staffing-owner"
                    value={staffingDraft.ownerEmployeeId == null ? '' : String(staffingDraft.ownerEmployeeId)}
                    onChange={(e) =>
                      setStaffingDraft({ ...staffingDraft, ownerEmployeeId: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  >
                    <option value="">未设置</option>
                    {staffingSnap.employees.map((emp) => (
                      <option key={emp.id} value={String(emp.id)}>
                        {emp.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="project-view__staffing-field">
                  建任务后派给谁
                  <select
                    data-testid="staffing-default-employee"
                    value={staffingDraft.defaultEmployeeId == null ? '' : String(staffingDraft.defaultEmployeeId)}
                    onChange={(e) =>
                      setStaffingDraft({ ...staffingDraft, defaultEmployeeId: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  >
                    <option value="">未设置</option>
                    {staffingSnap.employees.map((emp) => (
                      <option key={emp.id} value={String(emp.id)}>
                        {emp.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="project-view__staffing-field">
                  默认档
                  <select
                    data-testid="staffing-tier"
                    value={staffingDraft.defaultRiskTier == null ? '' : String(staffingDraft.defaultRiskTier)}
                    onChange={(e) =>
                      setStaffingDraft({
                        ...staffingDraft,
                        defaultRiskTier: e.target.value === '' ? null : (Number(e.target.value) as 0 | 1 | 2),
                      })
                    }
                  >
                    <option value="">未设置</option>
                    <option value="0">{STAFFING_TIER_LABEL[0]}</option>
                    <option value="1">{STAFFING_TIER_LABEL[1]}</option>
                    <option value="2">{STAFFING_TIER_LABEL[2]}</option>
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="staffing-save"
                  disabled={staffingSaving || sessionSnap.selectedProjectId == null}
                  onClick={() => {
                    void submitStaffing();
                  }}
                >
                  {staffingSaving ? '保存中…' : '保存'}
                </button>
                <span className="project-view__docs-text">只影响之后建的任务；已派发的不变。</span>
              </div>
            ) : null}
            {staffingError.length > 0 ? (
              <p className="project-view__error" data-testid="staffing-error" role="alert">
                {staffingError}
              </p>
            ) : null}
          </section>

          {/* D-19 P1：频道助手项目写权限（project-only 硬边界不变；项目内三态）。 */}
          <section className="project-pane__card" data-group="permission" data-testid="project-assistant-write-mode">
            <h3 className="project-view__state-title">频道助手写权限</h3>
            <p className="project-view__docs-text">
              频道助手只能写本项目根；越界仍拒绝。<strong>只读</strong>不写文件；<strong>写前确认</strong>
              每次写/建目录先出确认卡；<strong>项目内自主</strong>不逐次确认但全部写操作留审计。
            </p>
            <div className="project-view__docs-row">
              <select
                className="project-view__trigger-input"
                data-testid="assistant-write-mode-select"
                value={writeModeDraft}
                disabled={project == null || writeModeSaving}
                onChange={(event) =>
                  setWriteModeDraft(event.target.value === 'read-only' || event.target.value === 'auto' ? event.target.value : 'confirm')
                }
              >
                <option value="read-only">只读</option>
                <option value="confirm">写前确认（默认）</option>
                <option value="auto">项目内自主</option>
              </select>
              <button
                type="button"
                data-testid="assistant-write-mode-save"
                disabled={project == null || writeModeSaving}
                onClick={() => void submitWriteMode()}
              >
                {writeModeSaving ? '保存中…' : '保存'}
              </button>
              <span className="project-view__docs-text">下一次频道助手会话生效</span>
            </div>
            {writeModeNotice ? (
              <p className="project-pane__message" data-testid="assistant-write-mode-notice" role="status">
                {writeModeNotice}
              </p>
            ) : null}
            {writeModeError ? (
              <p className="project-view__error" data-testid="assistant-write-mode-error" role="alert">
                {writeModeError}
              </p>
            ) : null}
          </section>

          {/* B-1（M4）：项目概览·定时——列表/创建/取消/下次时间；与频道命令同源。 */}
          <ProjectTriggers projectId={sessionSnap.selectedProjectId} />

          {/* B-6（M4）：项目概览·项目记忆——老板显式写；pin/忘记/提升全局。 */}
          <ProjectMemory projectId={sessionSnap.selectedProjectId} />

          {/* B3（M3-N-3）：项目默认技能集（员工勾选 ∪ 项目默认；只影响该项目下新会话装配）。 */}
          <section className="project-pane__card" data-group="skills" data-testid="project-default-skills">
            <h3 className="project-view__state-title">项目默认技能</h3>
            <p className="project-view__docs-text">
              该项目下的任务自动附加（与员工勾选取并集）；不重复给每个员工配。
            </p>
            {skillsSnap.list == null ? (
              <p className="project-view__docs-text" data-testid="project-skills-loading">
                读取中…
              </p>
            ) : skillsSnap.list.length === 0 ? (
              <p className="project-view__docs-text" data-testid="project-skills-empty">
                暂无技能（先在 设置 · 技能 安装/启用）。
              </p>
            ) : (
              <div data-testid="project-skills-options">
                {skillsSnap.list.map((skill) => {
                  const selected = (projectSkillsDraft ?? []).includes(skill.name);
                  return (
                    <label key={skill.id} className="project-view__docs-check" data-testid="project-skill-option" data-skill-name={skill.name}>
                      <input
                        type="checkbox"
                        data-testid={`project-skill-toggle-${skill.id}`}
                        checked={selected}
                        disabled={skill.enabled !== 1 && !selected}
                        onChange={(e) => {
                          setProjectSkillsDraft((prev) => {
                            const base = new Set(prev ?? []);
                            if (e.target.checked) base.add(skill.name);
                            else base.delete(skill.name);
                            return [...base];
                          });
                          setProjectSkillsNotice('');
                          setProjectSkillsError('');
                        }}
                      />
                      {skill.name}
                      {skill.enabled !== 1 ? <span className="project-view__docs-text">（已停用）</span> : null}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="project-view__docs-row">
              <button
                type="button"
                data-testid="project-skills-save"
                disabled={projectSkillsSaving || projectSkillsDraft == null || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  void submitProjectSkills();
                }}
              >
                {projectSkillsSaving ? '保存中…' : '保存默认技能'}
              </button>
              <span className="project-view__docs-text" data-testid="project-skills-summary">
                {projectSkillsDraft == null ? '—' : `${projectSkillsDraft.length} 个默认技能`}
              </span>
            </div>
            {projectSkillsNotice.length > 0 ? (
              <p className="project-view__docs-text" data-testid="project-skills-notice" role="status">
                {projectSkillsNotice}
              </p>
            ) : null}
            {projectSkillsError.length > 0 ? (
              <p className="project-view__error" data-testid="project-skills-error" role="alert">
                {projectSkillsError}
              </p>
            ) : null}
          </section>

          {/* GAP9（M3-N-5）：公司配置版本化——文件随仓库走；预览 diff 后应用；apply 前备份可回滚。 */}
          <section className="project-pane__card" data-group="advanced" data-testid="company-config">
            <h3 className="project-view__state-title">公司配置版本化</h3>
            <p className="project-view__docs-text">
              员工（角色/人设/模型/思考/能力档/技能/MCP）＋公司级模型与调度设置 → <code>.aico/company.json</code>，
              可提交进仓库；不含凭据、项目路径与通知偏好。
            </p>
            <div className="project-view__docs-row">
              <button
                type="button"
                data-testid="company-export"
                disabled={companySnap.busy || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void exportCompanyConfig(sessionSnap.selectedProjectId);
                }}
              >
                导出配置
              </button>
              <button
                type="button"
                data-testid="company-preview"
                disabled={companySnap.busy || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void previewCompanyConfig(sessionSnap.selectedProjectId);
                }}
              >
                预览导入
              </button>
              <button
                type="button"
                data-testid="company-apply"
                disabled={companySnap.busy || companySnap.preview == null || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void applyCompanyConfig(sessionSnap.selectedProjectId);
                }}
              >
                应用预览
              </button>
              <button
                type="button"
                data-testid="company-rollback"
                disabled={companySnap.busy || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void rollbackCompanyConfig(sessionSnap.selectedProjectId);
                }}
              >
                回滚备份
              </button>
            </div>
            {companySnap.notice ? (
              <p className="project-view__docs-text" data-testid="company-notice" role="status">
                {companySnap.notice}
              </p>
            ) : null}
            {companySnap.error ? (
              <div data-testid="company-error" role="alert">
                <p className="project-view__error">{companySnap.error}</p>
                {companySnap.errorList.length > 0 ? (
                  <ul className="project-view__docs-more">
                    {companySnap.errorList.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {companySnap.preview ? (
              <div data-testid="company-diff">
                <p className="project-view__docs-text">
                  新增 {companySnap.preview.diff.added.length} · 更新 {companySnap.preview.diff.updated.length} · 不变{' '}
                  {companySnap.preview.diff.unchanged} · 跳过 {companySnap.preview.diff.skipped.length} · 设置 +
                  {companySnap.preview.diff.settings.added.length}/~
                  {companySnap.preview.diff.settings.updated.length}
                </p>
                {companySnap.preview.diff.added.length > 0 ? (
                  <p className="project-view__docs-more">新增员工：{companySnap.preview.diff.added.join('、')}</p>
                ) : null}
                {companySnap.preview.diff.updated.map((u) => (
                  <p key={u.name} className="project-view__docs-more">
                    更新 {u.name}：{Object.keys(u.changes).join('、')}
                  </p>
                ))}
                {companySnap.preview.diff.skipped.length > 0 ? (
                  <p className="project-view__docs-more">
                    配置里没有、将保留：{companySnap.preview.diff.skipped.join('、')}
                  </p>
                ) : null}
                {companySnap.preview.diff.errors.length > 0 ? (
                  <p className="project-view__error">{companySnap.preview.diff.errors.join('；')}</p>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* M2 §7 序 4 / M3-DOC-2：文档健康面板（只读结构检查；无树/失败/未检查都如实，不显假 0）。 */}
          <section className="project-pane__card" data-group="docs" data-testid="docs-health">
            <h3 className="project-view__state-title">文档健康</h3>
            <label className="project-view__docs-check">
              <input
                type="checkbox"
                data-testid="docs-check-enabled"
                checked={selectedProject?.docsCheckEnabled !== false}
                disabled={selectedProject == null || docsCheckSaving}
                onChange={(event) => {
                  void toggleDocsCheck(event.target.checked);
                }}
              />
              新任务验收默认检查文档（中/高风险；低风险直通免验）
            </label>
            {docsCheckError.length > 0 ? (
              <p className="project-view__error" data-testid="docs-check-error" role="alert">
                {docsCheckError}
              </p>
            ) : null}
            <div className="project-view__docs-row">
              <button
                type="button"
                data-testid="docs-health-run"
                disabled={docsSnap.status === 'busy' || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void checkProjectDocs(sessionSnap.selectedProjectId);
                }}
              >
                检查文档
              </button>
              <span className="project-view__docs-text" data-testid="docs-health-text">
                {docsView.text}
              </span>
            </div>
            <div className="project-view__docs-row">
              <button
                type="button"
                data-testid="docs-organize-preview"
                disabled={organizeBusy || sessionSnap.selectedProjectId == null}
                onClick={() => {
                  if (sessionSnap.selectedProjectId != null) void previewProjectDocsOrganize(sessionSnap.selectedProjectId);
                }}
              >
                {organizeSnap.status === 'previewing' ? '生成预览…' : '整理索引'}
              </button>
              <span className="project-view__docs-text">只补区索引 README，不删改正文；应用前先看 diff。</span>
            </div>
            {organizePlan && organizePlan.changes.length > 0 ? (
              <div className="project-view__docs-organize" data-testid="docs-organize-plan">
                <p className="project-view__docs-more">
                  将补 {organizePlan.changes.length} 个索引文件（只追加，不删除）。
                </p>
                {organizePlan.changes.map((change) => {
                  const diff = docsOrganizeDiff(change);
                  return (
                    <div className="project-view__docs-organize-change" data-testid="docs-organize-change" data-path={change.path} key={change.path}>
                      <p className="project-view__docs-root">
                        <code>{change.path}</code> 补：{change.added.join('、')}
                      </p>
                      <pre className="project-view__docs-diff" data-testid="docs-organize-diff">
                        {diff.text}
                        {diff.truncated ? '\n…（已截断）' : ''}
                      </pre>
                    </div>
                  );
                })}
                <div className="project-view__docs-organize-actions">
                  <button
                    type="button"
                    data-testid="docs-organize-apply"
                    disabled={organizeBusy || organizePlan.token == null}
                    onClick={() => {
                      if (sessionSnap.selectedProjectId != null && organizePlan.token != null) {
                        void applyProjectDocsOrganize(sessionSnap.selectedProjectId, organizePlan.token);
                      }
                    }}
                  >
                    {organizeSnap.status === 'applying' ? '应用中…' : '应用整理'}
                  </button>
                  <button type="button" data-testid="docs-organize-cancel" disabled={organizeBusy} onClick={cancelProjectDocsOrganize}>
                    取消
                  </button>
                </div>
              </div>
            ) : null}
            {organizeFresh && organizeSnap.notice ? (
              <p className="project-view__docs-clean" data-testid="docs-organize-notice">
                {organizeSnap.notice}
              </p>
            ) : null}
            {organizeFresh && organizeSnap.error ? (
              <p className="project-view__error" data-testid="docs-organize-error" role="alert">
                {organizeSnap.error}
              </p>
            ) : null}
            {docsView.state === 'ok' && docsView.counts ? (
              <div className="project-view__docs-panel" data-testid="docs-health-panel">
                <div className="project-view__docs-counts" data-testid="docs-health-counts">
                  <span data-testid="docs-health-count-live">活文档 {docsView.counts.live}</span>
                  <span data-testid="docs-health-count-archive">归档 {docsView.counts.archive}</span>
                  <span data-testid="docs-health-count-dangling">悬空 {docsView.counts.dangling}</span>
                  <span data-testid="docs-health-count-oversized">超线 {docsView.counts.oversized}</span>
                  <span data-testid="docs-health-count-issues">问题 {docsView.counts.issues}</span>
                </div>
                <p className="project-view__docs-root">文档根：{docsView.docRoot}</p>
                {docsView.items.length > 0 ? (
                  <ul className="project-view__docs-issues" data-testid="docs-health-issues">
                    {docsView.items.map((item, index) => (
                      <li className="project-view__docs-issue" key={`${item.kind}:${item.path}:${index}`} data-kind={item.kind}>
                        <span className="project-view__docs-kind">{item.kindLabel}</span>
                        <code className="project-view__docs-path">{item.path}</code>
                        <span>{item.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="project-view__docs-clean" data-testid="docs-health-clean">
                    未发现结构问题。
                  </p>
                )}
                {docsView.more > 0 ? (
                  <p className="project-view__docs-more" data-testid="docs-health-more">
                    另有 {docsView.more} 条未列出（单次最多显示 50 条）。
                  </p>
                ) : null}
                {docsView.truncated ? (
                  <p className="project-view__docs-more" data-testid="docs-health-truncated">
                    文件数超过检查上限，已截断（只检查前 2000 个文件）。
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
            </div>
            </details>
          ) : null}

          {/* UI-2 S3 将迁「运行」页签；先随设置页保底可见。 */}
          {/* S13-G / C3：变更历史（跨任务；只读人话版） */}
          <section className="project-pane__card" data-testid="project-history">
            <h3 className="project-pane__cardtitle">变更历史（本项目 · 最近 50 条）</h3>
            {history.length === 0 ? (
              <p className="project-view__muted" data-testid="project-history-empty">
                —（还没有变更集；任务完成工作项并提交后才会出现）
              </p>
            ) : (
              <ul className="project-history__list">
                {history.map((cs) => (
                  <li key={cs.id} className="project-history__row" data-testid="project-history-row" data-state={cs.state}>
                    <span className="project-history__task">{cs.shortId ?? `#${cs.taskId}`}</span>
                    <span className="project-history__branch">{cs.branch ?? '—'}</span>
                    <span className="project-history__state" data-state={cs.state}>
                      {cs.state === 'merged' ? '已合并' : cs.state === 'open' ? '待合并' : cs.state}
                    </span>
                    <span className="project-history__meta">
                      {cs.filesChanged} 文件 · +{cs.insertions}/−{cs.deletions}
                    </span>
                    <span className="project-history__meta">
                      {new Date(cs.mergedAt ?? cs.createdAt).toLocaleString('zh-CN')}
                    </span>
                    <span className="project-history__summary">{cs.summary ?? cs.commitMsg ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          </section>
          )}

          {createOpen ? (
            <TaskCreateDialog
              projectId={sessionSnap.selectedProjectId}
              projectName={group.name}
              onClose={() => setCreateOpen(false)}
              onCreated={(task) => {
                setCreateOpen(false);
                setCreateNotice(`已受理 ${task.shortId ?? `#${task.id}`}（已建到本项目）`);
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
