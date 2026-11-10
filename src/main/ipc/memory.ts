/**
 * B-6· 记忆 `P1b` 的 IPC 写入口（`memory:manage`）。
 *
 * 口径（`` / `` ⑤）：
 *  - 只做老板显式写：`remember/update/pin/forget/promote`；不做自动写、向量检索、跨项目读取；
 *  - `search/audit` 为**内部动作**（F-4 P-04）：保留给频道检索/未来诊断， 不提供独立 UI；
 *  - 作用域显式：`global` 或 `project:<id>`；项目必须存在；不猜当前项目；
 *  - 全局事实只由老板写（本通道就是老板 UI/命令）；提升需 `{by:'boss', confirmed:true}`；
 *  - 检索复用 `MemoryPort.search`（当前 LIKE/词项排序，不冒充 FTS5）；
 *  - 冲突不静默覆盖：`MemoryConflictError` → `conflict` ＋ existing 条目。
 */
import type { ChatRepo } from './ports.js';
import type { SqliteDb } from '../db/open.js';
import {
  MemoryConflictError,
  SqliteMemoryStore,
  type MemoryAudit,
  type MemoryHit,
  type MemoryItem,
  type MemoryKind,
  type MemoryPatch,
  type MemoryScope,
} from '../memory/index.js';

export interface MemoryHandlerDeps {
  repo: ChatRepo;
  db?: SqliteDb;
}

export type MemoryManageResult =
  | { ok: true; action: 'list'; items: MemoryItem[] }
  | { ok: true; action: 'remember' | 'update' | 'promote'; item: MemoryItem }
  | { ok: true; action: 'forget'; id: number; mode: 'archive' | 'delete' }
  | { ok: true; action: 'search'; hits: MemoryHit[] }
  | { ok: true; action: 'audit'; audit: MemoryAudit }
  | { ok: false; code: string; message: string; existing?: MemoryItem };

const KINDS: readonly MemoryKind[] = ['fact', 'decision', 'preference', 'glossary', 'constraint'];

function bad(message: string, code = 'bad_request'): MemoryManageResult {
  return { ok: false, code, message };
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseScope(deps: MemoryHandlerDeps, input: Record<string, unknown>): { ok: true; scope: MemoryScope } | { ok: false; message: string; code?: string } {
  if (input.scope === 'global') return { ok: true, scope: { type: 'global' } };
  if (input.scope !== 'project') return { ok: false, message: 'scope 需为 global 或 project' };
  const projectId = readPositiveInt(input.projectId);
  if (projectId == null) return { ok: false, message: 'project scope 需要 projectId' };
  if (!deps.repo.getProject(projectId)) return { ok: false, message: `项目不存在：${projectId}`, code: 'not_found' };
  return { ok: true, scope: { type: 'project', projectId } };
}

function parseKind(value: unknown): MemoryKind | null {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : null;
}

function parsePatch(input: Record<string, unknown>): { ok: true; patch: MemoryPatch } | { ok: false; message: string } {
  const patch: MemoryPatch = {};
  if (input.value !== undefined) {
    if (typeof input.value !== 'string' || input.value.trim().length === 0) return { ok: false, message: 'value 需为非空字符串' };
    patch.value = input.value.trim();
  }
  if (input.key !== undefined) {
    if (input.key !== null && typeof input.key !== 'string') return { ok: false, message: 'key 需为字符串或 null' };
    patch.key = typeof input.key === 'string' && input.key.trim().length > 0 ? input.key.trim() : null;
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') return { ok: false, message: 'pinned 需为布尔' };
    patch.pinned = input.pinned;
  }
  if (input.confidence !== undefined) {
    if (input.confidence !== 'confirmed' && input.confidence !== 'provisional' && input.confidence !== 'inferred') {
      return { ok: false, message: 'confidence 需为 confirmed/provisional/inferred' };
    }
    patch.confidence = input.confidence;
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: 'patch 至少需要一个字段' };
  return { ok: true, patch };
}

/**
 * `memory:manage`：
 *  - `{action:'list', scope:'global'|'project', projectId?, includeArchived?}`
 *  - `{action:'remember', scope, projectId?, value, key?, kind?, pinned?}`
 *  - `{action:'update', id, patch:{value?,key?,pinned?,confidence?}}`
 *  - `{action:'forget', id, mode?:'archive'|'delete'}`（缺省 archive）
 *  - `{action:'promote', id, to:'global'|'project', projectId?}`
 *  - `{action:'search', scope, projectId?, text}`
 *  - `{action:'audit', scope?, projectId?}`
 */
export function handleMemoryManage(
  deps: MemoryHandlerDeps,
  raw: unknown,
  now: number = Date.now(),
): MemoryManageResult {
  if (!deps.db) return bad('记忆库不可用（主进程未装配 db）', 'not_ready');
  const input = (raw ?? {}) as Record<string, unknown>;
  const action = typeof input.action === 'string' ? input.action : '';
  const store = new SqliteMemoryStore(deps.db);

  try {
    if (action === 'list') {
      const parsed = parseScope(deps, input);
      if (!parsed.ok) return bad(parsed.message, parsed.code);
      const items = store.list({
        scope: parsed.scope,
        includeArchived: input.includeArchived === true,
        // 归档行同时是历史行：要看见归档必须放开历史过滤（store.list 的组合语义）。
        includeHistorical: input.includeHistorical === true || input.includeArchived === true,
        limit: typeof input.limit === 'number' ? input.limit : 100,
      });
      return { ok: true, action: 'list', items };
    }

    if (action === 'remember') {
      const parsed = parseScope(deps, input);
      if (!parsed.ok) return bad(parsed.message, parsed.code);
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (value.length === 0) return bad('value 不能为空');
      const kind = input.kind === undefined ? 'fact' : parseKind(input.kind);
      if (kind == null) return bad('kind 需为 fact/decision/preference/glossary/constraint');
      if (input.pinned !== undefined && typeof input.pinned !== 'boolean') return bad('pinned 需为布尔');
      const item = store.remember({
        scope: parsed.scope,
        kind,
        ...(typeof input.key === 'string' && input.key.trim().length > 0 ? { key: input.key.trim() } : {}),
        value,
        source: { type: 'boss', ref: typeof input.ref === 'string' ? input.ref : null, at: now },
        confidence: 'confirmed',
        pinned: input.pinned === true,
        now,
      });
      return { ok: true, action: 'remember', item };
    }

    if (action === 'update') {
      const id = readPositiveInt(input.id);
      if (id == null) return bad('id 需为正整数');
      const patchInput = (input.patch ?? {}) as Record<string, unknown>;
      const parsed = parsePatch(patchInput);
      if (!parsed.ok) return bad(parsed.message);
      const item = store.update(id, parsed.patch, { type: 'boss', ref: 'memory:update', at: now });
      return { ok: true, action: 'update', item };
    }

    if (action === 'forget') {
      const id = readPositiveInt(input.id);
      if (id == null) return bad('id 需为正整数');
      const mode = input.mode === undefined ? 'archive' : input.mode;
      if (mode !== 'archive' && mode !== 'delete') return bad('mode 需为 archive 或 delete');
      if (!store.get(id)) return bad(`记忆不存在：${id}`, 'not_found');
      store.forget(id, mode);
      return { ok: true, action: 'forget', id, mode };
    }

    if (action === 'promote') {
      const id = readPositiveInt(input.id);
      if (id == null) return bad('id 需为正整数');
      const target = parseScope(deps, { scope: input.to, projectId: input.projectId });
      if (!target.ok) return bad(target.message, target.code);
      const item = store.promote(id, target.scope, { by: 'boss', confirmed: true, at: now });
      return { ok: true, action: 'promote', item };
    }

    if (action === 'search') {
      const parsed = parseScope(deps, input);
      if (!parsed.ok) return bad(parsed.message, parsed.code);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length === 0) return bad('text 不能为空');
      const hits = store.search({
        scope: parsed.scope,
        text,
        limit: typeof input.limit === 'number' ? input.limit : 20,
      });
      return { ok: true, action: 'search', hits };
    }

    if (action === 'audit') {
      if (input.scope === undefined) return { ok: true, action: 'audit', audit: store.audit() };
      const parsed = parseScope(deps, input);
      if (!parsed.ok) return bad(parsed.message, parsed.code);
      return { ok: true, action: 'audit', audit: store.audit(parsed.scope) };
    }

    return bad(`未知 action：${action || '-'}`);
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      return { ok: false, code: 'conflict', message: error.message, existing: error.existing };
    }
    return bad(error instanceof Error ? error.message : String(error));
  }
}
