/**
 * 2026-10-29 P2（D-N09）：diff 行内批注的存储与汇总（纯函数，可 node 测）。
 *
 * 口径：
 *  - 存储走 localStorage，按「任务 + 变更集 + 文件」一份 map（行键 → 批注文本）；
 *  - 汇总用于「打回」：把当前任务下所有文件的批注按 path:line 列出，带进 reject notes；
 *  - 空批注/坏 JSON → 忽略，不造内容（不臆造）。
 */

export function diffNotesStorageKey(taskId: number, changesetId: number, path: string): string {
  return `aico:diff-notes:${taskId}:${changesetId}:${path}`;
}

/** 任务级前缀（汇总时扫描）。 */
export function diffNotesTaskPrefix(taskId: number): string {
  return `aico:diff-notes:${taskId}:`;
}

export function parseDiffNoteMap(raw: string | null): Record<string, string> {
  if (raw == null || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export interface DiffNoteEntry {
  path: string;
  line: string;
  note: string;
}

/** 从存储键解析文件名（键格式固定为 aico:diff-notes:<task>:<cs>:<path>）。 */
export function pathFromDiffNotesKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length < 5 || parts[0] !== 'aico' || parts[1] !== 'diff-notes') return null;
  return parts.slice(4).join(':');
}

export function summarizeDiffNotes(entries: readonly DiffNoteEntry[]): string {
  const lines = entries
    .filter((entry) => entry.note.trim().length > 0)
    .map((entry) => `- ${entry.path}:${entry.line} ${entry.note.trim()}`);
  return lines.length === 0 ? '' : ['diff 批注：', ...lines].join('\n');
}
