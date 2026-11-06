/**
 * T0.7 · 任务详情视图容器（中栏）。
 *
 * 职责：把 `store`（valtio）与**纯展示**的 `TaskDetail` 接起来——
 *   - `store.taskDetail` 取数（`task:get` 详情）；
 *   - 顶部**轻量返回/面包屑**（UI §1：导航只在左栏；这里只做“回老板频道”的返回路径 + 当前任务标识，**不是第二套导航**）；
 *   - 未选任务时自动选第一个（便于 T0.7 截图 / 自测直接进入；正常入口是左栏任务行）。
 * 组件仍然不做业务逻辑：取数、裁剪、翻译都在主进程/纯函数里。
 * 落点：本文件与 `TaskDetail.tsx` 同属 `TaskDetail*.tsx`（所有权）。
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { discardTaskChangeset, exportTaskArchive, leaveTaskDetail, loadTaskCosts, loadTasks, mergeTaskChangeset, reworkMergeConflict, openTaskDetail, readArtifact, readToolOutput, referenceArtifact, rollbackTaskChangeset, saveTaskPlan, sendMessage, session, taskCost, taskDetail, tasks, transitionTask } from '../store';
import type { CostSummaryDTO, ProjectDTO, SkillDTO, TaskDTO } from '../types';
import { getApi } from '../api';
import { TaskDetail, type ArtifactPreviewDTO, type TaskDetailDTO, type TaskModelOption, type TaskSettingResult } from './TaskDetail';
import { detailReturn } from './detailReturn';
import { steerCommand, type TaskActionDTO } from './taskActions';
import { waitingReasonText, type TaskWaitDTO } from './waitingReason';

const BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 20px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--panel)',
};
const BACK_STYLE: CSSProperties = {
  minHeight: 32,
  padding: '0 14px',
  border: 0,
  borderRadius: 'var(--radius-pill)',
  background: 'var(--tint-soft)',
  color: 'var(--accent-ink)',
  font: 'inherit',
  fontWeight: 500,
  cursor: 'pointer',
};
const MUTED: CSSProperties = { color: 'var(--text-dim)', fontSize: 12 };
const VIEW_ROOT_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 };

export function TaskDetailView(): ReactElement {
  const detailSnap = useSnapshot(taskDetail);
  const sessionSnap = useSnapshot(session);
  const taskSnap = useSnapshot(tasks);
  const costSnap = useSnapshot(taskCost);

  const list = taskSnap.list as unknown as TaskDTO[];
  const selected = sessionSnap.selectedTaskId;
  const detail = detailSnap.data as unknown as TaskDetailDTO | null;
  // 2026-10-16（任务详情批）：「返回」随入口动态（`detailReturn` 纯映射）；插话入口本地态。
  const ret = detailReturn(sessionSnap.detailReturnView);
  const [steerText, setSteerText] = useState('');
  const [steerNotice, setSteerNotice] = useState('');
  /** UG-03：任务级设置的可选值（项目允许清单 + 只读模型目录 / 已启用技能）。 */
  const [modelOptions, setModelOptions] = useState<readonly TaskModelOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<readonly string[]>([]);
  const settingTask = detail?.task ?? null;

  useEffect(() => {
    const projectId = settingTask?.projectId;
    if (projectId == null) return;
    let cancelled = false;
    void (async () => {
      const api = getApi();
      if (!api) return;
      try {
        const [rawProject, rawCatalog, rawSkills] = await Promise.all([
          api.project.get({ projectId }) as Promise<ProjectDTO | undefined>,
          api.model.catalog({}) as Promise<{ models?: Array<{ provider: string; id: string; name: string; providerLabel: string; keyConfigured: boolean }> } | undefined>,
          api.skills.list({}) as Promise<SkillDTO[] | undefined>,
        ]);
        if (cancelled) return;
        const allowed = rawProject?.allowedModels ?? [];
        const catalog = rawCatalog?.models ?? [];
        const options: TaskModelOption[] = catalog.map((model) => {
          const value = `${model.provider}/${model.id}`;
          return {
            value,
            label: `${model.name} · ${model.providerLabel}`,
            allowed: allowed.length === 0 || allowed.includes(value),
            keyConfigured: model.keyConfigured,
          };
        });
        // 目录未加载/为空时，仍把项目允许清单如实列出来（不丢可选值）。
        if (options.length === 0) {
          for (const value of allowed) options.push({ value, label: value, allowed: true });
        }
        const current = settingTask?.model ?? null;
        if (current && !options.some((option) => option.value === current)) {
          options.unshift({ value: current, label: `${current}（任务当前）`, allowed: true });
        }
        setModelOptions(options);
        const skills = rawSkills ?? [];
        setSkillOptions(skills.filter((skill) => skill.enabled === 1).map((skill) => skill.name));
      } catch {
        if (!cancelled) {
          setModelOptions([]);
          setSkillOptions([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingTask?.projectId, settingTask?.model]);

  const taskLabel = settingTask?.shortId ?? (settingTask ? `T${settingTask.id}` : null);

  /** UG-03：复用已实现的高置信命令（加预算 / 模型 / 用技能）；**拒绝结构化回传**（`rejected`）→
   *  就地显示在 popover 里，不当成功。回执原文同时落老板频道（同一份事实）。 */
  const runTaskCommand = async (text: string): Promise<TaskSettingResult> => {
    const result = await sendMessage({ text, attachments: [] });
    if (result == null) return { ok: false, error: '命令未送出（主进程未连接）' };
    if (result.rejected) return { ok: false, error: result.rejected };
    if (settingTask) await openTaskDetail(settingTask.id);
    return { ok: true };
  };

  useEffect(() => {
    // 键盘交互批：**Esc 返回**（输入中/危险动作确认条/预览抽屉在场时不抢——
    // 确认条与抽屉各自处理自己的 Esc；UG-05：抽屉开着时 Esc 只关抽屉，不退详情）。
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (
        target != null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[data-testid="task-action-confirm"]') != null) return;
      if (document.querySelector('[data-testid="artifact-drawer-scrim"]') != null) return;
      if (document.querySelector('[data-testid="attachment-preview"]') != null) return;
      leaveTaskDetail();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** 插话（2026-10-16）：走高置信直通同一路径（`#短号 要说的话`）——与频道手打等价，不打折。 */
  async function sendSteer(): Promise<void> {
    if (detail == null || steerText.trim().length === 0) return;
    const text = steerText.trim();
    const result = await sendMessage({ text: steerCommand(detail.task.shortId, detail.task.id, text), attachments: [] });
    if (result == null) {
      setSteerNotice('插话未送出（主进程未连接）');
      return;
    }
    setSteerText('');
    setSteerNotice('已送出（回执见老板频道）');
  }

  useEffect(() => {
    if (list.length === 0) void loadTasks();
  }, [list.length]);

  useEffect(() => {
    if (selected == null) {
      const first = list[0];
      if (first) void openTaskDetail(first.id);
      return;
    }
    if (!detail || detail.task.id !== selected) void openTaskDetail(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在「选中任务变化 / 详情缺失」时取数
  }, [selected, detail, list]);

  // OPT-EXT-13 成本 tab：选中任务变化时拉单任务成本（含 byModel）。
  useEffect(() => {
    if (selected != null) void loadTaskCosts(selected);
  }, [selected]);

  const label = detail ? `${detail.task.shortId ?? `#${detail.task.id}`} · ${detail.task.title}` : null;
  // M1-3：等待文案**只由单一映射表产出**（`waitingReason.ts`）；无等待 → 空数组 → 不渲染占位。
  const waitTexts = (detail?.waits ?? []).map((wait: TaskWaitDTO) => waitingReasonText(wait));

  return (
    <section className="task-detail-view" data-testid="task-detail-view" style={VIEW_ROOT_STYLE}>
      <div className="task-detail-view__bar" style={BAR_STYLE}>
        {/* 返回路径（UI §1/层级纪律）：**随入口动态**——从哪进来回哪（缺省＝老板频道）。 */}
        <button type="button" style={BACK_STYLE} data-testid="back-to-channel" data-return-target={ret.target} onClick={leaveTaskDetail}>
          ← {ret.label}
        </button>
        <span style={MUTED}>任务详情</span>
        {label ? (
          <span style={MUTED} data-testid="task-detail-breadcrumb">
            {label}
          </span>
        ) : null}
        {/* 插话入口（2026-10-16 批）：`#短号 要说的话` 直通（steer 到员工下一步前；与频道同路径）。 */}
        {detail ? (
          <span className="tdv__steer" data-testid="task-steer">
            <input
              className="tdv__steerinput"
              data-testid="task-steer-input"
              value={steerText}
              placeholder={`对 ${detail.task.shortId ?? `#${detail.task.id}`} 插话…`}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendSteer();
              }}
            />
            <button
              type="button"
              className="tdv__steerbtn"
              data-testid="task-steer-send"
              disabled={steerText.trim().length === 0}
              onClick={() => void sendSteer()}
            >
              插话
            </button>
            {steerNotice.length > 0 ? (
              <span style={MUTED} data-testid="task-steer-notice">
                {steerNotice}
              </span>
            ) : null}
          </span>
        ) : null}
        {detailSnap.loading ? <span style={MUTED}>加载中…</span> : null}
        {detailSnap.error ? (
          <span
            className="task-detail-view__error"
            style={{ color: 'var(--danger)', fontSize: 12 }}
            data-testid="task-detail-error"
          >
            {detailSnap.error}
          </span>
        ) : null}
        {/* 挂载 3（BRK17）：详情操作失败回执（如「撤销结束」超 7 天窗口）——不静默。 */}
        {detailSnap.actionNotice ? (
          <span
            className="task-detail-view__notice"
            style={{ color: 'var(--warn)', fontSize: 12, marginLeft: 8 }}
            data-testid="task-action-notice"
          >
            {detailSnap.actionNotice}
          </span>
        ) : null}
        {detailSnap.planNotice ? (
          <span
            className="task-detail-view__notice"
            style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 8 }}
            data-testid="task-plan-notice"
          >
            {detailSnap.planNotice}
          </span>
        ) : null}
        {detailSnap.mergeNotice ? (
          <span
            className="task-detail-view__notice"
            style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 8 }}
            data-testid="task-merge-notice-bar"
          >
            {detailSnap.mergeNotice}
          </span>
        ) : null}
        {detailSnap.rollbackNotice ? (
          <span
            className="task-detail-view__notice"
            style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 8 }}
            data-testid="task-rollback-notice-bar"
          >
            {detailSnap.rollbackNotice}
          </span>
        ) : null}
        {detailSnap.discardNotice ? (
          <span
            className="task-detail-view__notice"
            style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 8 }}
            data-testid="task-discard-notice-bar"
          >
            {detailSnap.discardNotice}
          </span>
        ) : null}
      </div>
      <TaskDetail
        data={detail}
        waitTexts={waitTexts}
        cost={costSnap.data as unknown as CostSummaryDTO | null}
        refTargets={detailSnap.refTargets as unknown as ReadonlyArray<{ id: number; shortId: string | null; title: string }>}
        onReferenceArtifact={(artifactId, targetTaskId, mode) => void referenceArtifact(artifactId, targetTaskId, mode)}
        referenceNotice={detailSnap.referenceNotice}
        // BRK16-a（挂载 3）：产物读/打开/文件夹 + GAP11 导出档案（导出是任务级：带上当前任务 id）
        onReadArtifact={(artifactId, mode) => void readArtifact(artifactId, mode)}
        onExportArchive={(openAction) => {
          if (detail) void exportTaskArchive(detail.task.id, openAction);
        }}
        artifactPreview={detailSnap.artifactPreview as unknown as ArtifactPreviewDTO | null}
        onCloseArtifactPreview={() => {
          // 浮层批（2026-10-17）：关闭预览抽屉（✕ / 遮罩 / Esc）——清掉 store 里的最近预览。
          taskDetail.artifactPreview = null;
        }}
        artifactNotice={detailSnap.artifactNotice}
        exportNotice={detailSnap.exportNotice}
        onSavePlan={detail ? (steps, approve) => saveTaskPlan(detail.task.id, steps, approve) : undefined}
        onMergeChangeset={
          detail
            ? async (changesetId) => (await mergeTaskChangeset(detail.task.id, changesetId)) === null
            : undefined
        }
        mergeNotice={detailSnap.mergeNotice}
        mergeConflicts={detailSnap.mergeConflicts ?? null}
        mergeConflictChangesetId={detailSnap.mergeConflictChangesetId ?? null}
        onReworkConflict={detail ? (id) => reworkMergeConflict(detail.task.id, id) : undefined}
        onRollbackChangeset={
          detail ? (changesetId) => void rollbackTaskChangeset(detail.task.id, changesetId) : undefined
        }
        rollbackNotice={detailSnap.rollbackNotice}
        onDiscardChangeset={
          detail
            ? async (changesetId) => (await discardTaskChangeset(detail.task.id, changesetId)) === null
            : undefined
        }
        discardNotice={detailSnap.discardNotice}
        onReadToolOutput={(ref) => readToolOutput(ref)}
        onReadChangesetDiff={async (changesetId, path) => {
          if (!detail) return { ok: false, error: '任务未加载' };
          const api = getApi();
          if (!api?.task?.diff) return { ok: false, error: 'diff 通道不可用（主进程未连接）' };
          const res = (await api.task.diff({ taskId: detail.task.id, changesetId, path })) as
            | {
                ok?: boolean;
                code?: string;
                message?: string;
                diff?: string;
                truncated?: boolean;
                baseSha?: string;
                headSha?: string;
              }
            | undefined;
          if (!res || res.ok === false) {
            return { ok: false, error: res?.message ?? res?.code ?? 'diff 读取失败' };
          }
          return {
            ok: true,
            diff: res.diff ?? '',
            truncated: res.truncated === true,
            baseSha: res.baseSha,
            headSha: res.headSha,
          };
        }}
        modelOptions={modelOptions}
        skillOptions={skillOptions}
        onSetBudget={(tokens) =>
          taskLabel == null
            ? Promise.resolve({ ok: false, error: '任务短号缺失' })
            : runTaskCommand(`加预算 ${taskLabel} ${tokens}`)
        }
        onSetModel={(model) =>
          taskLabel == null
            ? Promise.resolve({ ok: false, error: '任务短号缺失' })
            : runTaskCommand(model == null ? `模型 ${taskLabel} 默认` : `模型 ${taskLabel} ${model}`)
        }
        onSetSkill={(skill) =>
          taskLabel == null
            ? Promise.resolve({ ok: false, error: '任务短号缺失' })
            : runTaskCommand(skill == null ? `取消技能 ${taskLabel}` : `用技能 ${skill} ${taskLabel}`)
        }
        onAction={(action: TaskActionDTO) => {
          // D2/C3：**只有已实现且带事件**的动作才会走到这里（纯组件已挡住未实现的）。
          if (!detail || !action.event) return;
          void transitionTask(detail.task.id, action.event, action.payload);
        }}
      />
    </section>
  );
}
