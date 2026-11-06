/**
 * 记忆模块 v1 —— SQLite 适配器（唯一直接碰 `memory_items`/`memory_events` 的实现）。
 *
 * 复用约束：本文件可以 import `better-sqlite3` 的类型，但**不 import Electron/Pi/渲染层**；
 * 其它模块通过 `MemoryPort` 使用，不直接查表。
 */
import type { SqliteDb } from '../db/open.js';
import type {
  BriefInput,
  Confirmation,
  MemoryAudit,
  MemoryBrief,
  MemoryBriefSection,
  MemoryHit,
  MemoryItem,
  MemoryPatch,
  MemoryQuery,
  MemoryScope,
  RememberInput,
  SourceRef,
} from './types.js';
import { MemoryConflictError } from './types.js';
import { assertNoSecret, redactSecrets } from './secrets.js';
import {
  MEMORY_BUDGETS,
  authorityRank,
  canPrincipalSee,
  estimateTokens,
  pickByBudget,
  renderItem,
  sameScope,
  sameValue,
  scopeColumns,
  sortForInjection,
} from './policy.js';
import type { MemoryPort } from './port.js';

interface MemoryRow {
  id: number;
  scope_type: 'global' | 'project';
  scope_id: number;
  kind: MemoryItem['kind'];
  key: string | null;
  value: string;
  source_type: MemoryItem['source']['type'];
  source_ref: string | null;
  source_excerpt: string | null;
  confidence: MemoryItem['confidence'];
  status: MemoryItem['status'];
  pinned: number;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  last_verified_at: number | null;
  superseded_by: number | null;
}

const SELECT_COLS = `id, scope_type, scope_id, kind, key, value, source_type, source_ref,
  source_excerpt, confidence, status, pinned, valid_from, valid_to, created_at, updated_at,
  expires_at, last_verified_at, superseded_by`;

const MAX_VALUE_CHARS = 4000;

function redactEvent(value: unknown): string | null {
  if (value == null) return null;
  const text = redactSecrets(JSON.stringify(value));
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function rowToItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope_type === 'global' ? { type: 'global' } : { type: 'project', projectId: row.scope_id },
    kind: row.kind,
    key: row.key,
    value: row.value,
    source: {
      type: row.source_type,
      ref: row.source_ref,
      excerpt: row.source_excerpt,
      at: row.created_at,
    },
    confidence: row.confidence,
    status: row.status,
    pinned: row.pinned === 1,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    lastVerifiedAt: row.last_verified_at,
    supersededBy: row.superseded_by,
  };
}

function scopeClause(scope: MemoryScope): { sql: string; args: unknown[] } {
  const { scopeType, scopeId } = scopeColumns(scope);
  return { sql: 'scope_type = ? AND scope_id = ?', args: [scopeType, scopeId] };
}

function queryTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1)
    .slice(0, 4);
}

/** 记忆模块 v1 的 SQLite 实现。 */
export class SqliteMemoryStore implements MemoryPort {
  /** FTS5 可用性（迁移 017 建表；老库未迁移/编译缺 FTS5 时回退 LIKE）。 */
  private ftsAvailableCache: boolean | null = null;

  constructor(private readonly db: SqliteDb) {}

  private ftsAvailable(): boolean {
    if (this.ftsAvailableCache != null) return this.ftsAvailableCache;
    try {
      this.db.prepare('SELECT 1 FROM memory_items_fts LIMIT 1').get();
      this.ftsAvailableCache = true;
    } catch {
      this.ftsAvailableCache = false;
    }
    return this.ftsAvailableCache;
  }

  remember(input: RememberInput): MemoryItem {
    const now = input.now ?? Date.now();
    const { scopeType, scopeId } = scopeColumns(input.scope);
    if (input.scope.type === 'project' && (!Number.isInteger(scopeId) || scopeId <= 0)) {
      throw new Error('[memory] project scope 需要有效的 projectId');
    }
    const value = input.value.trim();
    if (value.length === 0) throw new Error('[memory] value 不能为空');
    if (value.length > MAX_VALUE_CHARS) throw new Error(`[memory] value 超过 ${MAX_VALUE_CHARS} 字上限`);
    const key = input.key != null && input.key.trim().length > 0 ? input.key.trim() : null;
    const confidence = input.confidence ?? (input.source.type === 'boss' ? 'confirmed' : 'provisional');
    const sourceExcerpt = input.source.excerpt != null ? input.source.excerpt.slice(0, 200) : null;
    assertNoSecret([value, key, sourceExcerpt, input.source.ref]);

    const run = this.db.transaction((): MemoryItem => {
      const same = key != null ? this.findActiveByKey(scopeType, scopeId, input.kind, key) : null;
      if (same) {
        const existing = rowToItem(same);
        if (sameValue(existing.value, value)) {
          this.db
            .prepare('UPDATE memory_items SET updated_at = ?, last_verified_at = ? WHERE id = ?')
            .run(now, now, existing.id);
          const refreshed = this.get(existing.id) as MemoryItem;
          this.event(existing.id, 'update', input.source, existing, refreshed, now);
          return refreshed;
        }
        const incomingRank = authorityRank({ source: input.source, confidence });
        const existingRank = authorityRank(existing);
        const existingExpired =
          (existing.validTo != null && existing.validTo <= now) ||
          (existing.expiresAt != null && existing.expiresAt <= now);
        // 两条老板确认的冲突：不静默覆盖，交给调用方出决策卡；已过期则允许新事实接替。
        if (
          !existingExpired &&
          existing.source.type === 'boss' &&
          input.source.type === 'boss' &&
          existing.confidence === 'confirmed' &&
          confidence === 'confirmed'
        ) {
          throw new MemoryConflictError('[memory] 两条老板确认的事实冲突，需要显式裁决', existing, input);
        }
        if (incomingRank < existingRank && !existingExpired) {
          this.event(existing.id, 'skipped', input.source, existing, { value, key, confidence }, now);
          return existing;
        }
        if (incomingRank === existingRank && !existingExpired) {
          throw new MemoryConflictError('[memory] 同权威事实冲突，需要显式裁决', existing, input);
        }
        // 先让旧行退出 active（否则部分唯一索引会挡住新行），再插入新行并回填 superseded_by。
        this.db
          .prepare('UPDATE memory_items SET status = ?, valid_to = ?, updated_at = ? WHERE id = ?')
          .run('superseded', input.validFrom ?? now, now, existing.id);
        const newId = this.insertItem({
          scopeType,
          scopeId,
          kind: input.kind,
          key,
          value,
          source: input.source,
          sourceExcerpt,
          confidence,
          pinned: input.pinned === true,
          validFrom: input.validFrom ?? now,
          validTo: input.validTo ?? null,
          expiresAt: input.expiresAt ?? null,
          now,
        });
        this.db.prepare('UPDATE memory_items SET superseded_by = ? WHERE id = ?').run(newId, existing.id);
        this.event(existing.id, 'supersede', input.source, existing, { supersededBy: newId }, now);
        const created = this.get(newId) as MemoryItem;
        this.event(newId, 'create', input.source, null, created, now);
        return created;
      }

      const id = this.insertItem({
        scopeType,
        scopeId,
        kind: input.kind,
        key,
        value,
        source: input.source,
        sourceExcerpt,
        confidence,
        pinned: input.pinned === true,
        validFrom: input.validFrom ?? now,
        validTo: input.validTo ?? null,
        expiresAt: input.expiresAt ?? null,
        now,
      });
      const created = this.get(id) as MemoryItem;
      this.event(id, 'create', input.source, null, created, now);
      return created;
    });
    return run();
  }

  update(id: number, patch: MemoryPatch, source: SourceRef): MemoryItem {
    const now = source.at ?? Date.now();
    const run = this.db.transaction((): MemoryItem => {
      const before = this.get(id);
      if (!before) throw new Error(`[memory] 条目不存在: ${id}`);
      const value = patch.value != null ? patch.value.trim() : before.value;
      if (value.length === 0) throw new Error('[memory] value 不能为空');
      if (value.length > MAX_VALUE_CHARS) throw new Error(`[memory] value 超过 ${MAX_VALUE_CHARS} 字上限`);
      const key = patch.key !== undefined ? (patch.key != null && patch.key.trim().length > 0 ? patch.key.trim() : null) : before.key;
      assertNoSecret([value, key, source.ref, source.excerpt]);
      this.db
        .prepare(
          `UPDATE memory_items SET value = ?, key = ?, confidence = ?, pinned = ?, valid_to = ?,
             expires_at = ?, last_verified_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          value,
          key,
          patch.confidence ?? before.confidence,
          (patch.pinned ?? before.pinned) ? 1 : 0,
          patch.validTo !== undefined ? patch.validTo : before.validTo,
          patch.expiresAt !== undefined ? patch.expiresAt : before.expiresAt,
          patch.lastVerifiedAt !== undefined ? patch.lastVerifiedAt : now,
          now,
          id,
        );
      const after = this.get(id) as MemoryItem;
      this.event(id, 'update', source, before, after, now);
      return after;
    });
    return run();
  }

  forget(id: number, mode: 'archive' | 'delete'): void {
    const now = Date.now();
    const run = this.db.transaction((): void => {
      const before = this.get(id);
      if (!before) return;
      if (mode === 'delete') {
        this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
        this.event(id, 'delete', { type: 'boss' }, before, null, now);
        return;
      }
      this.db.prepare('UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ?').run('archived', now, id);
      this.event(id, 'archive', { type: 'boss' }, before, { status: 'archived' }, now);
    });
    run();
  }

  get(id: number): MemoryItem | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLS} FROM memory_items WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(query: MemoryQuery = {}): MemoryItem[] {
    if (query.principal && query.principal.kind === 'verifier') return [];
    const now = Date.now();
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.scope) {
      const sc = scopeClause(query.scope);
      where.push(sc.sql);
      args.push(...sc.args);
    }
    if (query.kind) {
      where.push('kind = ?');
      args.push(query.kind);
    }
    if (!query.includeArchived) where.push("status <> 'archived'");
    if (!query.includeHistorical) {
      where.push("status = 'active'");
      where.push('(valid_to IS NULL OR valid_to > ?)');
      where.push('(expires_at IS NULL OR expires_at > ?)');
      args.push(now, now);
    } else {
      where.push("status <> 'archived' OR status = 'archived'");
    }
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const sql = `SELECT ${SELECT_COLS} FROM memory_items ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as MemoryRow[];
    return rows.map(rowToItem);
  }

  search(query: MemoryQuery): MemoryHit[] {
    if (query.principal && query.principal.kind === 'verifier') return [];
    const terms = queryTerms(query.text ?? '');
    if (terms.length === 0) return [];
    const now = Date.now();
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.includeArchived) {
      where.push("status IN ('active', 'superseded', 'archived')");
    } else if (query.includeHistorical) {
      where.push("status IN ('active', 'superseded')");
    } else {
      where.push("status = 'active'", '(valid_to IS NULL OR valid_to > ?)', '(expires_at IS NULL OR expires_at > ?)');
      args.push(now, now);
    }
    if (query.scope) {
      const sc = scopeClause(query.scope);
      where.push(sc.sql);
      args.push(...sc.args);
    }
    if (query.kind) {
      where.push('kind = ?');
      args.push(query.kind);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
    // FTS5 trigram 只对 ≥3 字查询有效；更短的词仍走 LIKE（不假装 FTS 能召回 2 字中文）。
    const useFts = terms.every((t) => t.length >= 3) && this.ftsAvailable();
    let rows: MemoryRow[];
    if (useFts) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      try {
        rows = this.db
          .prepare(
            `SELECT ${SELECT_COLS} FROM memory_items WHERE id IN (SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH ?) AND ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
          )
          .all(match, ...args, limit) as MemoryRow[];
      } catch {
        // FTS 表/查询异常 → 本实例降级 LIKE；不静默返回空。
        this.ftsAvailableCache = false;
        const like = `%${terms[0]}%`;
        rows = this.db
          .prepare(
            `SELECT ${SELECT_COLS} FROM memory_items WHERE ${where.join(' AND ')} AND (value LIKE ? OR key LIKE ? OR source_excerpt LIKE ?) ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
          )
          .all(...args, like, like, like, limit) as MemoryRow[];
      }
    } else {
      const like = `%${terms[0]}%`;
      rows = this.db
        .prepare(
          `SELECT ${SELECT_COLS} FROM memory_items WHERE ${where.join(' AND ')} AND (value LIKE ? OR key LIKE ? OR source_excerpt LIKE ?) ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
        )
        .all(...args, like, like, like, limit) as MemoryRow[];
    }
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      const item = rowToItem(row);
      const hay = `${item.key ?? ''}\n${item.value}\n${item.source.excerpt ?? ''}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const matches = terms.filter((t) => hay.includes(t)).length;
      hits.push({
        item,
        score: matches * 10 + (item.pinned ? 5 : 0) + (item.confidence === 'confirmed' ? 2 : 0),
        snippet: item.value.length > 160 ? `${item.value.slice(0, 159)}…` : item.value,
      });
    }
    return hits.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt).slice(0, limit);
  }

  brief(input: BriefInput): MemoryBrief {
    const totalBudget = input.budgetTokens ?? MEMORY_BUDGETS.total;
    if (input.principal.kind === 'verifier') return { sections: [], totalTokens: 0, truncated: false };
    const sections: MemoryBriefSection[] = [];

    const globalItems = this.list({ scope: { type: 'global' }, includeHistorical: false, limit: 100 }).filter((it) =>
      canPrincipalSee(input.principal, it.scope),
    );
    sections.push(this.section('global', globalItems, MEMORY_BUDGETS.global));

    if (input.projectId != null && input.projectId > 0) {
      const projectItems = this.list({ scope: { type: 'project', projectId: input.projectId }, includeHistorical: false, limit: 100 }).filter(
        (it) => canPrincipalSee(input.principal, it.scope),
      );
      sections.push(this.section('project', projectItems, MEMORY_BUDGETS.project));
    }

    if (input.text && input.text.trim().length > 0) {
      const scope: MemoryScope | undefined = input.projectId != null && input.projectId > 0
        ? { type: 'project', projectId: input.projectId }
        : { type: 'global' };
      const hits = this.search({ scope, principal: input.principal, text: input.text, limit: 3 });
      const seen = new Set([...globalItems, ...sections.flatMap((s) => s.items)].map((it) => it.id));
      const items = hits.map((h) => h.item).filter((it) => !seen.has(it.id));
      sections.push(this.section('retrieval', items, MEMORY_BUDGETS.retrieval));
    }

    if (input.taskMemory && input.taskMemory.trim().length > 0) {
      const text = trimToTokens(input.taskMemory.trim(), MEMORY_BUDGETS.task);
      sections.push({ name: 'task', items: [], text, tokens: estimateTokens(text), dropped: [] });
    }

    // 总预算：按 T0→T3 顺序保留；超了从最后一节开始丢。
    let total = sections.reduce((n, s) => n + s.tokens, 0);
    let truncated = sections.some((s) => s.dropped.length > 0);
    for (let i = sections.length - 1; i >= 0 && total > totalBudget; i -= 1) {
      const section = sections[i];
      while (section.items.length > 0 && total > totalBudget) {
        // 从末尾找第一条非 pinned；pinned 绝不因总预算被丢。
        let removeAt = -1;
        for (let j = section.items.length - 1; j >= 0; j -= 1) {
          if (!section.items[j]!.pinned) {
            removeAt = j;
            break;
          }
        }
        if (removeAt < 0) break;
        const [removed] = section.items.splice(removeAt, 1);
        if (!removed) break;
        section.dropped.push(removed);
        section.tokens = section.items.reduce((n, it) => n + estimateTokens(renderItem(it)), 0);
        section.text = section.items.map(renderItem).join('\n');
        total = sections.reduce((n, s) => n + s.tokens, 0);
        truncated = true;
      }
      if (section.items.length === 0 && section.name !== 'task') {
        section.text = '';
        section.tokens = 0;
        total = sections.reduce((n, s) => n + s.tokens, 0);
      }
    }

    return { sections: sections.filter((s) => s.text.trim().length > 0), totalTokens: total, truncated };
  }

  audit(scope?: MemoryScope): MemoryAudit {
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM memory_items ${scope ? 'WHERE scope_type = ? AND scope_id = ?' : ''} ORDER BY id`)
      .all(...(scope ? scopeClause(scope).args : [])) as MemoryRow[];
    const items = rows.map(rowToItem);
    const active = items.filter((it) => it.status === 'active');
    const byKey = new Map<string, MemoryItem[]>();
    for (const it of active) {
      if (it.key == null) continue;
      const k = `${it.scope.type}:${it.scope.type === 'project' ? it.scope.projectId : 0}:${it.kind}:${it.key}`;
      const arr = byKey.get(k) ?? [];
      arr.push(it);
      byKey.set(k, arr);
    }
    const conflicts = [...byKey.values()].filter((arr) => arr.length > 1).flat();
    const seen = new Set<string>();
    const duplicates: MemoryItem[] = [];
    for (const it of active) {
      const sig = `${it.scope.type}:${it.scope.type === 'project' ? it.scope.projectId : 0}:${it.kind}:${it.key ?? ''}:${it.value.trim().toLowerCase()}`;
      if (seen.has(sig)) duplicates.push(it);
      seen.add(sig);
    }
    return {
      scope: scope ?? null,
      total: items.length,
      active: active.length,
      duplicates,
      conflicts,
      stale: active.filter((it) => (it.expiresAt != null && it.expiresAt <= now) || (it.validTo != null && it.validTo <= now)),
      oversize: items.filter((it) => it.value.length > MAX_VALUE_CHARS),
      missingSource: items.filter((it) => it.source.ref == null || it.source.ref.trim().length === 0),
      tokens: items.reduce((n, it) => n + estimateTokens(renderItem(it)), 0),
    };
  }

  promote(id: number, to: MemoryScope, confirmation: Confirmation): MemoryItem {
    if (confirmation.by !== 'boss' || confirmation.confirmed !== true) {
      throw new Error('[memory] 提升为全局/项目事实需要老板显式确认');
    }
    const source = this.get(id);
    if (!source) throw new Error(`[memory] 条目不存在: ${id}`);
    if (sameScope(source.scope, to)) return source;
    const promoted = this.remember({
      scope: to,
      kind: source.kind,
      key: source.key,
      value: source.value,
      source: { type: 'boss', ref: `memory:${source.id}`, excerpt: source.source.excerpt ?? null },
      confidence: 'confirmed',
      pinned: source.pinned,
      now: confirmation.at ?? Date.now(),
    });
    this.event(promoted.id, 'promote', { type: 'boss', ref: `memory:${source.id}` }, null, { from: source.scope, to }, Date.now());
    return promoted;
  }

  private findActiveByKey(
    scopeType: 'global' | 'project',
    scopeId: number,
    kind: MemoryItem['kind'],
    key: string,
  ): MemoryRow | undefined {
    return this.db
      .prepare(`SELECT ${SELECT_COLS} FROM memory_items WHERE scope_type = ? AND scope_id = ? AND kind = ? AND key = ? AND status = 'active' LIMIT 1`)
      .get(scopeType, scopeId, kind, key) as MemoryRow | undefined;
  }

  private insertItem(input: {
    scopeType: 'global' | 'project';
    scopeId: number;
    kind: MemoryItem['kind'];
    key: string | null;
    value: string;
    source: SourceRef;
    sourceExcerpt: string | null;
    confidence: MemoryItem['confidence'];
    pinned: boolean;
    validFrom: number | null;
    validTo: number | null;
    expiresAt: number | null;
    now: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO memory_items(scope_type, scope_id, kind, key, value, source_type, source_ref, source_excerpt,
           confidence, status, pinned, valid_from, valid_to, created_at, updated_at, expires_at, last_verified_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scopeType,
        input.scopeId,
        input.kind,
        input.key,
        input.value,
        input.source.type,
        input.source.ref ?? null,
        input.sourceExcerpt,
        input.confidence,
        input.pinned ? 1 : 0,
        input.validFrom,
        input.validTo,
        input.now,
        input.now,
        input.expiresAt,
        input.confidence === 'confirmed' ? input.now : null,
      );
    return Number(result.lastInsertRowid);
  }

  private section(name: MemoryBriefSection['name'], items: MemoryItem[], budget: number): MemoryBriefSection {
    const { picked, dropped, tokens } = pickByBudget(items, budget);
    return { name, items: picked, text: picked.map(renderItem).join('\n'), tokens, dropped };
  }

  private event(
    itemId: number | null,
    action: string,
    source: SourceRef,
    before: unknown,
    after: unknown,
    now: number,
  ): void {
    this.db
      .prepare('INSERT INTO memory_events(item_id, action, actor, source_type, source_ref, before_json, after_json, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        itemId,
        action,
        source.type,
        source.type,
        source.ref ?? null,
        redactEvent(before),
        redactEvent(after),
        now,
      );
  }
}

/** 粗略按 token 截断（用于 L1 摘要进入 T3；不破坏 JSON/指令）。 */
function trimToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let out = '';
  for (const ch of text) {
    if (estimateTokens(out + ch) > budget) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}
