/**
 * K1 幕僚长 `memory_search` 工具（老板 2026-11-05 裁「1 和 2 都做」的 ②）。
 *
 * 缺口：幕僚长的记忆 brief 只注入 global＋当前项目两节（`store.brief`），「别的项目里记过什么」
 * 检索不到。本工具只读、走既有 `SqliteMemoryStore.search`（FTS5/LIKE），**全局＋全部活跃项目**
 * 跨范围合并检索；不动 brief 结构、不动隔离边界（员工侧不挂载、不写任何数据、verifier 零记忆
 * 的硬规则不受影响——工具只挂幕僚长）。
 *
 * 与 task_status 同模式：ESM 动态 import Pi SDK；只读（闸门 category=other → 放行）。
 */
import type { SqliteDb } from '../db/open.js';
import { SqliteMemoryStore } from '../memory/index.js';

/** 单次回给上限（防一次灌爆幕僚长上下文；brief 预算口径之外的工具侧闸）。 */
const MAX_HITS = 8;
/** 每个范围最多取几条候选（合并后再按分排序截 MAX_HITS）。 */
const PER_SCOPE_LIMIT = 4;

interface ScopeHit {
  scopeLabel: string;
  value: string;
  kind: string;
  score: number;
  updatedAt: number;
}

export async function createMemorySearchTool(db: SqliteDb) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'memory_search',
    label: 'Memory Search',
    description:
      '只读跨范围搜索记忆库（全局＋全部活跃项目的事实/偏好/决定）。老板问「之前记过什么/说过什么/' +
      '某项目约定是什么」时先用本工具，再据实回答；查不到就明说，不凭记忆猜。',
    parameters: Type.Object({
      query: Type.String({ description: '关键词（1–4 个词；太长会被截断）' }),
    }),
    async execute(_toolCallId, params: { query: string }) {
      const store = new SqliteMemoryStore(db);
      const principal = { kind: 'assistant' } as const;
      const scopes: Array<{ label: string; scope: { type: 'global' } | { type: 'project'; projectId: number } }> = [
        { label: '全局', scope: { type: 'global' } },
      ];
      const projects = db.prepare('SELECT id, name FROM projects WHERE archived = 0 ORDER BY id').all() as Array<{
        id: number;
        name: string;
      }>;
      for (const p of projects) scopes.push({ label: p.name, scope: { type: 'project', projectId: p.id } });

      const merged: ScopeHit[] = [];
      for (const { label, scope } of scopes) {
        for (const hit of store.search({ scope, principal, text: params.query, limit: PER_SCOPE_LIMIT })) {
          merged.push({ scopeLabel: label, value: hit.item.value, kind: hit.item.kind, score: hit.score, updatedAt: hit.item.updatedAt });
        }
      }
      if (merged.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `没搜到与「${params.query}」相关的记忆。可以换个关键词再搜；若这条事实还没被记过，请老板在「记忆」页显式记下（或把项目记忆提升为全局）。`,
            },
          ],
          details: { query: params.query, hits: 0, returned: 0, scopes: scopes.length },
        };
      }
      merged.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
      const top = merged.slice(0, MAX_HITS);
      const lines = top.map((h) => `- [${h.scopeLabel}] ${h.value}（${h.kind}）`);
      const truncated = merged.length > top.length ? `\n（另有 ${merged.length - top.length} 条命中未列出，可换更具体的关键词）` : '';
      return {
        content: [{ type: 'text', text: `搜到 ${merged.length} 条相关记忆：\n${lines.join('\n')}${truncated}` }],
        details: { query: params.query, hits: merged.length, returned: top.length, scopes: scopes.length },
      };
    },
  });
}
