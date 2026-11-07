/**
 * B0-12（57 D 路 P2）：提交信息/变更集摘要的**语义化**（此前是 `T-1: work item 7` 模板＋`summary:''`）。
 *
 * 口径：摘要取员工 `submit_work_item.summary`（归一空白、截断）；没有摘要就**明说没有**，
 * 不假装有（也避免把空串写进 changeset 让 UI 显示空白）。
 */

function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export interface WorkItemCommitMessageInput {
  shortId: string;
  title?: string | null;
  summary?: string | null;
  workItemId: number;
}

/** `T-1042: 项目页行下展开 — 摘要…`；无摘要 → `（未提供摘要）`。 */
export function workItemCommitMessage(input: WorkItemCommitMessageInput): string {
  const title = oneLine(input.title) || `工作项 ${input.workItemId}`;
  const head = `${input.shortId}: ${clip(title, 60)}`;
  const summary = oneLine(input.summary);
  return summary.length > 0 ? `${head} — ${clip(summary, 72)}` : `${head}（未提供摘要）`;
}

/** changeset 摘要：员工摘要（≤200 字）或「未提供摘要（N 个文件变化）」。 */
export function changesetSummary(input: { summary?: string | null; filesChanged: number }): string {
  const summary = oneLine(input.summary);
  if (summary.length > 0) return clip(summary, 200);
  return `未提供摘要（${Math.max(0, Math.trunc(input.filesChanged))} 个文件变化）`;
}

/** 从 work_items.result（submit_work_item 归一化结果）取摘要；解析失败/缺失 → ''。 */
export function summaryFromWorkItemResult(result: string | null | undefined): string {
  if (result == null || result.length === 0) return '';
  try {
    const parsed = JSON.parse(result) as { summary?: unknown } | null;
    return typeof parsed?.summary === 'string' ? parsed.summary : '';
  } catch {
    return '';
  }
}
