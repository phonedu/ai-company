import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { AttachmentDTO } from '../types';
import { getApi } from '../api';
import { sendMessage, session } from '../store';
import { ArrowUpIcon, PaperclipIcon, PlusIcon } from './icons.js';

// ─────────────────────────────────────────────────────────────────────────────
// Composer：**独立、可替换**的输入组件（最小纯文本版）。
//   富文本 / 最终选型另有专项（chat 15）；结论「纯文本 + 自绘浮层、不做富文本」。
//    / UI §4.5：多行、Enter 发送 / Shift+Enter 换行、附件、拖拽、粘贴截图。
//   附件只取**元信息 + 不透明 fileToken**，**绝不传文件系统路径**。
//
//   本轮修复（决定）：
//   ① 中文 IME 守卫：合成中 `isComposing || keyCode===229` 时**不得**触发发送/浮层；
//   ② 拖拽 drop 必须 `preventDefault`（防 Electron 把文件当页面导航打开）；
//   ③ `getPathForFile` 返回 `''`（剪贴板截图）时，preload 走 `arrayBuffer()` 字节通路。
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_FILE_MAX_BYTES = 100 * 1024 * 1024; // UI §4.5/§4.6：单文件 ≤100MB
const SINGLE_MESSAGE_MAX_FILES = 10; // UI §4.6：单条 ≤10 个
const OVERSIZE_HINT = '超过 100MB，建议放进项目文件夹让任务就地读';

/** 待发附件（本地态）：带本地预览 URL；提交时只保留元信息 + `fileToken`。 */
interface PendingAttachment extends AttachmentDTO {
  localId: string;
  previewUrl?: string;
}

/** IME 合成守卫：Enter 与将来的 `/`、`#` 浮层触发都要先过这一关。
 *  `isComposing` 与 `keyCode===229` 两条都要判——不同输入法只命中其一。 */
export function isImeComposing(keyboard: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return keyboard.isComposing === true || keyboard.keyCode === 229;
}

function fallbackMeta(file: File): AttachmentDTO {
  return {
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
  };
}

export function Composer({ onCreateTask }: { onCreateTask?: () => void }): ReactElement {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewUrlsRef = useRef<string[]>([]);

  // 卸载时释放所有待发预览的 blob URL（避免泄漏）。
  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  // B 方案（一体胶囊）：输入区随内容长高，最多 160；不撑破底部工具条。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const canSend = !busy && (text.trim().length > 0 || attachments.length > 0);

  function removeAttachment(localId: string): void {
    setAttachments((prev) => {
      const target = prev.find((item) => item.localId === localId);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrlsRef.current = previewUrlsRef.current.filter((u) => u !== target.previewUrl);
      }
      return prev.filter((item) => item.localId !== localId);
    });
  }

  async function addFiles(files: FileList | File[] | null | undefined): Promise<void> {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    if (attachments.length + list.length > SINGLE_MESSAGE_MAX_FILES) {
      setError(`单条最多 ${SINGLE_MESSAGE_MAX_FILES} 个附件`);
      return;
    }
    // 上限即拒绝（UI §4.5/§4.6）：先本地看 size，避免白读一次大文件。
    const oversize = list.find((file) => file.size > SINGLE_FILE_MAX_BYTES);
    if (oversize) {
      setError(`「${oversize.name}」${OVERSIZE_HINT}`);
      return;
    }
    setError(null);

    const api = getApi();
    const next: PendingAttachment[] = [];
    for (const file of list) {
      const localId = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      const pending: PendingAttachment = { ...fallbackMeta(file), localId };
      // 本地预览：**只用于待发**，用 blob URL（不得写进消息记录/事件/DB）。
      if (file.type.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        previewUrlsRef.current.push(url);
        pending.previewUrl = url;
      }
      // 可信边界：preload 里 `webUtils.getPathForFile` → 有路径走路径、无路径走字节（例外③）。
      if (api?.files?.import) {
        try {
          const staged = await api.files.import(file);
          if (staged?.ok === false) {
            setError(staged.message ?? '附件导入失败');
          } else if (staged?.file?.fileToken) {
            pending.fileToken = staged.file.fileToken;
          }
        } catch (importError) {
          setError(importError instanceof Error ? importError.message : String(importError));
        }
      }
      next.push(pending);
    }
    setAttachments((prev) => [...prev, ...next]);
  }

  async function submit(): Promise<void> {
    const value = text.trim();
    if ((value.length === 0 && attachments.length === 0) || busy) return;
    const api = getApi();
    if (!api) {
      setError('主进程未连接');
      return;
    }
    setBusy(true);
    setError(null);
    // 点击即反馈：先清空输入（失败时恢复原话），按钮显示「发送中…」；不等 IPC 回来才有反应。
    setText('');
    try {
      await sendMessage({
        text: value,
        // 只带元信息 + fileToken；**不带路径、不带 blob URL**。
        attachments: attachments.map(({ name, size, type, fileToken }) => ({ name, size, type, fileToken })),
      });
      if (session.error) {
        // 发送失败：恢复原话；错误由频道上方的 session.error 显示（不重复刷两条）。
        setText((current) => (current.trim().length === 0 ? value : current));
        return;
      }
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current = [];
      setAttachments([]);
    } catch (submitError) {
      // 失败不清空草稿（决定）；发送期间用户新输入的内容优先保留。
      setText((current) => (current.trim().length === 0 ? value : current));
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`composer${dragging ? ' composer--dragging' : ''}`}
      data-testid="composer"
      onDragOver={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault(); // 防导航打开（关键）
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault(); // 防导航打开（关键）
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }
      }}
    >
      {attachments.length > 0 ? (
        <div className="composer__attachments" data-testid="composer-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.localId} className="composer__chip" data-testid="composer-chip">
              {attachment.previewUrl ? (
                <img className="composer__chip-thumb" src={attachment.previewUrl} alt={attachment.name} />
              ) : (
                '▤'
              )}{' '}
              {attachment.name}
              <button
                type="button"
                className="composer__chip-remove"
                aria-label={`移除 ${attachment.name}`}
                onClick={() => removeAttachment(attachment.localId)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="composer__error" data-testid="composer-error" role="alert">
          {error}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* B 方案（2026-10-22 选定）：输入与工具条同在一个浮起胶囊里。 */}
      <div className="composer__shell">
        <textarea
          ref={textareaRef}
          className="composer__input"
          data-testid="composer-input"
          rows={1}
          placeholder="请输入文字…（Enter 发送 / Shift+Enter 换行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // IME 合成中：Enter 是"上屏候选"，不是"发送"；也不触发浮层。
            if (isImeComposing(e.nativeEvent)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />

        <div className="composer__toolbar">
          <button
            type="button"
            className="composer__icon"
            data-testid="composer-attach"
            aria-label="添加附件"
            title="添加附件"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          {/* 2026-10-17（建任务入口批）：结构化表单（档位/验收/预算）。 */}
          {onCreateTask ? (
            <button
              type="button"
              className="composer__newtask"
              data-testid="composer-new-task"
              title="建任务（结构化表单：档位 / 验收 / 预算）"
              onClick={onCreateTask}
            >
              <PlusIcon />
              <span>建任务</span>
            </button>
          ) : null}
          <span className="composer__hint" aria-hidden="true">
            ⏎ 发送 · ⇧⏎ 换行
          </span>
          <button
            type="button"
            className="composer__send"
            data-testid="composer-send"
            data-busy={busy ? 'true' : 'false'}
            aria-busy={busy}
            aria-label={busy ? '发送中…' : '发送'}
            title={busy ? '发送中…' : '发送（Enter）'}
            disabled={!canSend}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? <span className="composer__spinner" aria-hidden="true" /> : <ArrowUpIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
