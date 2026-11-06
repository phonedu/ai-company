/**
 * 命令面板（`Ctrl K`；设计件 §4.9）——**纯展示**：输入＋结果组（任务 / 消息）＋键盘导航。
 * 过滤在 `paletteModel.ts`（可 node 测）；本件只管画与转发（受控：query/results 由壳持有）。
 *
 * 口径：实色浮层（遮罩 `rgba(0,0,0,.35)`＋面板 640）；`↑↓` 选择 · `Enter` 打开 · `Esc` 关闭；
 * 无结果＝「没有匹配」空态；**产物组＝随索引件**（脚注如实，不摆假组）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { PaletteResults } from './paletteModel.js';
import { useFocusTrap } from './useFocusTrap.js';

export interface CommandPaletteProps {
  open: boolean;
  query: string;
  results: PaletteResults;
  onQueryChange: (value: string) => void;
  /** 选中：任务 → 详情；消息 →（暂无定位，去频道）；全局 → 对应任务（无任务归属去频道）；产物带 artifactId 时开预览。 */
  onPick: (item: { kind: 'task' | 'message' | 'global'; id: number; taskId?: number | null; artifactId?: number }) => void;
  onClose: () => void;
}

export function CommandPalette({ open, query, results, onQueryChange, onPick, onClose }: CommandPaletteProps): ReactElement | null {
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, panelRef);

  // 打开即聚焦（键盘流：Ctrl K → 直接打字）。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  // 结果集变化（含查询变化）→ 选中回落第一项（不指向已不存在的行）。
  useEffect(() => {
    setActive(0);
  }, [results.query]);

  if (!open) return null;

  type PaletteGroup = '任务' | '消息' | '产物';
  const rows: Array<{
    kind: 'task' | 'message' | 'global';
    id: number;
    taskId: number | null;
    artifactId?: number;
    label: string;
    group: PaletteGroup;
  }> = [];
  const seenTasks = new Set<number>();
  const seenMessages = new Set<number>();
  for (const task of results.tasks) {
    seenTasks.add(task.id);
    rows.push({ kind: 'task', id: task.id, taskId: null, label: task.label, group: '任务' });
  }
  for (const message of results.messages) {
    seenMessages.add(message.id);
    rows.push({ kind: 'message', id: message.id, taskId: null, label: message.label, group: '消息' });
  }
  for (const item of results.global) {
    if (item.source === 'task') {
      if (seenTasks.has(item.id)) continue;
      seenTasks.add(item.id);
      rows.push({ kind: 'global', id: item.id, taskId: item.taskId, label: item.label, group: '任务' });
    } else if (item.source === 'message') {
      if (seenMessages.has(-item.id)) continue;
      seenMessages.add(-item.id);
      rows.push({ kind: 'global', id: item.id, taskId: item.taskId, label: item.label, group: '消息' });
    } else {
      rows.push({ kind: 'global', id: item.id, taskId: item.taskId, artifactId: item.artifactId, label: item.label, group: '产物' });
    }
  }

  const openRow = (index: number): void => {
    const row = rows[index];
    if (row) onPick({ kind: row.kind, id: row.id, taskId: row.taskId, ...(row.artifactId != null ? { artifactId: row.artifactId } : {}) });
  };

  return (
    <div
      className="palette-scrim"
      data-testid="command-palette-scrim"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="palette"
        data-testid="command-palette"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          data-testid="palette-input"
          data-autofocus
          value={query}
          placeholder="搜索任务 / 产物 / 消息…"
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              openRow(active);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        {results.query.length === 0 ? (
          <p className="palette__hint" data-testid="palette-hint">
            输入关键词：任务 / 消息 / 产物；继续输入可跨项目搜任务、消息正文、产物路径。
          </p>
        ) : results.total === 0 ? (
          <p className="palette__hint" data-testid="palette-empty">
            没有匹配
          </p>
        ) : (
          <ul className="palette__list" data-testid="palette-list">
            {(['任务', '消息', '产物'] as const).map((group) => {
              const slug = group === '任务' ? 'task' : group === '消息' ? 'message' : 'artifact';
              return (
              rows.some((r) => r.group === group) ? (
                <li key={group} className="palette__group" data-testid={`palette-group-${slug}`}>
                  <h3 className="palette__grouptitle">{group}</h3>
                  <ul>
                    {rows.map((row, index) =>
                      row.group === group ? (
                        <li key={`${row.kind}-${row.id}`}>
                          <button
                            type="button"
                            className="palette__row"
                            data-testid="palette-row"
                            data-kind={row.kind}
                            data-active={index === active ? 'true' : 'false'}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => onPick({ kind: row.kind, id: row.id, taskId: row.taskId })}
                          >
                            {row.label}
                          </button>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </li>
              ) : null
              );
            })}
          </ul>
        )}
        <p className="palette__foot">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
      </div>
    </div>
  );
}
