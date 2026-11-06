/**
 * K1 知识库 · 知识页（左栏「笔记」→ 中栏）。
 *
 * 一张列表看到所有知识：笔记（项目＋全局）＋项目文档＋任务产物。
 * 搜索实时过滤；点击展开查看/编辑（Milkdown 或只读渲染）。
 */
import { createElement, ReactElement, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSnapshot } from 'valtio';
import { notesStore, loadNotes, session } from '../store';
import { MilkdownEditor, type MilkdownApi } from './MilkdownEditor';
import { EDIT_CHUNK_MAX_CHARS, READ_FULL_MAX_CHARS, spliceChunk, splitMarkdownForRead } from './knowledgeChunks';
import { knowledgeItemKey, newNoteTarget, type NoteItem } from './knowledge-types.js';
import { SplitLayout } from './SplitLayout.js';

const TYPE_LABEL: Record<string, string> = { note: '笔记', doc: '文档', artifact: '产物', media: '媒体', text: '文本', file: '文件' };
// D3-3 类型重划（老板 2026-11-03）：媒体只收图/视频/音频；txt/csv 等归文本；pdf/office/html 归文档。
const FILTERS = ['全部', '笔记', '文档', '产物', '媒体', '文本', '文件'] as const;
const ICON_BY_TYPE: Record<string, string> = { note: '📝', doc: '📄', artifact: '📦', media: '🎬', text: '📋', file: '🗂️' };

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** IPC 异常 → 人话（2026-10-29）：EPERM/EACCES 说文件只读；其余去掉 Electron 的前缀噪声。 */
function noteErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/EPERM|EACCES/.test(raw)) return '文件只读或没有写入权限';
  if (/ENOSPC/.test(raw)) return '磁盘空间不足';
  if (/ENOENT/.test(raw)) return '文件或目录不存在';
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export function KnowledgePage(): ReactElement {
  const notesSnap = useSnapshot(notesStore);
  const sessionSnap = useSnapshot(session);
  // 2026-11-03 Phase A：默认跟随频道范围（当前项目＋全局）；可切全部/仅全局。
  const [scope, setScope] = useState<'project' | 'all' | 'global'>('project');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<NoteItem | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editName, setEditName] = useState('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [message, setMessage] = useState('');
  // Phase B：媒体/附件预览（图片/PDF/视频/音频/HTML 沙箱/文本）。
  type MediaPreview = {
    kind: string; name: string; ext: string; size: number;
    url?: string; text?: string; truncated?: boolean; message?: string;
  };
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const previewReqRef = useRef(0);
  // Phase C：正文搜索（后端前 8KB）与多选批量。
  const [bodyHitPaths, setBodyHitPaths] = useState<Set<string>>(new Set());
  const [bodySearching, setBodySearching] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // S13-B 遗留：超大笔记分章（默认第 1 章；换笔记回第 1 章）。
  const [readChunk, setReadChunk] = useState(0);
  // 2026-10-29 性能：编辑态不逐键把全文回传（避免 Crepe 每键 serialize）；保存时读一次。
  const editApiRef = useRef<MilkdownApi | null>(null);
  // 分章编辑：>40KB 的笔记一次只编辑一章，保存时无损拼回全文。
  const [editChunk, setEditChunk] = useState(0);

  useEffect(() => {
    setReadChunk(0);
    setEditChunk(0);
  }, [selected == null ? '' : knowledgeItemKey(selected)]);

  useEffect(() => {
    void loadNotes();
  }, []);

  // Phase C：正文搜索——列表先按名称/首行即时过滤，250ms 后再补主进程的正文命中（前 8KB）。
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setBodyHitPaths(new Set());
      setBodySearching(false);
      return;
    }
    let cancelled = false;
    // 新查询立即清掉上一轮正文命中，避免旧结果在 250ms 防抖窗口里残留。
    setBodyHitPaths(new Set());
    setBodySearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = (await window.api?.notes?.search({ query: q })) as
            | Array<{ path?: string }>
            | undefined;
          if (cancelled) return;
          setBodyHitPaths(new Set((hits ?? []).map((h) => h.path).filter((p): p is string => typeof p === 'string')));
        } catch {
          if (!cancelled) setBodyHitPaths(new Set());
        } finally {
          if (!cancelled) setBodySearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // P2-3：范围/筛选/搜索变化时清空选择，避免批量删除到当前看不见的条目。
  useEffect(() => {
    setSelection(new Set());
  }, [scope, filter, query]);

  // S13-C（老板真机交互走查）：新建笔记弹层要能用 Esc 关闭（与建任务弹层一致）。
  useEffect(() => {
    if (!creating) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCreating(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [creating]);

  const items = (notesSnap.list as unknown as NoteItem[]) ?? [];
  const scopeProjectId = sessionSnap.selectedProjectId ?? null;
  const scoped = items.filter((item) => {
    if (scope === 'all') return true;
    if (scope === 'global') return item.projectId == null;
    // 跟随频道范围：当前项目＋全局（无选中项目时只剩全局）。
    return item.projectId == null || (scopeProjectId != null && item.projectId === scopeProjectId);
  });
  const filtered = scoped.filter((item) => {
    if (filter !== '全部' && TYPE_LABEL[item.type] !== filter) return false;
    if (query.length > 0) {
      const q = query.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.preview.toLowerCase().includes(q) ||
        bodyHitPaths.has(item.path)
      );
    }
    return true;
  });
  // Phase A：按项目分组（全局第一组），组内保持后端的时间序。
  const grouped: Array<{ key: string; label: string; items: NoteItem[] }> = [];
  {
    const map = new Map<string, { key: string; label: string; items: NoteItem[] }>();
    for (const item of filtered) {
      const key = item.projectId == null ? 'global' : String(item.projectId);
      const label = item.projectId == null ? '全局' : (item.projectName ?? `项目 #${item.projectId}`);
      const group = map.get(key) ?? { key, label, items: [] };
      group.items.push(item);
      map.set(key, group);
    }
    grouped.push(...[...map.values()].sort((a, b) => (a.key === 'global' ? -1 : b.key === 'global' ? 1 : a.label.localeCompare(b.label, 'zh'))));
  }

  const selectedItems = items.filter((item) => selection.has(knowledgeItemKey(item)));

  const toggleSelection = useCallback((key: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const selectAllFiltered = useCallback(() => {
    setSelection(new Set(filtered.map((item) => knowledgeItemKey(item))));
  }, [filtered]);

  const handleBulkReveal = useCallback(async () => {
    if (selectedItems.length === 0) return;
    let ok = 0;
    const failures: string[] = [];
    for (const item of selectedItems) {
      try {
        const result = (await window.api?.notes?.preview({
          projectId: item.projectId,
          path: item.path,
          mode: 'reveal',
        })) as { ok: true } | { ok: false; message: string } | undefined;
        if (result != null && !result.ok) failures.push(`${item.name}：${result.message}`);
        else ok += 1;
      } catch (error) {
        failures.push(`${item.name}：${noteErrorText(error)}`);
      }
    }
    setMessage(failures.length === 0 ? `已在文件夹中显示 ${ok} 项` : `已在文件夹中显示 ${ok} 项；失败 ${failures.length} 项：${failures.join('；')}`);
  }, [selectedItems]);

  const handleBulkDelete = useCallback(async () => {
    const notes = selectedItems.filter((item) => item.type === 'note');
    if (notes.length === 0) {
      setMessage('选中的项目里没有可批量删除的笔记（文档/产物/媒体请在文件管理器处理）');
      return;
    }
    const skipped = selectedItems.length - notes.length;
    if (!confirm(`确定删除选中的 ${notes.length} 篇笔记？${skipped > 0 ? `（另有 ${skipped} 项不是笔记，将被跳过）` : ''}`)) return;
    let ok = 0;
    const failures: string[] = [];
    for (const item of notes) {
      try {
        const result = (await window.api?.notes?.delete({ projectId: item.projectId, name: item.name })) as
          | { ok: true }
          | { ok: false; error: string }
          | undefined;
        if (result?.ok) ok += 1;
        else failures.push(`${item.name}：${(result as { error?: string } | undefined)?.error ?? '主进程未返回结果'}`);
      } catch (error) {
        failures.push(`${item.name}：${noteErrorText(error)}`);
      }
    }
    if (selected != null && notes.some((item) => knowledgeItemKey(item) === knowledgeItemKey(selected))) setSelected(null);
    setSelection(new Set());
    void loadNotes();
    setMessage(
      failures.length === 0
        ? `已删除 ${ok} 篇笔记${skipped > 0 ? `（跳过 ${skipped} 项非笔记）` : ''}`
        : `已删除 ${ok} 篇${skipped > 0 ? `（跳过 ${skipped} 项非笔记）` : ''}；失败 ${failures.length} 篇：${failures.join('；')}`,
    );
  }, [selectedItems, selected]);

  const openItem = useCallback(async (item: NoteItem) => {
    setSelected(item);
    setEditing(false);
    setMessage('');
    setMediaPreview(null);
    setMediaError('');
    setMediaLoading(false);
    if (item.type === 'note') {
      // 笔记：notes 目录内的 .md，按名字走 notes:read（可编辑）。
      const result = (await window.api?.notes?.read({ projectId: item.projectId, name: item.name })) as
        | { ok: true; content: string }
        | { ok: false; error: string };
      if (result?.ok) {
        setEditContent(result.content);
        setEditName(item.name);
      } else {
        setEditContent(`（读取失败：${(result as { error: string })?.error ?? '未知'}）`);
      }
      return;
    }
    // 非 note：一律按自身路径走 notes:preview（P1-3：不能拿 name 去 notes 目录找）。
    setEditContent('');
    setEditName(item.name);
    const isMd = /\.md$/i.test(item.path);
    const req = ++previewReqRef.current;
    setMediaLoading(true);
    try {
      const result = (await window.api?.notes?.preview({ projectId: item.projectId, path: item.path })) as
        | ({ ok: true; mode: 'read' } & MediaPreview)
        | { ok: false; message: string }
        | undefined;
      if (req !== previewReqRef.current) return;
      if (!result?.ok || result.mode !== 'read') {
        setMediaError((result as { message?: string } | undefined)?.message ?? '预览不可用');
      } else if (result.kind === 'text' && isMd) {
        // md 文档/根目录 md：内容进只读渲染（Milkdown，不显示源码）；编辑只留给笔记。
        setEditContent(result.text ?? '');
      } else {
        // 媒体/文本/文件/文档类（图·视·音·PDF·HTML·txt·Office…）→ 预览面板。
        setMediaPreview(result);
      }
    } catch (error) {
      if (req === previewReqRef.current) setMediaError(noteErrorText(error));
    } finally {
      if (req === previewReqRef.current) setMediaLoading(false);
    }
  }, []);

  // 编辑分章（2026-10-29）：>40KB 整篇编辑打字 p90 超过 30ms，改为一章一章编辑；
  // 保存只写回本章，其余字节原样。
  const editChunks = useMemo(
    () => (editContent.length > EDIT_CHUNK_MAX_CHARS ? splitMarkdownForRead(editContent, EDIT_CHUNK_MAX_CHARS) : null),
    [editContent],
  );
  const editChunkIndex = editChunks == null ? 0 : Math.min(editChunk, editChunks.length - 1);
  const dirty = (): boolean => {
    if (!editing) return false;
    const now = editApiRef.current?.getMarkdown();
    if (now == null) return false;
    // 2026-11-06（终验 g3 带回 / D4 复核修）：优先和**编辑器自己的规范化基线**比——初值回吐
    // （尾部换行/列表符号）不算用户修改。拿磁盘原文比会误报；而用 trim 兜底又会把
    // 「首行缩进改 4 空格」（Markdown 变代码块）当成没改而静默丢弃。
    const base =
      editApiRef.current?.getBaseline?.() ??
      ((editChunks == null ? editContent : editChunks[editChunkIndex]!.text) ?? '');
    if (now === base) return false;
    // 兜底只忽略**尾部**空白差异（Crepe 规范化最常见的一类）；首部空白是用户可见编辑，必须算。
    return now.replace(/[ \t\r\n]+$/, '') !== base.replace(/[ \t\r\n]+$/, '');
  };

  const handleSave = useCallback(async () => {
    if (selected == null) return;
    const edited = editApiRef.current?.getMarkdown() ?? editContent;
    const nextContent =
      editChunks != null ? spliceChunk(editContent, editChunks, editChunkIndex, edited) : edited;
    try {
      const result = (await window.api?.notes?.write({ projectId: selected.projectId, name: editName, content: nextContent })) as
        | { ok: true }
        | { ok: false; error: string }
        | undefined;
      if (result?.ok) {
        setEditContent(nextContent);
        setMessage(editChunks != null ? '已保存本章' : '已保存');
        // 分章编辑：保存后留在编辑态继续下一章；整篇编辑：保存即退出（原行为）。
        if (editChunks == null) setEditing(false);
        void loadNotes();
      } else {
        setMessage(`保存失败：${(result as { error?: string } | undefined)?.error ?? '主进程未返回结果'}`);
      }
    } catch (error) {
      // 2026-10-29：writeFileSync 失败（只读/磁盘满/权限）此前抛到 IPC 层、界面零反馈——
      // 老板会以为已保存。失败必须可见，且保持编辑态不丢输入。
      setMessage(`保存失败：${noteErrorText(error)}`);
    }
  }, [selected, editName, editContent, editChunks, editChunkIndex]);

  /** 进入/退出编辑：退出时若有未保存修改，明确确认（不静默丢弃）。 */
  const toggleEditing = useCallback(() => {
    if (!editing) {
      setEditChunk(0);
      setEditing(true);
      return;
    }
    if (dirty() && !confirm('本章有未保存的修改，退出将丢弃。继续？')) return;
    setEditing(false);
  }, [editing, editContent, editChunks, editChunkIndex]);

  const switchEditChunk = useCallback((next: number) => {
    if (editChunks == null) return;
    const target = Math.min(Math.max(next, 0), editChunks.length - 1);
    if (target === editChunkIndex) return;
    if (dirty() && !confirm('本章有未保存的修改，切换将丢弃。继续？')) return;
    setEditChunk(target);
  }, [editChunks, editChunkIndex, editContent]);

  const handleDelete = useCallback(async () => {
    if (selected == null) return;
    if (!confirm(`确定删除「${selected.name}」？`)) return;
    try {
      const result = (await window.api?.notes?.delete({ projectId: selected.projectId, name: selected.name })) as
        | { ok: true }
        | { ok: false; error: string }
        | undefined;
      if (result?.ok) {
        setSelected(null);
        void loadNotes();
      } else {
        setMessage(`删除失败：${(result as { error?: string } | undefined)?.error ?? '主进程未返回结果'}`);
      }
    } catch (error) {
      setMessage(`删除失败：${noteErrorText(error)}`);
    }
  }, [selected]);

  const handlePromote = useCallback(async () => {
    if (selected == null || selected.projectId == null) return;
    if (!confirm(`将「${selected.name}」升级为项目文档？（文件从笔记移到 .aico/docs/）`)) return;
    try {
      const result = (await window.api?.notes?.promote({ projectId: selected.projectId, name: selected.name })) as
        | { ok: true }
        | { ok: false; error: string }
        | undefined;
      if (result?.ok) {
        setMessage('已升级为文档');
        setSelected(null);
        void loadNotes();
      } else {
        setMessage(`升级失败：${(result as { error?: string } | undefined)?.error ?? '主进程未返回结果'}`);
      }
    } catch (error) {
      setMessage(`升级失败：${noteErrorText(error)}`);
    }
  }, [selected]);

  const handleMediaOpen = useCallback(async (mode: 'open' | 'reveal') => {
    if (selected == null) return;
    try {
      const result = (await window.api?.notes?.preview({
        projectId: selected.projectId,
        path: selected.path,
        mode,
      })) as { ok: true } | { ok: false; message: string } | undefined;
      if (result != null && !result.ok) setMessage(`${mode === 'open' ? '系统打开' : '在文件夹中显示'}失败：${result.message}`);
    } catch (error) {
      setMessage(`${mode === 'open' ? '系统打开' : '在文件夹中显示'}失败：${noteErrorText(error)}`);
    }
  }, [selected]);

  const handleCreate = useCallback(async () => {
    if (newName.trim().length === 0) return;
    // RW-18（老板 2026-10-28 裁 A）：落点跟随当前范围（与助手 note_write 同语义）。
    const target = newNoteTarget(session.selectedProjectId);
    try {
      const result = (await window.api?.notes?.write({ projectId: target.projectId, name: newName.trim(), content: newContent })) as
        | { ok: true }
        | { ok: false; error: string }
        | undefined;
      if (result?.ok) {
        setCreating(false);
        setNewName('');
        setNewContent('');
        setMessage('已创建');
        void loadNotes();
      } else {
        setMessage(`创建失败：${(result as { error?: string } | undefined)?.error ?? '主进程未返回结果'}`);
      }
    } catch (error) {
      setMessage(`创建失败：${noteErrorText(error)}`);
    }
  }, [newName, newContent]);

  // 阅读分章：>200KB 才切；以下整篇渲染（保持原体验）。切分无损，拼接 === 原文。
  // 2026-10-29 性能：必须 memo——否则每次 render 都切出**新的字符串实例**，MilkdownEditor 的
  // value 同步 effect 每次都会 replaceAll 全文（1MB 笔记实测 60s 才出第一屏）。
  const readChunks = useMemo(
    () => (editContent.length > READ_FULL_MAX_CHARS ? splitMarkdownForRead(editContent) : null),
    [editContent],
  );
  const chunkIndex = readChunks == null ? 0 : Math.min(readChunk, readChunks.length - 1);
  return createElement('section', {
    'data-testid': 'knowledge-page',
    style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  },
    // 顶部：搜索＋筛选＋新建
    createElement('div', {
      'data-testid': 'knowledge-header',
      style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '12px 20px 8px', borderBottom: '.5px solid var(--separator)' },
    },
      createElement('input', {
        'data-testid': 'knowledge-search',
        type: 'search',
        placeholder: '搜索笔记 / 文档 / 产物 / 媒体（正文取前 8KB）…',
        value: query,
        onChange: (e: Event) => setQuery((e.target as HTMLInputElement).value),
        style: { flex: 1, fontSize: 13, padding: '4px 12px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-lg)', background: 'var(--panel)' },
      }),
      createElement('select', {
        'data-testid': 'knowledge-scope',
        value: scope,
        onChange: (e: Event) => setScope((e.target as HTMLSelectElement).value as 'project' | 'all' | 'global'),
        title: '查看范围',
        style: { fontSize: 12, padding: '3px 6px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'var(--panel)', color: 'var(--text)' },
      },
        createElement('option', { value: 'project' }, '当前项目'),
        createElement('option', { value: 'all' }, '全部项目'),
        createElement('option', { value: 'global' }, '仅全局'),
      ),
      createElement('div', { style: { display: 'flex', gap: 4 } },
        FILTERS.map((f) =>
          createElement('button', {
            key: f,
            type: 'button',
            'data-testid': `knowledge-filter-${f}`,
            onClick: () => setFilter(f),
            style: {
              fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)',
              background: filter === f ? 'var(--tint-soft)' : 'transparent',
              color: filter === f ? 'var(--accent-ink)' : 'var(--text-dim)',
              cursor: 'pointer',
            },
          }, f),
        ),
      ),
      createElement('button', {
        type: 'button',
        'data-testid': 'knowledge-new',
        onClick: () => { setCreating(true); setNewName(''); setNewContent(''); },
        style: { fontSize: 12, padding: '4px 12px', border: '.5px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-strong)', color: 'var(--on-accent)', fontWeight: 500, cursor: 'pointer' },
      }, '＋ 新建笔记'),
    ),
    // Phase C：多选批量条（选中才出现；删除只对笔记开放，其它类型如实跳过）
    selectedItems.length > 0 ? createElement('div', {
      'data-testid': 'knowledge-bulk',
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: '.5px solid var(--separator)', background: 'var(--tint-soft)', fontSize: 12 },
    },
      createElement('span', { 'data-testid': 'knowledge-bulk-count', style: { flex: 1, color: 'var(--accent-ink)' } }, `已选 ${selectedItems.length} 项`),
      createElement('button', {
        type: 'button',
        'data-testid': 'knowledge-bulk-select-all',
        onClick: selectAllFiltered,
        style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer' },
      }, `全选当前 ${filtered.length} 项`),
      createElement('button', {
        type: 'button',
        'data-testid': 'knowledge-bulk-reveal',
        onClick: () => void handleBulkReveal(),
        style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer' },
      }, '在文件夹中显示'),
      createElement('button', {
        type: 'button',
        'data-testid': 'knowledge-bulk-delete',
        onClick: () => void handleBulkDelete(),
        style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--danger)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' },
      }, '删除笔记'),
      createElement('button', {
        type: 'button',
        'data-testid': 'knowledge-bulk-clear',
        onClick: clearSelection,
        style: { fontSize: 12, padding: '2px 8px', border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer' },
      }, '清除选择'),
    ) : null,
    // 消息行
    message.length > 0 ? createElement('p', {
      'data-testid': 'knowledge-message',
      style: { padding: '4px 20px', fontSize: 12, color: 'var(--accent-ink)', margin: 0 },
    }, message) : bodySearching ? createElement('p', {
      'data-testid': 'knowledge-body-searching',
      style: { padding: '4px 20px', fontSize: 12, color: 'var(--text-dim)', margin: 0 },
    }, '正在搜索正文…') : null,
    // 主体：列表＋详情
    // 2026-11-04 SplitLayout 接入（批次 4）：列表/详情分栏统一组件；未选中时 hideMain=列表独占（与旧行为一致）。
    createElement(SplitLayout, {
      sideWidth: 340,
      label: '列表',
      storageKey: 'notes',
      count: filtered.length,
      hideMain: selected == null,
      side:
      // 左列：列表
      createElement('div', {
        'data-testid': 'knowledge-list',
        style: { flex: selected ? '0 0 340px' : '1', overflowY: 'auto', borderRight: selected ? '.5px solid var(--separator)' : 'none', padding: '4px 0' },
      },
        notesSnap.loading && items.length === 0 ? createElement('p', {
          'data-testid': 'knowledge-loading',
          style: { padding: '20px', fontSize: 13, color: 'var(--text-dim)', textAlign: 'center' },
        }, '正在加载笔记…') :
        notesSnap.error != null && notesSnap.error.length > 0 ? createElement('div', {
          'data-testid': 'knowledge-load-error',
          role: 'alert',
          style: { padding: '16px', fontSize: 13, color: 'var(--danger)' },
        },
          createElement('p', { style: { margin: 0 } }, `笔记加载失败：${notesSnap.error}`),
          createElement('button', {
            type: 'button',
            'data-testid': 'knowledge-load-retry',
            onClick: () => void loadNotes(),
            style: { marginTop: 8, fontSize: 12, padding: '2px 10px', cursor: 'pointer' },
          }, '重试'),
        ) :
        filtered.length === 0 ? createElement('p', {
          'data-testid': 'knowledge-empty',
          style: { padding: '20px', fontSize: 13, color: 'var(--text-dim)', textAlign: 'center' },
        }, items.length === 0 ? '还没有笔记、文档或附件；点右上角「＋ 新建笔记」开始。' : '没有匹配的内容（换关键词或查看范围试试）') :
        grouped.flatMap((group) => [
          createElement('div', {
            key: `group-${group.key}`,
            'data-testid': 'knowledge-group',
            'data-project-id': group.key,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 4px', fontSize: 12, color: 'var(--text-dim)' },
          },
            createElement('strong', { style: { fontSize: 12, color: 'var(--text)' } }, group.label),
            createElement('span', null, `${group.items.length} 项`),
          ),
          ...group.items.map((item) =>
          createElement('div', {
            key: knowledgeItemKey(item),
            role: 'button',
            tabIndex: 0,
            'data-testid': 'knowledge-item',
            'data-type': item.type,
            onClick: () => void openItem(item),
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void openItem(item);
              }
            },
            style: {
              display: 'flex', alignItems: 'flex-start', gap: 12,
              width: 'calc(100% - 16px)', margin: '4px 8px',
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              background: selected != null && knowledgeItemKey(selected) === knowledgeItemKey(item) ? 'var(--tint-soft)' : 'var(--panel)',
              cursor: 'pointer',
              transition: 'border-color .15s',
            },
          },
            createElement('input', {
              type: 'checkbox',
              'data-testid': 'knowledge-item-select',
              'aria-label': `选择 ${item.name}`,
              checked: selection.has(knowledgeItemKey(item)),
              onClick: (e: Event) => e.stopPropagation(),
              onChange: () => toggleSelection(knowledgeItemKey(item)),
              style: { marginTop: 9, flexShrink: 0, cursor: 'pointer' },
            }),
            // 类型图标（不同类型不同颜色）
            createElement('span', {
              'data-testid': 'knowledge-item-icon',
              style: {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, flexShrink: 0,
                borderRadius: 'var(--radius-sm)',
                fontSize: 14,
                background:
                  item.type === 'note' || item.type === 'text' ? 'var(--tint-soft)'
                  : item.type === 'doc' ? 'rgba(52,199,89,.12)'
                  : item.type === 'file' ? 'rgba(127,127,127,.14)'
                  : 'rgba(255,159,10,.12)',
                color:
                  item.type === 'note' || item.type === 'text' ? 'var(--file-icon-note)'
                  : item.type === 'doc' ? 'var(--file-icon-doc)'
                  : item.type === 'file' ? 'var(--text-dim)'
                  : 'var(--file-icon-artifact)',
              },
            }, ICON_BY_TYPE[item.type] ?? '📦'),
            createElement('div', { style: { flex: 1, minWidth: 0 } },
              createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
                createElement('strong', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
                createElement('span', { style: { fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap', flexShrink: 0 } },
                  `${item.projectName ?? '全局'} · ${TYPE_LABEL[item.type]} · ${timeAgo(item.updatedAt)}`),
              ),
              createElement('p', { style: { fontSize: 12, color: 'var(--text-dim)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                item.preview || '（空）'),
            ),
          ),
        )]),
      ),
      main: selected ? createElement('div', {
        'data-testid': 'knowledge-detail',
        style: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      },
        createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '.5px solid var(--separator)' } },
          createElement('strong', { style: { fontSize: 14, flex: 1 } }, editName),
          selected.type === 'note' && selected.projectId != null ? createElement('button', {
            type: 'button', 'data-testid': 'knowledge-promote',
            onClick: () => void handlePromote(),
            style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer' },
          }, '升级为文档') : null,
          selected.type === 'note' ? createElement('button', {
            type: 'button', 'data-testid': 'knowledge-edit-toggle',
            onClick: () => toggleEditing(),
            style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer' },
          }, editing ? '取消' : '编辑') : null,
          editing ? createElement('button', {
            type: 'button', 'data-testid': 'knowledge-save',
            onClick: () => void handleSave(),
            style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-strong)', color: 'var(--on-accent)', fontWeight: 500, cursor: 'pointer' },
          }, '保存') : null,
          selected.type === 'note' ? createElement('button', {
            type: 'button', 'data-testid': 'knowledge-delete',
            onClick: () => void handleDelete(),
            style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--danger)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' },
          }, '删除') : null,
        ),
        selected.type !== 'note' && !/\.md$/i.test(selected.path)
          ? createElement('div', {
              'data-testid': 'knowledge-media-info',
              style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: '16px', overflow: 'auto' },
            },
              createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                createElement('span', { style: { fontSize: 12, color: 'var(--text-dim)', flex: 1 } },
                  `${selected.ext?.replace('.', '').toUpperCase() || '文件'} · ${Math.max(1, Math.round((selected.size ?? 0) / 1024))} KB`),
                createElement('button', {
                  type: 'button',
                  'data-testid': 'knowledge-media-open',
                  onClick: () => void handleMediaOpen('open'),
                  style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--accent-ink)', cursor: 'pointer' },
                }, '系统打开'),
                createElement('button', {
                  type: 'button',
                  'data-testid': 'knowledge-media-reveal',
                  onClick: () => void handleMediaOpen('reveal'),
                  style: { fontSize: 12, padding: '2px 8px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer' },
                }, '在文件夹中显示'),
              ),
              createElement('p', { style: { fontSize: 12, color: 'var(--text-dim)', margin: 0, wordBreak: 'break-all' } }, selected.path),
              mediaLoading
                ? createElement('p', { 'data-testid': 'knowledge-media-loading', style: { fontSize: 13, color: 'var(--text-dim)', margin: 0 } }, '正在读取预览…')
                : mediaError.length > 0
                  ? createElement('div', {
                      'data-testid': 'knowledge-media-error',
                      role: 'alert',
                      style: { padding: '10px 12px', border: '.5px solid var(--danger)', borderRadius: 'var(--radius-sm)', color: 'var(--danger)', fontSize: 13 },
                    },
                      createElement('p', { style: { margin: 0 } }, `预览失败：${mediaError}`),
                      createElement('button', {
                        type: 'button',
                        'data-testid': 'knowledge-media-retry',
                        onClick: () => void openItem(selected),
                        style: { marginTop: 8, fontSize: 12, padding: '2px 10px', cursor: 'pointer' },
                      }, '重试'),
                    )
                  : mediaPreview != null
                    ? createElement('div', {
                        'data-testid': 'knowledge-media-preview',
                        'data-kind': mediaPreview.kind,
                        style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
                      },
                        mediaPreview.kind === 'image' && mediaPreview.url != null
                          ? createElement('img', {
                              'data-testid': 'knowledge-preview-image',
                              src: mediaPreview.url,
                              alt: mediaPreview.name,
                              style: { maxWidth: '100%', maxHeight: 480, objectFit: 'contain', alignSelf: 'flex-start' },
                            })
                          : null,
                        mediaPreview.kind === 'pdf' && mediaPreview.url != null
                          ? createElement('iframe', {
                              'data-testid': 'knowledge-preview-pdf',
                              title: mediaPreview.name,
                              src: mediaPreview.url,
                              style: { width: '100%', height: 520, border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: '#fff' },
                            })
                          : null,
                        mediaPreview.kind === 'video' && mediaPreview.url != null
                          ? createElement('video', {
                              'data-testid': 'knowledge-preview-video',
                              src: mediaPreview.url,
                              controls: true,
                              preload: 'metadata',
                              style: { maxWidth: '100%', maxHeight: 480, alignSelf: 'flex-start', background: '#000' },
                            })
                          : null,
                        mediaPreview.kind === 'audio' && mediaPreview.url != null
                          ? createElement('audio', {
                              'data-testid': 'knowledge-preview-audio',
                              src: mediaPreview.url,
                              controls: true,
                              preload: 'metadata',
                              style: { width: '100%' },
                            })
                          : null,
                        // 安全：sandbox 为空 = 禁脚本、禁表单、禁同源；HTML 只作为静态文档展示。
                        mediaPreview.kind === 'html' && mediaPreview.url != null
                          ? createElement('iframe', {
                              'data-testid': 'knowledge-preview-html',
                              title: mediaPreview.name,
                              src: mediaPreview.url,
                              sandbox: '',
                              style: { width: '100%', height: 480, border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: '#fff' },
                            })
                          : null,
                        mediaPreview.kind === 'html'
                          ? createElement('p', { style: { fontSize: 12, color: 'var(--text-dim)', margin: 0 } },
                              'HTML 沙箱预览：脚本、表单与同源访问已禁用；图片/样式等外链资源不会加载。')
                          : null,
                        mediaPreview.kind === 'text'
                          ? createElement('pre', {
                              'data-testid': 'knowledge-preview-text',
                              style: { flex: 1, minHeight: 0, maxHeight: 'calc(100vh - 260px)', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55, padding: 12, margin: 0, border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)', background: 'var(--panel)' },
                            }, mediaPreview.text ?? '')
                          : null,
                        mediaPreview.kind === 'text' && mediaPreview.truncated === true
                          ? createElement('p', { 'data-testid': 'knowledge-preview-truncated', style: { fontSize: 12, color: 'var(--text-dim)', margin: 0 } },
                              '文件较大，仅显示前 256 KB；完整内容请系统打开。')
                          : null,
                        mediaPreview.message != null && mediaPreview.message.length > 0
                          ? createElement('p', { 'data-testid': 'knowledge-media-note', style: { fontSize: 13, margin: 0, color: 'var(--text-dim)' } }, mediaPreview.message)
                          : null,
                      )
                    : null,
            )
          : editing
          ? createElement('div', {
              'data-testid': 'knowledge-editor',
              style: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '8px 16px' },
            },
              editChunks != null
                ? createElement('div', {
                    'data-testid': 'knowledge-edit-chunks',
                    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px', borderBottom: '.5px solid var(--separator)' },
                  },
                    createElement('span', { style: { fontSize: 12, color: 'var(--text-dim)', flex: 1 } },
                      `分章编辑：第 ${editChunkIndex + 1}/${editChunks.length} 章 · ${editChunks[editChunkIndex]!.title} · 保存只写回本章`),
                    createElement('button', {
                      type: 'button',
                      'data-testid': 'knowledge-edit-chunk-prev',
                      disabled: editChunkIndex === 0,
                      onClick: () => switchEditChunk(editChunkIndex - 1),
                      style: { fontSize: 12, padding: '2px 8px', cursor: editChunkIndex === 0 ? 'default' : 'pointer' },
                    }, '上一章'),
                    createElement('button', {
                      type: 'button',
                      'data-testid': 'knowledge-edit-chunk-next',
                      disabled: editChunkIndex >= editChunks.length - 1,
                      onClick: () => switchEditChunk(editChunkIndex + 1),
                      style: { fontSize: 12, padding: '2px 8px', cursor: editChunkIndex >= editChunks.length - 1 ? 'default' : 'pointer' },
                    }, '下一章'),
                  )
                : null,
              createElement(MilkdownEditor, {
                // RW-32（老板真机：点「编辑」仍不可编辑）：阅读/编辑在同一位置，React 会复用
                // 同一个 Crepe 实例——只读状态被粘住。key 不同 → 切换即重建（可编辑）。
                // 2026-10-29 性能：大笔记按章编辑（每章 <=40KB），key 随章号重建。
                key: editChunks != null ? `knowledge-edit-${editChunkIndex}` : 'knowledge-edit',
                value: editChunks != null ? editChunks[editChunkIndex]!.text : editContent,
                // 不注册逐键回传（避免每键 serialize 全文）；保存时经 apiRef 读一次。
                apiRef: editApiRef,
                style: { flex: 1 },
              }),
            )
          : createElement('div', {
              // RW-28（老板 2026-10-28 裁）：阅读态**只渲染**，不显示 Markdown 源码；
              // 与编辑态同一个 Crepe 渲染器（只读化），样式一致。
              'data-testid': 'knowledge-readonly',
              style: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '8px 16px' },
            },
              // 超大笔记：一次只挂一章（<=120KB），否则 1MB/1.9 万段会把渲染进程卡死。
              readChunks != null
                ? createElement('div', {
                    'data-testid': 'knowledge-chunks',
                    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px', borderBottom: '.5px solid var(--separator)' },
                  },
                    createElement('span', { style: { fontSize: 12, color: 'var(--text-dim)', flex: 1 } },
                      `超长笔记：分章阅读 · 第 ${chunkIndex + 1}/${readChunks.length} 章 · ${readChunks[chunkIndex]!.title}`),
                    createElement('button', {
                      type: 'button',
                      'data-testid': 'knowledge-chunk-prev',
                      disabled: chunkIndex === 0,
                      onClick: () => setReadChunk(Math.max(0, chunkIndex - 1)),
                      style: { fontSize: 12, padding: '2px 8px', cursor: chunkIndex === 0 ? 'default' : 'pointer' },
                    }, '上一章'),
                    createElement('button', {
                      type: 'button',
                      'data-testid': 'knowledge-chunk-next',
                      disabled: chunkIndex >= readChunks.length - 1,
                      onClick: () => setReadChunk(Math.min(readChunks.length - 1, chunkIndex + 1)),
                      style: { fontSize: 12, padding: '2px 8px', cursor: chunkIndex >= readChunks.length - 1 ? 'default' : 'pointer' },
                    }, '下一章'),
                  )
                : null,
              createElement(MilkdownEditor, {
                // 阅读分章复用同一只读实例（replaceAll 换章）——比每章重建 Crepe 快约 1s。
                key: 'knowledge-read',
                value: readChunks != null ? readChunks[chunkIndex]!.text : editContent,
                readOnly: true,
                style: { flex: 1 },
              }),
            ),
      ) : null,
      }),
    // 新建弹层
    creating ? createElement('div', {
      style: { position: 'fixed', inset: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.3)' },
      onClick: (e: Event) => { if (e.target === e.currentTarget) setCreating(false); },
    },
      createElement('div', {
        'data-testid': 'knowledge-create',
        style: { width: 480, maxHeight: '70vh', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, border: '.5px solid var(--separator)', borderRadius: 'var(--radius-lg)', background: 'var(--panel)', boxShadow: 'var(--shadow-overlay)' },
        onClick: (e: Event) => e.stopPropagation(),
      },
        createElement('strong', { style: { fontSize: 14 } }, '新建笔记'),
        createElement('input', {
          'data-testid': 'knowledge-create-name',
          type: 'text',
          placeholder: '笔记名（如 deploy-runbook）',
          value: newName,
          onChange: (e: Event) => setNewName((e.target as HTMLInputElement).value),
          style: { fontSize: 13, padding: '6px 10px', border: '.5px solid var(--separator)', borderRadius: 'var(--radius-sm)' },
        }),
        // RW-18（老板 2026-10-28 裁 A）：落点跟随当前范围，提示随落点如实变化。
        createElement('p', { style: { fontSize: 12, color: 'var(--text-dim)', margin: 0 } }, newNoteTarget(session.selectedProjectId).hint),
        createElement('div', {
          'data-testid': 'knowledge-create-content',
          style: { flex: 1, minHeight: 160, display: 'flex', flexDirection: 'column' },
        },
          createElement(MilkdownEditor, {
            value: newContent,
            onChange: (md: string) => setNewContent(md),
            placeholder: '笔记内容（Markdown）',
            style: { flex: 1 },
          }),
        ),
        createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          createElement('button', { type: 'button', onClick: () => setCreating(false), style: { fontSize: 12, padding: '4px 12px', cursor: 'pointer' } }, '取消'),
          createElement('button', {
            type: 'button', 'data-testid': 'knowledge-create-save',
            onClick: () => void handleCreate(),
            disabled: newName.trim().length === 0,
            style: { fontSize: 12, padding: '4px 12px', border: '.5px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-strong)', color: 'var(--on-accent)', fontWeight: 500, cursor: 'pointer' },
          }, '创建'),
        ),
      ),
    ) : null,
  );
}
