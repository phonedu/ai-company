/**
 *  · 统一预览抽屉（聊天附件 / 任务产物共用）。
 *
 * 两种变体只差 class/testid（兼容既有契约）；交互/焦点/关闭/Esc/加载/错误/截断逻辑同一份。
 * - artifact：右侧 480 抽屉（`td__drawer-*` / `artifact-*`）。
 * - attachment：频道附件弹层（`attachment-preview*`；后续可收成同一视觉，不改契约）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { useFocusTrap } from './useFocusTrap.js';
import { MilkdownEditor } from './MilkdownEditor.js';

export interface PreviewDrawerData {
  title: string;
  /** 元信息一行（path/size/sha/截断/不一致等）；无则不渲染。 */
  meta?: string;
  kind: 'image' | 'pdf' | 'text' | 'file';
  url?: string;
  text?: string;
  truncated?: boolean;
  loading?: boolean;
  error?: string;
  /**
   * 文本是否为 Markdown（2026-11-05 决定「抽屉内只读渲染」）：true 时用只读渲染器
   * （MilkdownEditor/Crepe）显示，并可显式切「看原文」；不自动回落裸源码（口径）。
   */
  markdown?: boolean;
  /** 正文前的显式说明（如「这是旧版本行；下面是磁盘当前内容，非当时版本」）。 */
  noteBeforeBody?: string;
  /** artifact 变体：`data-artifact-id`。 */
  artifactId?: number;
}

export interface PreviewDrawerProps {
  data: PreviewDrawerData;
  onClose: () => void;
  variant?: 'artifact' | 'attachment';
}

export function PreviewDrawer({ data, onClose, variant = 'artifact' }: PreviewDrawerProps): ReactElement {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useFocusTrap(true, panelRef);
  /**
   * Markdown 文本的显示模式（2026-11-05 裁「抽屉内只读渲染」）：
   * 默认 `render`（只读 Crepe 排版）；`source` 仅在老板**显式**点「看原文」时进入——
   * 不自动回落裸源码（/2026-10-28 口径：阅读态不显示源码）。
   */
  const [view, setView] = useState<'render' | 'source'>('render');
  // 换产物时回到默认渲染态（不把上一个文件选的「看原文」带过去）。
  const previewKey = data.artifactId ?? data.title;
  useEffect(() => {
    setView('render');
  }, [previewKey]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    // Esc 只关抽屉——capture 阶段拦住并阻断后续监听（否则 TaskDetailView 的 document Esc
    // 会同时把详情退回频道）。capture 在 document 冒泡之前跑，`stopImmediatePropagation` 断链。
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const artifact = variant === 'artifact';
  const scrimClass = artifact ? 'td__drawer-scrim' : 'attachment-preview';
  const panelClass = artifact ? 'td__drawer' : 'attachment-preview__panel';
  const headClass = artifact ? 'td__drawer-head' : 'attachment-preview__head';
  const titleClass = artifact ? 'td__drawer-title' : 'attachment-preview__name';
  const closeClass = artifact ? 'td__drawer-close' : 'attachment-preview__close';
  const bodyClass = artifact ? 'td__drawer-body' : 'attachment-preview__body';
  const imageClass = artifact ? 'td__preview-image' : 'attachment-preview__image';
  const frameClass = artifact ? 'td__preview-frame' : 'attachment-preview__frame';
  const textClass = artifact ? 'td__preview' : 'attachment-preview__text';
  const noteClass = artifact ? 'td__meta' : 'attachment-preview__note';
  const errorClass = artifact ? 'td__meta' : 'attachment-preview__error';

  return (
    <div
      className={scrimClass}
      data-testid={artifact ? 'artifact-drawer-scrim' : 'attachment-preview'}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <aside
        ref={panelRef}
        className={panelClass}
        data-testid={artifact ? 'artifact-preview' : 'attachment-preview-panel'}
        data-artifact-id={artifact ? data.artifactId : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={artifact ? '产物预览' : '附件预览'}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={headClass}>
          <span className={titleClass}>{data.title}</span>
          <button
            ref={closeRef}
            type="button"
            className={closeClass}
            data-testid={artifact ? 'artifact-drawer-close' : 'attachment-preview-close'}
            aria-label="关闭预览"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        {artifact && data.meta ? (
          <p className={noteClass} data-testid="artifact-preview-meta">
            {data.meta}
          </p>
        ) : null}
        {data.kind === 'text' && data.markdown ? (
          <div className="td__preview-modes">
            <button
              type="button"
              data-testid="artifact-preview-mode-toggle"
              onClick={() => setView(view === 'render' ? 'source' : 'render')}
            >
              {view === 'render' ? '看原文' : '看渲染'}
            </button>
            <span className={noteClass}>{view === 'render' ? '只读渲染' : '原始文本'}</span>
          </div>
        ) : null}
        {data.noteBeforeBody ? (
          <p className="td__plannotice" data-testid="artifact-preview-note">
            {data.noteBeforeBody}
          </p>
        ) : null}
        <div className={bodyClass}>
          {data.loading ? (
            <p className={noteClass}>读取中…</p>
          ) : data.error ? (
            <p className={errorClass} data-testid={artifact ? 'artifact-preview-error' : 'attachment-preview-error'}>
              {data.error}
            </p>
          ) : data.kind === 'image' && data.url ? (
            <img
              className={imageClass}
              data-testid={artifact ? 'artifact-preview-image' : undefined}
              src={data.url}
              alt={data.title}
            />
          ) : data.kind === 'pdf' && data.url ? (
            <iframe
              className={frameClass}
              data-testid={artifact ? 'artifact-preview-frame' : undefined}
              src={data.url}
              title={data.title}
            />
          ) : data.kind === 'text' && data.markdown && view === 'render' ? (
            <>
              <MilkdownEditor value={data.text ?? ''} readOnly style={{ maxHeight: '60vh' }} />
              {data.truncated ? <p className={noteClass}>已截断：仅显示前 256 KiB。</p> : null}
            </>
          ) : data.kind === 'text' ? (
            <>
              <pre className={textClass} data-testid={artifact ? 'artifact-preview-text' : undefined}>
                {data.text}
              </pre>
              {data.truncated ? <p className={noteClass}>已截断：仅显示前 200KB。</p> : null}
            </>
          ) : (
            <p className={noteClass}>该类型暂不支持在应用内预览。</p>
          )}
        </div>
        {!artifact && data.meta ? <footer className="attachment-preview__meta">{data.meta}</footer> : null}
      </aside>
    </div>
  );
}
