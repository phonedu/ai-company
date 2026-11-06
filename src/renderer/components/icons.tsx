import type { ReactElement } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// 内联图标（壳层重排 v4，2026-10-16）——**不引依赖**：16×16 / stroke=currentColor /
//   strokeWidth 1.5 / round。设计源＝FigCraft 板（左栏 6 枚＋折叠钮＋窗口三键）。
//   §7 待裁「去 emoji 化 ＋ 定 Lucide 为唯一图标源」若批：整体替换本件，调用点不动。
// ─────────────────────────────────────────────────────────────────────────────

export type NavIconName = 'inbox' | 'channel' | 'hall' | 'projects' | 'archive' | 'settings';

const SVG_ATTRS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const NAV_PATHS: Record<NavIconName, ReactElement> = {
  inbox: (
    <>
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M2.5 9.5h3l1 1.6h3l1-1.6h3" />
    </>
  ),
  channel: <path d="M2.6 4.6A1.6 1.6 0 0 1 4.2 3h7.6a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6H7.4L4.8 13.6v-2.2H4.2a1.6 1.6 0 0 1-1.6-1.6z" />,
  hall: (
    <>
      <path d="M3 13.5V4.2a1.2 1.2 0 0 1 1.2-1.2h5.6a1.2 1.2 0 0 1 1.2 1.2v9.3" />
      <path d="M2 13.5h12" />
      <path d="M5.5 5.5h1M5.5 8h1M5.5 10.5h1M8.5 5.5h1M8.5 8h1M8.5 10.5h1" />
    </>
  ),
  projects: <path d="M2.5 4.6a1.3 1.3 0 0 1 1.3-1.3h2.4l1.3 1.6h4.7a1.3 1.3 0 0 1 1.3 1.3v5.5a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z" />,
  archive: (
    <>
      <path d="M2.5 3h11v3h-11z" />
      <path d="M3.5 6v6.2a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6" />
      <path d="M6.5 8.8h3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavIconName }): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      {NAV_PATHS[name]}
    </svg>
  );
}

/** 侧栏折叠钮（面板图标：外框 ＋ 一侧分隔线）。 */
export function PanelToggleIcon({ side }: { side: 'left' | 'right' }): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <rect x="1.5" y="3" width="13" height="10" rx="2" />
      <path d={side === 'left' ? 'M5.5 3v10' : 'M10.5 3v10'} />
    </svg>
  );
}

/** 自绘窗口三键字形（— / ▢ / ✕；hover 由 CSS 承担）。 */
export function WinGlyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      {kind === 'minimize' ? <path d="M3 8h10" /> : null}
      {kind === 'maximize' ? <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /> : null}
      {kind === 'restore' ? (
        <>
          <rect x="3.5" y="5.5" width="7" height="7" rx="1" />
          <path d="M6 5.5V4.5a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1h-1" />
        </>
      ) : null}
      {kind === 'close' ? <path d="M4 4l8 8M12 4l-8 8" /> : null}
    </svg>
  );
}

/** 关闭（浮层 ×）；与窗口关闭同形，单独命名便于浮层复用。 */
export function CloseIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 搜索（命令面板输入框前缀）。 */
export function SearchIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3 3" />
    </svg>
  );
}

/** 勾选（命令面板选中项）。 */
export function CheckIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M3.5 8.2l3 3 6-6.4" />
    </svg>
  );
}

/** 回形针（附件）——替代 Composer 里的 emoji，线宽与导航图标一致。 */
export function PaperclipIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M10.8 3.6 4.6 9.8a3.2 3.2 0 0 0 4.5 4.5l6.2-6.2a2.1 2.1 0 0 0-3-3L6.1 11.3a1 1 0 0 0 1.4 1.4l5.5-5.5" />
    </svg>
  );
}

/** 加号（建任务）——与文字并排，线宽 1.6。 */
export function PlusIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/** 上箭头（发送）——B 方案里的圆形发送按钮。 */
export function ArrowUpIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

/** 铅笔（编辑别名）——与别名共用一个胶囊，不单独做成大按钮。 */
export function PencilIcon(): ReactElement {
  return (
    <svg className="icon" {...SVG_ATTRS}>
      <path d="M3 13l.8-2.8 6.8-6.8 2 2-6.8 6.8L3 13Z" />
      <path d="M9.4 4.6l2 2" />
    </svg>
  );
}

