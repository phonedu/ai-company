import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { getApi } from '../api';
import { createProject, loadProjectsForOverview, projectActions, setChannelScope, showChannel, assistant, cards, channelFocus, channelItems, inbox, loadChannel, loadReadState, markChannelMessagesRead, messages, session } from '../store';
import type { HumanMessageDTO, ReportDTO, TaskDTO } from '../types';
import { Card } from './Card';
import { Composer } from './Composer';
import { PreviewDrawer } from './PreviewDrawer';
import { ProseText } from './ProseText';
import { TaskCreateDialog } from './TaskCreateDialog';
import { streamAnchors } from './channelStream';

// 老板频道（UI §4.5）：消息流 + composer + 卡片最小渲染。
// 只读主进程推送、只发 IPC 请求；不碰 Node/DB/fs（DEV §7.4）。
// 2026-10-16（频道批，设计板 v4）：**日期锚**（今天/昨天/…）＋**「新消息」锚**（本次进入后到达的
//   第一条——挂载时刻起算，进入即重置；与「待我处理」未读游标口径分开，各管各的）+ 气泡终版（见 CSS）。

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentPreviewData {
  kind: 'image' | 'pdf' | 'text' | 'file';
  name: string;
  size: number;
  type: string;
  previewable: boolean;
  url?: string;
  text?: string;
  truncated?: boolean;
}

interface PreviewState {
  loading: boolean;
  data?: AttachmentPreviewData;
  error?: string;
}

function MessageBubble({
  message,
  onConvertToTask,
}: {
  message: HumanMessageDTO;
  onConvertToTask?: (text: string) => void;
}): ReactElement {
  // direction='in' ＝ 老板自己发的（右侧绿泡）；'out' ＝ 幕僚长（左侧白泡）。
  const boss = message.direction === 'in';
  const who = boss ? '你' : '幕僚长';
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  async function openAttachment(index: number): Promise<void> {
    setPreview({ loading: true });
    try {
      const api = getApi();
      if (!api?.chat?.resolveAttachment) {
        setPreview({ loading: false, error: '未连接主进程，无法读取附件' });
        return;
      }
      const result = (await api.chat.resolveAttachment({ messageId: message.id, index })) as {
        ok?: boolean;
        attachment?: AttachmentPreviewData;
        message?: string;
      };
      if (result?.ok === true && result.attachment) {
        setPreview({ loading: false, data: result.attachment });
      } else {
        setPreview({ loading: false, error: result?.message ?? '附件不可预览' });
      }
    } catch (error) {
      setPreview({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <>
      <div className="bubble-row" data-testid="message" data-direction={message.direction}>
        <span className="bubble-row__avatar" aria-hidden="true">{boss ? '你' : '幕'}</span>
        <div className="bubble-row__col">
          <div className="bubble__meta">
            <span className="bubble__who">{who}</span>
            <span className="bubble__time">{formatTime(message.createdAt)}</span>
          </div>
          <div className={`bubble bubble--${boss ? 'in' : 'out'}`}>
            <ProseText className="bubble__content" text={message.content} />
            {message.attachments.length > 0 ? (
              <div className="bubble__attachments">
                {message.attachments.map((attachment, index) => (
                  <button
                    key={`${attachment.name}-${index}`}
                    type="button"
                    className="chip chip--attachment"
                    data-testid="attachment-chip"
                    title="预览附件"
                    onClick={() => void openAttachment(index)}
                  >
                    {attachment.name}
                  </button>
                ))}
              </div>
            ) : null}
            {message.resolution ? (
              <footer className="bubble__resolution" data-testid="resolution">
                归属：{message.resolution.kind}
                {message.resolution.via ? ` · ${message.resolution.via}` : ''}
              </footer>
            ) : null}
            {/* 2026-10-29 P2（P-N01）：消息悬停操作——复制 / 转任务（不改变消息本身）。 */}
            <div className="bubble__actions">
              <button
                type="button"
                className="bubble__action"
                data-testid="message-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(message.content).catch(() => undefined);
                }}
              >
                复制
              </button>
              {onConvertToTask ? (
                <button
                  type="button"
                  className="bubble__action"
                  data-testid="message-to-task"
                  onClick={() => onConvertToTask(message.content)}
                >
                  转任务
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {preview ? (
        <PreviewDrawer
          variant="attachment"
          onClose={() => setPreview(null)}
          data={{
            title: preview.data?.name ?? '附件预览',
            meta: preview.data ? `${preview.data.type || '未知类型'} · ${formatSize(preview.data.size)}` : undefined,
            kind: preview.data?.kind ?? 'file',
            url: preview.data?.url,
            text: preview.data?.text,
            // 2026-11-05（老板：附件 .md 也要渲染）：与产物「读」同口径——按附件名识别 Markdown，
            // 抽屉内只读渲染＋可切「看原文」；其它文本仍原文。
            markdown: /\.(md|markdown)$/i.test(preview.data?.name ?? ''),
            truncated: preview.data?.truncated,
            loading: preview.loading,
            error: preview.error,
          }}
        />
      ) : null}
    </>
  );
}

/** 范围菜单选项样式（选中项左侧 ✓；键盘可达＝原生 button）。 */
function scopeOptionStyle(selected: boolean): Record<string, string | number> {
  return {
    textAlign: 'left',
    fontSize: 12,
    padding: '4px 8px',
    border: 0,
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: selected ? 'var(--text)' : 'var(--text-dim)',
    fontWeight: selected ? 600 : 400,
    cursor: 'pointer',
  };
}

export function BossChannel(): ReactElement {
  const msgSnap = useSnapshot(messages);
  const cardSnap = useSnapshot(cards);
  const sessionSnap = useSnapshot(session);
  const actionsSnap = useSnapshot(projectActions);
  // 频道范围选择器（老板 2026-10-26）：下拉常驻显示当前范围；「＋新建项目」就地小表单。
  const [scopeCreating, setScopeCreating] = useState(false);
  const [scopeName, setScopeName] = useState('');
  const [scopeError, setScopeError] = useState('');
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeProjects = actionsSnap.list as unknown as Array<{ id: number; name: string }>;
  useEffect(() => {
    // 下拉选项以 project:list 为准（含空项目）；空时拉一次（频道可能先于项目页打开）
    if ((actionsSnap.list as unknown as unknown[]).length === 0) void loadProjectsForOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在清单为空时补拉
  }, []);
  const scopeId = sessionSnap.selectedProjectId ?? null;
  const scopeName_ = scopeId == null ? null : scopeProjects.find((p) => p.id === scopeId)?.name ?? `项目#${scopeId}`;
  const assistantSnap = useSnapshot(assistant);
  const focusSnap = useSnapshot(channelFocus);
  const inboxSnap = useSnapshot(inbox);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const lastItemKeyRef = useRef<string | null>(null);
  // RM-4（2026-10-19 真机）：首次进入/切回频道时先落到底部，不再从最早一条开始。
  const initialScrollDoneRef = useRef(false);
  // D4：老板主动上翻时，新到的 IM 消息不能强行把他拽回底部。
  const atBottomRef = useRef(true);
  const [loaded, setLoaded] = useState(false);
  // 「新消息」锚：进入频道时的服务端消息游标快照（在 mark 之前取；否则标读后锚会立刻消失）。
  const entryCursorRef = useRef<number | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [now] = useState(() => Date.now());
  /** 2026-10-17（建任务入口批）：composer 旁「＋建任务」→ 结构化表单；成功回执在输入框上方一行。 */
  const [createOpen, setCreateOpen] = useState(false);
  const [createGoal, setCreateGoal] = useState('');
  const [createNotice, setCreateNotice] = useState('');

  useEffect(() => {
    // V3 修：**订阅已上移到 `AppShell`**（全局单点；此前挂在本组件 ⇒ 离开频道视图即丢推送、
    // 左栏任务分组陈旧）。本组件只负责进频道时拉一次同源数据。
    // M3-REM-1c：先拉数据＋消息游标，记下**进入时**的游标（供「新消息」锚），再推进消息游标。
    void (async () => {
      await loadChannel();
      await loadReadState('channel:messages');
      if (entryCursorRef.current == null) entryCursorRef.current = inbox.messageCursor;
      await markChannelMessagesRead();
      setLoaded(true);
    })();
  }, []);

  const items = channelItems(
    msgSnap.list as unknown as HumanMessageDTO[],
    cardSnap.list as unknown as ReportDTO[],
  );
  // 锚位（纯函数口径见 `channelStream.ts`）：日期锚＋「新消息」锚。
  // 「新消息」优先用服务端消息游标（持久、跨重启）；没有游标时回落本次进入时刻。
  const anchors = streamAnchors(items, openedAt, now, entryCursorRef.current ?? inboxSnap.messageCursor);

  // 等回复判定（老板 2026-10-26 真机反馈：回复慢且无任何指示，不知道是卡住还是在整理）：
  // 纯数据推导——流末尾是老板自己的消息 ⇒ 在等幕僚长（回执/回复一到，末尾变 out/卡，指示自消）。
  const lastItem = items[items.length - 1];
  const awaitingReply =
    sessionSnap.sending ||
    (lastItem?.kind === 'message' && (lastItem.message as HumanMessageDTO).direction === 'in');
  const awaitingReplyAt =
    lastItem?.kind === 'message' ? (lastItem.message as HumanMessageDTO).createdAt : openedAt;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!awaitingReply) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [awaitingReply]);


  // RM-4：首屏渲染完成后落到底部（切走再切回＝组件重挂，ref 重置 → 同样落底）。
  // 若从「待我处理 → 在频道看」进来，下面的定位 effect 会再把目标卡滚到视野中央。
  useEffect(() => {
    const stream = streamRef.current;
    if (!loaded || !stream || initialScrollDoneRef.current || items.length === 0) return;
    stream.scrollTop = stream.scrollHeight;
    atBottomRef.current = true;
    initialScrollDoneRef.current = true;
  }, [loaded, items.length]);

  // 底部跟随（老板 2026-10-26 真机反馈：助手回复/决策卡到达屏幕纹丝不动，全靠手滑）：
  // **老板本来就在底部时，任何新内容（自己消息/助手回复/卡片）都跟随滚动**；
  // 上翻读历史时仍不抢滚动位置（D4 原则保留）。用最后一条 key 判断——列表上限 100，长度可能不变。
  // RW-24（S10 真机：「对话来了依旧不回底」）：长 Markdown 回复/卡片排版晚于本次提交——
  // 只滚一次会停在旧底部；改为下一帧滚（rAF），并由下面的 MutationObserver 在内容继续增长时钉住。
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const last = items[items.length - 1];
    const lastKey = last == null
      ? null
      : last.kind === 'card'
        ? `card-${(last.card as ReportDTO).id}`
        : `msg-${(last.message as HumanMessageDTO).id}`;
    const changed = lastKey != null && lastKey !== lastItemKeyRef.current;
    lastItemKeyRef.current = lastKey;
    if (!changed || focusSnap.cardId != null) return;
    if (!atBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (!stream.isConnected) return;
      stream.scrollTop = stream.scrollHeight;
      // S13-C：程序化滚动落地后显式回到「在底部」——否则排版未完时 scroll 事件会把
      // atBottom 判成 false，后续长回复增长就再也不跟随（真机 gap 88→743）。
      atBottomRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [items, focusSnap.cardId]);

  // RW-24：内容增长钉底——长回复/表格/代码块排版完成、流式文字追加都会再改 scrollHeight；
  // 老板在底部（atBottomRef）时每帧跟随一次；上翻读历史时不动（D4 原则）。
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let raf = 0;
    const pin = (): void => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!stream.isConnected || !atBottomRef.current) return;
        stream.scrollTop = stream.scrollHeight;
        atBottomRef.current = true;
      });
    };
    const observer = new MutationObserver(pin);
    observer.observe(stream, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // 「待我处理 → 在频道看」：等卡渲染出来后滚到视野中央 + 短暂高亮；找不到（不在最近列表）则放弃，不静默改位置。
  useEffect(() => {
    const cardId = focusSnap.cardId;
    if (cardId == null) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const locate = (): void => {
      const el = streamRef.current?.querySelector<HTMLElement>(
        `[data-testid="card"][data-card-id="${cardId}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        el.setAttribute('data-focused', 'true');
        setTimeout(() => el.removeAttribute('data-focused'), 2400);
        channelFocus.cardId = null;
        return;
      }
      if (attempts++ < 20) {
        timer = setTimeout(locate, 100);
      } else {
        channelFocus.cardId = null;
      }
    };
    locate();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [focusSnap.cardId, items.length]);

  return (
    <section className="boss-channel" data-testid="boss-channel">
      <div
        className="boss-channel__stream"
        data-testid="message-stream"
        ref={streamRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {assistantSnap.starting ? (
          <div
            className="boss-channel__status"
            data-testid="assistant-status"
            style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}
          >
            幕僚长启动中…
          </div>
        ) : null}
        {awaitingReply ? (
          <div
            className="boss-channel__status"
            data-testid="assistant-thinking"
            style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', padding: '4px 0' }}
          >
            幕僚长正在处理… {Math.floor((nowTick - awaitingReplyAt) / 1000)}s
            <span aria-hidden>…</span>
          </div>
        ) : null}
        {items.length === 0 && cardSnap.loading && !cardSnap.loaded ? (
          <div className="boss-channel__status" data-testid="boss-channel-loading" role="status">
            正在加载频道…
          </div>
        ) : items.length === 0 && cardSnap.error ? (
          <div className="boss-channel__empty" data-testid="boss-channel-error" role="alert">
            <p style={{ margin: 0 }}>频道加载失败：{String(cardSnap.error)}</p>
            <button
              type="button"
              data-testid="boss-channel-retry"
              onClick={() => {
                void loadChannel();
              }}
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="boss-channel__empty" data-testid="boss-channel-guide">
            <p style={{ margin: 0 }}>还没有消息。我是幕僚长，可以直接对我说：</p>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>「建一个任务：读一遍 docs/ 并汇总要点」</li>
              <li>「看看 review-site 现在的进度」</li>
              <li>「把这条经验记进笔记」</li>
            </ul>
          </div>
        ) : (
          items.map((item, index) => {
            const key = item.kind === 'card' ? `card-${(item.card as ReportDTO).id}` : `msg-${(item.message as HumanMessageDTO).id}`;
            const anchor = anchors[index];
            return (
              <div key={key} className="channel-item">
                {anchor.showDate != null ? (
                  <div className="channel-date" data-testid="channel-date">
                    {anchor.showDate}
                  </div>
                ) : null}
                {anchor.showNew ? (
                  <div className="channel-new" data-testid="channel-new">
                    新消息
                  </div>
                ) : null}
                {item.kind === 'card' ? (
                  <Card card={item.card as ReportDTO} />
                ) : (
                  <MessageBubble
                    message={item.message as HumanMessageDTO}
                    onConvertToTask={(text) => {
                      setCreateGoal(text.slice(0, 400));
                      setCreateOpen(true);
                    }}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      {sessionSnap.error ? (
        <div className="boss-channel__error" data-testid="error">
          {sessionSnap.error}
        </div>
      ) : null}
      {createNotice.length > 0 ? (
        <p className="boss-channel__notice" data-testid="channel-create-notice">
          {createNotice}
        </p>
      ) : null}
      {/* 频道范围选择器（老板 2026-10-26 提案）：范围＝助手的工作范围，显式可选、常驻可见。
          自定义菜单（非原生 select——老板 2026-10-26 反馈：样式要跟应用、朝上展开）。
          公司＝可聊天/查任意任务状态；选项目＝该项目的命令与读写。与项目树点选互同步。 */}
      <div className="boss-channel__scope" data-testid="channel-scope" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 12px 4px', fontSize: 12, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
        <span>当前范围</span>
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <button
            type="button"
            data-testid="channel-scope-select"
            aria-haspopup="listbox"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setScopeOpen(false);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              padding: '4px 12px',
              border: '.5px solid var(--separator)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--panel)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            {scopeId == null ? '公司（全部项目）' : (scopeName_ ?? `项目#${scopeId}`)}
            <span aria-hidden style={{ fontSize: 10, transform: scopeOpen ? 'rotate(180deg)' : 'none' }}>▲</span>
          </button>
          {scopeOpen ? (
            <>
              <div
                data-testid="channel-scope-scrim"
                onClick={() => setScopeOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 30 }}
              />
              <div
                role="listbox"
                aria-label="当前范围"
                data-testid="channel-scope-menu"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setScopeOpen(false);
                }}
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 31,
                  minWidth: 200,
                  maxHeight: '50vh',
                  overflowY: 'auto',
                  padding: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  border: '.5px solid var(--separator)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--panel)',
                  boxShadow: 'var(--shadow-overlay)',
                }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={scopeId == null}
                  data-testid="channel-scope-option-company"
                  onClick={() => {
                    setChannelScope(null);
                    setScopeOpen(false);
                    setScopeCreating(false);
                  }}
                  style={scopeOptionStyle(scopeId == null)}
                >
                  {scopeId == null ? '✓ ' : ''}公司（全部项目）
                </button>
                {scopeProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={scopeId === p.id}
                    data-testid={`channel-scope-option-${p.id}`}
                    onClick={() => {
                      setChannelScope(p.id);
                      setScopeOpen(false);
                      setScopeCreating(false);
                    }}
                    style={scopeOptionStyle(scopeId === p.id)}
                  >
                    {scopeId === p.id ? '✓ ' : ''}
                    {p.name}
                  </button>
                ))}
                <div style={{ height: '.5px', background: 'var(--separator)', margin: '4px 2px' }} />
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-testid="channel-scope-option-new"
                  onClick={() => {
                    setScopeError('');
                    setScopeName('');
                    setScopeCreating(true);
                    setScopeOpen(false);
                  }}
                  style={scopeOptionStyle(false)}
                >
                  ＋新建项目…
                </button>
              </div>
            </>
          ) : null}
        </span>
        <span data-testid="channel-scope-hint">
          {scopeId == null
            ? '公司范围：可聊天、用任务号查任意项目状态；执行命令与文件读写请选择具体项目。'
            : `「${scopeName_ ?? ''}」范围：助手可执行命令与读写该项目；查其他项目用任务号，动其他项目先切换范围。`}
        </span>
      </div>
      {scopeCreating ? (
        <form
          data-testid="channel-scope-create"
          style={{ display: 'flex', gap: 8, margin: '0 12px 4px', fontSize: 12, alignItems: 'center' }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (scopeName.trim().length === 0 || scopeBusy) return;
            setScopeBusy(true);
            setScopeError('');
            const res = await createProject(scopeName.trim(), true);
            setScopeBusy(false);
            if (res.ok !== true) {
              setScopeError(res.error);
              return;
            }
            setScopeCreating(false);
            setScopeName('');
            setChannelScope(res.project.id);
            showChannel();
          }}
        >
          <input
            data-testid="channel-scope-create-name"
            value={scopeName}
            onChange={(e) => setScopeName(e.target.value)}
            placeholder="新项目名"
            style={{ fontSize: 12, width: 140 }}
          />
          <button type="submit" disabled={scopeBusy || scopeName.trim().length === 0} style={{ fontSize: 12 }}>
            建并切换范围
          </button>
          <button
            type="button"
            style={{ fontSize: 12 }}
            onClick={() => {
              setScopeCreating(false);
              setScopeError('');
            }}
          >
            取消
          </button>
          {scopeError.length > 0 ? <span style={{ color: 'var(--danger, #b00020)' }}>{scopeError}</span> : null}
        </form>
      ) : null}
      <Composer
        onCreateTask={() => {
          setCreateNotice('');
          setCreateOpen(true);
        }}
      />
      {createOpen ? (
        <TaskCreateDialog
          projectId={scopeId}
          projectName={scopeName_}
          initialGoal={createGoal}
          onClose={() => setCreateOpen(false)}
          onCreated={(task: TaskDTO) => {
            setCreateOpen(false);
            setCreateNotice(`已受理 ${task.shortId ?? `#${task.id}`}（在「项目树」里看）`);
          }}
        />
      ) : null}
    </section>
  );
}
