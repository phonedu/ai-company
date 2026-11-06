/**
 * CTX-1 P0（CTX1-2）· 上下文遥测 —— 纯函数层（无 IO，可内存测）。
 *
 * 口径（上下文工程口径（C2））：
 *  - 每层 chars/estTokens/truncated/来源；总 token；窗口占用（contextWindow 未知 → null，不写假 0）。
 *  - token 估算与记忆模块同一保守口径（CJK 1 字≈1 token，ASCII 4 字≈1）——**读数口径单一真源**。
 *  - 层预算裁剪（CTX1-4）也在这里：每层超限 → 头+尾截断＋显式标记（不静默丢）。
 */

/** 与 `memory/policy.ts` 同口径的保守估算（单一真源原则：两处签名一致，测试断言不漂移）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x7f) cjk += 1;
    else ascii += 1;
  }
  return cjk + Math.ceil(ascii / 4);
}

/** 单层读数。 */
export interface ContextLayerMetric {
  /** 层名（platform/role/persona/memory/…；与 context.ts 组装顺序一致）。 */
  name: string;
  /** 层在 system（压缩不丢）还是 user 段。 */
  side: 'system' | 'user';
  chars: number;
  estTokens: number;
  /** 本层是否被截断（CTX1-4 caps）。 */
  truncated: boolean;
  /** 截断前 token（未截断＝同 estTokens）。 */
  tokensBeforeCap: number;
}

export interface ContextTelemetry {
  /** 分层读数（按组装顺序）。 */
  layers: ContextLayerMetric[];
  totalTokens: number;
  /** system 段 token（压缩不丢侧）。 */
  systemTokens: number;
  /** user 段 token。 */
  userTokens: number;
  /** 窗口占用率（0..1）；contextWindow 未知 → null（渲染层显 `—`）。 */
  utilization: number | null;
  /** 任一层被截断 → true。 */
  truncated: boolean;
}

/** 组装各层文本 → 分层读数＋总量＋占用（纯投影）。 */
export function buildTelemetry(
  segments: ReadonlyArray<{ name: string; text: string; side: 'system' | 'user'; truncated?: boolean; tokensBeforeCap?: number }>,
  contextWindow: number | null,
): ContextTelemetry {
  const layers: ContextLayerMetric[] = segments.map((s) => ({
    name: s.name,
    side: s.side,
    chars: s.text.length,
    estTokens: estimateTokens(s.text),
    truncated: s.truncated === true,
    tokensBeforeCap: s.tokensBeforeCap ?? estimateTokens(s.text),
  }));
  const systemTokens = segments
    .filter((s) => s.side === 'system')
    .reduce((n, s) => n + estimateTokens(s.text), 0);
  const userTokens = segments
    .filter((s) => s.side === 'user')
    .reduce((n, s) => n + estimateTokens(s.text), 0);
  const totalTokens = systemTokens + userTokens;
  return {
    layers,
    totalTokens,
    systemTokens,
    userTokens,
    utilization: contextWindow != null && contextWindow > 0 ? totalTokens / contextWindow : null,
    truncated: layers.some((l) => l.truncated),
  };
}

/**
 * 在已组装上下文之后追加材料（评审/规划）时，**同步**扩读数——
 * 否则 `context_metrics` 会少记评审材料/角色规则，误导后续 A/B。
 */
export function extendTelemetry(
  base: ContextTelemetry,
  extra: ReadonlyArray<{ name: string; text: string; side: 'system' | 'user'; truncated?: boolean; tokensBeforeCap?: number }>,
): ContextTelemetry {
  const layers = [...base.layers];
  let systemTokens = base.systemTokens;
  let userTokens = base.userTokens;
  for (const s of extra) {
    const est = estimateTokens(s.text);
    layers.push({
      name: s.name,
      side: s.side,
      chars: s.text.length,
      estTokens: est,
      truncated: s.truncated === true,
      tokensBeforeCap: s.tokensBeforeCap ?? est,
    });
    if (s.side === 'system') systemTokens += est;
    else userTokens += est;
  }
  return {
    layers,
    systemTokens,
    userTokens,
    totalTokens: systemTokens + userTokens,
    utilization: base.utilization,
    truncated: layers.some((l) => l.truncated),
  };
}

// ───────────── CTX1-4 · 层预算裁剪（纯函数） ─────────────

/** 各层 token 上限（起始值；上下文工程口径（C4）表——基线校准前不动 caps 语义）。 */
export const LAYER_TOKEN_CAPS: Readonly<Record<string, number>> = {
  projectContext: 2000,
  bossText: 4000,
  workBrief: 1000,
  skillIndex: 800,
  /** CTX1-6：计划复述（每轮动态；步骤多/文本长时截断，不静默丢）。 */
  planRecitation: 800,
  /** RET-F-02：员工 L1 记忆（D-17 2k 口径；留余量给事实/检索层）。 */
  employeeMemory: 1200,
};

export interface CappedLayer {
  text: string;
  truncated: boolean;
  tokensBeforeCap: number;
}

export interface CapLayerOptions {
  /** 标记里加一句「去哪读全文」（RET-F-01：项目约定层要给路径）。 */
  hint?: string;
  /** 被截断部分的**标题目录**（RET-F-01：让模型知道漏了哪些章节，再按需 read）。 */
  outline?: readonly string[];
  /** `head-tail`（默认）保头尾；`tail-heavy` 保最近内容（记忆等时间序）。 */
  mode?: 'head-tail' | 'tail-heavy';
}

/**
 * 超限截断：默认**头 65% ＋ 尾**（保首尾语义）＋ 显式标记行（不静默丢）；
 * `tail-heavy` 为头 20% ＋ 尾 80%（记忆等时间序，近期更重要）。
 * 可选 `hint`（去哪读全文）与 `outline`（被截部分的章节标题）。
 * 未超限 → 原文原样（truncated=false）。截断标记/目录本身计入返回文本。
 */
export function capLayer(
  name: string,
  text: string,
  capTokens: number,
  options: CapLayerOptions = {},
): CappedLayer {
  const before = estimateTokens(text);
  if (before <= capTokens) return { text, truncated: false, tokensBeforeCap: before };
  // 反推字符预算：按同口径近似（CJK 全文时 token≈char；保守多留 10%）。
  let charBudget = Math.floor(capTokens * 1.1);
  if (charBudget >= text.length) charBudget = text.length - 1;
  const headShare = options.mode === 'tail-heavy' ? 0.2 : 0.65;
  const headLen = Math.floor(charBudget * headShare);
  const tailLen = Math.max(1, charBudget - headLen - 1);
  const hintPart = options.hint != null && options.hint.trim().length > 0 ? `${options.hint.trim()}；` : '';
  const outline = (options.outline ?? []).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 24);
  const outlinePart = outline.length > 0 ? `\n【${name} 章节目录】${outline.join('；')}` : '';
  const marker = `\n…【${name} 已截断（约 ${before}→${capTokens} tokens）；${hintPart}完整内容用工具读取】${outlinePart}`;
  const capped = text.slice(0, headLen) + marker + '\n' + text.slice(text.length - tailLen);
  return { text: capped, truncated: true, tokensBeforeCap: before };
}
