/**
 * N4（``）· **压缩可观测**（纯逻辑，可 node 测；无 IO、不依赖 Pi）。
 *
 * 背景（核实自底座）：
 *  - 底座**默认开自动压缩**（`settings.compaction.enabled ?? true`）；auto 路径（threshold/overflow）
 *    **不传 `customInstructions`** ⇒ 我们**无法**给底座的摘要注入领域指令；
 *  - 钩子只能「取消」或「返回自定义 compaction 结果」（自己生成摘要）——后者要拿会话内部的
 *    model/apiKey/streamFn，耦合深、收益低；
 *  - **真正的解法在上下文层**：任务基线（简报/验收/证据索引）放进 **system 段**——
 *    **system 不参与历史压缩** ⇒ 压缩后必然仍在（**构造性保证**，不靠"希望摘要保留"）。
 *
 * 本模块负责"**可读 + 如实**"：每次压缩**留痕**（reason/tokensBefore/willRetry/是否有旧摘要）并**计数**，
 * 不静默（P6）。**不改变压缩行为**（不取消、不自定义），摘要仍由底座生成。
 */

import { isCtxEnabled } from './context-flags.js';

export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface CompactionObservation {
  reason: CompactionReason | string;
  /** 压缩前 token 数（底座 `preparation.tokensBefore`）。 */
  tokensBefore: number;
  /** overflow 恢复时会重试被中断的一轮。 */
  willRetry: boolean;
  /** 是否为「迭代摘要」（上一轮摘要存在）。 */
  hadPreviousSummary: boolean;
}

export interface CompactionStats {
  /** **成功压缩次数**（由 `session_compact` 累计；`session_before_compact` 可能被取消）。 */
  count: number;
  /** 最近一次「即将压缩」的观测（无 → null）。 */
  lastBefore: CompactionObservation | null;
}

let count = 0;
let lastBefore: CompactionObservation | null = null;

/**
 * CTX1-2：**按会话**的压缩读数（会话键由 `pi-runtime` 创建 loader 时闭包传入）。
 * 进程级 `stats()` 不足以写进 `context_metrics`（多会话并发时会把别家次数记到本行）。
 */
const sessionStats = new Map<string, CompactionStats>();

/** 记一次「即将压缩」（钩子 `session_before_compact` 调；**不改行为**，只观测）。 */
export function observeBeforeCompact(o: CompactionObservation, sessionKey?: string): CompactionObservation {
  lastBefore = o;
  if (sessionKey != null) {
    const cur = sessionStats.get(sessionKey) ?? { count: 0, lastBefore: null };
    sessionStats.set(sessionKey, { count: cur.count, lastBefore: o });
  }
  return o;
}

/** 记一次「压缩成功」（钩子 `session_compact` 调）。 */
export function observeCompacted(sessionKey?: string): CompactionStats {
  count += 1;
  if (sessionKey != null) {
    const cur = sessionStats.get(sessionKey) ?? { count: 0, lastBefore: null };
    sessionStats.set(sessionKey, { count: cur.count + 1, lastBefore: cur.lastBefore });
  }
  return stats();
}

export function stats(): CompactionStats {
  return { count, lastBefore };
}

/** CTX1-2：本会话压缩读数（未观测 → count=0 且 lastBefore=null；渲染层按需显 `—`）。 */
export function sessionCompactionStats(sessionKey: string): CompactionStats {
  return sessionStats.get(sessionKey) ?? { count: 0, lastBefore: null };
}

/** 测试用：复位（进程级计数，测试间不串）。 */
export function resetCompactionStats(): void {
  count = 0;
  lastBefore = null;
  sessionStats.clear();
}

/** 人读一行（日志留痕用；含「基线在 system 段」的提示，防读者误以为简报被压掉）。 */
export function describeCompaction(o: CompactionObservation): string {
  return (
    `reason=${o.reason} tokensBefore=${o.tokensBefore} willRetry=${o.willRetry}` +
    `${o.hadPreviousSummary ? '（迭代摘要）' : ''}｜任务基线在 system 段、不参与压缩（N4）`
  );
}

// ───────────── CTX1-5 · 按模型窗口推导压缩阈值（纯函数） ─────────────

/** 与 Pi `compaction.modelOverrides` 同形的每模型档。 */
export interface CompactionTokenOverride {
  reserveTokens: number;
  keepRecentTokens: number;
}

/** 推导用的最小模型信息（只读投影，不依赖 Pi 类型）。 */
export interface ModelWindowInfo {
  provider: string;
  id: string;
  contextWindow: number;
}

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20000;

/** `AICO_CTX_COMPACTION=off` 关闭按模型阈值（A/B 单变量用；默认开）。 */
export function isCompactionTuningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isCtxEnabled(env)) return false;
  const raw = (env.AICO_CTX_COMPACTION ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/**
 * 按窗口推导起始值（上下文工程口径（C4））：
 *  - reserveTokens = min(16384, floor(cw × 0.15))
 *  - keepRecentTokens = min(20000, floor(cw × 0.35))
 * 窗口非正/非整数 → 跳过（不写假数）；同 key 先到先得（目录顺序稳定）。
 */
export function deriveCompactionOverrides(
  models: readonly ModelWindowInfo[],
): Record<string, CompactionTokenOverride> {
  const out: Record<string, CompactionTokenOverride> = {};
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    const cw = model.contextWindow;
    if (provider.length === 0 || id.length === 0) continue;
    if (!Number.isSafeInteger(cw) || cw <= 0) continue;
    const key = `${provider}/${id}`;
    if (out[key] != null) continue;
    out[key] = {
      reserveTokens: Math.min(DEFAULT_COMPACTION_RESERVE_TOKENS, Math.floor(cw * 0.15)),
      keepRecentTokens: Math.min(DEFAULT_COMPACTION_KEEP_RECENT_TOKENS, Math.floor(cw * 0.35)),
    };
  }
  return out;
}
