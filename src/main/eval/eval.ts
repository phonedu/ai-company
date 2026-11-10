/**
 * `` 评测集**纯逻辑**（§7 序 5）：任务集校验 · 验收判分 · 三列汇总表。
 *
 * 口径（`work/plan-reorg-r1-r4.md` §2.1）：
 *  - 任务集＝`scripts/eval/tasks.json`，字段 `{id, title, goal, risk, acceptance:[{text, check?}], tags}`；
 *  - **判分器＝评测跑器自身**（命令型 `check`：在**任务工作区**里跑，超时/fail 一律算不通过）——
 *    这是"机器判分"，与 app 内的 verifier 会话（LLM 抽验）**分开**：评测要的是可复现的决定；
 *  - **有牙**：任务集必须含 ≥1 条 `impossible`（其 check 恒不通过）——判 fail 即证明判分器在工作；
 *  - 三列＝**质量**（acceptance 通过率）/ **成本**（USD）/ **时长**（wall ms）。
 *
 * 本模块**纯函数**（命令执行注入），可内存测；真跑装配在 `scripts/eval/run.mjs`。
 */

export interface EvalAcceptanceItem {
  text: string;
  /** 可执行判据（在工作区里跑；缺省 ⇒ 只能人工看，评测里算「不可判」→ 不计入通过率）。 */
  check?: string;
}

export interface EvalTask {
  id: string;
  title: string;
  goal: string;
  /** 0＝L0 直通 / 1＝L1 审计划（评测两轴里的"编排"轴）。 */
  risk: 0 | 1;
  tags: string[];
  /** 判分前先铺进工作区的文件（内容任务尤其需要）。 */
  seedFiles?: Record<string, string>;
  acceptance: EvalAcceptanceItem[];
  /** **有牙样本**（恒不通过）——任务集必须含 ≥1 条。 */
  impossible?: boolean;
  /** **仅 `--dry-run` 用**：脚本化"员工产出"（fake 运行时按此写盘）；真跑不看它。 */
  dryRunArtifacts?: Record<string, string>;
}

export interface EvalTaskSet {
  version: number;
  tasks: EvalTask[];
}

export interface ValidateResult {
  ok: boolean;
  tasks: EvalTask[];
  errors: string[];
}

/**
 * 任务集校验（**唯一守卫**）：字段形状 / id 唯一 / ≥1 条 acceptance（且至少 1 条带 `check`）/
 * **必须含 ≥1 条 `impossible`**（否则"判分器有没有牙"无法证）/ 上限 20 条（少真调纪律）。
 */
export function validateEvalTasks(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const tasks: EvalTask[] = [];
  const obj = (raw ?? {}) as { version?: unknown; tasks?: unknown };
  if (typeof obj.version !== 'number') errors.push('version 需为数字');
  if (!Array.isArray(obj.tasks)) {
    errors.push('tasks 需为数组');
    return { ok: false, tasks: [], errors };
  }
  if (obj.tasks.length === 0) errors.push('任务集为空');
  if (obj.tasks.length > 20) errors.push(`任务数 ${obj.tasks.length} > 20（首版封顶，少真调纪律）`);
  const seen = new Set<string>();
  for (const [i, item] of obj.tasks.entries()) {
    const t = (item ?? {}) as Partial<EvalTask>;
    const where = `tasks[${i}]`;
    if (typeof t.id !== 'string' || t.id.trim().length === 0) errors.push(`${where}.id 需非空字符串`);
    else if (seen.has(t.id)) errors.push(`${where}.id 重复：${t.id}`);
    else seen.add(t.id);
    if (typeof t.title !== 'string' || t.title.trim().length === 0) errors.push(`${where}.title 需非空字符串`);
    if (typeof t.goal !== 'string' || t.goal.trim().length === 0) errors.push(`${where}.goal 需非空字符串`);
    if (t.risk !== 0 && t.risk !== 1) errors.push(`${where}.risk 需为 0 或 1`);
    if (!Array.isArray(t.tags)) errors.push(`${where}.tags 需为数组`);
    if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) {
      errors.push(`${where}.acceptance 至少 1 条`);
    } else if (!t.acceptance.some((a) => typeof (a as EvalAcceptanceItem).check === 'string' && (a as EvalAcceptanceItem).check!.trim().length > 0)) {
      errors.push(`${where}.acceptance 至少 1 条带可执行 check（否则无法机器判分）`);
    }
    tasks.push(t as EvalTask);
  }
  if (!tasks.some((t) => t.impossible === true)) {
    errors.push('任务集必须含 ≥1 条 impossible（有牙：判分器必须能判 fail）');
  }
  return { ok: errors.length === 0, tasks, errors };
}

/** 命令执行注入（真跑＝child_process；单测＝内存桩）。 */
export type RunCheck = (command: string, opts: { cwd: string; timeoutMs: number }) => { code: number; output: string };

export interface GradedItem {
  text: string;
  check: string | null;
  pass: boolean | null; // null＝不可判（无 check）
  reason: string;
}

export interface GradeResult {
  items: GradedItem[];
  /** 质量＝可判条目通过率（0–1）；无可用条目 ⇒ null（不臆造 0 或 1）。 */
  quality: number | null;
  verdict: 'pass' | 'fail';
}

/**
 * 判分：逐条跑 `check`（在任务工作区）。
 * 口径：任一条 **有 check 的** 条目不过 ⇒ `verdict='fail'`；无 check 的条目记 `null`（不可判，不计入分母）；
 * 一条可判条目都没有 ⇒ `verdict='fail'`（"没法判"不得算通过）。
 */
export function gradeAcceptance(
  task: EvalTask,
  workspaceDir: string,
  runCheck: RunCheck,
  timeoutMs = 30_000,
): GradeResult {
  const items: GradedItem[] = [];
  for (const a of task.acceptance) {
    const check = typeof a.check === 'string' && a.check.trim().length > 0 ? a.check : null;
    if (check === null) {
      items.push({ text: a.text, check: null, pass: null, reason: '无 check（不可判，不计入通过率）' });
      continue;
    }
    const res = runCheck(check, { cwd: workspaceDir, timeoutMs });
    const pass = res.code === 0;
    items.push({
      text: a.text,
      check,
      pass,
      reason: pass ? '通过' : `不通过（exit=${res.code}）${res.output.trim().length > 0 ? `：${res.output.trim().slice(0, 200)}` : ''}`,
    });
  }
  const judged = items.filter((i): i is GradedItem & { pass: boolean } => i.pass !== null);
  const quality = judged.length === 0 ? null : judged.filter((i) => i.pass).length / judged.length;
  const verdict: 'pass' | 'fail' = judged.length > 0 && judged.every((i) => i.pass) ? 'pass' : 'fail';
  return { items, quality, verdict };
}

export interface EvalRow {
  taskId: string;
  orchestration: 'l0' | 'l1';
  tier: string;
  /** 引擎终态（done/failed/needs_decision/超时…）。 */
  taskState: string;
  quality: number | null;
  verdict: 'pass' | 'fail';
  usd: number;
  wallMs: number;
  /** 逐会话模型（`costs.model` 去重）——V2 的"档位真切换"证据。 */
  models: string[];
  notes?: string;
}

/** 三列汇总（按任务 × 编排 × 档排；缺项显 `—`——不臆造 0）。 */
export function formatEvalTable(rows: readonly EvalRow[]): string {
  const header = ['任务', '编排', '档', '终态', '判', '质量', '成本(USD)', '时长(s)', '模型'];
  const lines = [header.join('\t')];
  for (const r of rows) {
    lines.push(
      [
        r.taskId,
        r.orchestration.toUpperCase(),
        r.tier,
        r.taskState,
        r.verdict,
        r.quality === null ? '—' : `${Math.round(r.quality * 100)}%`,
        r.usd > 0 ? r.usd.toFixed(4) : '—',
        (r.wallMs / 1000).toFixed(1),
        r.models.join('+') || '—',
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

/** 汇总读数（进挂牌表的人话一行；**只报事实**，不承诺省 X%）。 */
export function evalSummaryLine(rows: readonly EvalRow[], stamp: string): string {
  const byTier = new Map<string, { usd: number; wall: number; pass: number; n: number }>();
  for (const r of rows) {
    const e = byTier.get(r.tier) ?? { usd: 0, wall: 0, pass: 0, n: 0 };
    e.usd += r.usd;
    e.wall += r.wallMs;
    e.pass += r.verdict === 'pass' ? 1 : 0;
    e.n += 1;
    byTier.set(r.tier, e);
  }
  const parts = [...byTier.entries()].map(
    ([tier, e]) => `${tier}：${e.pass}/${e.n} 过 · $${e.usd.toFixed(4)} · ${(e.wall / 1000).toFixed(0)}s`,
  );
  const impossible = rows.filter((r) => r.taskId === 'impossible').every((r) => r.verdict === 'fail');
  return `评测（${stamp}，${rows.length} 行）：${parts.join('｜')}；有牙样本恒 fail=${impossible ? '是' : '否⚠️'}`;
}
