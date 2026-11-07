import { join } from 'node:path';
import { retrievalTerms } from './terms.js';
import { searchNotes } from '../agent/notes.js';
/**
 * OPT-AI-11 · 轻量检索（FTS5/LIKE 口径；**先 LIKE，向量库后评估**）。
 *
 * 目的：让员工开局能看到**同项目里与本题相关的历史**（记忆/事件/产物），而不是全靠完整记忆块或瞎猜。
 * 边界：只读、限条数、每段截断（防它自己变成新的上下文债）；**不跨项目**（项目＝上下文边界）。
 * 检索词：从任务标题/目标抽 2–4 个词（中文取 2 字 n-gram，英文/数字按空白词），全部 `LIKE` 命中即可（OR）。
 */
import type { SqliteDb } from './open.js';

export interface RetrievalHit {
  source: 'memory' | 'event' | 'artifact' | 'fact' | 'note';
  taskId: number | null;
  text: string;
  at: number;
}

export { retrievalTerms } from './terms.js';

function snippet(text: string, term: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const at = one.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  const start = Math.max(0, at - 60);
  const piece = one.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${piece}${start + max < one.length ? '…' : ''}`;
}

/** 预筛：前 3 个词 OR（放宽召回；命中后仍要求全部词，避免误报）。 */
function prefilter(columns: readonly string[], terms: readonly string[]): { sql: string; params: string[] } {
  const used = terms.slice(0, 3);
  const clauses: string[] = [];
  const params: string[] = [];
  for (const col of columns) {
    for (const term of used) {
      clauses.push(`${col} LIKE ?`);
      params.push(`%${term}%`);
    }
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * RET-1 P2 · 事实检索升级：FTS5（trigram）＋ LIKE 混合。
 * trigram 要求 ≥3 字才能命中——中文 2-gram（retrievalTerms 大多数输出）只能走 LIKE。
 * 两路合并去重：FTS5 bm25 排序在前（更相关），LIKE 命中补充在后（覆盖短词）。
 */
function ftsFactSearch(db: SqliteDb, projectId: number, terms: readonly string[], limit = 50): Array<{ key: string | null; value: string; updated_at: number }> {
  const longTerms = terms.filter((t) => t.length >= 3);
  const shortTerms = terms.filter((t) => t.length < 3);
  const seen = new Set<number>();
  const out: Array<{ key: string | null; value: string; updated_at: number; _rank: number }> = [];

  // 路 1：FTS5 bm25（≥3 字词）
  if (longTerms.length > 0) {
    const query = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      const rows = db
        .prepare(
          `SELECT mi.id, mi.key, mi.value, mi.updated_at, bm25(memory_items_fts) AS rank
           FROM memory_items_fts fts
           JOIN memory_items mi ON mi.id = fts.rowid
           WHERE mi.scope_type = 'project' AND mi.scope_id = ? AND mi.status = 'active' AND mi.pinned = 0
             AND memory_items_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(projectId, query, limit) as Array<{ id: number; key: string | null; value: string; updated_at: number; rank: number }>;
      for (const r of rows) {
        seen.add(r.id);
        out.push({ key: r.key, value: r.value, updated_at: r.updated_at, _rank: r.rank });
      }
    } catch {
      // FTS5 表不存在或语法错误 → 全走 LIKE
    }
  }

  // 路 2：LIKE（短词 + FTS5 未命中的兜底）
  if (shortTerms.length > 0 || longTerms.length === 0) {
    const allTerms = terms;
    const factPre = prefilter(['mi.key', 'mi.value'], allTerms);
    const rows = db
      .prepare(
        `SELECT mi.id, mi.key, mi.value, mi.updated_at FROM memory_items mi
         WHERE mi.scope_type = 'project' AND mi.scope_id = ? AND mi.status = 'active' AND mi.pinned = 0
           AND ${factPre.sql} ORDER BY mi.updated_at DESC LIMIT ?`,
      )
      .all(projectId, ...factPre.params, limit) as Array<{ id: number; key: string | null; value: string; updated_at: number }>;
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push({ key: r.key, value: r.value, updated_at: r.updated_at, _rank: 999 });
      }
    }
  }

  return out.map(({ _rank, ...rest }) => rest);
}

/**
 * 同项目相关历史（记忆/事件/产物/项目事实）；按来源各取 ≤2，合并去重后取 `limit`（缺省 4）。
 * 排除当前任务自己的事件/产物（那是基线，不是"历史"）；记忆/事实是项目级，保留。
 * RET-F-03：预筛用前 3 词 OR（原先只用首词，常见 2-gram 会把召回卡住）；`memory_items` 纳入（只取项目级、active、非 pinned）。
 */
export function searchRelated(
  db: SqliteDb,
  input: { projectId: number; taskId?: number | null; text: string; limit?: number },
): RetrievalHit[] {
  const terms = retrievalTerms(input.text);
  const limit = Math.max(1, input.limit ?? 4);
  if (terms.length === 0) return [];
  const score = (text: string): number => {
    const lower = text.toLowerCase();
    return terms.reduce((n, t) => n + (lower.includes(t.toLowerCase()) ? 1 : 0), 0);
  };
  const takeTop = <T>(rows: T[], textOf: (row: T) => string, atOf: (row: T) => number, source: RetrievalHit['source'], taskIdOf: (row: T) => number | null): RetrievalHit[] => {
    const scored = rows
      .map((row) => ({ row, score: score(textOf(row)), at: atOf(row) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, 2);
    return scored.map((x) => ({ source, taskId: taskIdOf(x.row), text: snippet(textOf(x.row), terms[0]), at: x.at }));
  };

  const memPre = prefilter(['memory'], terms);
  const memoryRows = db
    .prepare(`SELECT memory, updated_at FROM employee_memory WHERE project_id = ? AND ${memPre.sql} ORDER BY updated_at DESC LIMIT 50`)
    .all(input.projectId, ...memPre.params) as Array<{ memory: string; updated_at: number }>;
  const hits: RetrievalHit[] = [
    ...takeTop(memoryRows, (r) => r.memory, (r) => r.updated_at, 'memory', () => null),
  ];

  const evPre = prefilter(['e.payload'], terms);
  const eventRows = db
    .prepare(
      `SELECT e.task_id, e.payload, e.ts FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE t.project_id = ? AND e.kind IN ('agent_message','question_asked','submitted_summary','progress_reported','artifact_produced')
         AND ${evPre.sql} ORDER BY e.ts DESC LIMIT 50`,
    )
    .all(input.projectId, ...evPre.params) as Array<{ task_id: number; payload: string; ts: number }>;
  hits.push(
    ...takeTop(
      eventRows.filter((r) => input.taskId == null || r.task_id !== input.taskId),
      (r) => r.payload,
      (r) => r.ts,
      'event',
      (r) => r.task_id,
    ),
  );

  const artPre = prefilter(['a.path', 'a.note'], terms);
  const artifactRows = db
    .prepare(
      `SELECT a.task_id, a.path, a.note, a.created_at FROM artifacts a JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id = ? AND ${artPre.sql} ORDER BY a.id DESC LIMIT 50`,
    )
    .all(input.projectId, ...artPre.params) as Array<{ task_id: number; path: string; note: string; created_at: number }>;
  hits.push(
    ...takeTop(
      artifactRows.filter((r) => input.taskId == null || r.task_id !== input.taskId),
      (r) => `${r.path}${r.note ? ` · ${r.note}` : ''}`,
      (r) => r.created_at,
      'artifact',
      (r) => r.task_id,
    ),
  );

  // 项目级事实（RET-1 P2：FTS5 bm25 排序优先，回退 LIKE）；active/非 pinned；只查本项目。
  const factRows = ftsFactSearch(db, input.projectId, terms);
  hits.push(
    ...takeTop(factRows, (r) => `${r.key ? `${r.key}：` : ''}${r.value}`, (r) => r.updated_at, 'fact', () => null),
  );

  // K1 知识库：项目笔记（.aico/notes/）＋全局笔记——员工干活时自动看到相关知识
  if (input.projectId != null) {
    const proj = db
      .prepare('SELECT root_dir FROM projects WHERE id = ?')
      .get(input.projectId) as { root_dir: string } | undefined;
    if (proj?.root_dir != null) {
      const noteHits = searchNotes({
        query: terms.join(' '),
        projects: [{ id: input.projectId, name: '', rootDir: proj.root_dir }],
        globalDir: join(proj.root_dir, '..', '..', '.aico-notes'),
      });
      for (const nh of noteHits.slice(0, 2)) {
        hits.push({ source: 'note', taskId: null, text: `${nh.name}：${nh.preview}`, at: Date.now() });
      }
    }
  }

  const seen = new Set<string>();
  return hits
    .filter((h) => {
      if (seen.has(h.text)) return false;
      seen.add(h.text);
      return true;
    })
    .sort((a, b) => score(b.text) - score(a.text) || b.at - a.at)
    .slice(0, limit);
}
