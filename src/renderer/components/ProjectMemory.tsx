/**
 * B-6· 项目概览「项目记忆」容器：`memory:manage` ↔ 纯视图。
 * 口径：老板显式写；项目作用域；pin/忘记（软归档）/提升全局；空态不伪装。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { getApi } from '../api.js';
import type { MemoryAuditDTO, MemoryHitDTO, MemoryItemDTO } from '../types.js';
import { ProjectMemoryView } from './ProjectMemoryView.js';

type MemoryResponse =
  | { ok: true; action: 'list'; items?: MemoryItemDTO[] }
  | { ok: true; action: 'remember' | 'update' | 'promote'; item?: MemoryItemDTO }
  | { ok: true; action: 'forget'; id?: number }
  | { ok: true; action: 'search'; hits?: MemoryHitDTO[] }
  | { ok: true; action: 'audit'; audit?: MemoryAuditDTO }
  | { ok: false; code?: string; message?: string }
  | undefined;

function errorOf(res: MemoryResponse, fallback: string): string {
  return res && res.ok === false ? (res.message ?? res.code ?? fallback) : fallback;
}

export function ProjectMemory({ projectId }: { projectId: number | null }): ReactElement {
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [items, setItems] = useState<MemoryItemDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<MemoryItemDTO['kind']>('fact');
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [mode, setMode] = useState<'list' | 'search' | 'audit'>('list');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHitDTO[] | undefined>(undefined);
  const [audit, setAudit] = useState<MemoryAuditDTO | null>(null);
  const [searching, setSearching] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  /** 防切项目竞态：旧项目的 list 响应晚到不得覆盖新项目。 */
  const loadSeq = useRef(0);

  const load = async (targetScope: 'project' | 'global' = scope): Promise<void> => {
    const seq = ++loadSeq.current;
    if (targetScope === 'project' && projectId == null) {
      setItems([]);
      setLoading(false);
      return;
    }
    const api = getApi();
    if (!api?.memory?.manage) {
      setItems([]);
      setError('记忆通道不可用（主进程未连接）');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = (await api.memory.manage(
        targetScope === 'global'
          ? { action: 'list', scope: 'global' }
          : { action: 'list', scope: 'project', projectId },
      )) as MemoryResponse;
      if (seq !== loadSeq.current) return;
      if (res && res.ok === true && res.action === 'list') {
        setItems(Array.isArray(res.items) ? res.items : []);
      } else {
        setItems([]);
        setError(errorOf(res, targetScope === 'global' ? '读取全局记忆失败' : '读取项目记忆失败'));
      }
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    // 切项目/切作用域：草稿/回执不跨上下文；旧请求由 loadSeq 丢弃。
    setDraft('');
    setNotice(null);
    setError(null);
    setQuery('');
    setHits(undefined);
    setAudit(null);
    void load(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope]);

  const remember = async (): Promise<void> => {
    if ((scope === 'project' && projectId == null) || busy || draft.trim().length === 0) return;
    const api = getApi();
    if (!api?.memory?.manage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = (await api.memory.manage(
        scope === 'global'
          ? { action: 'remember', scope: 'global', value: draft.trim(), kind }
          : { action: 'remember', scope: 'project', projectId, value: draft.trim(), kind },
      )) as MemoryResponse;
      if (res && res.ok === true && res.action === 'remember') {
        setDraft('');
        setNotice(res.item ? `已记住${scope === 'global' ? '全局' : ''} #${res.item.id}` : '已记住');
        await load(scope);
      } else {
        setError(errorOf(res, '写入记忆失败'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    item: MemoryItemDTO,
    action: 'update' | 'forget' | 'promote',
    doneText: string,
  ): Promise<void> => {
    if ((scope === 'project' && projectId == null) || actingId != null) return;
    const api = getApi();
    if (!api?.memory?.manage) return;
    setActingId(item.id);
    setError(null);
    setNotice(null);
    try {
      const payload =
        action === 'update'
          ? { action, id: item.id, patch: { pinned: !item.pinned } }
          : action === 'forget'
            ? { action, id: item.id, mode: 'archive' }
            : { action, id: item.id, to: 'global' };
      const res = (await api.memory.manage(payload)) as MemoryResponse;
      if (res && res.ok === true) {
        setNotice(doneText);
        await load(scope);
      } else {
        setError(errorOf(res, `${doneText}失败`));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  };

  const search = async (): Promise<void> => {
    if ((scope === 'project' && projectId == null) || searching || query.trim().length === 0) return;
    const api = getApi();
    if (!api?.memory?.manage) return;
    setSearching(true);
    setError(null);
    setHits(undefined);
    try {
      const res = (await api.memory.manage({
        action: 'search',
        ...(scope === 'global' ? { scope: 'global' } : { scope: 'project', projectId }),
        text: query.trim(),
        limit: 20,
      })) as MemoryResponse;
      if (res && res.ok === true && res.action === 'search') {
        setHits(Array.isArray(res.hits) ? res.hits : []);
      } else {
        setError(errorOf(res, '搜索记忆失败'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const loadAudit = async (): Promise<void> => {
    if ((scope === 'project' && projectId == null) || auditLoading) return;
    const api = getApi();
    if (!api?.memory?.manage) return;
    setAuditLoading(true);
    setError(null);
    try {
      const res = (await api.memory.manage({
        action: 'audit',
        ...(scope === 'global' ? { scope: 'global' } : { scope: 'project', projectId }),
      })) as MemoryResponse;
      if (res && res.ok === true && res.action === 'audit' && res.audit) {
        setAudit(res.audit);
      } else {
        setError(errorOf(res, '读取记忆审计失败'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditLoading(false);
    }
  };

  return (
    <ProjectMemoryView
      projectId={projectId}
      scope={scope}
      items={items}
      loading={loading}
      error={error}
      notice={notice}
      draft={draft}
      kind={kind}
      busy={busy}
      actingId={actingId}
      onScopeChange={setScope}
      onDraftChange={setDraft}
      onKindChange={setKind}
      onRemember={() => void remember()}
      mode={mode}
      query={query}
      hits={hits}
      audit={audit}
      searching={searching}
      auditLoading={auditLoading}
      onModeChange={setMode}
      onQueryChange={setQuery}
      onSearch={() => void search()}
      onLoadAudit={() => void loadAudit()}
      onTogglePin={(item) => void act(item, 'update', item.pinned ? `已取消置顶 #${item.id}` : `已置顶 #${item.id}`)}
      onForget={(item) => void act(item, 'forget', `已忘记 #${item.id}`)}
      onPromote={(item) => void act(item, 'promote', `已提升 #${item.id} 为全局`)}
      onRefresh={() => void load(scope)}
    />
  );
}
