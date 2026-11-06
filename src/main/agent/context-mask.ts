import { isCtxEnabled } from './context-flags.js';

/**
 * CTX-1 P1（CTX1-1）· 工具输出裁剪（模型边界）—— 纯逻辑，可 node 测；无 IO、无 Pi 依赖。
 *
 * 两条路径（上下文工程口径（C1））：
 *  1. **新大输出**（写入时，`tool_result` 钩子）：≥ 8000 字符 → 头 2000＋尾 800＋显式标记＋归档 ref；
 *     原始内容仍落归档，UI/审计可展开；**错误输出不裁剪**（错误要留在上下文里）。
 *  2. **旧输出**（每轮 `context` 钩子）：只遮**最近 K 条之外**、非错误、文本 ≥ 400 字符的工具结果；
 *     替换为「一行标记＋前 200 字摘要」，**不删消息**（保持 tool_use/tool_result 配对）。
 *
 * 开关：`AICO_CTX_MASK=off` 关闭（A/B 单变量用；默认开）。
 */

export const TOOL_OUTPUT_MASK_THRESHOLD_CHARS = 8000;
export const NEW_OUTPUT_HEAD_CHARS = 2000;
export const NEW_OUTPUT_TAIL_CHARS = 800;
/** 旧输出：保留最近 K 条工具结果原样（含错误）。 */
export const KEEP_RECENT_TOOL_RESULTS = 6;
/** 旧输出：小于该长度的不动（不值得遮）。 */
export const OLD_OUTPUT_MIN_CHARS = 400;
/** 旧输出：保留摘要前缀长度（人读/模型够用）。 */
export const OLD_OUTPUT_HEAD_CHARS = 200;
/**
 * CTX1-1 策略收窄（2026-10-25 A/B 实证）：`read` 的输出是**分析素材**，头尾截断会丢中间数据、
 * 逼模型反复重读（工具密集 A/B 成本 +47.8%）。文件内容一律不遮；只遮 `bash` 等命令噪声。
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(['read']);

export function isContextMaskingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isCtxEnabled(env)) return false;
  const raw = (env.AICO_CTX_MASK ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/** 写入时裁剪：头＋尾＋显式标记；未达阈值原样返回（truncated=false，不制造噪音）。 */
export function maskNewToolOutput(input: {
  text: string;
  toolName: string;
  /** 归档 ref（相对归档根；缺省不写 ref，但标记仍说明已裁剪）。 */
  ref?: string | null;
  bytes?: number;
}): { text: string; masked: boolean } {
  const text = input.text;
  if (PROTECTED_TOOL_NAMES.has(input.toolName)) return { text, masked: false };
  if (text.length < TOOL_OUTPUT_MASK_THRESHOLD_CHARS) return { text, masked: false };
  const head = text.slice(0, NEW_OUTPUT_HEAD_CHARS);
  const tail = text.slice(Math.max(0, text.length - NEW_OUTPUT_TAIL_CHARS));
  const bytes = input.bytes ?? text.length;
  const refPart = input.ref != null && input.ref.length > 0 ? `；完整内容已归档 ref=${input.ref}（审计/老板可展开）` : '';
  const marker =
    `\n…【工具输出已裁剪：${input.toolName}；原文 ${text.length} 字符 / ${bytes} 字节；仅保留头尾；` +
    `需要细节请分段读取或缩窄命令${refPart}】\n`;
  return { text: `${head}${marker}${tail}`, masked: true };
}

interface TextItem {
  type: 'text';
  text: string;
}

function isTextItem(value: unknown): value is TextItem {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

/** 提取消息文本（数组里所有 text 项 join；字符串原样）。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextItem)
    .map((item) => item.text)
    .join('\n');
}

export interface MaskOldResult {
  /** 新数组（未改动时原样返回同一引用，调用方可据此跳过 set）。 */
  messages: readonly unknown[];
  maskedCount: number;
  savedChars: number;
}

/**
 * 旧输出裁剪：从末尾数，最近 K 条工具结果不动；错误不动；过短不动。
 * 只替换 content 里的 text 项，**保留图片项与消息本身**（配对不断裂）。
 */
export function maskOldToolResults(
  messages: readonly unknown[],
  options: { keepRecent?: number; minChars?: number; headChars?: number } = {},
): MaskOldResult {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS;
  const minChars = options.minChars ?? OLD_OUTPUT_MIN_CHARS;
  const headChars = options.headChars ?? OLD_OUTPUT_HEAD_CHARS;

  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message != null && typeof message === 'object' && (message as { role?: unknown }).role === 'toolResult') {
      toolIndexes.push(index);
    }
  });
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - keepRecent)));

  let maskedCount = 0;
  let savedChars = 0;
  const next = messages.map((message, index) => {
    const m = message as { role?: unknown; toolName?: unknown; content?: unknown; isError?: unknown } | null;
    if (m == null || typeof m !== 'object' || m.role !== 'toolResult') return message;
    if (protectedIndexes.has(index)) return message;
    if (m.isError === true) return message;
    if (typeof m.toolName === 'string' && PROTECTED_TOOL_NAMES.has(m.toolName)) return message;
    const text = messageText(m.content);
    if (text.length < minChars) return message;
    const toolName = typeof m.toolName === 'string' && m.toolName.length > 0 ? m.toolName : '(未知工具)';
    const marker =
      `【旧工具输出已清理：${toolName}；原 ${text.length} 字符；摘要：${text.slice(0, headChars)}…】`;
    const content = Array.isArray(m.content)
      ? [({ type: 'text', text: marker } as TextItem), ...m.content.filter((item) => !isTextItem(item))]
      : marker;
    maskedCount += 1;
    savedChars += Math.max(0, text.length - marker.length);
    return { ...(m as object), content };
  });

  return { messages: maskedCount > 0 ? next : messages, maskedCount, savedChars };
}

// ───────────── 计数器（A/B 读数；进程级，测试可复位） ─────────────

export interface MaskStats {
  /** 写入时被裁剪的次数/原始字符数。 */
  newMaskedCount: number;
  newMaskedChars: number;
  /** 旧输出被清理的次数/节省字符数。 */
  oldMaskedCount: number;
  oldSavedChars: number;
}

let stats: MaskStats = { newMaskedCount: 0, newMaskedChars: 0, oldMaskedCount: 0, oldSavedChars: 0 };

export function recordNewMasked(originalChars: number): void {
  stats = { ...stats, newMaskedCount: stats.newMaskedCount + 1, newMaskedChars: stats.newMaskedChars + originalChars };
}

export function recordOldMasked(result: Pick<MaskOldResult, 'maskedCount' | 'savedChars'>): void {
  if (result.maskedCount === 0) return;
  stats = {
    ...stats,
    oldMaskedCount: stats.oldMaskedCount + result.maskedCount,
    oldSavedChars: stats.oldSavedChars + result.savedChars,
  };
}

export function maskStats(): MaskStats {
  return { ...stats };
}

export function resetMaskStats(): void {
  stats = { newMaskedCount: 0, newMaskedChars: 0, oldMaskedCount: 0, oldSavedChars: 0 };
}
