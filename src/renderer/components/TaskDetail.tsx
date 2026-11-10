/**
 *  · 任务详情三 tab 最小版（计划与验收 / 时间线 / 行为日志）。
 *
 * 边界与定位：
 *  - **纯展示组件**：只吃 props（`TaskDetailDTO`），不读写 valtio store、不碰 `window.api`/DB/fs；
 *    接线（取数 + 中栏视图切换）在 `store.ts` / `AppShell.tsx` 完成。
 *  - 数据源契约（一处写死，便于机器断言）：
 *      `plan` = `plan_steps`（按 idx 排序）+ 验收项 `tasks.acceptance`
 *      `timeline` = `task_events` 全量投影
 *      `behavior` = `task_events` 中 `kind='tool_call'` 子集（审计层，UI §9）
 *      `artifacts`= `artifacts` 表（`sha256` + **来源=kind/`work_item_id`产出者/`created_at`**）+ 各步证据 `plan_steps.evidence_ref`（；`commit` 恒显，数据源 `changesets` 属→ 现为 `—`）
 *  - 条数一致性断言（验收②）：每个 tab 的**行元素**都带固定 `data-testid`，
 *    `test/task-detail.test.ts` 用 `react-dom/server` 渲染真实组件后逐 tab 数 `data-testid` 出现次数，
 *    与查询返回条数（`counts`）比对——**不靠肉眼**。
 *
 * `data-testid` 清单（稳定契约，勿改）：
 *  - tab 按钮：`plan` / `artifacts` / `timeline`（3 个；记录内含行为日志筛选）
 *  - 内部面板（非 tab，供测试/兼容）：`behavior-panel` / `cost-panel`
 *  - 行：`plan-step` / `acceptance-item` / `timeline-item` / `behavior-item` / `artifact-item` / `evidence-item`
 *  - 空态：`artifacts-empty`（**空态不伪装**）
 *  - 顶部：`task-detail`（根）、`progress`（进度条）
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { normalizePlanSteps, PLAN_STEPS_MAX } from '../../core/plan.js';
import type { CostSummaryDTO } from '../types.js';
import type { TaskWaitDTO } from './waitingReason.js';
import { RawConversation, type RawItemDTO } from './RawConversation.js';
import { cancelConfirmText, rejectActionWithNotes, taskActionsOf, type TaskActionDTO } from './taskActions.js';
import { parseUnifiedDiff, type DiffRow } from './changesetDiff.js';
import {
  diffNotesStorageKey,
  diffNotesTaskPrefix,
  parseDiffNoteMap,
  pathFromDiffNotesKey,
  summarizeDiffNotes,
  type DiffNoteEntry,
} from './diffNotes.js';
import { dependencySummary, forcedSkillOf, taskContextView } from './taskContext.js';
import { verdictText, verdictTone } from './cardCopy.js';
import { appendPlanStep, movePlanStep, removePlanStep, updatePlanStep } from './planEditor.js';
import { PROJECT_STATE_LABEL } from './projectView.js';
import { PreviewDrawer } from './PreviewDrawer.js';
import { STATE_TONE } from './taskVisuals.js';

// ── DTO（与主进程 `task:get` 返回一致；形状见本群 id 1190 接口请求）───────────────

export type PlanStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface AcceptanceItemDTO {
  text: string;
  /** 可选的可执行检查命令（schema.sql `tasks.acceptance`：[{text, check?}]）。 */
  check?: string;
  /** 验收判定（由 `verification_completed` 投影； 缺省 pending）。 */
  state?: 'pending' | 'pass' | 'fail';
  evidenceRef?: string | null;
}

/** 产物（`artifacts` 表；`path` **仅供参考展示**，渲染层不据此读盘）。
 * **来源口径（1993 裁定 (b)，不加迁移）**：来源 = `kind` + **`workItemId`（谁产出）** + `at`（= `created_at`）。
 * `commit` 待从 `changesets` join（可得则显示前 8 位，不可得保持缺省）。 */
export interface ArtifactDTO {
  id: number;
  kind: string;
  name: string;
  path: string;
  sha256?: string | null;
  /** 产出该产物的提交（join `changesets` 可得时）；不可得为 `null`。 */
  commit?: string | null;
  workItemId?: number | null;
  at?: number | null;
  /** G-A 余项（2026-10-16）：引用副本的来源（结构化；自产缺省/`null`）。 */
  originArtifactId?: number | null;
  originProjectId?: number | null;
  originProjectName?: string | null;
  /**  尾（G-A link）：`link:<originProjectId>` ＝ 链接（源随动）；NULL＝副本/自产。 */
  source?: string | null;
}

/** -a（挂载 3）：产物读预览（`task:read-artifact` `mode:'read'` 的回执；容器（store）传入）。 */
export interface ArtifactPreviewDTO {
  artifactId: number;
  name: string;
  path: string;
  size: number;
  sha256: string;
  /** 实读 sha256 与产物记录不一致（内容仍如实展示；记录不改）。 */
  sha256Mismatch: boolean;
  /**
   * 2026-11-05：同任务同路径存在**更晚产出**（旧版本）。此时指纹不一致是「旧版本」的事实，
   * 不是异常——抽屉显示「旧版本（已被 #N 后续产出覆盖）」而不报警。
   */
  supersededBy?: { artifactId: number; createdAt: number } | null;
  text: string;
  /** 超出读预览上限、已截断（如实标注，不假装全文）。 */
  truncated: boolean;
  /** 图片/PDF 受控预览（`aico-file://preview/<短票>`）；文本不带 URL。 */
  previewKind?: 'image' | 'pdf';
  previewUrl?: string;
}

export interface PlanStepDTO {
  idx: number;
  text: string;
  state: PlanStepState;
  workItemId?: number | null;
  evidenceRef?: string | null;
}

export interface TimelineItemDTO {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  workItemId?: number | null;
  /** 原始事件载荷（人话投影由 UI 侧渲染，事件本身不改写）。 */
  payload?: unknown;
}

export interface BehaviorLogItemDTO {
  id: number;
  ts: number;
  actor: string;
  workItemId?: number | null;
  payload?: unknown;
}

export interface TaskHeadDTO {
  id: number;
  shortId: string | null;
  projectId: number;
  title: string;
  goal: string;
  state: string;
  /** paused 来源（v15）：manual | task_budget | company_budget；NULL＝老行/未知。 */
  pauseReason?: string | null;
  /** `tasks.archived`（0/1）：归档任务锁定合并/回滚。 */
  archived?: number;
  riskLevel: number;
  priority: number;
  createdAt: number;
  updatedAt: number;
  acceptance: AcceptanceItemDTO[];
  /** 项目接入模式（`inplace` ⇒ 不产生变更集）。 */
  projectAccessMode?: string | null;
  /** 009：任务级模型（NULL＝未指派）。 */
  model?: string | null;
  /**  尾：截止时刻（epoch ms；NULL＝未设）。 */
  deadline?: number | null;
  /** 所属项目名/别名（task:get 的 toStoredTask 带上）。 */
  projectName?: string | null;
  projectAlias?: string | null;
  /** 最新工作项的执行员工（无件 ⇒ null；缺省＝旧数据不承诺）。 */
  executor?: { id: number; name: string | null } | null;
  /** 预算 / 已耗 / 余额（未设 ⇒ null；不写假 0）。 */
  budgetTokens?: number | null;
  costTokens?: number | null;
  budgetLeftTokens?: number | null;
}

/** `task:get` 的负责人（建单/分工给的；与执行员工分开）。 */
export interface TaskOwnerDTO {
  id: number;
  name: string;
}

/** 前置任务（短号 + 标题 + 状态；调度器真值）。 */
export interface TaskDependencyDTO {
  id: number;
  shortId: string | null;
  title: string;
  state: string;
}

/** 差异清单逐条投影（由 `task_events.deviation_recorded` 派生）。 */
export interface DeviationItemDTO {
  title: string;
  why: string | null;
  owner: string | null;
  milestone: string | null;
  status: string;
  open: boolean;
}

export interface DeviationSummaryDTO {
  total: number;
  open: number;
  openWithoutOwner: string[];
  items?: DeviationItemDTO[];
}

/** 任务级模型选项（项目允许清单 + 只读模型目录投影）。 */
export interface TaskModelOption {
  /** `provider/model`（写 `tasks.model` 的完整串）。 */
  value: string;
  label: string;
  /** 项目允许清单是否放行；false → 控件 disabled（不假装可点）。 */
  allowed: boolean;
  keyConfigured?: boolean;
}

/** 保存类操作的统一回执（失败必须能显示原因）。 */
export interface TaskSettingResult {
  ok: boolean;
  error?: string;
}

/** 容器读一条变更集 diff 的回执（成功只给文本与 SHA，不给仓库路径）。 */
export interface ChangesetDiffResult {
  ok: boolean;
  diff?: string;
  truncated?: boolean;
  baseSha?: string;
  headSha?: string;
  error?: string;
}

export interface ChangesetDiffViewState {
  changesetId: number;
  path: string;
  loading: boolean;
  error?: string;
  diff?: string;
  truncated?: boolean;
  baseSha?: string;
  headSha?: string;
}

/** 任务头「预计模型＋来源」（执行员工视角）。 */
export interface TaskModelResolutionDTO {
  model: string;
  source: string;
  /** assistant 选型理由。 */
  reason?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  rejected?: string;
}

/**  变更集（变更区块）。 */
export interface ChangesetDTO {
  id: number;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
  state: string;
  createdAt: number;
  files: Array<{
    path: string;
    status: string;
    insertions: number;
    deletions: number;
    employeeId: number | null;
    /** 产出员工名（查无 → null；不臆造）。 */
    employeeName?: string | null;
  }>;
}

/** CTX1-2：单层上下文读数（与主进程 `ContextMetricLayer` 同形）。 */
export interface ContextLayerMetricDTO {
  name: string;
  side?: 'system' | 'user';
  chars: number;
  estTokens: number;
  truncated: boolean;
  tokensBeforeCap: number;
}

/** CTX1-2：一轮上下文遥测（`context_metrics` 行；未知一律 null → 显 —）。 */
export interface ContextMetricDTO {
  id: number;
  sessionKey: string;
  ts: number;
  totalTokens: number;
  systemTokens: number;
  userTokens: number;
  contextWindow: number | null;
  utilization: number | null;
  truncated: boolean;
  layers: ContextLayerMetricDTO[];
  compactionCount: number | null;
  tokensBeforeCompaction: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** 评审/验证结论（`reports.verdict` 优先；timeline 事件补齐批注）。 */
export interface ReviewDTO {
  eventId: number;
  ts: number;
  stage: 'plan' | 'verification';
  actor: string;
  role: string | null;
  verdict: string | null;
  notes: string | null;
  workItemId: number | null;
  reportId: number | null;
  verifierEmployeeId: number | null;
}

/** `task:get` 返回体（timeline/planSteps/behaviorLog 为该任务的查询结果）。 */
export interface TaskDetailDTO {
  task: TaskHeadDTO;
  /** 负责人（建单/分工；缺省/旧数据 ⇒ null → 显「未指定」）。 */
  owner?: TaskOwnerDTO | null;
  /** 前置任务（空/缺省 ＝ 无依赖）。 */
  dependsOn?: TaskDependencyDTO[];
  /** 差异清单汇总（缺省/空 ＝ 无偏离；收尾 openWithoutOwner 必须为空）。 */
  deviations?: DeviationSummaryDTO | null;
  /** 任务头「预计模型＋来源」；缺省＝旧数据（不渲染模型行）。 */
  modelResolution?: TaskModelResolutionDTO | null;
  progress: { done: number; total: number };
  planSteps: PlanStepDTO[];
  /** critic/verifier 结论；缺省/空＝无评审结论（不渲染空组）。 */
  reviews?: ReviewDTO[];
  /** 验证中被打回的最近 submitted 件（手动打回补全 workItemId 用）。 */
  verificationWorkItemId?: number | null;
  timeline: TimelineItemDTO[];
  behaviorLog: BehaviorLogItemDTO[];
  /** （` 第 4 条`）：引擎给出的等待原因；**空/缺省 = 不等待**（渲染层不显示占位）。 */
  waits?: TaskWaitDTO[];
  /** 本任务产物（按 id 升序；空 = 无产物）。 */
  artifacts?: ArtifactDTO[];
  /** （2303/2328）：原始交流**派生投影**（只读）；**缺省/空 = 无原始交流**（渲染层显式空态，不臆造）。 */
  rawConversation?: RawItemDTO[] | null;
  /** 本任务变更集（含文件明细）；**缺省/空 = 无**（`inplace` 显式说明）。 */
  changesets?: ChangesetDTO[] | null;
  /** （挂载 3 余·取消小步）：工作项按状态计数——危险动作（取消）确认文案的真读数；缺省 ⇒ 不写数字。 */
  workItemCounts?: Record<string, number> | null;
  /** CTX1-2：最近 N 轮上下文遥测（新的在前）；**缺省/空 = 还没有任何会话遥测**（显式空态，不写假 0）。 */
  contextMetrics?: ContextMetricDTO[] | null;
  /** G-C（§7 序 3）：可引用的**候选目标任务**（非归档、**不含本任务**）；缺省/空 → 引用控件不可用。 */
  refTargets?: readonly ArtifactRefTarget[];
  /** G-C：把某产物引用到目标任务（**老板显式发起**）；缺省 → 行内按钮 disabled（不假装可点）。 */
  onReferenceArtifact?: (artifactId: number, targetTaskId: number, mode?: 'copy' | 'link') => void;
  /** G-C：最近一次引用的结果回执（人话；失败也在这里显式给出）。 */
  referenceNotice?: string | null;
  /** 查询返回条数：断言「DOM 条数 == 查询返回条数」用（不靠肉眼）。 */
  counts?: { planSteps: number; timeline: number; behaviorLog: number; acceptance: number };
}

/** G-C：引用候选（目标任务）最小面。 */
export interface ArtifactRefTarget {
  id: number;
  shortId: string | null;
  title: string;
}

export type TaskDetailTab = 'plan' | 'timeline' | 'behavior' | 'artifacts' | 'cost';

// ── 纯函数（可单测，无副作用）─────────────────────────────────────────────

/** 进度条：`plan_steps` 中 state='done' 计数 / 总数（schema.sql 头注释）。 */
export function progressOf(steps: readonly PlanStepDTO[]): { done: number; total: number } {
  let done = 0;
  for (const step of steps) if (step.state === 'done') done += 1;
  return { done, total: steps.length };
}

/** 行为日志 = `task_events` 中 `kind='tool_call'` 子集（按 id 升序，保持事件顺序）。 */
export function behaviorLogOf(events: readonly TimelineItemDTO[]): BehaviorLogItemDTO[] {
  return events
    .filter((event) => event.kind === 'tool_call')
    .map((event) => ({
      id: event.id,
      ts: event.ts,
      actor: event.actor,
      workItemId: event.workItemId ?? null,
      payload: event.payload,
    }));
}

/** 时间线的人话投影标题（UI §9；事件本身仍是唯一事实来源，这里只做展示层翻译）。 */
const TIMELINE_LABEL: Record<string, string> = {
  task_created: '创建任务',
  task_triaged: '分诊',
  task_activated: '依赖满足，激活',
  plan_drafted: '计划草案',
  plan_edited: '修改计划',
  plan_reviewed: '计划评审',
  plan_approved: '计划批准',
  task_started: '开始执行',
  task_paused: '暂停',
  task_resumed: '继续',
  task_reopened: '撤销结束',
  work_item_created: '拆分工作项',
  work_item_started: '工作项开始',
  work_item_done: '工作项完成',
  work_item_failed: '工作项失败',
  work_item_rejected: '工作项被打回',
  work_item_skipped: '工作项跳过',
  action_failed: '动作失败',
  deviation_recorded: '偏离',
  progress_reported: '进展汇报',
  artifact_produced: '产出产物',
  verification_started: '开始验证',
  verification_completed: '验证完成',
  verification_invalidated: '验证结论已过期',
  review_completed: '评审完成',
  checkpoint_created: '记录检查点',
  work_item_rolled_back: '工作项已回滚',
  changeset_created: '生成变更集',
  changeset_merged: '变更已合并',
  changeset_discarded: '变更已丢弃',
  budget_exceeded: '超预算暂停',
  task_skill_forced: '强制加载技能',
  task_renewed: '续办任务',
  report_generated: '生成汇报',
  decision_requested: '请求决策',
  decision_made: '做出决策',
  task_completed: '任务完成',
  task_failed: '任务失败',
  task_blocked: '任务阻塞',
  task_archived: '任务归档',
  cost_recorded: '记录成本',
  tool_call: '工具调用',
};

export function timelineLabel(kind: string): string {
  return TIMELINE_LABEL[kind] ?? kind;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 事件载荷里可读的一行摘要（工具调用显示命令/名称；其余显示关键字段）。 */
export function payloadSummary(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  for (const key of ['tool', 'toolName', 'name', 'command', 'cmd', 'summary', 'title', 'text', 'state']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  try {
    const json = JSON.stringify(payload);
    return json.length > 160 ? `${json.slice(0, 160)}…` : json;
  } catch {
    return '';
  }
}

/**
 * G3/G6 上屏：从 `payload` 取「逐工具耗时 `durationMs`」与「未落盘标记 `sessionPersisted===false`」。
 * **白名单**（不扫全部字段）：字段缺/类型不对 → **不返回**（调用方不渲染、**不臆造、不显示空白异常**）。
 */
export function payloadFlags(payload: unknown): {
  durationMs?: number;
  notPersisted?: boolean;
  outputSummary?: string;
  outputRef?: string;
  outputBytes?: number;
} {
  if (payload == null || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const out: {
    durationMs?: number;
    notPersisted?: boolean;
    outputSummary?: string;
    outputRef?: string;
    outputBytes?: number;
  } = {};
  if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)) out.durationMs = record.durationMs;
  if (record.sessionPersisted === false) out.notPersisted = true;
  if (typeof record.outputSummary === 'string' && record.outputSummary.length > 0) out.outputSummary = record.outputSummary;
  if (typeof record.outputRef === 'string' && record.outputRef.length > 0) out.outputRef = record.outputRef;
  if (typeof record.outputBytes === 'number' && Number.isFinite(record.outputBytes)) out.outputBytes = record.outputBytes;
  return out;
}

export type ToolOutputReadResult = { ok: true; text: string } | { ok: false; error: string };

/** P2：工具大输出摘要＋按需展开（展开走容器注入的受控读取；纯展示不碰 fs）。 */
function ToolOutputExpand({
  outputRef,
  summary,
  onRead,
}: {
  outputRef: string;
  summary?: string;
  onRead?: (ref: string) => Promise<ToolOutputReadResult>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false);
      return;
    }
    if (text != null) {
      setOpen(true);
      return;
    }
    if (!onRead) {
      setError('读取未接线');
      setOpen(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await onRead(outputRef);
      if (res.ok) setText(res.text);
      else setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setOpen(true);
    }
  };

  return (
    <span className="td__tooloutput-wrap" data-testid="tool-output" data-ref={outputRef}>
      {summary ? (
        <span className="td__meta" data-testid="tool-output-summary" title={summary}>
          {' · 输出摘要：'}
          {summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}
        </span>
      ) : null}
      <button type="button" className="td__toggle" data-testid="tool-output-expand" onClick={() => void toggle()}>
        {loading ? '读取中…' : open ? '收起输出' : '展开输出'}
      </button>
      {open ? (
        error != null ? (
          <pre className="td__tooloutput" data-testid="tool-output-error" style={{ color: 'var(--danger)' }}>
            {error}
          </pre>
        ) : (
          <pre className="td__tooloutput" data-testid="tool-output-text">
            {text ?? ''}
          </pre>
        )
      ) : null}
    </span>
  );
}

/** G3：时长人读格式（`≥1000ms` → `1.2s`；否则 `Nms`）。 */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** （挂载 3）：任务头/成本面板的预算徽标文案（未设 ⇒「预算：未设」；不写假 0）。 */
export function budgetBadge(task: unknown): string {
  const t = (task ?? {}) as { budgetTokens?: number | null; costTokens?: number; budgetLeftTokens?: number | null };
  if (t.budgetTokens == null) return '预算：未设';
  return `预算：${t.budgetTokens} · 已耗 ${t.costTokens ?? 0} · 余 ${t.budgetLeftTokens ?? 0}`;
}

/**
 * 2026-10-17（逐页审查批，设计板 §4.2 v2「徽标人话，L1 进悬停」）：风险档→人话档位。
 * 术语（L0/L1/L2 与档位解释）只进 `title` 悬停，不上屏。
 */
const RISK_WORD: Record<number, string> = { 0: '低', 1: '中', 2: '高' };
const RISK_HINT: Record<number, string> = {
  0: '直通：计划不送评审、直接开工',
  1: '审计划：计划先经你批准',
  2: '全流程：另加人工批准',
};

/** 模型来源人话（来源词与 core/model-tiers 的 ModelSource 一一对应）。 */
const MODEL_SOURCE_LABEL: Record<string, string> = {
  task: '任务指定',
  assistant: '幕僚长选择',
  employee: '员工偏好',
  role_map: '角色映射',
  'economy(L0)': '省钱档',
  project_default: '项目默认',
  default: '公司默认',
};

/** 产物类型→人话（未知类型原样显示——不臆造）。 */
function artifactKindText(kind: string): string {
  const map: Record<string, string> = { file: '文件', url: '链接', snapshot: '快照', input: '输入' };
  return map[kind] ?? kind;
}

/** 行内追加的「时长 / 未落盘」小标记（无字段时渲染 `null`，不留空 span）。 */
function PayloadFlags({ payload, prefix }: { payload: unknown; prefix: string }): ReactElement | null {
  const flags = payloadFlags(payload);
  const hasDuration = flags.durationMs !== undefined;
  if (!hasDuration && !flags.notPersisted) return null;
  return (
    <>
      {hasDuration ? (
        <span className="td__meta" data-testid={`${prefix}-duration`}>
          {' · '}
          {formatDuration(flags.durationMs as number)}
        </span>
      ) : null}
      {flags.notPersisted ? (
        <span
          className="td__meta"
          data-testid={`${prefix}-not-persisted`}
          style={{ color: 'var(--danger)' }}
          title="本次会话未能落盘：会话历史可能丢失（重启不可续）；已完成的任务事件/产物仍以数据库为准"
        >
          {' · ⚠️ 未落盘（会话历史可能丢失）'}
        </span>
      ) : null}
    </>
  );
}

// ── 样式（内联注入，避免改 styles.css；一次性 <style> 声明 .td-* 命名空间）──

const TASK_DETAIL_CSS = `
.td{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
.td__head{padding:16px 20px 12px;border-bottom:.5px solid var(--separator)}
.td__line1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.td__short{font-weight:600;color:var(--accent)}
.td__title{font-size:var(--text-title);font-weight:600;margin:0}
/* 2026-10-17（审查批）：标题区右组读数（去 chip 感）——状态点＋人话，术语只进悬停。 */
.td__readings{margin-left:auto;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;color:var(--text-dim);font-size:var(--text-meta)}
.td__reading{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.td__readingdot{width:6px;height:6px;border-radius:50%;background:var(--text-dim)}
.td__reading--state[data-tone='accent']{color:var(--text)}
.td__reading--state[data-tone='accent'] .td__readingdot{background:var(--accent)}
.td__reading--state[data-tone='warn'] .td__readingdot{background:var(--warn)}
.td__reading--state[data-tone='danger'] .td__readingdot{background:var(--danger)}
.td__progress{display:flex;align-items:center;gap:8px;margin-top:8px}
.td__bar{position:relative;flex:0 0 180px;height:5px;border-radius:var(--radius-pill);background:var(--fill);overflow:hidden}
.td__barfill{position:absolute;inset:0 auto 0 0;background:var(--accent)}
.td__progresstext{color:var(--text-dim);font-size:var(--text-meta)}
.td__tabs{display:inline-flex;gap:4px;width:fit-content;margin:12px 20px 0;padding:2px;border:0;border-radius:var(--radius-md);background:var(--fill)}
.td__tab{min-height:30px;padding:0 14px;border:0;border-radius:var(--radius-inner);background:transparent;color:var(--text-dim);font:inherit;font-size:var(--text-body);font-weight:500;cursor:pointer}
.td__tab:hover{background:var(--hover-layer);color:var(--text)}
/* 选中态：Cupertino 分段控件——白色 thumb ＋ 轻阴影，不再用绿色底线。 */
.td__tab[aria-selected='true']{background:var(--panel);color:var(--text);font-weight:600;box-shadow:var(--shadow-card)}
.td__panel{flex:1;overflow:auto;padding:16px 20px 24px;display:flex;flex-direction:column;gap:16px;min-height:0}
.td__group{display:flex;flex-direction:column;gap:8px}
.td__grouptitle{margin:0;font-size:var(--text-section);font-weight:600;letter-spacing:0;line-height:var(--leading-title);color:var(--text);text-transform:none}
.td__row{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:.5px solid var(--separator);border-radius:var(--radius-md);background:var(--panel);line-height:var(--leading-ui)}
.td__idx{flex:0 0 22px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.td__text{flex:1;line-height:1.5;word-break:break-word}
.td__meta{color:var(--text-dim);font-size:var(--text-meta);white-space:nowrap}
.td__dot{flex:0 0 8px;height:8px;margin-top:6px;border-radius:50%;background:var(--text-dim)}
.td__dot[data-state='done']{background:var(--ok)}
.td__dot[data-state='running']{background:var(--accent)}
.td__dot[data-state='failed']{background:var(--danger)}
.td__dot[data-state='skipped']{background:var(--warn)}
/* 验收三态（2026-10-16 批，设计板：点色双编码扩展到验收行）：已过＝绿 / 未过＝红 / 未跑＝灰。 */
.td__dot[data-state='pass']{background:var(--ok)}
.td__dot[data-state='fail']{background:var(--danger)}
.td__dot[data-state='pending']{background:var(--text-dim)}
.td__empty{display:flex;flex-direction:column;gap:4px;margin:0;color:var(--text-dim);padding:4px 0;font-size:var(--text-note);line-height:1.65}
.td__emptytitle{font-size:var(--text-body);font-weight:600;line-height:var(--leading-title);color:var(--text)}
.td__empty span{font-size:var(--text-note);line-height:1.65}
.td__waits{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.td__wait{padding:4px 8px;border-radius:var(--radius-pill);background:var(--panel-2);color:var(--warn);font-size:var(--text-meta)}
/* 操作条（2026-10-17 审查批，设计板 §4.2）：主/次/危险三型；**未实现＝panel-2 底＋dim 字**（禁用可辨）。 */
.td__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.td__action{min-height:32px;padding:0 14px;border:0;border-radius:var(--radius-pill);background:var(--fill);color:var(--text);font:inherit;font-size:var(--text-body);font-weight:500;cursor:pointer}
.td__action:disabled{background:var(--fill);color:var(--text-dim);cursor:not-allowed;opacity:.4}
.td__action--danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border-color:transparent}
.td__more{position:relative}
.td__more-summary{list-style:none;display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 12px;border-radius:var(--radius-pill);background:var(--fill);color:var(--text);font-size:var(--text-body);cursor:pointer}
.td__more-summary::-webkit-details-marker{display:none}
.td__more-menu{position:absolute;top:calc(100% + 8px);left:0;z-index:20;display:grid;gap:4px;min-width:160px;padding:8px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-overlay)}
.td__more-menu .td__action{justify-content:flex-start;width:100%;background:transparent;text-align:left}
.td__confirm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.td__confirm-text{flex:1;min-width:220px;font-size:var(--text-note);line-height:1.6;color:var(--text-dim)}
/* 变更集文件行（status / 路径 / +− / 员工 / diff）。 */
.td__csfiles{display:flex;flex-direction:column;gap:4px;margin:0 0 4px 12px}
.td__csfile{display:flex;align-items:center;gap:8px;padding:6px 10px;border-left:2px solid var(--border);background:var(--panel-2);border-radius:var(--radius-sm);font-size:var(--text-meta)}
.td__csbadge{flex:0 0 20px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--fill);color:var(--text-dim);font-size:var(--text-meta);font-weight:600}
.td__csbadge[data-status='added']{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.td__csbadge[data-status='deleted']{background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)}
.td__csbadge[data-status='renamed']{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.td__csfilepath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-size:var(--text-meta)}
/* 全宽只读 diff 层（覆盖任务详情；Esc 只关这一层）。 */
.td__diff-layer{position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;background:var(--bg);min-height:0}
.td__diff-head{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:.5px solid var(--separator);background:var(--panel)}
.td__diff-title{flex:0 1 auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-title);font-weight:600}
.td__diff-head .td__popover-close{margin-left:auto}
.td__diff-body{flex:1;min-height:0;overflow:auto;padding:12px 20px;background:var(--panel);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7}
.td__diffrow{display:flex;gap:12px;min-height:22px;white-space:pre-wrap;word-break:break-word;border-radius:var(--radius-sm)}
.td__diffline{flex:0 0 38px;text-align:right;color:var(--text-faint);font-variant-numeric:tabular-nums;user-select:none}
.td__difftext{flex:1;min-width:0}
.td__diffrow--add{background:color-mix(in srgb,var(--ok) 10%,transparent)}
.td__diffrow--add .td__difftext{color:var(--ok)}
.td__diffrow--del{background:color-mix(in srgb,var(--danger) 9%,transparent)}
.td__diffrow--del .td__difftext{color:var(--danger)}
.td__diffrow--hunk{background:var(--fill);color:var(--text-dim)}
.td__diffrow--meta{color:var(--text-faint)}
.td__diff-foot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 20px;border-top:.5px solid var(--separator);background:var(--panel)}
.td__diff-foot .td__meta:last-child{margin-left:auto}
/* 产物行两列（2026-10-17 审查批，设计板 §4.2）：左＝名＋元信息（审计折叠）；右＝动作组。 */
.td__artifact{align-items:flex-start;justify-content:space-between}
.td__artifact-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.td__artifact-name{font-size:var(--text-body);word-break:break-all}
.td__artifact-meta{white-space:normal}
.td__artifact-fold summary{cursor:pointer}
.td__artifact-raw{display:block;margin-top:4px;white-space:normal;word-break:break-all}
.td__artifact-actions{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap}
/*  计划编辑：行内增删/排序（批准前）。输入框与按钮沿用详情行密度；保存组靠右。 */
.td__planeditor{display:flex;flex-direction:column;gap:8px}
.td__planhint{color:var(--text-dim);font-size:var(--text-note);line-height:1.6}
.td__editrow{align-items:center}
.td__editinput{flex:1;min-width:0;padding:8px 12px;border:.5px solid transparent;border-radius:var(--radius-md);background:var(--fill);color:var(--text);font:inherit;font-size:var(--text-body)}
.td__editinput:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--tint-soft)}
.td__editbtns{display:flex;gap:4px;flex:0 0 auto}
.td__smallbtn{min-width:28px;height:28px;padding:0 8px;border:0;border-radius:var(--radius-md);background:var(--fill);color:var(--text-dim);font:inherit;font-size:var(--text-meta);cursor:pointer}
.td__smallbtn:disabled{background:var(--fill);color:var(--text-dim);cursor:not-allowed;opacity:.4}
.td__planactions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td__spacer{flex:1}
.td__action--primary{border-color:transparent;background:var(--accent-strong);color:var(--on-accent)}
.td__plannotice{margin:0;color:var(--warn);font-size:var(--text-meta)}
/* 评审/验证结论（左点色＋结论＋批注）＋打回批注编辑 */
.td__review{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--separator);border-radius:var(--radius-md);background:var(--panel)}
.td__reviewhead{display:flex;align-items:flex-start;gap:8px}
.td__reviewhead .td__dot{margin-top:6px}
.td__reviewnotes{margin:0 0 0 24px;color:var(--text-dim);font-size:var(--text-note);line-height:1.65;white-space:pre-wrap;word-break:break-word}
.td__reject{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:12px 14px;border:.5px solid var(--warn);border-radius:var(--radius-md);background:var(--fill-2)}
.td__rejectlabel{font-size:var(--text-note);line-height:1.6;color:var(--text)}
.td__rejecttextarea{min-height:76px;resize:vertical;padding:10px 12px;border:.5px solid transparent;border-radius:var(--radius-md);background:var(--fill);color:var(--text);font:inherit;font-size:var(--text-body)}
.td__rejecttextarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--tint-soft)}
/* （方案 A）：目标一行 + 项目/负责人/截止/依赖一行四格。 */
.td__goal{margin:8px 0 0;font-size:var(--text-body);line-height:1.6;color:var(--text);word-break:break-word}
.td__goallabel{margin-right:8px;color:var(--text-dim);font-size:var(--text-meta)}
.td__context{display:flex;margin-top:8px;padding:10px 14px;border:.5px solid var(--separator);border-radius:var(--radius-md);background:var(--panel);min-width:0}
.td__contextcell{flex:1 1 0;min-width:0;padding:0 12px}
.td__contextcell:first-child{padding-left:0}
.td__contextcell+.td__contextcell{border-left:.5px solid var(--separator)}
.td__contextlabel{display:block;color:var(--text-dim);font-size:var(--text-meta);line-height:1.4}
.td__contextvalue{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-size:var(--text-body);line-height:1.45}
.td__contextmeta{color:var(--text-dim);font-size:var(--text-meta)}
.td__contextcell[data-tone='warn'] .td__contextmeta--relative{color:var(--warn)}
.td__contextcell[data-tone='danger'] .td__contextmeta--relative{color:var(--danger)}
.td__deviation-warning{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 12px;border:.5px solid color-mix(in srgb,var(--warn) 32%,transparent);border-radius:var(--radius-md);background:color-mix(in srgb,var(--warn) 8%,var(--panel));color:var(--warn);font-size:var(--text-meta)}
.td__deviation-warning span{flex:1;min-width:0}
.td__deviation-warning .td__toggle{margin-left:auto;color:var(--accent-ink)}
@media (max-width:900px){
  .td__context{flex-wrap:wrap;gap:8px 0}
  .td__contextcell{flex:1 1 45%;padding:0 10px}
  .td__contextcell:nth-child(odd){padding-left:0;border-left:0}
  .td__contextcell:nth-child(even){border-left:.5px solid var(--separator)}
}
/* 任务级设置（加预算 / 任务模型 / 强制技能）行内 popover。 */
.td__settings{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.td__actions .td__settings{margin-top:0}
.td__settingwrap{position:relative;display:inline-flex}
.td__popover-scrim{position:fixed;inset:0;z-index:30}
.td__popover{position:absolute;top:calc(100% + 8px);left:0;z-index:31;width:320px;max-width:calc(100vw - 48px);padding:12px;display:flex;flex-direction:column;gap:8px;border:.5px solid var(--separator);border-radius:var(--radius-lg);background:var(--panel);box-shadow:var(--shadow-overlay)}
.td__popover-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.td__popover-title{font-size:var(--text-body);font-weight:600}
.td__popover-close{width:24px;height:24px;padding:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text-dim);font:inherit;cursor:pointer}
.td__popover-close:hover{background:var(--hover-layer);color:var(--text)}
.td__popover-label{font-size:var(--text-meta);color:var(--text-dim)}
.td__popover-input{min-height:36px;width:100%;box-sizing:border-box;padding:8px 10px;border:.5px solid transparent;border-radius:var(--radius-md);background:var(--fill);color:var(--text);font:inherit;font-size:var(--text-body)}
.td__popover-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--tint-soft)}
.td__popover-chips{display:flex;gap:8px;flex-wrap:wrap}
.td__chipbtn{min-height:26px;padding:0 10px;border:0;border-radius:var(--radius-pill);background:var(--fill);color:var(--text);font:inherit;font-size:var(--text-meta);cursor:pointer}
.td__chipbtn:hover{background:var(--hover-layer)}
.td__modellist{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.td__modeloption{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:var(--radius-sm);font-size:var(--text-body);line-height:1.45;cursor:pointer}
.td__modeloption:hover{background:var(--hover-layer)}
.td__modeloption input{margin-top:2px}
.td__popover-note{margin:0;color:var(--text-dim);font-size:var(--text-meta);line-height:1.55}
.td__popover-error{margin:0;color:var(--danger);font-size:var(--text-meta);line-height:1.55}
.td__popover-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.td__settingnotice{color:var(--text-dim);font-size:var(--text-meta);line-height:1.5}
`;

// ── 子组件 ───────────────────────────────────────────────────────────────

/** 验收三态文案（2026-10-16 批：点色之外的**第二编码**——已过/未过/未跑）。 */
function acceptanceStateText(state: string | undefined): string {
  if (state === 'pass') return '已过';
  if (state === 'fail') return '未过';
  return '未跑';
}

/** 变更集状态人话（未知态如实回显）。 */
/**
 *  /：diff 审查进度的「已看」开关（localStorage 持久化，按 task+changeset+path）。
 */
function diffReviewedKey(taskId: number, changesetId: number, path: string): string {
  return `aico:diff-reviewed:${taskId}:${changesetId}:${path}`;
}

function DiffReviewedToggle({
  taskId,
  changesetId,
  path,
}: {
  taskId: number;
  changesetId: number;
  path: string;
}): ReactElement {
  const key = diffReviewedKey(taskId, changesetId, path);
  const [done, setDone] = useState<boolean>(() => {
    try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
  });
  return (
    <button
      type="button"
      className="td__smallbtn"
      data-testid="diff-reviewed"
      data-reviewed={done ? 'true' : 'false'}
      aria-pressed={done}
      title={done ? '已看（再点取消）' : '标记为已看'}
      onClick={() => {
        const next = !done;
        setDone(next);
        try { window.localStorage.setItem(key, next ? '1' : '0'); } catch { /* 私有模式忽略 */ }
      }}
    >
      {done ? '已看' : '标记已看'}
    </button>
  );
}

function changesetStateText(state: string): string {
  if (state === 'open') return '待合并';
  if (state === 'merged') return '已合并';
  if (state === 'discarded') return '已丢弃';
  if (state === 'rolled_back') return '已回滚';
  if (state === 'superseded') return '已替代';
  return state;
}

/** git 文件状态 → 单字母徽标（未知原样首字母，不臆造）。 */
function changesetStatusLetter(status: string): string {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'renamed') return 'R';
  if (status === 'modified') return 'M';
  return status.slice(0, 1).toUpperCase() || '?';
}

/** 评审结论点色（通过=done，打回/未通过=failed，部分=skipped，未知=pending）。 */
function reviewDotState(verdict: string | null): string {
  const tone = verdictTone(verdict);
  if (tone === 'ok') return 'done';
  if (tone === 'danger') return 'failed';
  if (tone === 'warn') return 'skipped';
  return 'pending';
}

/** 谁给的结论（内部角色说人话；未知演员如实显示）。 */
function reviewActorLabel(review: ReviewDTO): string {
  if (review.actor === 'boss') return '你';
  if (review.role === 'critic') return '评审者';
  if (review.role === 'verifier') return '验证者';
  return review.role ?? review.actor;
}

function PlanPanel({
  task,
  steps,
  reviews,
  editing,
  canEdit,
  onStartEdit,
  onCancelEdit,
  onSavePlan,
  onSaved,
  onOpenArtifacts,
}: {
  task: TaskHeadDTO;
  steps: readonly PlanStepDTO[];
  /** critic/verifier 结论（空 = 不渲染该组）。 */
  reviews: readonly ReviewDTO[];
  /** 是否处于编辑态（由 TaskDetail 控制：操作条「改计划再批准」也能进入）。 */
  editing: boolean;
  canEdit: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  /** 返回 `null`＝成功；字符串＝失败回执（不静默）。 */
  onSavePlan?: (steps: string[], approve: boolean) => Promise<string | null>;
  onSaved: () => void;
  /** 「查看证据」跳到产物/证据 tab。 */
  onOpenArtifacts?: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 2026-10-29 P2（U-N09）：切 tab 会卸载本面板——草稿按任务存 sessionStorage，回来能续上。
  const draftKey = `aico:plan-draft:${task.id}`;

  // 进入编辑态时以当前投影为草稿；有未保存的会话草稿则优先恢复。
  useEffect(() => {
    if (!editing) return;
    let restored: string[] | null = null;
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) restored = parsed as string[];
      }
    } catch {
      restored = null;
    }
    setDraft(restored ?? steps.map((step) => step.text));
    setNotice(null);
    // 只在进入编辑态时初始化（steps 变化不覆盖正在输入的内容）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    try {
      window.sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // 会话存储不可用：不影响编辑
    }
  }, [draft, editing, draftKey]);

  const clearDraft = (): void => {
    try {
      window.sessionStorage.removeItem(draftKey);
    } catch {
      // 忽略
    }
  };

  const save = async (approve: boolean): Promise<void> => {
    if (onSavePlan == null || saving) return;
    const normalized = normalizePlanSteps(draft);
    if (!normalized.ok) {
      setNotice(normalized.message);
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const error = await onSavePlan(normalized.steps, approve);
      if (error != null) {
        setNotice(error);
        return;
      }
      clearDraft();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="td__panel" data-testid="plan-panel" data-tab="plan">
      {reviews.length > 0 ? (
        <div className="td__group" data-testid="review-panel" data-count={reviews.length}>
          <h3 className="td__grouptitle">评审与验证结论（{reviews.length}）</h3>
          {reviews.map((review) => (
            <div
              key={`review-${review.eventId}`}
              className="td__review"
              data-testid="review-item"
              data-stage={review.stage}
              data-verdict={review.verdict ?? 'none'}
            >
              <div className="td__reviewhead">
                <span className="td__dot" data-state={reviewDotState(review.verdict)} aria-hidden="true" />
                <span className="td__text">
                  <strong>{review.stage === 'plan' ? '计划评审' : '验证结论'}</strong>
                  <span className="td__meta">
                    {' '}
                    · {verdictText(review.verdict) ?? '无结论'} · {reviewActorLabel(review)}
                  </span>
                </span>
                {review.workItemId != null && onOpenArtifacts != null ? (
                  <button
                    type="button"
                    className="td__smallbtn"
                    data-testid="review-evidence"
                    data-work-item={review.workItemId}
                    onClick={onOpenArtifacts}
                  >
                    查看证据
                  </button>
                ) : null}
              </div>
              <p className="td__reviewnotes" data-testid="review-notes">
                {review.notes ?? '无文字批注'}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="td__group">
        <div className="td__grouphead">
          <h3 className="td__grouptitle">计划步骤（{editing ? draft.length : steps.length}）</h3>
          {canEdit && !editing ? (
            <button type="button" className="td__action" data-testid="plan-edit" onClick={onStartEdit}>
              编辑计划
            </button>
          ) : null}
        </div>
        {editing ? (
          <div className="td__planeditor" data-testid="plan-editor">
            <span className="td__planhint">批准前可增删、排序；保存后批准卡同步显示新计划。</span>
            {draft.map((text, index) => (
              <div
                key={`plan-edit-${index}`}
                className="td__row td__editrow"
                data-testid="plan-step-edit"
                data-idx={index + 1}
              >
                <span className="td__idx">{index + 1}.</span>
                <input
                  className="td__editinput"
                  data-testid="plan-step-input"
                  data-idx={index + 1}
                  value={text}
                  placeholder="这一步做什么？"
                  aria-label={`计划第 ${index + 1} 步`}
                  onChange={(event) => {
                    setDraft((current) => updatePlanStep(current, index, event.target.value));
                  }}
                />
                <span className="td__editbtns">
                  <button
                    type="button"
                    className="td__smallbtn"
                    data-testid="plan-step-up"
                    data-idx={index + 1}
                    disabled={index === 0 || saving}
                    title="上移"
                    aria-label={`上移第 ${index + 1} 步`}
                    onClick={() => {
                      setDraft((current) => movePlanStep(current, index, -1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="td__smallbtn"
                    data-testid="plan-step-down"
                    data-idx={index + 1}
                    disabled={index === draft.length - 1 || saving}
                    title="下移"
                    aria-label={`下移第 ${index + 1} 步`}
                    onClick={() => {
                      setDraft((current) => movePlanStep(current, index, 1));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="td__smallbtn"
                    data-testid="plan-step-remove"
                    data-idx={index + 1}
                    disabled={draft.length <= 1 || saving}
                    title="删除这一步"
                    aria-label={`删除第 ${index + 1} 步`}
                    onClick={() => {
                      setDraft((current) => removePlanStep(current, index));
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
            <div className="td__planactions">
              <button
                type="button"
                className="td__action"
                data-testid="plan-step-add"
                disabled={saving || draft.length >= PLAN_STEPS_MAX}
                onClick={() => {
                  setDraft((current) => appendPlanStep(current));
                }}
              >
                ＋ 添加一步
              </button>
              <span className="td__spacer" />
              <button
                type="button"
                className="td__action"
                data-testid="plan-cancel"
                disabled={saving}
                onClick={() => {
                  clearDraft();
                  onCancelEdit();
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="td__action"
                data-testid="plan-save"
                disabled={saving}
                onClick={() => {
                  void save(false);
                }}
              >
                {saving ? '保存中…' : '保存修改'}
              </button>
              <button
                type="button"
                className="td__action td__action--primary"
                data-testid="plan-save-approve"
                disabled={saving}
                onClick={() => {
                  void save(true);
                }}
              >
                保存并批准
              </button>
            </div>
            {notice != null ? (
              <p className="td__plannotice" data-testid="plan-edit-notice">
                {notice}
              </p>
            ) : null}
          </div>
        ) : steps.length === 0 ? (
          <div className="td__empty" data-testid="plan-empty">
            <strong className="td__emptytitle">计划还没生成</strong>
            <span>任务进入规划后，这里会出现步骤。</span>
          </div>
        ) : (
          steps.map((step) => (
            <div
              key={`plan-${step.idx}`}
              className="td__row"
              data-testid="plan-step"
              data-state={step.state}
              data-idx={step.idx}
            >
              <span className="td__idx">{step.idx}.</span>
              <span className="td__dot" data-state={step.state} aria-hidden="true" />
              <span className="td__text">{step.text}</span>
              <span className="td__meta">{step.state}</span>
            </div>
          ))
        )}
      </div>

      <div className="td__group">
        <h3 className="td__grouptitle">验收项（{task.acceptance.length}）</h3>
        {task.acceptance.length === 0 ? (
          <div className="td__empty" data-testid="acceptance-empty">
            <strong className="td__emptytitle">验收项还没生成</strong>
            <span>计划批准后会列出可核对的验收项。</span>
          </div>
        ) : (
          task.acceptance.map((item, index) => (
            <div
              key={`acc-${index}`}
              className="td__row"
              data-testid="acceptance-item"
              data-state={item.state ?? 'pending'}
              // 验收三态双编码（2026-10-16 批）：点色（绿/红/灰）＋ 文案（悬停可见）。
              title={acceptanceStateText(item.state)}
            >
              <span className="td__dot" data-state={item.state ?? 'pending'} aria-hidden="true" />
              <span className="td__text">{item.text}</span>
              {item.check ? <span className="td__meta">$ {item.check}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TimelinePanel({
  items,
  behavior,
  raw,
  onReadToolOutput,
}: {
  items: readonly TimelineItemDTO[];
  /** 记录 tab 内的「工具调用」筛选（行为日志的派生投影；不新增 tab）。 */
  behavior?: readonly BehaviorLogItemDTO[];
  raw?: readonly RawItemDTO[] | null;
  onReadToolOutput?: (ref: string) => Promise<ToolOutputReadResult>;
}): ReactElement {
  // 「原始交流」开关（UI §7 时间线右上角一键切换）。**无数据则禁用 + 显式理由**（不假装可切）。
  const [showRaw, setShowRaw] = useState(false);
  // 2026-10-23 UI 简化：记录 tab 内切换「全部 / 工具调用」；不再单开行为日志 tab。
  const [showTools, setShowTools] = useState(false);
  const hasRaw = Array.isArray(raw) && raw.length > 0;
  const tools = behavior ?? [];
  return (
    <div className="td__panel" data-testid="timeline-panel" data-tab="timeline">
      <div className="td__group">
        <div className="td__grouphead">
          <h3 className="td__grouptitle">记录（{showTools ? tools.length : items.length}）</h3>
          <button
            type="button"
            className="td__toggle"
            data-testid="record-tools-toggle"
            aria-pressed={showTools}
            title={showTools ? '回到全部记录' : '只看工具调用（审计层）'}
            onClick={() => setShowTools((value) => !value)}
          >
            {showTools ? '全部' : '工具调用'}
          </button>
          <button
            type="button"
            className="td__toggle"
            data-testid="timeline-raw-toggle"
            aria-pressed={hasRaw && showRaw}
            disabled={!hasRaw}
            title={hasRaw ? '显示员工之间的原始交流（原文）' : '无原始交流数据（M1）'}
            onClick={() => setShowRaw((value) => !value)}
          >
            原始交流
          </button>
        </div>
        {showTools ? (
          <BehaviorRows items={tools} />
        ) : showRaw && hasRaw ? (
          <RawConversation items={raw ?? []} />
        ) : items.length === 0 ? (
          <p className="td__empty">还没有事件。</p>
        ) : (
          items.map((event) => {
            const summary = payloadSummary(event.payload);
            const flags = payloadFlags(event.payload);
            return (
              <div key={`tl-${event.id}`} className="td__row" data-testid="timeline-item" data-kind={event.kind}>
                <span className="td__meta">{formatTime(event.ts)}</span>
                <span className="td__text">
                  {event.actor} · {timelineLabel(event.kind)}
                  {summary ? <span className="td__meta"> · {summary}</span> : null}
                  <PayloadFlags payload={event.payload} prefix="tl" />
                  {flags.outputRef ? (
                    <ToolOutputExpand outputRef={flags.outputRef} summary={flags.outputSummary} onRead={onReadToolOutput} />
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ArtifactsPanel({
  taskId,
  artifacts,
  steps,
  changesets,
  accessMode,
  refTargets,
  onReferenceArtifact,
  referenceNotice,
  onReadArtifact,
  onExportArchive,
  artifactPreview,
  onCloseArtifactPreview,
  artifactNotice,
  exportNotice,
  onMergeChangeset,
  mergeNotice,
  mergeConflicts,
  mergeConflictChangesetId,
  onReworkConflict,
  onRollbackChangeset,
  rollbackNotice,
  onDiscardChangeset,
  discardNotice,
  changesetActionsLocked,
  deviations,
  onOpenChangesetDiff,
}: {
  taskId: number;
  artifacts: readonly ArtifactDTO[];
  steps: readonly PlanStepDTO[];
  changesets?: readonly ChangesetDTO[] | null;
  /** 差异清单（有 total 才渲染明细卡；不改空态判定口径以外的数据）。 */
  deviations?: DeviationSummaryDTO | null;
  /** 打开某个变更集文件的只读 diff；缺省 ⇒ 行尾 diff disabled。 */
  onOpenChangesetDiff?: (changesetId: number, path: string) => void;
  accessMode?: string | null;
  refTargets: readonly ArtifactRefTarget[];
  onReferenceArtifact?: (artifactId: number, targetTaskId: number, mode?: 'copy' | 'link') => void;
  referenceNotice?: string | null;
  /** -a：产物操作（读/系统打开/在文件夹中显示；容器发 `task:read-artifact`）。 */
  onReadArtifact?: (artifactId: number, mode: 'read' | 'open' | 'reveal') => void;
  /** 审计导出（容器发 `task:export`）；`openAction` 缺省 = 只导出。 */
  onExportArchive?: (openAction?: 'open' | 'reveal') => void;
  artifactPreview?: ArtifactPreviewDTO | null;
  /** 2026-10-17（浮层批）：预览抽屉关闭（✕ / 遮罩 / Esc）——容器清掉 store 里的预览。 */
  onCloseArtifactPreview?: () => void;
  artifactNotice?: string | null;
  exportNotice?: string | null;
  /** 合并一个变更集（行内按钮）；缺省 → 按钮 disabled。 */
  onMergeChangeset?: (changesetId: number) => Promise<boolean> | void;
  /** 最近一次合并回执。 */
  mergeNotice?: string | null;
  /** /：结构化冲突文件列表（非空 ⇒ 面板可见）。 */
  mergeConflicts?: readonly string[] | null;
  /** /：发生冲突的变更集（重试按钮的目标）。 */
  mergeConflictChangesetId?: number | null;
  /** 冲突派回原员工修复（建续办任务）。 */
  onReworkConflict?: (changesetId: number) => Promise<string | null> | void;
  /** 回滚一个变更集到其工作项检查点（行内二次确认；容器发 `task:rollback`）。 */
  onRollbackChangeset?: (changesetId: number) => void;
  /** 最近一次回滚回执。 */
  rollbackNotice?: string | null;
  /** B-2：丢弃一个变更集（行内二次确认；容器发 `task:discard`）。 */
  onDiscardChangeset?: (changesetId: number) => Promise<boolean> | void;
  /** B-2：最近一次丢弃回执。 */
  discardNotice?: string | null;
  /** 归档/取消任务：合并/回滚/丢弃锁定（后端同样拒）。 */
  changesetActionsLocked?: boolean;
}): ReactElement {
  // G-C：引用目标（受控；候选变化时回落第一个——不臆造选择）
  const [refTargetId, setRefTargetId] = useState<number | null>(refTargets[0]?.id ?? null);
  /** 回滚是危险动作（丢弃该次提交）→ 行内二次确认；null＝不在确认。 */
  const [confirmRollbackId, setConfirmRollbackId] = useState<number | null>(null);
  /** B-2：丢弃是危险动作（该变更集永不合并）→ 行内二次确认；null＝不在确认。 */
  const [confirmDiscardId, setConfirmDiscardId] = useState<number | null>(null);
  const currentTarget = refTargets.some((t) => t.id === refTargetId) ? refTargetId : (refTargets[0]?.id ?? null);
  const evidence = steps.filter((s) => typeof s.evidenceRef === 'string' && s.evidenceRef.length > 0);
  const csList: readonly ChangesetDTO[] = changesets ?? [];
  const hasChangeset = csList.length > 0;
  const hasDeviations = deviations != null && deviations.total > 0;
  // 输入附件（消息来的）与产出分组；同一批 `artifact-item` 行，计数契约不变。
  const inputArtifacts = artifacts.filter((artifact) => artifact.kind === 'input');
  const outputArtifacts = artifacts.filter((artifact) => artifact.kind !== 'input');

  /**
   * 2026-11-05（老板真机：同一 `docs/specs/*.md` 两行、一行带 ⚠️ 像故障）：
   * 产物登记幂等键是 `(task, work_item, path)` ⇒ **不同工作项**各提交一次同路径会留两行
   * （如「实现」与「修复」），先产出的那行指纹记录的是旧版本。列表按「kind|path|来源项目」
   * 分组，默认只显示最新版本；旧版本收进「历史版本（N）」可展开——审计不丢，界面不乱。
   */
  const versionGroups = (() => {
    const groups = new Map<string, ArtifactDTO[]>();
    for (const artifact of outputArtifacts) {
      const key = `${artifact.kind}|${artifact.path}|${artifact.originProjectId ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(artifact);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([key, list]) => {
      const sorted = [...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.id - a.id);
      return { key, latest: sorted[0]!, older: sorted.slice(1) };
    });
  })();
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});

  const renderArtifactRow = (artifact: ArtifactDTO, isHistory: boolean): ReactElement => {
    const producerStep =
      artifact.workItemId != null ? steps.find((s) => s.workItemId === artifact.workItemId) : undefined;
    return (
      <div
        key={`artifact-${artifact.id}`}
        className="td__row td__artifact"
        data-testid="artifact-item"
        data-kind={artifact.kind}
        data-owner={artifact.workItemId ?? ''}
        data-artifact-id={artifact.id}
        data-history={isHistory ? 'true' : undefined}
      >
        {/* 设计板 §4.2：两列结构——左＝名＋两行元（sha/commit 默认折叠）；右＝动作组。 */}
        <div className="td__artifact-main">
          <span className="td__artifact-name">{artifact.name}</span>
          <span className="td__meta td__artifact-meta">
            {isHistory ? '旧版本 · ' : ''}
            {artifactKindText(artifact.kind)}
            {producerStep != null ? ` · 步骤 ${producerStep.idx}` : ''}
            {typeof artifact.at === 'number' ? ` · ${formatTime(artifact.at)}` : ''}
            {/* G-A 余项（2026-10-16）：引用副本**结构化**标来源（项目名查无 → 项目#id；自产不显） */}
            {artifact.originProjectId != null
              ? ` · 引用自 ${artifact.originProjectName ?? `项目#${artifact.originProjectId}`}${artifact.originArtifactId != null ? ` · a${artifact.originArtifactId}` : ''}`
              : ''}
            {artifact.source?.startsWith('link:') ? ' · 链接（源随动）' : ''}
          </span>
          {/* `commit` **恒显**（2023 冻结口径 (b)）：数据源 `changesets` 属，暂无写者 → 显式 `—`，非缺失。
              审计细节**默认折叠**（设计板 §4.2：sha256 / commit 默认折叠）——展开即在，不省略。 */}
          <details className="td__artifact-fold">
            <summary className="td__meta">审计明细（sha256 / commit）</summary>
            <span className="td__meta td__artifact-raw">
              {artifact.sha256 ? `sha256:${artifact.sha256.slice(0, 12)}…` : 'sha256:—'}
              {` · 产出者:#${artifact.workItemId != null ? artifact.workItemId : '—'}`}
              {` · commit:${artifact.commit ? artifact.commit.slice(0, 8) : '—'}`}
            </span>
          </details>
        </div>
        <div className="td__artifact-actions">
          <button
            type="button"
            data-testid={`artifact-ref-${artifact.id}`}
            onClick={() => {
              if (onReferenceArtifact && currentTarget != null) onReferenceArtifact(artifact.id, currentTarget);
            }}
            disabled={!onReferenceArtifact || currentTarget == null}
            title={currentTarget == null ? '无可选目标任务' : '把本产物 copy 一份到所选任务（老板显式发起）'}
          >
            引用
          </button>
          {/*  尾（G-A link）：老板显式发起的链接（不复制；源随动；读时按源项目根解析）。 */}
          <button
            type="button"
            data-testid={`artifact-link-${artifact.id}`}
            onClick={() => {
              if (onReferenceArtifact && currentTarget != null) onReferenceArtifact(artifact.id, currentTarget, 'link');
            }}
            disabled={!onReferenceArtifact || currentTarget == null}
            title={currentTarget == null ? '无可选目标任务' : '链接到所选任务（不复制；源变了读到的也变）'}
          >
            链接
          </button>
          {/* -a：读预览 / 系统打开 / 在文件夹中显示（未接线 ⇒ disabled，不假装可点）。 */}
          <button
            type="button"
            data-testid={`artifact-read-${artifact.id}`}
            onClick={() => onReadArtifact?.(artifact.id, 'read')}
            disabled={!onReadArtifact}
            title={onReadArtifact ? '读产物文本预览（超上限截断如实标注；二进制显式说明）' : '读预览未接线'}
          >
            读
          </button>
          <button
            type="button"
            data-testid={`artifact-open-${artifact.id}`}
            onClick={() => onReadArtifact?.(artifact.id, 'open')}
            disabled={!onReadArtifact}
            title={onReadArtifact ? '用系统默认应用打开（经主进程 shell，越界路径拒）' : '系统打开未接线'}
          >
            打开
          </button>
          <button
            type="button"
            data-testid={`artifact-reveal-${artifact.id}`}
            onClick={() => onReadArtifact?.(artifact.id, 'reveal')}
            disabled={!onReadArtifact}
            title={onReadArtifact ? '在系统文件管理器中显示该文件' : '在文件夹中显示未接线'}
          >
            文件夹
          </button>
        </div>
      </div>
    );
  };

  // **空态不伪装**（验收）：产物/证据/变更**都为空**时才给一句总结空态。
  if (artifacts.length === 0 && evidence.length === 0 && !hasChangeset && !hasDeviations) {
    return (
      <div className="td__panel" data-testid="artifacts-panel" data-tab="artifacts">
        <p className="td__empty" data-testid="artifacts-empty">
          本任务暂无产物或证据。
        </p>
        {/* 无产物也可导出档案（事件时间线＋成本仍在）——导出是任务级动作，不是产物级。 */}
        {onExportArchive ? (
          <p style={{ margin: '4px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" data-testid="task-export" onClick={() => onExportArchive()} title="导出任务档案（事件时间线＋产物＋成本，单一 JSON 文件）">
              导出档案
            </button>
            <button type="button" data-testid="task-export-open" onClick={() => onExportArchive('open')} title="导出后用系统默认程序打开 JSON 文件（打开失败不回滚导出）">
              导出并打开
            </button>
            <button type="button" data-testid="task-export-reveal" onClick={() => onExportArchive('reveal')} title="导出后在文件管理器中定位 JSON 文件（定位失败不回滚导出）">
              导出并定位
            </button>
          </p>
        ) : null}
        {typeof exportNotice === 'string' && exportNotice.length > 0 ? (
          <p className="td__meta" data-testid="task-export-notice" style={{ margin: '4px 0', wordBreak: 'break-all' }}>
            {exportNotice}
          </p>
        ) : null}
        {/* 变更面无 changeset 时**显式说明**（inplace 尤其，不给空白）。 */}
        {accessMode === 'inplace' ? (
          <p className="td__empty" data-testid="changeset-inplace">
            本次为就地修改、无变更集。
          </p>
        ) : (
          <p className="td__empty" data-testid="changeset-empty">
            暂无变更集。
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="td__panel" data-testid="artifacts-panel" data-tab="artifacts">
      {inputArtifacts.length > 0 ? (
        <div className="td__group td__group--card" data-testid="input-artifacts">
          <h3 className="td__grouptitle">输入附件（{inputArtifacts.length}）</h3>
          <p className="td__meta">来自老板频道消息 · 已归档到项目 inputs/，可在下方预览或系统打开</p>
          {inputArtifacts.map((artifact) => (
            <div
              key={`input-${artifact.id}`}
              className="td__row td__artifact td__artifact--input"
              data-testid="artifact-item"
              data-kind="input"
              data-input="true"
              data-artifact-id={artifact.id}
            >
              <div className="td__artifact-main">
                <span className="td__artifact-name">{artifact.name}</span>
                <span className="td__meta td__artifact-meta">
                  {artifactKindText(artifact.kind)}
                  {artifact.path ? ` · ${artifact.path}` : ''}
                  {typeof artifact.at === 'number' ? ` · ${formatTime(artifact.at)}` : ''}
                </span>
                <details className="td__artifact-fold">
                  <summary className="td__meta">审计明细（sha256 / 来源）</summary>
                  <span className="td__meta td__artifact-raw">
                    {artifact.sha256 ? `sha256:${artifact.sha256.slice(0, 12)}…` : 'sha256:—'}
                    {` · 产出者:#${artifact.workItemId != null ? artifact.workItemId : '—'}`}
                    {` · commit:${artifact.commit ? artifact.commit.slice(0, 8) : '—'}`}
                    {artifact.source ? ` · ${artifact.source}` : ''}
                  </span>
                </details>
              </div>
              <div className="td__artifact-actions">
                <button
                  type="button"
                  data-testid={`artifact-read-${artifact.id}`}
                  onClick={() => onReadArtifact?.(artifact.id, 'read')}
                  disabled={!onReadArtifact}
                  title={onReadArtifact ? '读附件预览（图片 / PDF / 文本）' : '读预览未接线'}
                >
                  读
                </button>
                <button
                  type="button"
                  data-testid={`artifact-open-${artifact.id}`}
                  onClick={() => onReadArtifact?.(artifact.id, 'open')}
                  disabled={!onReadArtifact}
                  title={onReadArtifact ? '用系统默认应用打开' : '系统打开未接线'}
                >
                  打开
                </button>
                <button
                  type="button"
                  data-testid={`artifact-reveal-${artifact.id}`}
                  onClick={() => onReadArtifact?.(artifact.id, 'reveal')}
                  disabled={!onReadArtifact}
                  title={onReadArtifact ? '在系统文件管理器中显示' : '在文件夹中显示未接线'}
                >
                  文件夹
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="td__group td__group--card" data-testid="output-artifacts">
        <div className="td__row" style={{ alignItems: 'center', gap: 8 }}>
          <h3 className="td__grouptitle" style={{ flex: '1 1 auto' }}>产物（{outputArtifacts.length}）</h3>
          {/* （审计导出）：任务/事件/产物/成本的单一文件档案（导出与"打开"是两件事，打开失败不回滚导出）。 */}
          {onExportArchive ? (
            <>
              <button
                type="button"
                data-testid="task-export"
                onClick={() => onExportArchive()}
                title="导出任务档案（事件时间线＋产物＋成本，单一 JSON 文件）"
                style={{ flex: '0 0 auto' }}
              >
                导出档案
              </button>
              <button
                type="button"
                data-testid="task-export-open"
                onClick={() => onExportArchive('open')}
                title="导出后用系统默认程序打开 JSON 文件（打开失败不回滚导出）"
                style={{ flex: '0 0 auto' }}
              >
                导出并打开
              </button>
              <button
                type="button"
                data-testid="task-export-reveal"
                onClick={() => onExportArchive('reveal')}
                title="导出后在文件管理器中定位 JSON 文件（定位失败不回滚导出）"
                style={{ flex: '0 0 auto' }}
              >
                导出并定位
              </button>
            </>
          ) : null}
        </div>
        {typeof exportNotice === 'string' && exportNotice.length > 0 ? (
          <p className="td__meta" data-testid="task-export-notice" style={{ margin: '4px 0', wordBreak: 'break-all' }}>
            {exportNotice}
          </p>
        ) : null}
        {/* G-C（§7 序 3）：跨项目引用——把本任务产物引用到另一目标任务（老板显式发起；copy 快照＋sha256）。 */}
        {outputArtifacts.length > 0 ? (
          <div
            className="td__row"
            data-testid="artifact-ref-bar"
            style={{ alignItems: 'center', gap: 8 }}
          >
            <span className="td__meta">引用到任务：</span>
            <select
              className="settings-view__input"
              data-testid="artifact-ref-target"
              value={currentTarget ?? ''}
              onChange={(e) => setRefTargetId(e.target.value === '' ? null : Number(e.target.value))}
              disabled={refTargets.length === 0}
              style={{ maxWidth: 260 }}
            >
              {refTargets.length === 0 ? <option value="">（无可选目标任务）</option> : null}
              {refTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortId ?? `#${t.id}`} · {t.title}
                </option>
              ))}
            </select>
            {typeof referenceNotice === 'string' && referenceNotice.length > 0 ? (
              <span className="td__meta" data-testid="artifact-ref-notice">
                {referenceNotice}
              </span>
            ) : null}
          </div>
        ) : null}
        {/* -a：读预览（最近一次「读」的内容；截断 / 指纹不一致如实标注）。 */}
        {artifactPreview ? (
          <PreviewDrawer
            variant="artifact"
            onClose={() => onCloseArtifactPreview?.()}
            data={{
              title: artifactPreview.name,
              meta:
                `${artifactPreview.path} · ${artifactPreview.size > 0 ? `${artifactPreview.size} B` : '—'}` +
                (artifactPreview.sha256 ? ` · sha256:${artifactPreview.sha256.slice(0, 12)}…` : '') +
                (artifactPreview.supersededBy
                  ? ` · 旧版本（已被 #${artifactPreview.supersededBy.artifactId} 覆盖）`
                  : artifactPreview.sha256Mismatch
                    ? ' ⚠️ 与记录不一致'
                    : '') +
                (artifactPreview.truncated ? ' · 已截断（仅前 256 KiB）' : ''),
              // 2026-11-05：产物不留版本快照——旧版本行读到的必然是**磁盘当前内容**。
              // 不写这句＝拿当前内容冒充当时版本（误导），所以必须显式说明。
              ...(artifactPreview.supersededBy
                ? {
                    noteBeforeBody:
                      `此行记录的是旧版本指纹；下面是磁盘上的当前内容（已被 #${artifactPreview.supersededBy.artifactId} 的产出覆盖），` +
                      '不是当时的版本内容。',
                  }
                : {}),
              kind:
                artifactPreview.previewKind === 'image'
                  ? 'image'
                  : artifactPreview.previewKind === 'pdf'
                    ? 'pdf'
                    : 'text',
              // 2026-11-05 决定「抽屉内只读渲染」：.md 产物渲染排版，不直接摊源码。
              markdown: /\.(md|markdown)$/i.test(artifactPreview.path || artifactPreview.name),
              url: artifactPreview.previewUrl,
              text: artifactPreview.text,
              truncated: artifactPreview.truncated,
              artifactId: artifactPreview.artifactId,
            }}
          />
        ) : null}
        {typeof artifactNotice === 'string' && artifactNotice.length > 0 ? (
          <p className="td__meta" data-testid="artifact-notice" style={{ margin: '4px 0' }}>
            {artifactNotice}
          </p>
        ) : null}
        {outputArtifacts.length === 0 ? (
          <p className="td__empty">暂无产物。</p>
        ) : (
          versionGroups.map(({ key, latest, older }) => (
            <div key={`group-${key}`} className="td__artifact-group" data-testid="artifact-group">
              {renderArtifactRow(latest, false)}
              {older.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="td__artifact-history"
                    data-testid="artifact-history-toggle"
                    aria-expanded={historyOpen[key] === true}
                    onClick={() => setHistoryOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                  >
                    {historyOpen[key] ? `收起历史版本（${older.length}）` : `历史版本（${older.length}）`}
                  </button>
                  {historyOpen[key] ? older.map((artifact) => renderArtifactRow(artifact, true)) : null}
                </>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="td__group td__group--card">
        <h3 className="td__grouptitle">证据（{evidence.length}）</h3>
        {evidence.length === 0 ? (
          <p className="td__empty">暂无证据。</p>
        ) : (
          evidence.map((step) => (
            <div key={`evidence-${step.idx}`} className="td__row" data-testid="evidence-item" data-step-idx={step.idx}>
              <span className="td__meta">步骤 {step.idx}</span>
              <span className="td__text">{step.evidenceRef}</span>
            </div>
          ))
        )}
      </div>

      {/* 差异清单明细（汇总来自 task_events；不新增表）。 */}
      {hasDeviations ? (
        <div className="td__group" data-testid="deviations-panel">
          <h3 className="td__grouptitle">
            差异台账（{deviations!.total}）
            <span className="td__meta" style={{ marginLeft: 8 }}>
              {deviations!.open} 未结 · {deviations!.openWithoutOwner.length} 无主
            </span>
          </h3>
          {deviations!.items && deviations!.items.length > 0 ? (
            deviations!.items.map((item, index) => (
              <div
                key={`deviation-${index}`}
                className="td__row"
                data-testid="deviation-item"
                data-open={item.open ? 'true' : 'false'}
                data-owner={item.owner ?? ''}
              >
                <span className="td__dot" data-state={item.open ? 'skipped' : 'done'} aria-hidden="true" />
                <span className="td__text">
                  {item.title}
                  {item.why ? <span className="td__meta"> · {item.why}</span> : null}
                </span>
                <span className="td__meta">
                  owner {item.owner ?? '未指定'} · 里程碑 {item.milestone ?? '未设置'} · {item.open ? '未结' : '已结'}
                </span>
              </div>
            ))
          ) : (
            <p className="td__empty">
              汇总：{deviations!.total} 条 · {deviations!.open} 未结 · {deviations!.openWithoutOwner.length} 无主
            </p>
          )}
          {deviations!.openWithoutOwner.length > 0 ? (
            <p className="td__plannotice" data-testid="deviations-unowned">
              未结且无 owner：{deviations!.openWithoutOwner.join('、')}——收尾前必须清零。
            </p>
          ) : null}
        </div>
      ) : null}

      {/*  变更（本次提交）—— 放进产物/证据 tab（3513 裁 (B)）；小标题明确，不让老板猜。 */}
      {hasChangeset ? (
        <div className="td__group td__group--card" data-testid="changeset-block">
          <h3 className="td__grouptitle">变更（本次提交）</h3>
          {typeof mergeNotice === 'string' && mergeNotice.length > 0 ? (
            <p className="td__meta" data-testid="task-merge-notice">
              {mergeNotice}
            </p>
          ) : null}
          {mergeConflicts != null && mergeConflicts.length > 0 ? (
            <div className="td__confirm" data-testid="merge-conflict-panel" role="alert">
              <span className="td__confirm-text">
                合并冲突（{mergeConflicts.length} 个文件）：主分支未改动，变更集仍待合并。
              </span>
              <ul className="merge-conflict__list" data-testid="merge-conflict-files">
                {mergeConflicts.map((path: string) => (
                  <li key={path} className="merge-conflict__file">{path}</li>
                ))}
              </ul>
              <button
                type="button"
                className="td__action"
                data-testid="merge-conflict-retry"
                disabled={mergeConflictChangesetId == null || onMergeChangeset == null}
                title="处理完冲突后重试合并"
                onClick={() => {
                  if (mergeConflictChangesetId != null) onMergeChangeset?.(mergeConflictChangesetId);
                }}
              >
                重试合并
              </button>
              <button
                type="button"
                className="td__action"
                data-testid="merge-conflict-rework"
                disabled={mergeConflictChangesetId == null || onReworkConflict == null}
                title="把冲突交给原执行员工处理（新建续办任务）"
                onClick={() => {
                  if (mergeConflictChangesetId != null) void onReworkConflict?.(mergeConflictChangesetId);
                }}
              >
                派回原员工修复
              </button>
            </div>
          ) : null}
          {typeof rollbackNotice === 'string' && rollbackNotice.length > 0 ? (
            <p className="td__meta" data-testid="task-rollback-notice">
              {rollbackNotice}
            </p>
          ) : null}
          {typeof discardNotice === 'string' && discardNotice.length > 0 ? (
            <p className="td__meta" data-testid="task-discard-notice">
              {discardNotice}
            </p>
          ) : null}
          {csList.map((cs) => (
            <Fragment key={`cs-${cs.id}`}>
              <div
                className="td__row"
                data-testid="changeset-row"
                data-changeset-id={cs.id}
                data-base-known={cs.baseSha ? 'true' : 'false'}
              >
                <span className="td__text">
                  {cs.branch ?? '—'}
                  <span className="td__meta">
                    {' '}
                    · {cs.filesChanged} 文件 · +{cs.insertions}/-{cs.deletions}
                  </span>
                </span>
                {cs.baseSha == null ? (
                  <span className="td__meta" data-testid="changeset-base-unknown" style={{ color: 'var(--warn)' }}>
                    ⚠️ 基准未知
                  </span>
                ) : null}
                <span className="td__meta" data-testid="changeset-state" data-state={cs.state}>
                  {changesetStateText(cs.state)}
                </span>
                {cs.files.length > 0 && onOpenChangesetDiff != null ? (
                  <button
                    type="button"
                    className="td__smallbtn"
                    data-testid={`changeset-next-unseen-${cs.id}`}
                    title="打开第一个未标记「已看」的文件 diff"
                    onClick={() => {
                      let nextPath: string | null = null;
                      try {
                        nextPath = cs.files.find((f) => window.localStorage.getItem(diffReviewedKey(taskId, cs.id, f.path)) !== '1')?.path ?? null;
                      } catch {
                        nextPath = cs.files[0]?.path ?? null;
                      }
                      if (nextPath != null) onOpenChangesetDiff?.(cs.id, nextPath);
                    }}
                  >
                    下一个未看
                  </button>
                ) : null}
                {cs.state === 'open' && !changesetActionsLocked ? (
                  <button
                    type="button"
                    data-testid={`changeset-merge-${cs.id}`}
                    data-changeset-id={cs.id}
                    disabled={onMergeChangeset == null}
                    title={onMergeChangeset ? '把这个变更集合并到项目主分支' : '合并未接线'}
                    onClick={() => onMergeChangeset?.(cs.id)}
                  >
                    合并
                  </button>
                ) : null}
                {cs.state === 'open' && !changesetActionsLocked ? (
                  <button
                    type="button"
                    className="td__action td__action--danger"
                    data-testid={`changeset-rollback-${cs.id}`}
                    data-changeset-id={cs.id}
                    disabled={onRollbackChangeset == null}
                    title={onRollbackChangeset ? '回滚到本次工作项开始前（只动这次提交改过的文件）' : '回滚未接线'}
                    onClick={() => setConfirmRollbackId(cs.id)}
                  >
                    回滚
                  </button>
                ) : null}
                {cs.state === 'open' && !changesetActionsLocked ? (
                  <button
                    type="button"
                    className="td__action td__action--danger"
                    data-testid={`changeset-discard-${cs.id}`}
                    data-changeset-id={cs.id}
                    disabled={onDiscardChangeset == null}
                    title={onDiscardChangeset ? '丢弃这个变更集（不合并；主分支不动）' : '丢弃未接线'}
                    onClick={() => setConfirmDiscardId(cs.id)}
                  >
                    丢弃
                  </button>
                ) : null}
              </div>
              {cs.files.length > 0 ? (
                <div className="td__csfiles" data-testid="changeset-files">
                  {cs.files.map((file, index) => (
                    <div
                      className="td__csfile"
                      data-testid="changeset-file"
                      data-status={file.status}
                      data-path={file.path}
                      key={`cs-${cs.id}-${file.path}`}
                    >
                      <span className="td__csbadge" data-status={file.status}>
                        {changesetStatusLetter(file.status)}
                      </span>
                      <span className="td__text td__csfilepath">{file.path}</span>
                      <span className="td__meta">
                        <span style={{ color: 'var(--ok)' }}>+{file.insertions}</span>{' '}
                        <span style={{ color: 'var(--danger)' }}>−{file.deletions}</span>
                      </span>
                      <span className="td__meta">
                        {file.employeeName ?? (file.employeeId != null ? `#${file.employeeId}` : '—')}
                      </span>
                      <DiffReviewedToggle taskId={taskId} changesetId={cs.id} path={file.path} />
                      <button
                        type="button"
                        className="td__smallbtn"
                        data-testid={`changeset-file-diff-${cs.id}-${index}`}
                        disabled={!onOpenChangesetDiff}
                        title={onOpenChangesetDiff ? '查看该文件只读 diff' : 'diff 未接线'}
                        onClick={() => onOpenChangesetDiff?.(cs.id, file.path)}
                      >
                        diff
                      </button>
                    </div>
                  ))}
                </div>
              ) : cs.baseSha != null ? (
                <p className="td__meta">无文件明细（变更集记录未带 files）。</p>
              ) : null}
              {confirmRollbackId === cs.id ? (
                <div
                  className="td__confirm"
                  data-testid="changeset-rollback-confirm"
                  role="alertdialog"
                  aria-label="确认回滚变更集"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setConfirmRollbackId(null);
                  }}
                >
                  <span className="td__confirm-text">
                    回滚会撤销该次提交改过的 {cs.filesChanged} 个文件并产生反向提交；无关文件不动。
                  </span>
                  <button
                    type="button"
                    className="td__action td__action--danger"
                    data-testid="changeset-rollback-yes"
                    onClick={() => {
                      setConfirmRollbackId(null);
                      onRollbackChangeset?.(cs.id);
                    }}
                  >
                    确认回滚
                  </button>
                  <button
                    type="button"
                    className="td__action"
                    data-testid="changeset-rollback-no"
                    autoFocus
                    onClick={() => setConfirmRollbackId(null)}
                  >
                    返回
                  </button>
                </div>
              ) : null}
              {confirmDiscardId === cs.id ? (
                <div
                  className="td__confirm"
                  data-testid="changeset-discard-confirm"
                  role="alertdialog"
                  aria-label="确认丢弃变更集"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setConfirmDiscardId(null);
                  }}
                >
                  <span className="td__confirm-text">
                    丢弃后该变更集不会再合并到 main；主分支和其他工作项不动；分支保留作证据。
                  </span>
                  <button
                    type="button"
                    className="td__action td__action--danger"
                    data-testid="changeset-discard-yes"
                    onClick={() => {
                      setConfirmDiscardId(null);
                      onDiscardChangeset?.(cs.id);
                    }}
                  >
                    确认丢弃
                  </button>
                  <button
                    type="button"
                    className="td__action"
                    data-testid="changeset-discard-no"
                    autoFocus
                    onClick={() => setConfirmDiscardId(null)}
                  >
                    返回
                  </button>
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      ) : accessMode === 'inplace' ? (
        <p className="td__empty" data-testid="changeset-inplace">
          本次为就地修改、无变更集。
        </p>
      ) : (
        <p className="td__empty" data-testid="changeset-empty">
          暂无变更集。
        </p>
      )}
    </div>
  );
}

// ── 成本 tab──────────────────────────────────────────────
function CostPanel({ cost }: { cost?: CostSummaryDTO | null }): ReactElement {
  const has = !!cost && cost.costRows > 0;
  return (
    <div className="td__panel" data-testid="cost-panel" data-tab="cost">
      {!has ? (
        // 空态不伪装：无成本行就说清楚（不摆 $0.0000 / 空 0）。
        <p className="td__empty" data-testid="cost-empty">
          本任务暂无成本记录。
        </p>
      ) : (
        <div className="td__group">
          <h3 className="td__grouptitle" data-testid="cost-total">
            本任务成本 · {cost!.tokens} tok · ${cost!.usd.toFixed(4)}
          </h3>
          {/* N1：缓存命中率（分母 0 ⇒ 显 —，不写假 0）＋ 该任务最近 1 小时速率 */}
          <div className="td__row" data-testid="cost-cache" data-has-hit={cost!.cacheHitRate != null ? 'true' : 'false'}>
            <span className="td__text">缓存命中</span>
            <span className="td__meta">
              {cost!.cacheHitRate != null ? `${Math.round(cost!.cacheHitRate * 100)}%` : '—'}
              {(cost!.cacheReadTokens ?? 0) + (cost!.cacheWriteTokens ?? 0) > 0
                ? ` · 读 ${cost!.cacheReadTokens ?? 0} / 写 ${cost!.cacheWriteTokens ?? 0}`
                : ''}
            </span>
          </div>
          {typeof cost!.usdPerHour === 'number' && cost!.usdPerHour > 0 ? (
            <div className="td__row" data-testid="cost-rate">
              <span className="td__text">近 1 小时</span>
              <span className="td__meta">${cost!.usdPerHour.toFixed(4)}/h</span>
            </div>
          ) : null}
          {(cost!.byModel ?? []).map((m) => (
            <div key={m.model} className="td__row" data-testid="cost-row" data-model={m.model}>
              <span className="td__text">{m.model}</span>
              <span className="td__meta">
                {m.tokensIn} in / {m.tokensOut} out
              </span>
              <span className="td__meta">${m.usd.toFixed(4)}</span>
            </div>
          ))}
          {/* （挂载 3）：按员工归因（null=公司级如实列出；数据面＝costSummary.byEmployee）。 */}
          {(((cost ?? {}) as { byEmployee?: Array<{ employeeId: number | null; name: string | null; usd: number }> }).byEmployee ?? []).map(
            (e) => (
              <div
                key={`emp-${e.employeeId ?? 'company'}`}
                className="td__row"
                data-testid="cost-by-employee"
                data-employee={e.employeeId ?? 'company'}
              >
                <span className="td__text">{e.name ?? (e.employeeId == null ? '公司级（无归属）' : `#${e.employeeId}`)}</span>
                <span className="td__meta">${e.usd.toFixed(4)}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function BehaviorRows({ items }: { items: readonly BehaviorLogItemDTO[] }): ReactElement {
  return (
    <div className="td__group">
      <h3 className="td__grouptitle">行为日志 · 工具调用（{items.length}）</h3>
      {items.length === 0 ? (
        <p className="td__empty">还没有工具调用记录。</p>
      ) : (
        items.map((item) => {
          // OPT-（结果上屏）：工具调用**失败要可见**（`payload.isError`），不静默。
          const failed = (item.payload as { isError?: unknown } | null | undefined)?.isError === true;
          return (
            <div
              key={`bh-${item.id}`}
              className="td__row"
              data-testid="behavior-item"
              data-error={failed ? 'true' : 'false'}
            >
              <span className="td__meta">{formatTime(item.ts)}</span>
              <span className="td__text">
                {item.actor}
                {payloadSummary(item.payload) ? ` · ⌨️ ${payloadSummary(item.payload)}` : ''}
                <PayloadFlags payload={item.payload} prefix="behavior" />
                {failed ? (
                  <span className="td__meta" data-testid="behavior-error">
                    {' '}
                    · ⚠️ 失败
                  </span>
                ) : null}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function BehaviorPanel({ items }: { items: readonly BehaviorLogItemDTO[] }): ReactElement {
  return (
    <div className="td__panel" data-testid="behavior-panel" data-tab="behavior">
      <BehaviorRows items={items} />
    </div>
  );
}

// ── 主组件 ───────────────────────────────────────────────────────────────

const TABS: ReadonlyArray<{ key: TaskDetailTab; label: string }> = [
  { key: 'plan', label: '计划与验收' },
  // id 保持 `artifacts`；2026-10-23 UI 简化后标签改为「变更与产物」。
  { key: 'artifacts', label: '变更与产物' },
  // 2026-10-23 UI 简化：时间线＋行为日志合并为「记录」；行为日志在面板内筛选。
  { key: 'timeline', label: '记录' },
];

const rootStyle: CSSProperties = { position: 'relative' };

/** 任务级设置（加预算 / 任务模型 / 强制技能）行内 popover。 */
function TaskSettings({
  task,
  data,
  modelOptions,
  skillOptions,
  onSetBudget,
  onSetModel,
  onSetSkill,
}: {
  task: TaskHeadDTO;
  data: TaskDetailDTO;
  modelOptions?: readonly TaskModelOption[];
  skillOptions?: readonly string[];
  onSetBudget?: (tokens: number) => Promise<TaskSettingResult>;
  onSetModel?: (model: string | null) => Promise<TaskSettingResult>;
  onSetSkill?: (skill: string | null) => Promise<TaskSettingResult>;
}): ReactElement | null {
  const [panel, setPanel] = useState<'budget' | 'model' | 'skill' | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [skillDraft, setSkillDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const forcedSkill = forcedSkillOf(data.timeline);
  // 已停用/已不在库里的强制技能仍要能显示当前值（否则下拉会显示空白，假装“无”）。
  const skillChoices =
    forcedSkill != null && !(skillOptions ?? []).includes(forcedSkill)
      ? [...(skillOptions ?? []), forcedSkill]
      : (skillOptions ?? []);
  const terminal = task.state === 'done' || task.state === 'cancelled' || task.archived === 1;

  useEffect(() => {
    if (panel === null) return;
    setError(null);
    if (panel === 'budget') setBudgetDraft(task.budgetTokens == null ? '' : String(task.budgetTokens));
    if (panel === 'model') setModelDraft(task.model ?? '');
    if (panel === 'skill') setSkillDraft(forcedSkill ?? '');
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPanel(null);
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开面板时初始化草稿
  }, [panel]);

  if (terminal) return null;
  if (!onSetBudget && !onSetModel && !onSetSkill) return null;

  const close = (): void => {
    setPanel(null);
    setError(null);
  };
  const finish = (result: TaskSettingResult): void => {
    if (!result.ok) {
      setError(result.error ?? '保存失败');
      return;
    }
    setPanel(null);
    setError(null);
    setNotice('已提交；回执见老板频道，数值以详情回读为准。');
  };

  const saveBudget = async (): Promise<void> => {
    if (!onSetBudget || busy) return;
    const tokens = Number(budgetDraft);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      setError('预算必须是正整数（token 数）');
      return;
    }
    setBusy(true);
    try {
      finish(await onSetBudget(tokens));
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async (): Promise<void> => {
    if (!onSetModel || busy) return;
    const value = modelDraft.trim();
    if (value.length === 0) {
      setBusy(true);
      try {
        finish(await onSetModel(null));
      } finally {
        setBusy(false);
      }
      return;
    }
    const option = modelOptions?.find((item) => item.value === value);
    if (option && !option.allowed) {
      setError('该模型不在项目允许清单内');
      return;
    }
    setBusy(true);
    try {
      finish(await onSetModel(value));
    } finally {
      setBusy(false);
    }
  };

  const saveSkill = async (): Promise<void> => {
    if (!onSetSkill || busy) return;
    setBusy(true);
    try {
      finish(await onSetSkill(skillDraft.trim().length > 0 ? skillDraft.trim() : null));
    } finally {
      setBusy(false);
    }
  };

  const quickBudget = (delta: number): void => {
    const base = Number(budgetDraft);
    const next = (Number.isFinite(base) && base > 0 ? base : task.budgetTokens ?? 0) + delta;
    setBudgetDraft(String(next));
  };

  const wrapper = (kind: 'budget' | 'model' | 'skill', label: string, testid: string, enabled: boolean, body: ReactElement): ReactElement => (
    <span className="td__settingwrap">
      <button
        type="button"
        className="td__action"
        data-testid={testid}
        aria-haspopup="dialog"
        aria-expanded={panel === kind}
        disabled={!enabled}
        title={enabled ? label : `${label}未接线`}
        onClick={() => setPanel((current) => (current === kind ? null : kind))}
      >
        {label}
      </button>
      {panel === kind ? (
        <>
          <div className="td__popover-scrim" data-testid={`${testid}-scrim`} onClick={close} />
          <div className="td__popover" role="dialog" aria-label={label} data-testid={`${testid}-popover`}>
            <div className="td__popover-head">
              <strong className="td__popover-title">{label}</strong>
              <button type="button" className="td__popover-close" aria-label="关闭" onClick={close}>
                ✕
              </button>
            </div>
            {body}
            {error ? (
              <p className="td__popover-error" data-testid={`${testid}-error`} role="alert">
                {error}
              </p>
            ) : null}
            <div className="td__popover-actions">
              <button type="button" className="td__action td__action--primary" disabled={busy} onClick={() => void (kind === 'budget' ? saveBudget() : kind === 'model' ? saveModel() : saveSkill())}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button type="button" className="td__action" onClick={close}>
                取消
              </button>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );

  return (
    <div className="td__settings" data-testid="task-settings" data-state={task.state}>
      {wrapper(
        'budget',
        '加预算',
        'task-setting-budget',
        onSetBudget != null,
        <>
          <p className="td__popover-note">
            已用 {task.costTokens ?? 0} · 当前预算 {task.budgetTokens ?? '未设'} · 余额{' '}
            {task.budgetLeftTokens ?? '—'}
          </p>
          <label className="td__popover-label" htmlFor="task-budget-input">
            新的预算（tokens）
          </label>
          <input
            id="task-budget-input"
            className="td__popover-input"
            data-testid="task-budget-input"
            inputMode="numeric"
            value={budgetDraft}
            placeholder="例如 800000"
            onChange={(event) => setBudgetDraft(event.target.value)}
          />
          <div className="td__popover-chips">
            <button type="button" className="td__chipbtn" onClick={() => quickBudget(100_000)}>
              +100k
            </button>
            <button type="button" className="td__chipbtn" onClick={() => quickBudget(500_000)}>
              +500k
            </button>
            <button type="button" className="td__chipbtn" onClick={() => quickBudget(1_000_000)}>
              +1M
            </button>
          </div>
          <p className="td__popover-note">
            保存后写 tasks.budget_tokens；因任务预算暂停会自动继续；公司日预算 / 手动暂停不自动继续。
          </p>
        </>,
      )}
      {wrapper(
        'model',
        '任务模型',
        'task-setting-model',
        onSetModel != null,
        <>
          <p className="td__popover-note">当前：{task.model ?? '跟随项目默认'}（保存后影响该任务全部会话）</p>
          <label className="td__popover-label" htmlFor="task-model-input">
            指定任务模型
          </label>
          {modelOptions && modelOptions.length > 0 ? (
            <div className="td__modellist" data-testid="task-model-options">
              <label className="td__modeloption">
                <input
                  type="radio"
                  name="task-model"
                  value=""
                  checked={modelDraft === ''}
                  onChange={() => setModelDraft('')}
                />
                <span>跟随项目默认（清除任务级模型）</span>
              </label>
              {modelOptions.map((option) => (
                <label
                  key={option.value}
                  className="td__modeloption"
                  data-testid="task-model-option"
                  data-value={option.value}
                  data-allowed={option.allowed ? 'true' : 'false'}
                >
                  <input
                    type="radio"
                    name="task-model"
                    value={option.value}
                    checked={modelDraft === option.value}
                    disabled={!option.allowed}
                    onChange={() => setModelDraft(option.value)}
                  />
                  <span>
                    {option.label}
                    {!option.allowed ? ' · 白名单外' : option.keyConfigured === false ? ' · Key 未配置' : ''}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <input
              id="task-model-input"
              className="td__popover-input"
              data-testid="task-model-input"
              value={modelDraft}
              placeholder="provider/model（留空＝跟随项目默认）"
              onChange={(event) => setModelDraft(event.target.value)}
            />
          )}
          <p className="td__popover-note">白名单外模型由主进程拒绝；回执见老板频道。</p>
        </>,
      )}
      {wrapper(
        'skill',
        '强制技能',
        'task-setting-skill',
        onSetSkill != null,
        <>
          <p className="td__popover-note">当前：{forcedSkill ?? '无'}（只影响之后的会话装配）</p>
          <label className="td__popover-label" htmlFor="task-skill-select">
            强制加载技能
          </label>
          <select
            id="task-skill-select"
            className="td__popover-input"
            data-testid="task-skill-select"
            value={skillDraft}
            onChange={(event) => setSkillDraft(event.target.value)}
          >
            <option value="">不强制（按员工 / 项目）</option>
            {skillChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="td__popover-note">技能须已登记且启用；当前在跑的轮次不打断，下一次派工生效。</p>
        </>,
      )}
      {notice ? (
        <span className="td__settingnotice" data-testid="task-setting-notice" role="status">
          {notice}
        </span>
      ) : null}
    </div>
  );
}

export function TaskDetail({
  data,
  initialTab = 'plan',
  onTabChange,
  waitTexts,
  onAction,
  cost,
  refTargets,
  onReferenceArtifact,
  referenceNotice,
  onReadArtifact,
  onExportArchive,
  artifactPreview,
  onCloseArtifactPreview,
  artifactNotice,
  exportNotice,
  onSavePlan,
  onMergeChangeset,
  mergeNotice,
  mergeConflicts,
  mergeConflictChangesetId,
  onReworkConflict,
  onRollbackChangeset,
  rollbackNotice,
  onDiscardChangeset,
  discardNotice,
  onReadToolOutput,
  onReadChangesetDiff,
  modelOptions,
  skillOptions,
  onSetBudget,
  onSetModel,
  onSetSkill,
}: {
  data: TaskDetailDTO | null;
  initialTab?: TaskDetailTab;
  onTabChange?: (tab: TaskDetailTab) => void;
  /** **已格式化**的等待文案（单一映射表产出；空则一条不显示）。 */
  waitTexts?: string[];
  /** D2/C3：点了**已实现**的详情操作（容器负责发 `task:transition`）。 */
  onAction?: (action: TaskActionDTO) => void;
  /** G-C（§7 序 3）：引用候选目标任务（容器取；缺省 → 引用控件不可用）。 */
  refTargets?: readonly ArtifactRefTarget[];
  /** G-C：引用动作（容器发 `task:reference-artifact`）。 */
  onReferenceArtifact?: (artifactId: number, targetTaskId: number, mode?: 'copy' | 'link') => void;
  /** G-C：引用结果回执（人话）。 */
  referenceNotice?: string | null;
  /** -a（挂载 3）：产物操作（读预览 / 系统打开 / 在文件夹中显示；容器发 `task:read-artifact`）。 */
  onReadArtifact?: (artifactId: number, mode: 'read' | 'open' | 'reveal') => void;
  /** 审计导出（容器发 `task:export`；`openAction` 缺省 = 只导出）。 */
  onExportArchive?: (openAction?: 'open' | 'reveal') => void;
  /** -a：最近一次读预览。 */
  artifactPreview?: ArtifactPreviewDTO | null;
  /** 2026-10-17（浮层批）：预览抽屉关闭（✕ / 遮罩 / Esc）——容器清掉 store 里的预览。 */
  onCloseArtifactPreview?: () => void;
  /** -a：最近一次产物操作回执。 */
  artifactNotice?: string | null;
  /** 最近一次导出回执（含落盘路径）。 */
  exportNotice?: string | null;
  /** 本任务成本（`cost:summary{taskId}`）；无行 → 成本 tab 显「暂无成本记录」。 */
  cost?: CostSummaryDTO | null;
  /** 保存编辑后的计划（容器发 `task:edit-plan`）；返回 `null`＝成功，字符串＝失败回执。 */
  onSavePlan?: (steps: string[], approve: boolean) => Promise<string | null>;
  /** 合并一个变更集（容器发 `task:merge`）。 */
  onMergeChangeset?: (changesetId: number) => Promise<boolean> | void;
  /** 最近一次合并回执（成功 commit / 冲突文件 / 拒绝原因）。 */
  mergeNotice?: string | null;
  /** /：结构化冲突文件列表（非空 ⇒ 面板可见）。 */
  mergeConflicts?: readonly string[] | null;
  /** /：发生冲突的变更集（重试按钮的目标）。 */
  mergeConflictChangesetId?: number | null;
  /** 冲突派回原员工修复（建续办任务）。 */
  onReworkConflict?: (changesetId: number) => Promise<string | null> | void;
  /** 回滚一个变更集（容器发 `task:rollback`）。 */
  onRollbackChangeset?: (changesetId: number) => void;
  /** 最近一次回滚回执。 */
  rollbackNotice?: string | null;
  /** B-2：丢弃一个变更集（容器发 `task:discard`）。 */
  onDiscardChangeset?: (changesetId: number) => Promise<boolean> | void;
  /** B-2：最近一次丢弃回执。 */
  discardNotice?: string | null;
  /** （P2）：按 ref 读取归档的工具大输出（缺省 → 展开按钮显式说未接线）。 */
  onReadToolOutput?: (ref: string) => Promise<ToolOutputReadResult>;
  /** 读一个变更集文件的只读 diff（缺省 ⇒ 行尾 diff disabled）。 */
  onReadChangesetDiff?: (changesetId: number, path: string) => Promise<ChangesetDiffResult>;
  /** 任务级模型候选（容器从项目允许清单 + 只读模型目录投影；缺省 ⇒ 自由输入）。 */
  modelOptions?: readonly TaskModelOption[];
  /** 已启用技能名（强制技能下拉；缺省 ⇒ 只显示“不强制”）。 */
  skillOptions?: readonly string[];
  /** 加预算（容器走 `加预算 Txxx N` 命令；成功/失败回执统一）。 */
  onSetBudget?: (tokens: number) => Promise<TaskSettingResult>;
  /** 任务级模型（null＝清除任务级模型）。 */
  onSetModel?: (model: string | null) => Promise<TaskSettingResult>;
  /** 强制技能（null＝清除）。 */
  onSetSkill?: (skill: string | null) => Promise<TaskSettingResult>;
}): ReactElement {
  const [tab, setTab] = useState<TaskDetailTab>(initialTab);
  /** 上下文相对时间只在挂载时取一次（避免每次渲染跳字）。必须在 `if (!data)` 早退之前。 */
  const [contextNow] = useState(() => Date.now());
  /** （D-9）：危险动作（`danger:true`，如「取消」）的**行内二次确认**当前动作；null＝不在确认。 */
  const [confirmAction, setConfirmAction] = useState<TaskActionDTO | null>(null);
  //  P0/C2：结束任务且存在未合并变更集 → 先选「合并并结束/保留分支/丢弃」。
  const [finishAction, setFinishAction] = useState<TaskActionDTO | null>(null);
  /** 计划编辑态（批准前；操作条「改计划再批准」或计划面板「编辑计划」进入）。 */
  const [editingPlan, setEditingPlan] = useState(false);
  /** 验证打回的批注编辑态（点 [打回] → 先写批注再确认；批注进返工项）。 */
  const [rejectAction, setRejectAction] = useState<TaskActionDTO | null>(null);
  const [rejectNotes, setRejectNotes] = useState('');
  /** 没有可合并变更集时的行内提示（不假装点击有效）。 */
  const [mergeHint, setMergeHint] = useState<string | null>(null);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  /** 全宽只读 diff 层（null＝不在 diff；切换任务自动清掉）。 */
  const [diffView, setDiffView] = useState<ChangesetDiffViewState | null>(null);
  /** 当前文件的行内批注（行键 → 文本）与展开中的行。 */
  const [diffNotes, setDiffNotes] = useState<Record<string, string>>({});
  const [diffNoteOpen, setDiffNoteOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setDiffView(null);
  }, [data?.task.id]);

  useEffect(() => {
    if (!diffView || data == null) {
      setDiffNotes({});
      setDiffNoteOpen(new Set());
      return;
    }
    try {
      const raw = window.localStorage.getItem(diffNotesStorageKey(data.task.id, diffView.changesetId, diffView.path));
      setDiffNotes(parseDiffNoteMap(raw));
    } catch {
      setDiffNotes({});
    }
    setDiffNoteOpen(new Set());
  }, [diffView?.changesetId, diffView?.path, data?.task.id]);

  const saveDiffNote = (lineKey: string, text: string): void => {
    if (!diffView || data == null) return;
    const next = { ...diffNotes, [lineKey]: text };
    if (text.trim().length === 0) delete next[lineKey];
    setDiffNotes(next);
    try {
      window.localStorage.setItem(
        diffNotesStorageKey(data.task.id, diffView.changesetId, diffView.path),
        JSON.stringify(next),
      );
    } catch {
      // 存储不可用：本次仍可看到批注，不阻塞
    }
  };

  /** 汇总本任务所有 diff 批注（打回时带入 notes）。 */
  const collectDiffNotes = (): string => {
    if (data == null) return '';
    const entries: DiffNoteEntry[] = [];
    try {
      const prefix = diffNotesTaskPrefix(data.task.id);
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key == null || !key.startsWith(prefix)) continue;
        const path = pathFromDiffNotesKey(key);
        if (path == null) continue;
        const map = parseDiffNoteMap(window.localStorage.getItem(key));
        for (const [line, note] of Object.entries(map)) entries.push({ path, line, note });
      }
    } catch {
      return '';
    }
    return summarizeDiffNotes(entries);
  };

  const openChangesetDiff = async (changesetId: number, path: string): Promise<void> => {
    if (!onReadChangesetDiff) return;
    setDiffView({ changesetId, path, loading: true });
    try {
      const result = await onReadChangesetDiff(changesetId, path);
      if (!result.ok) {
        setDiffView({ changesetId, path, loading: false, error: result.error ?? 'diff 读取失败' });
        return;
      }
      setDiffView({
        changesetId,
        path,
        loading: false,
        diff: result.diff ?? '',
        truncated: result.truncated === true,
        baseSha: result.baseSha,
        headSha: result.headSha,
      });
    } catch (error) {
      setDiffView({
        changesetId,
        path,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // diff 层打开时，Esc 只关 diff（capture 阶段拦住 TaskDetailView 的「返回」）。
  useEffect(() => {
    if (!diffView) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setDiffView(null);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [diffView]);

  // 「⋯」菜单：Esc 或点外关闭（原生 details 不会自己收）。
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const el = moreRef.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && moreRef.current?.open) {
        moreRef.current.open = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('mousedown', onDown);
    // 捕获阶段：菜单开着时 Esc 只收菜单，不再关闭任务详情/抽屉。
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  // 离开对应状态 → 自动收起编辑/批注面板，避免把旧草稿写回新状态。
  useEffect(() => {
    if (data == null) return;
    if (data.task.state !== 'awaiting_approval') setEditingPlan(false);
    if (data.task.state !== 'verifying') setRejectAction(null);
  }, [data]);

  const select = (next: TaskDetailTab): void => {
    setTab(next);
    onTabChange?.(next);
  };

  // 键盘交互批（2026-10-16）：**tab 数字键 1–5**（输入中/确认条在场不抢；带修饰键不抢）。
  // 位置纪律（2026-10-17 真机修）：**必须在 `if (!data)` 早退之前**——data 从 null→有值时
  // hooks 数量变化会触发 React #310（pages-shots 真机抓到整屏白屏）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target != null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[data-testid="task-action-confirm"]') != null) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1 || index > TABS.length) return;
      select(TABS[index - 1].key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载期挂一次（select 内部 setState 稳定）
  }, []);

  if (!data) {
    return (
      <section className="td" data-testid="task-detail" style={rootStyle}>
        <style>{TASK_DETAIL_CSS}</style>
        <p className="td__empty" style={{ padding: 20 }}>
          选择一个任务查看详情。
        </p>
      </section>
    );
  }

  const { task } = data;
  const context = taskContextView(data, contextNow);
  const diffRows: DiffRow[] = diffView?.diff ? parseUnifiedDiff(diffView.diff) : [];
  const progress = data.progress ?? progressOf(data.planSteps);
  const behavior = data.behaviorLog ?? behaviorLogOf(data.timeline);
  // D2/C3：详情操作条（**「详情可见操作」逐行落点**；未知 state → 空表 → 不渲染）。
  const actions = taskActionsOf(data.task.state);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  // 任务设置是操作条的一部分（设计 D）；无状态动作时（如 needs_decision）单独占一行。
  const settingsNode = (
    <TaskSettings
      task={task}
      data={data}
      modelOptions={modelOptions}
      skillOptions={skillOptions}
      onSetBudget={onSetBudget}
      onSetModel={onSetModel}
      onSetSkill={onSetSkill}
    />
  );

  // tab 计数（2026-10-23 UI 简化：只给「变更与产物」带真读数；记录/成本不再占 tab）。
  const evidenceCount = data.planSteps.filter((s) => typeof s.evidenceRef === 'string' && s.evidenceRef.length > 0).length;
  const tabCounts: Partial<Record<TaskDetailTab, number>> = {
    artifacts: (data.artifacts?.length ?? 0) + evidenceCount,
  };
  // 2026-10-23 UI 简化：整屏只留一个主操作，其余进「⋯」；危险动作仍在菜单内二次确认。
  const primaryAction = actions.find((action) => action.implemented && !action.danger) ?? actions[0] ?? null;
  // 加预算从「未实现动作」升级为 TaskSettings 的行内 popover；操作条不再渲染灰色的同名按钮。
  // 2026-10-29 P2（F-N09）：「打回」在批准/验证两态是高频动作，不藏进 ⋯——与主按钮并列。
  const inlineSecondaryIds = new Set(['revise', 'reject']);
  const inlineSecondary = primaryAction
    ? actions.filter((action) => action !== primaryAction && inlineSecondaryIds.has(action.id) && action.implemented)
    : [];
  const secondaryActions = primaryAction
    ? actions.filter(
        (action) =>
          action !== primaryAction &&
          !inlineSecondaryIds.has(action.id) &&
          (action.id !== 'add-budget' || onSetBudget == null),
      )
    : [];
  const renderActionButton = (action: TaskActionDTO): ReactElement => (
    <button
      key={action.id}
      type="button"
      className={`td__action${action === primaryAction ? ' td__action--primary' : ''}${action.danger ? ' td__action--danger' : ''}`}
      data-testid={`task-action-${action.id}`}
      data-event={action.event ?? ''}
      data-implemented={action.implemented ? 'true' : 'false'}
      data-danger={action.danger ? 'true' : 'false'}
      data-opens-editor={action.opensPlanEditor ? 'true' : 'false'}
      disabled={!action.implemented}
      aria-disabled={!action.implemented}
      title={action.implemented ? action.label : (action.reason ?? '未实现（M2）')}
      onClick={() => {
        // 「改计划再批准」不发 transition（缺 steps），只打开计划编辑器；
        // 保存时由 PlanPanel 走 `task:edit-plan`（可一并 approval）。
        if (action.opensPlanEditor) {
          select('plan');
          setEditingPlan(true);
          return;
        }
        // 合并走独立 IPC（无任务机事件）。**只有唯一 open 变更集时**操作条才直接合并；
        // 多个时必须在下方逐条选，避免“默认合了最旧那条”。
        if (action.ipcAction === 'task:merge') {
          const open = (data.changesets ?? []).filter((cs) => cs.state === 'open');
          if (open.length === 1 && onMergeChangeset != null) {
            setMergeHint(null);
            onMergeChangeset(open[0]!.id);
          } else if (open.length > 1) {
            setMergeHint('有多个待合并变更集——请在下方每条变更集上选择合并');
          } else {
            setMergeHint('没有可合并的变更集（只有 staging 项目的已提交改动才有变更集）');
          }
          return;
        }
        if (!action.implemented || !action.event) return;
        // 验证 [打回] 先写批注（必填），再带 `notes` + `workItemId` 发事件；
        // 批注会成为返工工作项的 brief（不是只写事件）。
        if (action.id === 'reject') {
          setRejectAction(action);
          if (rejectNotes.trim().length === 0) {
            const summary = collectDiffNotes();
            if (summary.length > 0) setRejectNotes(summary);
          }
          return;
        }
        // P0/C2：结束且存在未合并变更集 → 先选处理方式。
        if (action.id === 'finish') {
          const open = (data.changesets ?? []).filter((cs) => cs.state === 'open');
          if (open.length > 0) {
            setFinishAction(action);
            return;
          }
        }
        // 危险动作（cancel）先出确认条；其余照旧直发（四态既有风格：直点 + 回执）。
        if (action.danger) {
          setConfirmAction(action);
          return;
        }
        onAction?.(action);
      }}
    >
      {action.label}
    </button>
  );

  return (
    <section className="td" data-testid="task-detail" data-task-id={task.id} style={rootStyle}>
      <style>{TASK_DETAIL_CSS}</style>

      <header className="td__head">
        <div className="td__line1">
          {task.shortId ? <span className="td__short">{task.shortId}</span> : null}
          <h2 className="td__title">{task.title}</h2>
          {/* 2026-10-17（逐页审查批，设计板 §4.2 v2）：标题区右组**读数化、去 chip 感**——
              术语不上屏：状态人话（执行中）、风险人话（低/中/高；L0/L1/L2 只进悬停）、预算如实。 */}
          <span className="td__readings" data-testid="task-readings">
            <span
              className="td__reading td__reading--state"
              data-testid="task-state"
              data-state={task.state}
              data-tone={STATE_TONE[task.state] ?? 'dim'}
              title={`任务状态：${task.state}`}
            >
              <span className="td__readingdot" aria-hidden="true" />
              {PROJECT_STATE_LABEL[task.state] ?? task.state}
            </span>
            {task.state === 'paused' && task.pauseReason ? (
              <span className="td__reading" data-testid="task-pause-reason" title="暂停来源（v15）">
                {task.pauseReason === 'company_budget'
                  ? '公司日预算暂停'
                  : task.pauseReason === 'task_budget'
                    ? '任务预算暂停'
                    : task.pauseReason === 'manual'
                      ? '手动暂停'
                      : '暂停'}
              </span>
            ) : null}
            <span
              className="td__reading"
              data-testid="task-risk"
              title={`风险档 L${task.riskLevel} · ${RISK_HINT[task.riskLevel] ?? '未知档位'}`}
            >
              风险：{RISK_WORD[task.riskLevel] ?? `L${task.riskLevel}`}
            </span>
            {/* R3-1：L0 直通——不审计划、直接开工（任务头显式标注，防"没看见计划评审"被误读为漏审）。 */}
            {task.riskLevel === 0 ? (
              <span className="td__reading" data-testid="task-direct" title="本次直通（L0）：计划不送评审、直接开工">
                本次直通
              </span>
            ) : null}
            {/* 任务头显示预计模型与来源（执行员工视角）；回落/拒绝都如实说明。 */}
            {data.modelResolution ? (
              <span
                className="td__reading"
                data-testid="task-model"
                data-source={data.modelResolution.source}
                data-fallback={data.modelResolution.fallbackFrom ? 'true' : 'false'}
                data-rejected={data.modelResolution.rejected ? 'true' : 'false'}
                title={[
                  `预计模型：${data.modelResolution.model}（${MODEL_SOURCE_LABEL[data.modelResolution.source] ?? data.modelResolution.source}）`,
                  data.modelResolution.reason,
                  data.modelResolution.fallbackReason,
                  data.modelResolution.rejected,
                  '执行员工视角；实际会话按角色可能不同',
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                模型 {data.modelResolution.model.split('/').pop()}
                {' · '}
                {data.modelResolution.rejected
                  ? '不可用'
                  : (MODEL_SOURCE_LABEL[data.modelResolution.source] ?? data.modelResolution.source)}
                {data.modelResolution.fallbackFrom ? '（已回落）' : ''}
              </span>
            ) : null}
            {/* （挂载 3）：任务头显示预算（未设如实标注；加预算入口＝频道命令 `加预算 T1042 N`）。 */}
            <span className="td__reading" data-testid="task-budget" title="预算 / 已耗 / 余额（token）">
              {budgetBadge(task)}
            </span>
            {/* 2026-10-23 UI 简化：成本从独立 tab 收到标题行；「明细」保留原成本面板入口。 */}
            <span className="td__reading" data-testid="task-cost" title="本任务成本（cost:summary；无数据显 —）">
              成本 {cost != null && cost.costRows > 0 ? `$${cost.usd.toFixed(4)}` : '—'}
              {cost != null && cost.costRows > 0 ? (
                <button
                  type="button"
                  className="td__toggle"
                  data-testid="task-cost-detail"
                  title="查看成本明细（按模型/员工）"
                  onClick={() => select('cost')}
                >
                  明细
                </button>
              ) : null}
            </span>
          </span>
        </div>
        {/* （2026-10-25 裁 A）：目标单独一行；项目 / 负责人 / 截止 / 依赖压成一行四格。 */}
        <p className="td__goal" data-testid="task-goal">
          <span className="td__goallabel">目标</span>
          {context.goal}
        </p>
        <div className="td__context" data-testid="task-context">
          <div className="td__contextcell" data-testid="task-context-project">
            <span className="td__contextlabel">项目</span>
            <span className="td__contextvalue" title={task.projectName ?? undefined}>
              {context.project}
            </span>
          </div>
          <div className="td__contextcell" data-testid="task-context-owner" title={context.owner.title}>
            <span className="td__contextlabel">负责人</span>
            <span className="td__contextvalue">
              {context.owner.name}
              {context.owner.meta ? <span className="td__contextmeta"> · {context.owner.meta}</span> : null}
            </span>
          </div>
          <div
            className="td__contextcell"
            data-testid="task-context-deadline"
            data-tone={context.deadline.tone}
            title={context.deadline.relative || '未设置截止时间'}
          >
            <span className="td__contextlabel">截止</span>
            <span className="td__contextvalue">
              {context.deadline.date}
              {context.deadline.relative ? (
                <span className="td__contextmeta td__contextmeta--relative"> · {context.deadline.relative}</span>
              ) : null}
            </span>
          </div>
          <div
            className="td__contextcell"
            data-testid="task-context-deps"
            title={context.deps.title}
          >
            <span className="td__contextlabel">依赖</span>
            <span className="td__contextvalue">{context.deps.text}</span>
          </div>
        </div>
        {data.deviations != null && data.deviations.total > 0 ? (
          <div className="td__deviation-warning" data-testid="task-deviations-warning" role="status">
            <span>
              ⚠ 差异台账：{data.deviations.total} 条 · {data.deviations.open} 未结 ·{' '}
              {data.deviations.openWithoutOwner.length} 无主
            </span>
            <button type="button" className="td__toggle" data-testid="task-deviations-open" onClick={() => select('artifacts')}>
              查看 →
            </button>
          </div>
        ) : null}
        {progress.total > 0 ? (
          <div
            className="td__progress"
            data-testid="progress"
            data-done={progress.done}
            data-total={progress.total}
          >
            <span className="td__bar">
              <span className="td__barfill" style={{ width: `${percent}%` }} />
            </span>
            <span className="td__progresstext" data-testid="progress-text">
              {/* （2026-11-06 决定）：未完成步骤不是硬门，但必须可见/可交代——
                  完成后仍缺步时显式标出，避免「done 了但 7/12 步」像正常收尾。 */}
              {`${progress.done}/${progress.total} 步已完成`}
              {progress.done < progress.total
                ? `（${progress.total - progress.done} 步未完成${data.task.state === 'done' ? '，见验收报告交代' : ''}）`
                : ''}
            </span>
          </div>
        ) : null}
        {/* 「当前在等什么」（UI §7）：**无等待时不渲染任何占位**（AC②）。 */}
        {waitTexts && waitTexts.length > 0 ? (
          <div className="td__waits" data-testid="task-waits">
            {waitTexts.map((text, index) => (
              <span key={`wait-${index}`} className="td__wait" data-testid="task-wait">
                {text}
              </span>
            ))}
          </div>
        ) : null}
        {/* D2/C3（「详情可见操作」逐行落点）：**未实现的动作不许可点**（disabled + title）。
            未知/无表的 state → 不渲染操作条（不臆造）。
            （挂载 3 余·取消小步，D-9）：`danger:true`（取消）＝**行内二次确认**——点一次进确认条，
            默认焦点在「返回」（安全默认）、Esc 退回；确认条文案的件数取**真读数**（workItemCounts）。 */}
        {/* P0/C2：结束任务前的变更集处理三选一 */}
        {finishAction != null ? (
          <div className="td__confirm" data-testid="td-finish-confirm" role="alertdialog" aria-label="结束任务前处理变更">
            <span className="td__confirm-text" data-testid="td-finish-confirm-text">
              还有 {(data.changesets ?? []).filter((cs) => cs.state === 'open').length} 个未合并的变更集——结束前怎么处理？
            </span>
            <button
              type="button"
              className="td__action td__action--primary"
              data-testid="td-finish-merge"
              disabled={(data.changesets ?? []).filter((cs) => cs.state === 'open').length !== 1 || onMergeChangeset == null}
              title={
                (data.changesets ?? []).filter((cs) => cs.state === 'open').length !== 1
                  ? '有多个变更集：请先在下方逐条合并，或选择保留分支'
                  : '先合并到主分支，再结束任务'
              }
              onClick={() => {
                const open = (data.changesets ?? []).filter((cs) => cs.state === 'open');
                const id = open[0]?.id;
                if (id == null || onMergeChangeset == null) return;
                void Promise.resolve(onMergeChangeset(id)).then((ok) => {
                  if (ok === false) return;
                  const action = finishAction;
                  setFinishAction(null);
                  if (action != null) onAction?.(action);
                });
              }}
            >
              合并并结束
            </button>
            <button
              type="button"
              className="td__action"
              data-testid="td-finish-keep"
              onClick={() => {
                const action = finishAction;
                setFinishAction(null);
                if (action != null) onAction?.(action);
              }}
            >
              保留分支，结束
            </button>
            <button
              type="button"
              className="td__action td__action--danger"
              data-testid="td-finish-discard"
              onClick={() => {
                const open = (data.changesets ?? []).filter((cs) => cs.state === 'open');
                if (onDiscardChangeset == null) return;
                void (async () => {
                  for (const cs of open) {
                    const ok = await Promise.resolve(onDiscardChangeset(cs.id));
                    if (ok === false) return;
                  }
                  const action = finishAction;
                  setFinishAction(null);
                  if (action != null) onAction?.(action);
                })();
              }}
            >
              丢弃改动并结束
            </button>
            <button type="button" className="td__action" data-testid="td-finish-cancel" onClick={() => setFinishAction(null)}>
              取消
            </button>
          </div>
        ) : null}

        {actions.length > 0 ? (
          confirmAction != null ? (
            <div
              className="td__confirm"
              data-testid="task-action-confirm"
              role="alertdialog"
              aria-label="确认中止任务"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setConfirmAction(null);
              }}
            >
              <span className="td__confirm-text" data-testid="task-action-confirm-text">
                {cancelConfirmText({ shortId: task.shortId, counts: data.workItemCounts })}
              </span>
              <button
                type="button"
                className="td__action td__action--danger"
                data-testid="task-action-confirm-yes"
                onClick={() => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  onAction?.(action);
                }}
              >
                确认中止
              </button>
              <button
                type="button"
                className="td__action"
                data-testid="task-action-confirm-no"
                autoFocus
                onClick={() => setConfirmAction(null)}
              >
                返回
              </button>
            </div>
          ) : (
            <div className="td__actions" data-testid="task-actions" data-state={task.state}>
              {primaryAction ? renderActionButton(primaryAction) : null}
              {inlineSecondary.map((action) => renderActionButton(action))}
              {secondaryActions.length > 0 ? (
                <details className="td__more" data-testid="task-actions-more" ref={moreRef}>
                  <summary className="td__more-summary" title="更多操作">
                    ⋯
                  </summary>
                  <div className="td__more-menu">{secondaryActions.map((action) => renderActionButton(action))}</div>
                </details>
              ) : null}
              {settingsNode}
            </div>
          )
        ) : null}
        {actions.length === 0 ? settingsNode : null}
        {mergeHint != null ? (
          <p className="td__meta" data-testid="task-merge-hint" style={{ marginTop: 8 }}>
            {mergeHint}
          </p>
        ) : null}
        {rejectAction != null ? (
          <div
            className="td__reject"
            data-testid="task-reject-editor"
            role="dialog"
            aria-label="打回批注"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRejectAction(null);
            }}
          >
            <label className="td__rejectlabel" htmlFor="task-reject-notes">
              打回批注（会写进返工说明）
            </label>
            <textarea
              id="task-reject-notes"
              className="td__rejecttextarea"
              data-testid="task-reject-notes"
              value={rejectNotes}
              maxLength={2000}
              autoFocus
              placeholder="写清哪里不对、期望怎么改"
              onChange={(event) => setRejectNotes(event.target.value)}
            />
            <div className="td__planactions">
              <span className="td__meta">{rejectNotes.trim().length}/2000</span>
              <span className="td__spacer" />
              <button
                type="button"
                className="td__action"
                data-testid="task-reject-cancel"
                onClick={() => setRejectAction(null)}
              >
                返回
              </button>
              <button
                type="button"
                className="td__action td__action--primary"
                data-testid="task-reject-submit"
                disabled={rejectNotes.trim().length === 0}
                onClick={() => {
                  const notes = rejectNotes.trim();
                  if (notes.length === 0) return;
                  const action = rejectAction;
                  setRejectAction(null);
                  onAction?.(rejectActionWithNotes(action, notes, data.verificationWorkItemId));
                }}
              >
                确认打回
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <nav className="td__tabs" role="tablist" aria-label="任务详情">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            className="td__tab"
            data-testid={entry.key}
            aria-selected={tab === entry.key}
            onClick={() => {
              select(entry.key);
            }}
          >
            {entry.label}
            {tabCounts[entry.key] != null ? ` ${tabCounts[entry.key]}` : ''}
          </button>
        ))}
      </nav>

      {tab === 'plan' ? (
        <PlanPanel
          task={task}
          steps={data.planSteps}
          reviews={data.reviews ?? []}
          onOpenArtifacts={() => select('artifacts')}
          editing={editingPlan}
          canEdit={task.state === 'awaiting_approval' && onSavePlan != null}
          onStartEdit={() => setEditingPlan(true)}
          onCancelEdit={() => setEditingPlan(false)}
          onSavePlan={onSavePlan}
          onSaved={() => setEditingPlan(false)}
        />
      ) : null}
      {tab === 'timeline' ? (
        <TimelinePanel
          items={data.timeline}
          behavior={behavior}
          raw={data.rawConversation ?? null}
          onReadToolOutput={onReadToolOutput}
        />
      ) : null}
      {tab === 'behavior' ? <BehaviorPanel items={behavior} /> : null}
      {tab === 'artifacts' ? (
        <ArtifactsPanel
          taskId={task.id}
          artifacts={data.artifacts ?? []}
          steps={data.planSteps}
          changesets={data.changesets ?? []}
          accessMode={task.projectAccessMode ?? null}
          refTargets={refTargets ?? []}
          onReferenceArtifact={onReferenceArtifact}
          referenceNotice={referenceNotice ?? null}
          onReadArtifact={onReadArtifact}
          onExportArchive={onExportArchive}
          artifactPreview={artifactPreview ?? null}
          onCloseArtifactPreview={onCloseArtifactPreview}
          artifactNotice={artifactNotice ?? null}
          exportNotice={exportNotice ?? null}
          onMergeChangeset={onMergeChangeset}
          mergeNotice={mergeNotice ?? null}
          mergeConflicts={mergeConflicts ?? null}
          mergeConflictChangesetId={mergeConflictChangesetId ?? null}
          onReworkConflict={onReworkConflict}
          onRollbackChangeset={onRollbackChangeset}
          rollbackNotice={rollbackNotice ?? null}
          onDiscardChangeset={onDiscardChangeset}
          discardNotice={discardNotice ?? null}
          changesetActionsLocked={task.archived === 1 || task.state === 'cancelled'}
          deviations={data.deviations ?? null}
          onOpenChangesetDiff={
            onReadChangesetDiff ? (changesetId, path) => void openChangesetDiff(changesetId, path) : undefined
          }
        />
      ) : null}
      {tab === 'cost' ? <CostPanel cost={cost} /> : null}
      {diffView ? (
        <div className="td__diff-layer" data-testid="changeset-diff-layer" role="dialog" aria-modal="true" aria-label="变更 diff">
          <header className="td__diff-head">
            <button type="button" className="td__action" data-testid="changeset-diff-back" onClick={() => setDiffView(null)}>
              ← 变更与产物
            </button>
            <span className="td__diff-title" data-testid="changeset-diff-path">
              {diffView.path}
            </span>
            <span className="td__meta">
              {diffView.baseSha ? `${diffView.baseSha.slice(0, 8)} ↔ ${diffView.headSha?.slice(0, 8) ?? '—'}` : '基准未知'}
            </span>
            <button type="button" className="td__popover-close" aria-label="关闭 diff" onClick={() => setDiffView(null)}>
              ✕
            </button>
          </header>
          {diffView.loading ? (
            <p className="td__empty" data-testid="changeset-diff-loading">
              读取中…
            </p>
          ) : diffView.error ? (
            <p className="td__empty" data-testid="changeset-diff-error" role="alert" style={{ color: 'var(--danger)' }}>
              {diffView.error}
            </p>
          ) : (
            <div className="td__diff-body" data-testid="changeset-diff-body">
              {diffRows.length === 0 ? (
                <p className="td__empty">无差异（该提交未改动此文件内容）。</p>
              ) : (
                diffRows.map((row, index) => (
                  <div
                    className={`td__diffrow td__diffrow--${row.kind}`}
                    data-testid="changeset-diff-row"
                    data-kind={row.kind}
                    key={`diff-${index}`}
                  >
                    <span className="td__diffline">{row.oldNo ?? ''}</span>
                    <span className="td__diffline">{row.newNo ?? ''}</span>
                    <span className="td__difftext">
                      {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
                      {row.text}
                    </span>
                    {(() => {
                      const lineKey = String(row.newNo ?? row.oldNo ?? index);
                      const note = diffNotes[lineKey] ?? '';
                      const open = diffNoteOpen.has(lineKey);
                      return (
                        <span className="td__diffnote">
                          <button
                            type="button"
                            className="td__smallbtn"
                            data-testid="diff-note-toggle"
                            title={note.length > 0 ? `批注：${note}` : '给这一行加批注'}
                            onClick={() => {
                              setDiffNoteOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(lineKey)) next.delete(lineKey);
                                else next.add(lineKey);
                                return next;
                              });
                            }}
                          >
                            {note.length > 0 ? '✎' : '＋'}
                          </button>
                          {open ? (
                            <textarea
                              className="td__diffnote-input"
                              data-testid="diff-note-input"
                              rows={2}
                              value={note}
                              placeholder="给这一行写批注（打回时会带上）"
                              onChange={(e) => saveDiffNote(lineKey, (e.target as HTMLTextAreaElement).value)}
                            />
                          ) : null}
                        </span>
                      );
                    })()}
                  </div>
                ))
              )}
            </div>
          )}
          <footer className="td__diff-foot">
            <span className="td__meta">只读 · unified diff</span>
            {diffView.truncated ? (
              <span className="td__meta" data-testid="changeset-diff-truncated">
                已截断：仅显示前 256KB
              </span>
            ) : null}
            <span className="td__meta">Esc 关闭</span>
          </footer>
        </div>
      ) : null}
    </section>
  );
}
