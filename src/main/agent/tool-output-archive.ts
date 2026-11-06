/**
 * M4-D-1（P2）· 工具大输出归档。
 *
 * 口径：
 *  - 只有**大输出**（≥ 阈值）落盘；小输出保持原样，不制造额外文件；
 *  - 会话/上下文只留**摘要＋不透明 ref**，不把大输出塞进 `task_events`；
 *  - 展开时按 ref 受控读取（必须落在归档根内，拒绝 `..`/绝对路径逃逸）；
 *  - 归档发生在工具结果返回处（prompt 前缀之后），**不改 system prompt 前缀**，缓存前缀稳定。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const TOOL_OUTPUT_THRESHOLD_CHARS = 8000;
export const TOOL_OUTPUT_SUMMARY_CHARS = 400;
/** 展开读取上限（防一次性把超大文件拉进渲染层）。 */
export const TOOL_OUTPUT_READ_MAX_BYTES = 1_000_000;

/** 从 Pi `AgentToolResult`/任意结果里提取文本（数组 content 取 text 项；对象取 text；否则 JSON）。 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result == null) return '';
  if (Array.isArray(result)) return result.map((item) => toolResultText(item)).filter((s) => s.length > 0).join('\n');
  if (typeof result === 'object') {
    const obj = result as { content?: unknown; text?: unknown; output?: unknown };
    if (Array.isArray(obj.content)) return toolResultText(obj.content);
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.output === 'string') return obj.output;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** 摘要：短输出原样；长输出取头 + 尾（不静默截断成半句）。 */
export function summarizeToolOutput(text: string, maxChars = TOOL_OUTPUT_SUMMARY_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.65));
  const tail = Math.max(1, maxChars - head - 5);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'session';
}

export interface ArchiveToolOutputInput {
  root: string;
  sessionKey: string;
  toolCallId: string;
  toolName: string;
  text: string;
  now?: number;
}

export interface ArchivedToolOutput {
  /** 相对归档根的不透明引用（不是绝对路径；渲染层只拿这个）。 */
  ref: string;
  bytes: number;
  summary: string;
}

/** 写入归档根下 `session/时间-工具-哈希.txt`；返回 ref/字节数/摘要。 */
export function archiveToolOutput(input: ArchiveToolOutputInput): ArchivedToolOutput {
  const now = input.now ?? Date.now();
  const session = safePart(input.sessionKey);
  const dir = join(input.root, session);
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(input.text).digest('hex').slice(0, 10);
  const name = `${now}-${safePart(input.toolName)}-${safePart(input.toolCallId)}-${hash}.txt`;
  const file = join(dir, name);
  writeFileSync(file, input.text, 'utf8');
  return {
    ref: `${session}/${name}`,
    bytes: statSync(file).size,
    summary: summarizeToolOutput(input.text),
  };
}

/** 按 ref 受控读取（归档根内）；逃逸/不存在 → null（不抛、不静默回退到真实路径）。 */
export function readArchivedToolOutput(root: string, ref: string): string | null {
  if (ref.trim().length === 0) return null;
  const base = resolve(root);
  const abs = resolve(base, ref);
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) return null;
  if (!existsSync(abs)) return null;
  try {
    const size = statSync(abs).size;
    if (size > TOOL_OUTPUT_READ_MAX_BYTES) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
