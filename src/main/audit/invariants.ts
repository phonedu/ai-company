/**
 * `invariants.ts` —— 引擎不变量探测（`pnpm test:invariants`）的**纯逻辑**（无 IO，可内存测）。
 *
 * 缘起（C4 计划 P3）：静态探测（`audit:chain`）抓「接线存在性」；**时序交错类**断链（BRK4/BRK8 族）
 * 只能靠"撞"——随机命令序列打到**真引擎**（骑缝 `scripts/eval/run.mjs` 的 headless 装配）上，
 * 每一步静默后校验不变量；失败即收缩出最小复现。本模块＝命令目录 × 适用性 × 种子 PRNG
 * （mulberry32）× 不变量检查 × 违规键 × 序列收缩；装配/执行/对账在 `scripts/invariants/run.mjs`。
 *
 * 首批不变量（v1，如实登记）：
 *  - `I0` 状态合法：任务/工作项状态 ∈ 已知枚举（防"幽灵态"）；
 *  - `I1` 卡死（settled⇒推进）：任务 `executing` ＋ 件全 settled（done/submitted/failed/interrupted）
 *    ＋ 已静默 ⇒ 违规（**BRK4 签名**：暂停期间件跑完、恢复后不再聚合）；
 *  - `I2` 孤儿会话：静默后仍有 `running` 工作项（会话应已 settle——BRK2 类"事件非法抛出"的签名）；
 *  - `I3` 终态冻结：终态任务不得在非 `undo_finish` 命令下离终态（防幽灵复活）；
 *  - `I4`（跑器侧）合法命令必被接受：按适用表派发的命令被引擎拒绝 ⇒ 违规（引擎行为与表不符）。
 *
 * 口径（v1）：
 *  - 随机源＝mulberry32（种子可复跑）；命令空间离散且小 ⇒ **不引 fast-check**（依赖白名单 + HANDOVER §3.4
 *    同步未走；其价值在任意值域 shrinking，命令删除收缩由 `minimizeSequence` 贪心删除承担）——
 *    偏差已写回计划件 §2 P3；
 *  - 已知违规账本 `KNOWN_INVARIANT_VIOLATIONS`（如 BRK4，批 R 待修）：命中＝「已知」不计红；未命中＝红；
 *    已知项不再出现＝提示翻案；`--strict` 忽略账本（演示/验牙用）；
 *  - 「静默」＝ `pendingActions===0`（action_log 无 pending）；跑器以「连续 3 轮读数为 0」为口径。
 */

export type InvariantId = 'I0' | 'I1' | 'I2' | 'I3' | 'I4';

export interface InvariantViolation {
  invariant: InvariantId;
  /** 违规键（账本对账 / 收缩判同用）。 */
  key: string;
  detail: string;
}

/** 引擎快照（跑器从真库读；纯函数检查）。 */
export interface EngineSnapshot {
  /** 当前关注任务（单血脉：沿 renew 链）。 */
  taskId: number;
  taskState: string;
  wiStates: string[];
  /** 全库终态任务（I3 冻结对账）。 */
  terminalTasks: Array<{ id: number; state: string }>;
  /** action_log 中 state='pending' 的条数（0＝静默）。 */
  pendingActions: number;
}

export interface CheckInput {
  prev: EngineSnapshot | null;
  cur: EngineSnapshot;
  /** 自上一检查点以来派发的命令 id **集合**（burst 可能含多条——I3 豁免按「本波含命中自身的 undo_finish」判）。 */
  commands: readonly string[];
}

export interface CommandSpec {
  id: string;
  event: string;
  /** 适用任务状态（与 `TASK_TRANSITIONS` 对照；派发前先行过滤）。 */
  from: readonly string[];
  label: string;
}

export const KNOWN_TASK_STATES = new Set([
  'inbox', 'planning', 'awaiting_approval', 'ready', 'executing', 'paused',
  'verifying', 'needs_decision', 'blocked', 'done', 'failed', 'cancelled',
]);

export const KNOWN_WI_STATES = new Set([
  'queued', 'running', 'submitted', 'rejected', 'done', 'failed', 'interrupted',
]);

const SETTLED_WI = new Set(['done', 'submitted', 'failed', 'interrupted']);

/**
 * v1 命令目录（老板视角动作；`retry` 因守卫依赖「存在可重试件」暂不入池——防 I4 假阳性，登记 v1 缺口）。
 */
export const COMMANDS: readonly CommandSpec[] = [
  { id: 'triage', event: 'triage', from: ['inbox'], label: '分诊' },
  { id: 'discard', event: 'discard', from: ['inbox'], label: '丢弃' },
  { id: 'plan_approved', event: 'plan_approved', from: ['awaiting_approval'], label: '批准' },
  { id: 'revise', event: 'revise', from: ['awaiting_approval'], label: '打回' },
  { id: 'pause', event: 'pause', from: ['ready', 'executing', 'verifying', 'blocked'], label: '暂停' },
  { id: 'resume', event: 'resume', from: ['paused'], label: '继续' },
  {
    id: 'cancel',
    event: 'cancel',
    // 注意：`inbox` 的关闭事件是 `discard`（FLOWS §3.1.1 inbox 行）——首跑 I4 曾抓到本表笔误；
    // 命令表须与真值表逐行对齐（I4 的价值正是盯这个）。
    from: ['planning', 'awaiting_approval', 'ready', 'executing', 'paused', 'verifying', 'needs_decision', 'blocked'],
    label: '取消',
  },
  { id: 'finish_manual', event: 'finish_manual', from: ['executing'], label: '结束收尾' },
  { id: 'finish', event: 'finish', from: ['paused'], label: '完成收尾' },
  { id: 'renew', event: 'renew', from: ['done', 'failed', 'cancelled'], label: '续办' },
  { id: 'undo_finish', event: 'undo_finish', from: ['done'], label: '撤销结束' },
];

export function applicableCommands(taskState: string): CommandSpec[] {
  return COMMANDS.filter((c) => c.from.includes(taskState));
}

/** mulberry32——小而确定的种子 PRNG（同一 seed 必得同一序列）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 不变量检查（纯函数）——跑器每步静默后调用。 */
export function checkInvariants(input: CheckInput): InvariantViolation[] {
  const { prev, cur, commands } = input;
  const out: InvariantViolation[] = [];

  if (!KNOWN_TASK_STATES.has(cur.taskState)) {
    out.push({ invariant: 'I0', key: `I0:task:${cur.taskState}`, detail: `任务状态非法：${cur.taskState}` });
  }
  for (const state of cur.wiStates) {
    if (!KNOWN_WI_STATES.has(state)) {
      out.push({ invariant: 'I0', key: `I0:wi:${state}`, detail: `工作项状态非法：${state}` });
    }
  }

  if (cur.pendingActions === 0 && cur.wiStates.length > 0 && cur.taskState === 'executing' && cur.wiStates.every((s) => SETTLED_WI.has(s))) {
    out.push({
      invariant: 'I1',
      key: 'I1:executing-settled',
      detail: `executing ＋ 全件 settled（${cur.wiStates.join('/')}）⇒ 应推进却停在 executing（静默）`,
    });
  }

  if (cur.pendingActions === 0 && cur.wiStates.includes('running')) {
    out.push({ invariant: 'I2', key: 'I2:running-orphan', detail: '静默后仍有 running 工作项（会话应已 settle）' });
  }

  if (prev) {
    const curMap = new Map(cur.terminalTasks.map((t) => [t.id, t.state]));
    for (const t of prev.terminalTasks) {
      if (curMap.has(t.id)) continue;
      if (commands.includes('undo_finish') && t.id === cur.taskId) continue;
      out.push({
        invariant: 'I3',
        key: 'I3:left-terminal',
        detail: `终态任务 T#${t.id}（${t.state}）离终态，而本波命令（${commands.join('/') || '—'}）不含命中自身的 undo_finish`,
      });
    }
  }

  return out;
}

// ───────────────────────────── 已知违规账本 ─────────────────────────────

export interface KnownViolation {
  invariant: InvariantId;
  key: string;
  ref: string;
  note: string;
}

/**
 * 已知违规账本（如历史 BRK4，批 R 已修）：命中＝打印为「已知」不计红；未命中＝红；
 * 已知项不再出现＝提示翻案（「修复锚」语义，与 `chain-registry` 同族）。
 * **2026-10-18（M3-R-1）**：BRK4 / `undo_finish` 两条路径已由「恢复进入 executing 时对账」
 * 统一修复；账本清空——若签名再现即红（回归）。
 */
export const KNOWN_INVARIANT_VIOLATIONS: KnownViolation[] = [];

export function matchKnownViolation(v: InvariantViolation): KnownViolation | null {
  return KNOWN_INVARIANT_VIOLATIONS.find((k) => k.invariant === v.invariant && k.key === v.key) ?? null;
}

// ───────────────────────────── 序列收缩（ddmin-lite）─────────────────────────────

/**
 * 贪心删除最小化：逐条尝试删除，仍能复现（`stillReplays` 为真）则保留删除结果。
 * O(n) 次重放；`stillReplays` 由跑器用「同 key 违规复现」实现。
 * 泛型 `T`：跑器按「条目」（含节奏 gapMs/thenPump）收缩，按位置删除（重复 id 不失真）。
 */
export async function minimizeSequence<T>(
  seq: readonly T[],
  stillReplays: (candidate: readonly T[]) => Promise<boolean>,
): Promise<T[]> {
  let cur = [...seq];
  let i = 0;
  while (i < cur.length) {
    const candidate = [...cur.slice(0, i), ...cur.slice(i + 1)];
    if (candidate.length > 0 && (await stillReplays(candidate))) {
      cur = candidate;
    } else {
      i += 1;
    }
  }
  return cur;
}
