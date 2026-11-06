/**
 * M4-D-1（P2）· `task:read-tool-output` —— 按不透明 ref 受控读取归档的工具大输出。
 * 只接受归档根内的 ref；越界/不存在/超读取上限 → 显式错误（不静默读任意文件）。
 */
import { readArchivedToolOutput } from '../agent/tool-output-archive.js';

export interface ToolOutputReaderDeps {
  toolOutputDir?: string;
}

export type ReadToolOutputResult =
  | { ok: true; ref: string; text: string }
  | { ok: false; code: string; message: string };

export function handleReadToolOutput(deps: ToolOutputReaderDeps, raw: unknown): ReadToolOutputResult {
  const input = (raw ?? {}) as { ref?: unknown };
  if (typeof input.ref !== 'string' || input.ref.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'ref 需为非空字符串' };
  }
  if (!deps.toolOutputDir) return { ok: false, code: 'not_ready', message: '工具输出归档不可用（主进程未装配）' };
  const text = readArchivedToolOutput(deps.toolOutputDir, input.ref);
  if (text == null) {
    return { ok: false, code: 'not_found', message: '归档输出不存在、越界或超过读取上限' };
  }
  return { ok: true, ref: input.ref, text };
}
