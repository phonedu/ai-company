/**
 *  · 只读 unified diff 的展示投影（纯函数，无 React/DOM/fs）。
 *
 * 只解析 `git diff --unified=3` 文本；不访问仓库、不猜内容。
 * 行号规则：
 *  - `@@ -a,b +c,d @@` 之后，context 同时递增 old/new；
 *  - `-` 只递增 old；`+` 只递增 new；
 *  - 其余（`diff --git`/`index`/`---`/`+++`/`\ No newline`）作 meta 行，不编号。
 */
export type DiffRowKind = 'context' | 'add' | 'del' | 'hunk' | 'meta';

export interface DiffRow {
  oldNo: number | null;
  newNo: number | null;
  /** 展示文本（已去掉 `+`/`-`/前导空格；hunk/meta 保留原文）。 */
  text: string;
  kind: DiffRowKind;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(input: string | null | undefined): DiffRow[] {
  if (typeof input !== 'string' || input.length === 0) return [];
  const rows: DiffRow[] = [];
  let oldNo: number | null = null;
  let newNo: number | null = null;
  // 统一换行；末尾空行不造一条假行。
  const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ oldNo: null, newNo: null, text: raw, kind: 'hunk' });
      continue;
    }
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('\\ No newline')) {
      rows.push({ oldNo: null, newNo: null, text: raw, kind: 'meta' });
      continue;
    }
    if (oldNo == null || newNo == null) {
      // 没有 hunk 头的自由文本（例如 git 的错误/空 diff 说明）按 meta 原样展示。
      rows.push({ oldNo: null, newNo: null, text: raw, kind: 'meta' });
      continue;
    }
    if (raw.startsWith('+')) {
      rows.push({ oldNo: null, newNo, text: raw.slice(1), kind: 'add' });
      newNo += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      rows.push({ oldNo, newNo: null, text: raw.slice(1), kind: 'del' });
      oldNo += 1;
      continue;
    }
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ oldNo, newNo, text, kind: 'context' });
    oldNo += 1;
    newNo += 1;
  }
  return rows;
}
