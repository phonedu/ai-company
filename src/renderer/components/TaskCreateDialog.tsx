/**
 * 建任务对话框（2026-10-17 建任务入口批，要求「就按你的建议来」）——
 *   两个上下文入口共用：**老板频道输入框旁** ＋ **项目树页右栏页头**。
 *   - 字段：目标 / 执行方式 / 谁来做 / 验收（一行一条）/ 预算；执行方式与负责人预填自项目分工。
 *   - 写入仍走 `store.createTask`（单一写入口径，与频道打字交办同路径）；成功回执交容器显示。
 *   - 项目上下文：项目页传 `projectId`（任务直接建到该项目）；老板频道不传默认项目，
 *     但**对话框内可选择软件内任意未归档项目**（2026-10-25 老板反馈）。
 *   - 实色模态（§4.9）：遮罩 rgba .35、面板 panel、发丝、阴影一档；Esc/遮罩/✕ 关闭。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { createTask, loadProjectsForOverview, loadStaffingDefaults, projectActions, staffingDefaults, tasks, type StaffingDefaultsResult } from '../store';
import type { ProjectDTO, TaskDTO } from '../types';
import { taskRiskTierLabel, suggestTaskTier } from './taskSuggestion.js';
import { useFocusTrap } from './useFocusTrap.js';

export interface TaskCreateDialogProps {
  /** 项目上下文（项目页传选中项目；频道不传＝默认项目）。 */
  projectId?: number | null;
  /** 2026-10-29 P2（P-N01）：从频道消息「转任务」时预填目标。 */
  initialGoal?: string;
  /** 项目名（显示「建到：X」；缺省显「默认项目」）。 */
  projectName?: string | null;
  onClose: () => void;
  /** 成功：容器关面板并显示回执（「已受理 T-xxxx（在项目树里看）」）。 */
  onCreated: (task: TaskDTO) => void;
}

export function TaskCreateDialog({ projectId = null, projectName = null, initialGoal = '', onClose, onCreated }: TaskCreateDialogProps): ReactElement {
  const staffingSnap = useSnapshot(staffingDefaults);
  const projectsSnap = useSnapshot(projectActions);
  const tasksSnap = useSnapshot(tasks);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(true, dialogRef);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(projectId);
  const [goal, setGoal] = useState(initialGoal);
  const [riskLevel, setRiskLevel] = useState(1);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [tierTouched, setTierTouched] = useState(false);
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [acceptanceText, setAcceptanceText] = useState('');
  const [budgetText, setBudgetText] = useState('');
  const [deadlineText, setDeadlineText] = useState('');
  const [depsText, setDepsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [prefill, setPrefill] = useState<StaffingDefaultsResult | null>(null);
  /** B-7：建议档先读项目默认档；无默认档才用目标文本启发式（不覆盖手选）。 */
  const suggestion = suggestTaskTier({ goal, projectDefaultTier: prefill?.defaultRiskTier ?? null });
  const projects = (projectsSnap.list as unknown as ProjectDTO[]).filter((p) => p.archived === 0);
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const effectiveProjectName = selectedProject
    ? `${selectedProject.name}${selectedProject.alias ? `（${selectedProject.alias}）` : ''}`
    : projectName ?? '默认项目（设置 · 项目里可改）';

  useEffect(() => {
    void loadProjectsForOverview();
  }, []);

  useEffect(() => {
    setSelectedProjectId(projectId);
  }, [projectId]);

  // 本次对话框自己的预填结果：不吃全局 staffingDefaults 的上一个项目残留；项目切换/卸载后旧请求作废。
  useEffect(() => {
    let alive = true;
    setPrefill(null);
    setRiskLevel(1);
    setOwnerId(null);
    setTierTouched(false);
    setOwnerTouched(false);
    void loadStaffingDefaults(selectedProjectId).then((result) => {
      if (!alive) return;
      // 显式项目必须与返回项目一致（列表竞态/失败 → 不预填，绝不拿别的项目值）。
      if (selectedProjectId != null && result.projectId !== selectedProjectId) return;
      setPrefill(result);
    });
    return () => {
      alive = false;
    };
  }, [selectedProjectId]);

  // 预填：用户还没手动改过才写回（改过＝任务级覆盖优先）。
  useEffect(() => {
    if (!prefill || tierTouched) return;
    if (prefill.defaultRiskTier != null) setRiskLevel(prefill.defaultRiskTier);
  }, [prefill, tierTouched]);
  useEffect(() => {
    if (!prefill || ownerTouched) return;
    setOwnerId(prefill.ownerEmployeeId);
  }, [prefill, ownerTouched]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (goal.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError('');
    const budget = Number(budgetText.trim());
    //  尾：截止时间（datetime-local → epoch ms；非法/已过去 → 响亮拒，不静默丢）。
    const deadline = deadlineText.trim().length > 0 ? new Date(deadlineText).getTime() : null;
    if (deadlineText.trim().length > 0 && (!Number.isFinite(deadline) || (deadline as number) <= Date.now())) {
      setError('截止时间无效或已过去（请选一个未来时间）');
      setSubmitting(false);
      return;
    }
    //  尾：依赖任务短号 → 任务 id（查不到 → 不猜，直接说清楚）。
    const depTokens = depsText
      .split(/[,，、\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const dependsOn: number[] = [];
    for (const token of depTokens) {
      const shortId = token.includes('-') ? token.toUpperCase() : /^T\d+$/i.test(token) ? `T-${token.slice(1)}` : token;
      const match = (tasksSnap.list as unknown as TaskDTO[]).find(
        (task) => (task.shortId ?? '').toUpperCase() === shortId.toUpperCase(),
      );
      if (!match) {
        setError(`依赖任务短号不存在：${token}（先建它，或在频道发「依赖 T-xxxx …」）`);
        setSubmitting(false);
        return;
      }
      if (!dependsOn.includes(match.id)) dependsOn.push(match.id);
    }
    if (budgetText.trim().length > 0 && (!Number.isInteger(budget) || budget <= 0)) {
      setError('预算需为正整数 token，或留空（继承项目默认/不限）');
      setSubmitting(false);
      return;
    }
    try {
      const created = await createTask(goal, {
        riskLevel,
        ...(ownerId != null ? { ownerId } : {}),
        ...(selectedProjectId != null ? { projectId: selectedProjectId } : {}),
        acceptance: acceptanceText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        ...(Number.isInteger(budget) && budget > 0 ? { budgetTokens: budget } : {}),
        ...(deadline != null ? { deadline } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      });
      if (created == null) {
        setError('建任务未发出（主进程未连接）');
        return;
      }
      onCreated(created);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="taskdlg-scrim"
      data-testid="task-create-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="taskdlg" ref={dialogRef} role="dialog" aria-modal="true" aria-label="建任务">
        <header className="taskdlg__head">
          <h2 className="taskdlg__title">建任务</h2>
          <span className="taskdlg__where" data-testid="taskdlg-project">
            建到：{effectiveProjectName}
          </span>
          <button type="button" className="taskdlg__close" data-testid="taskdlg-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="taskdlg__body">
        <label className="taskdlg__field">
          <span className="taskdlg__label">建到项目</span>
          <select
            className="taskdlg__input"
            data-testid="taskdlg-project-select"
            value={selectedProjectId == null ? '' : String(selectedProjectId)}
            title="选择软件内项目；默认项目可在设置·项目里改"
            onChange={(e) => {
              setSelectedProjectId(e.target.value === '' ? null : Number(e.target.value));
              setError('');
            }}
          >
            <option value="">默认项目（设置 · 项目里可改）</option>
            {projects.map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}{project.alias ? `（${project.alias}）` : ''}
              </option>
            ))}
          </select>
          <p
            className="taskdlg__hint"
            data-testid="taskdlg-project-path"
            style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-dim)' }}
          >
            {selectedProject
              ? `落点：${selectedProject.rootDir}`
              : '未指定项目 → 会落到默认项目；建议先在上方选择具体项目'}
          </p>
        </label>

        <label className="taskdlg__field">
          <span className="taskdlg__label">要做什么</span>
          <textarea
            className="taskdlg__input"
            data-testid="taskdlg-goal"
            data-autofocus
            rows={3}
            autoFocus
            value={goal}
            placeholder="请输入文字…"
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>

        <div className="taskdlg__row">
          <label className="taskdlg__field">
            <span className="taskdlg__label">执行方式</span>
            <select
              className="taskdlg__input"
              data-testid="taskdlg-risk"
              value={String(riskLevel)}
              title="先审计划＝你批准后开工；直接执行＝立即开工；全流程＝另加验证与人工批准"
              onChange={(e) => {
                setTierTouched(true);
                setRiskLevel(Number(e.target.value));
              }}
            >
              <option value="1">先审计划（推荐）</option>
              <option value="0">直接执行</option>
              <option value="2">全流程（严格）</option>
            </select>
          </label>
          <label className="taskdlg__field">
            <span className="taskdlg__label">谁来做</span>
            <select
              className="taskdlg__input"
              data-testid="taskdlg-owner"
              value={ownerId == null ? '' : String(ownerId)}
              title="默认按项目分工；本任务可改（改后只影响这一单）"
              onChange={(e) => {
                setOwnerTouched(true);
                setOwnerId(e.target.value === '' ? null : Number(e.target.value));
              }}
            >
              <option value="">按项目默认</option>
              {staffingSnap.employees.map((employee) => (
                <option key={employee.id} value={String(employee.id)}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          className="taskdlg__row"
          data-testid="taskdlg-suggestion"
          data-tier={suggestion.tier}
          data-source={suggestion.source}
          style={{ alignItems: 'center', gap: 8 }}
        >
          <span className="taskdlg__hint" style={{ margin: 0, flex: 1 }}>
            建议：{taskRiskTierLabel(suggestion.tier)} · {suggestion.reason}
            {tierTouched ? '（已手选，建议仅供参考）' : ''}
          </span>
          {riskLevel !== suggestion.tier ? (
            <button
              type="button"
              className="taskdlg__btn"
              data-testid="taskdlg-adopt-suggestion"
              onClick={() => {
                setTierTouched(true);
                setRiskLevel(suggestion.tier);
              }}
            >
              采用建议
            </button>
          ) : (
            <span className="taskdlg__hint" data-testid="taskdlg-suggestion-adopted" style={{ margin: 0 }}>
              已采用
            </span>
          )}
        </div>

        <label className="taskdlg__field">
          <span className="taskdlg__label">验收标准（一行一条，可选）</span>
          <textarea
            className="taskdlg__input"
            data-testid="taskdlg-acceptance"
            rows={2}
            value={acceptanceText}
            placeholder="例如：pytest 全过"
            onChange={(e) => setAcceptanceText(e.target.value)}
          />
        </label>

        <label className="taskdlg__field">
          <span className="taskdlg__label">预算上限（可选，按 token 计）</span>
          <input
            className="taskdlg__input"
            data-testid="taskdlg-budget"
            inputMode="numeric"
            value={budgetText}
            placeholder="例如：200000"
            onChange={(e) => setBudgetText(e.target.value)}
          />
        </label>

        <div className="taskdlg__row">
          <label className="taskdlg__field">
            <span className="taskdlg__label">截止时间（可选）</span>
            <input
              className="taskdlg__input"
              data-testid="taskdlg-deadline"
              type="datetime-local"
              value={deadlineText}
              onChange={(e) => setDeadlineText(e.target.value)}
            />
          </label>
          <label className="taskdlg__field">
            <span className="taskdlg__label">依赖任务（可选）</span>
            <input
              className="taskdlg__input"
              data-testid="taskdlg-depends-on"
              value={depsText}
              placeholder="例如：T-1001, T-1002"
              onChange={(e) => setDepsText(e.target.value)}
            />
          </label>
        </div>
        <p className="taskdlg__hint" data-testid="taskdlg-depends-hint">
          依赖任务全部完成后才会自动开工；也可在频道发「依赖 T-1042 T-1001」。
        </p>

        {error.length > 0 ? (
          <p className="taskdlg__error" data-testid="taskdlg-error" role="alert">
            {error}
          </p>
        ) : null}
        </div>

        <footer className="taskdlg__actions">
          <button type="button" className="taskdlg__btn" data-testid="taskdlg-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="taskdlg__btn taskdlg__btn--primary"
            data-testid="taskdlg-submit"
            disabled={submitting || goal.trim().length === 0}
            onClick={() => {
              void submit();
            }}
          >
            {submitting ? '提交中…' : '建任务'}
          </button>
        </footer>
      </section>
    </div>
  );
}
